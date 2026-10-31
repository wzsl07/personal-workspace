"""每域名限速自检：同一域名的两个来源必须串行，且开始时间相隔 ≥3 秒。

跑法：python tests/test_domain_limit.py
（用临时库，不会动你的真实数据）

为什么单独测这个：真实来源通常都是不同域名，肉眼看不出限速有没有生效。
但这个机制是"不被对方站点封"的关键 —— 一旦失效，你会变成对方眼里的攻击流量。
"""

from __future__ import annotations

import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

DB = os.path.join(tempfile.gettempdir(), "agg-domain-test.db")
for suffix in ("", "-wal", "-shm"):
    if os.path.exists(DB + suffix):
        os.remove(DB + suffix)
os.environ["AGG_DB"] = DB

from core.scheduler import PER_DOMAIN_MIN_GAP, Scheduler   # noqa: E402
from storage import db as db_store                          # noqa: E402
from storage import sources as sources_store                # noqa: E402

STARTS: list[tuple[str, str, float]] = []   # (名称, 域名, 拿到许可的时刻)


def _remember(name: str) -> None:
    """记下当前线程正在跑哪个来源（多线程下不能用普通变量）。"""
    import threading

    if not hasattr(_remember, "local"):
        _remember.local = threading.local()
    _remember.local.name = name


def _current_name() -> str:
    return getattr(getattr(_remember, "local", None), "name", "?")


def main() -> int:
    conn = db_store.connect()
    db_store.init_db(conn)
    sources_store.add_source(conn, name="同域名A", type="rss", url="https://sspai.com/feed")
    sources_store.add_source(conn, name="同域名B", type="rss", url="https://sspai.com/feed")
    sources_store.add_source(conn, name="其它域名", type="rss",
                             url="https://www.ruanyifeng.com/blog/atom.xml")
    conn.close()

    sch = Scheduler(workers=8)

    # 探针要插在"拿到域名许可之后"，而不是任务开始之前 ——
    # 任务开始后会先在 limiter 上排队，插错位置就测不到排队效果。
    orig_acquire = sch.limiter.acquire

    def timed_acquire(domain: str) -> None:
        orig_acquire(domain)
        STARTS.append((_current_name(), domain, time.monotonic()))

    sch.limiter.acquire = timed_acquire

    orig_task = sch._task

    def named(source):
        _remember(source.name)
        orig_task(source)

    sch._task = named
    n = sch.scan_once()
    sch._pool.shutdown(wait=True)

    print(f"派发 {n} 个来源：两个同属 sspai.com，一个属 www.ruanyifeng.com\n")
    base = min(t for _, _, t in STARTS)
    for name, dom, t in sorted(STARTS, key=lambda x: x[2]):
        print(f"  {name:<8} {dom:<24} 开始 +{t - base:.2f}s")

    same = sorted([t for n_, d, t in STARTS if d == "sspai.com"])
    gap = same[1] - same[0] if len(same) >= 2 else 0
    others = [t for n_, d, t in STARTS if d != "sspai.com"]

    print()
    ok = True
    print(f"同域名两次开始相隔 {gap:.2f}s（要求 ≥ {PER_DOMAIN_MIN_GAP}s）"
          f"  {'✓' if gap >= PER_DOMAIN_MIN_GAP else '✗'}")
    ok &= gap >= PER_DOMAIN_MIN_GAP
    if others:
        parallel = min(others) - base < 1.0
        print(f"不同域名是否几乎同时开始（并发生效）：{'✓' if parallel else '✗'}"
              f"  （+{min(others) - base:.2f}s）")
        ok &= parallel

    print("\n全部通过 ✓" if ok else "\n有项没通过 ✗")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
