"""调度层：到期扫描循环 + 并发池 + 每域名限速。

三个设计要点（都是需求里点名的，也都有实际原因）：

1. **用到期扫描而不是内存定时器**
   每 30 秒查一次 `next_due_at <= now` 的来源。内存定时器（sleep / schedule 库）
   一重启就全丢了；存进数据库的 next_due_at 是"重启能自动恢复"的唯一保证。

2. **全局并发上限 + 每域名串行**
   全局 8 个线程防止一次开太多连接；同一域名必须串行且留最小间隔，
   否则你会变成对方站点眼里的"攻击流量" —— 这是被封的最快方式。

3. **抖动 ±10%**
   不加抖动，所有来源会在同一秒一起发请求（尤其是整点），
   既容易触发对方限流，也会让你的网络瞬间堵一下。

Step 5 会在此基础上加：指数退避、自适应降频、连续失败隔离。
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from core.pipeline import run_source_once
from storage import db as db_store
from storage import sources as sources_store  # noqa: F401  （compute_next_due 在这里）

LOCAL_TZ = timezone(timedelta(hours=8))

SCAN_INTERVAL_SEC = 30      # 每 30 秒扫一次到期
MAX_WORKERS = 8             # 全局并发上限
PER_DOMAIN_MIN_GAP = 3.0    # 同一域名两次请求的最小间隔（秒）
JITTER = 0.1                # ±10% 抖动


def _now() -> datetime:
    return datetime.now(LOCAL_TZ)


def _log(msg: str) -> None:
    print(f"[{_now().strftime('%H:%M:%S')}] {msg}", flush=True)


def domain_of(url: str) -> str:
    try:
        return urlsplit(url).netloc.lower()
    except Exception:
        return url


class DomainLimiter:
    """每域名串行 + 最小请求间隔（简易令牌桶）。

    同一域名共用一把锁，拿到锁之后再补足与上次请求的时间差。
    """

    def __init__(self, min_gap: float = PER_DOMAIN_MIN_GAP) -> None:
        self.min_gap = min_gap
        self._locks: dict[str, threading.Lock] = {}
        self._last: dict[str, float] = {}
        self._guard = threading.Lock()

    def _lock_for(self, domain: str) -> threading.Lock:
        with self._guard:
            if domain not in self._locks:
                self._locks[domain] = threading.Lock()
            return self._locks[domain]

    def acquire(self, domain: str) -> None:
        lock = self._lock_for(domain)
        lock.acquire()
        wait = self.min_gap - (time.monotonic() - self._last.get(domain, 0.0))
        if wait > 0:
            time.sleep(wait)
        self._last[domain] = time.monotonic()

    def release(self, domain: str) -> None:
        self._lock_for(domain).release()


class Scheduler:
    """到期扫描调度器。"""

    def __init__(
        self,
        db_path: str | None = None,
        workers: int = MAX_WORKERS,
        scan_interval: int = SCAN_INTERVAL_SEC,
    ) -> None:
        self.db_path = db_path
        self.workers = workers
        self.scan_interval = scan_interval
        self.limiter = DomainLimiter()
        self._stop = threading.Event()
        self._pool = ThreadPoolExecutor(max_workers=workers)
        self._inflight: set[int] = set()
        self._inflight_guard = threading.Lock()

    # ---------- 到期扫描 ----------

    def due_sources(self, conn) -> list:
        now_iso = _now().isoformat()
        rows = conn.execute(
            """SELECT * FROM sources
               WHERE enabled=1
                 AND (next_due_at IS NULL OR next_due_at <= ?)""",
            (now_iso,),
        ).fetchall()
        from storage.sources import _row_to_source

        out = []
        for r in rows:
            s = _row_to_source(r)
            with self._inflight_guard:
                if s.id in self._inflight:
                    continue          # 上一轮还没跑完，这一轮跳过
            out.append(s)
        return out

    def _mark_dispatched(self, source) -> None:
        """派发前先把 next_due_at 推后，防止同一轮里被重复派发。"""
        conn = db_store.connect(self.db_path)
        try:
            # 用 sources.compute_next_due，抖动只在那一个地方算
            due = sources_store.compute_next_due(source.interval_sec, _now())
            conn.execute("UPDATE sources SET next_due_at=? WHERE id=?", (due, source.id))
            conn.commit()
        finally:
            conn.close()

    # ---------- 单个任务 ----------

    def _task(self, source) -> None:
        domain = domain_of(source.url)
        with self._inflight_guard:
            self._inflight.add(source.id)
        try:
            self.limiter.acquire(domain)
            # 每个线程用自己的连接：sqlite 连接不能跨线程共用
            conn = db_store.connect(self.db_path)
            try:
                r = run_source_once(conn, source)
                status = (
                    "error" if r["error"]
                    else r.get("status") if r.get("status") == "not_modified"
                    else ("ok" if r["new"] else "empty")
                )
                _log(
                    f"#{source.id} {source.name}: {status} "
                    f"找到 {r['found']} 新增 {r['new']} "
                    f"HTTP {r['http_status']} {r['duration_ms']}ms"
                    + (f" 错误={r['error'][:40]}" if r["error"] else "")
                )
            finally:
                conn.close()
        except Exception as e:
            _log(f"#{source.id} {source.name}: 任务异常 {type(e).__name__}: {e}")
        finally:
            self.limiter.release(domain)
            with self._inflight_guard:
                self._inflight.discard(source.id)

    # ---------- 主循环 ----------

    def scan_once(self) -> int:
        conn = db_store.connect(self.db_path)
        try:
            db_store.init_db(conn)
            due = self.due_sources(conn)
            for s in due:
                self._mark_dispatched(s)
                self._pool.submit(self._task, s)
            return len(due)
        finally:
            conn.close()

    def loop(self) -> None:
        _log(f"调度器启动：扫描间隔 {self.scan_interval}s，并发上限 {self.workers}，"
             f"每域名最小间隔 {PER_DOMAIN_MIN_GAP}s")
        while not self._stop.is_set():
            try:
                n = self.scan_once()
                if n:
                    _log(f"本轮派发 {n} 个来源")
            except Exception as e:
                _log(f"扫描出错：{type(e).__name__}: {e}")
            self._stop.wait(self.scan_interval)
        _log("调度器已停止")

    def stop(self) -> None:
        self._stop.set()
        self._pool.shutdown(wait=False)

    def run_forever(self) -> None:
        try:
            self.loop()
        except KeyboardInterrupt:
            _log("收到 Ctrl+C，正在停止…")
            self.stop()
