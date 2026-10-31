"""Step 2：启动调度循环（前台运行，Ctrl+C 停止）。

用法（在 aggregator 目录下）：
    python run.py                # 一直跑
    python run.py --once         # 只扫一轮（调试用）
    python run.py --interval 300 # 把所有来源的间隔临时改成 300 秒再跑（测试用）

为什么是"前台跑"：
Step 2 还没做界面，让它把每一轮做了什么直接打到屏幕上，你能一眼看懂；
Step 4 加上 Web 服务后，这个循环会变成后台线程，由 main.py 一起拉起。
"""

from __future__ import annotations

import argparse
import sys

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass

sys.path.insert(0, __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0])

from core.scheduler import Scheduler          # noqa: E402
from storage import db as db_store            # noqa: E402
from storage import sources as sources_store  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="信息聚合 · 调度循环")
    ap.add_argument("--once", action="store_true", help="只扫描一轮就退出")
    ap.add_argument("--interval", type=int, default=0,
                    help="把现有来源的间隔统一改成这个值（最小 300，测试用）")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--scan", type=int, default=30, help="到期扫描间隔，默认 30 秒")
    args = ap.parse_args()

    db_store.init_db(db_store.connect())

    if args.interval:
        conn = db_store.connect()
        for s in sources_store.list_sources(conn):
            sources_store.update_source(conn, s.id, interval_sec=args.interval)
        print(f"已把所有来源的间隔改为 {args.interval} 秒")

    sch = Scheduler(workers=args.workers, scan_interval=args.scan)
    if args.once:
        n = sch.scan_once()
        print(f"派发 {n} 个来源，任务在后台线程池执行（稍等几秒看结果）")
        sch._pool.shutdown(wait=True)
        return 0

    sch.run_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
