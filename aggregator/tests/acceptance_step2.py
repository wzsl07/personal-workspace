"""Step 2 验收脚本：挂机 20 分钟 + 中途重启。

跑法（在 aggregator 目录下）：
    python tests/acceptance_step2.py

流程：
    1. 把所有来源间隔改成 300 秒（测试用，跑完建议改回 900）
    2. 启动调度器跑 12 分钟
    3. **强行杀掉**（模拟关机 / 崩溃），等 5 秒
    4. 再启动跑 8 分钟
    5. 汇总 fetch_runs：每个来源跑了几轮、间隔多少、有没有被重复抓

为什么要强行杀：温和退出（Ctrl+C）会走清理逻辑，而真实场景更多是
直接关窗口 / 系统重启 —— 只有硬杀才能证明"重启能恢复"是靠数据库而不是靠内存。
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from storage import db as db_store          # noqa: E402
from storage import runs as runs_store      # noqa: E402
from storage import sources as sources_store  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LOCAL_TZ = timezone(timedelta(hours=8))

PHASE1_MIN = 12
PHASE2_MIN = 8


def log(msg: str) -> None:
    print(f"[{datetime.now(LOCAL_TZ).strftime('%H:%M:%S')}] {msg}", flush=True)


def start_scheduler(logfile: str) -> subprocess.Popen:
    f = open(logfile, "w", encoding="utf-8")
    return subprocess.Popen(
        [sys.executable, "run.py"], cwd=ROOT, stdout=f, stderr=subprocess.STDOUT
    )


def wait(minutes: float, label: str) -> None:
    end = time.time() + minutes * 60
    while time.time() < end:
        left = int(end - time.time())
        if left % 120 == 0:
            log(f"{label}：还剩 {left//60} 分 {left%60} 秒")
        time.sleep(10)
    log(f"{label}：结束")


def summarize() -> None:
    conn = db_store.connect()
    print()
    print("=" * 72)
    print("抓取轮次汇总")
    print("=" * 72)
    for s in sources_store.list_sources(conn):
        rows = runs_store.recent_runs(conn, source_id=s.id, limit=50)
        rows = list(reversed(rows))   # 按时间正序
        print(f"\n#{s.id} {s.name}（间隔 {s.interval_sec}s，健康 {s.health_status}）"
              f"  共 {len(rows)} 轮")
        prev = None
        for r in rows:
            t = datetime.fromisoformat(r["started_at"]).astimezone(LOCAL_TZ)
            gap = ""
            if prev:
                gap = f"  +{(t - prev).total_seconds():.0f}s"
            prev = t
            print(f"   {t.strftime('%H:%M:%S')}{gap}  {r['status']:<6}"
                  f" HTTP {r['http_status']}  找到 {r['items_found']} 新增 {r['items_new']}")
    total_new = conn.execute(
        "SELECT COALESCE(SUM(items_new),0) c FROM fetch_runs"
    ).fetchone()["c"]
    total_items = conn.execute("SELECT COUNT(*) c FROM items").fetchone()["c"]
    print(f"\n累计新增 {total_new} 条，库中现有 {total_items} 条")
    print("判定：每个来源的轮次间隔应≈300s（±10% 抖动 = 270~330s）；")
    print("      重启之后的第一轮不应出现「所有来源同时立即重抓」。")


def main() -> int:
    os.chdir(ROOT)
    conn = db_store.connect()
    db_store.init_db(conn)
    for s in sources_store.list_sources(conn):
        sources_store.update_source(conn, s.id, interval_sec=300)
    log("已把所有来源间隔改为 300 秒（测试用）")

    log(f"阶段 1：启动调度器，跑 {PHASE1_MIN} 分钟")
    p1 = start_scheduler(os.path.join(HERE, "_step2_phase1.log"))
    wait(PHASE1_MIN, "阶段 1")
    log("阶段 1 结束 → 强行杀掉进程（模拟崩溃 / 直接关窗口）")
    p1.terminate()
    try:
        p1.wait(timeout=20)
    except subprocess.TimeoutExpired:
        p1.kill()
    time.sleep(5)

    log(f"阶段 2：重新启动，跑 {PHASE2_MIN} 分钟")
    p2 = start_scheduler(os.path.join(HERE, "_step2_phase2.log"))
    wait(PHASE2_MIN, "阶段 2")
    p2.terminate()
    try:
        p2.wait(timeout=20)
    except subprocess.TimeoutExpired:
        p2.kill()
    log("阶段 2 结束")

    summarize()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
