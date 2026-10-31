"""Step 1 的命令行入口：建库、来源增删改查、抓一次、看条目。

用法（在 aggregator 目录下）：
    python cli.py init
    python cli.py add --name 阮一峰 --url https://www.ruanyifeng.com/blog/atom.xml --type rss
    python cli.py list
    python cli.py fetch --all
    python cli.py items --n 10
    python cli.py pause 1    /  python cli.py resume 1
    python cli.py delete 1
"""

from __future__ import annotations

import argparse
import json
import sys

# Windows 的 cmd 默认 GBK，强制 UTF-8 输出，否则中文乱码
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass

sys.path.insert(0, __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0])

from core.pipeline import run_source_once          # noqa: E402
from storage import db as db_store                 # noqa: E402
from storage import items as items_store           # noqa: E402
from storage import runs as runs_store             # noqa: E402
from storage import sources as sources_store       # noqa: E402

HEALTH_MARK = {"ok": "●", "degraded": "◐", "failing": "○", "disabled": "—", "unknown": "?"}


def cmd_init(_a) -> int:
    conn = db_store.connect()
    db_store.init_db(conn)
    print(f"数据库已就绪：{db_store.DB_PATH}")
    return 0


def cmd_add(a) -> int:
    conn = db_store.connect()
    db_store.init_db(conn)
    cfg = json.loads(a.config) if a.config else {"version": 1}
    sid = sources_store.add_source(
        conn,
        name=a.name,
        type=a.type,
        url=a.url,
        interval_sec=a.interval,
        parser_config=cfg,
        tags=a.tags or "",
    )
    print(f"已添加来源 #{sid}：{a.name}（{a.type}，每 {a.interval} 秒）")
    return 0


def cmd_list(_a) -> int:
    conn = db_store.connect()
    db_store.init_db(conn)
    srcs = sources_store.list_sources(conn)
    if not srcs:
        print("还没有来源。用 `python cli.py add --name ... --url ... --type rss` 加一个。")
        return 0
    print(f"{'ID':<4}{'状态':<4}{'类型':<6}{'名称':<20}{'条目':<6}{'上次抓取':<18}健康")
    print("-" * 78)
    for s in srcs:
        n = items_store.count_items(conn, s.id)
        last = (s.last_fetched_at or "从未")[:16].replace("T", " ")
        mark = HEALTH_MARK.get(s.health_status, "?")
        flag = "" if s.enabled else "（已暂停）"
        print(f"{s.id:<4}{mark:<4}{s.type:<6}{s.name[:18]:<20}{n:<6}{last:<18}"
              f"{s.health_status}{flag}")
        if s.last_error:
            print(f"       └ 最近错误：{s.last_error[:60]}")
    return 0


def cmd_fetch(a) -> int:
    conn = db_store.connect()
    db_store.init_db(conn)
    if a.all:
        targets = [s for s in sources_store.list_sources(conn) if s.enabled]
    else:
        s = sources_store.get_source(conn, a.id)
        targets = [s] if s else []
    if not targets:
        print("没有可抓的来源（用 --all 需要至少一个启用中的来源）。")
        return 1

    total_new = 0
    for s in targets:
        r = run_source_once(conn, s, verbose=True)
        total_new += r["new"]
        if r["error"]:
            print(f"      ✗ {r['error'][:80]}")
    print(f"\n本次共新增 {total_new} 条。")
    return 0


def cmd_items(a) -> int:
    conn = db_store.connect()
    db_store.init_db(conn)
    rows = items_store.list_items(conn, source_id=a.source, limit=a.n, keyword=a.q,
                                  section=a.section)
    if not rows:
        print("没有条目。")
        return 0
    for i, r in enumerate(rows, 1):
        pub = (r["published_at"] or r["discovered_at"] or "")[:16].replace("T", " ")
        sec = f" · {r['section']}" if r["section"] else ""
        print(f"{i}. [{r['source_name']}{sec}] {r['title']}")
        print(f"   {pub}  {r['url']}")
        if r["summary"]:
            print(f"   {r['summary'][:70]}")
    print(f"\n共 {len(rows)} 条（库里总计 {items_store.count_items(conn, a.source)} 条）")
    return 0


def cmd_sections(a) -> int:
    """列出某来源下识别出的栏目及条数。"""
    conn = db_store.connect()
    db_store.init_db(conn)
    srcs = [sources_store.get_source(conn, a.id)] if a.id else sources_store.list_sources(conn)
    for s in srcs:
        if not s:
            continue
        secs = items_store.sections_of(conn, s.id)
        print(f"#{s.id} {s.name}（{s.type}）")
        if not secs:
            print("   （还没有条目）")
            continue
        for name, cnt in secs:
            print(f"   {name or '(未命名)':<16} {cnt} 条")
    return 0


def cmd_runs(a) -> int:
    conn = db_store.connect()
    db_store.init_db(conn)
    rows = runs_store.recent_runs(conn, source_id=a.source, limit=a.n)
    if not rows:
        print("还没有抓取记录。")
        return 0
    print(f"{'ID':<4}{'来源':<6}{'开始':<18}{'结果':<10}{'HTTP':<6}{'耗时':<8}{'找到/新增'}")
    print("-" * 70)
    for r in rows:
        start = (r["started_at"] or "")[:19].replace("T", " ")
        print(f"{r['id']:<4}{r['source_id']:<6}{start:<18}{r['status']:<10}"
              f"{str(r['http_status'] or '-'):<6}{r['duration_ms']}ms{'':<3}"
              f"{r['items_found']}/{r['items_new']}")
        if r["error_message"]:
            print(f"       └ {r['error_message'][:70]}")
    return 0


def cmd_pause(a) -> int:
    conn = db_store.connect()
    sources_store.set_enabled(conn, a.id, False)
    print(f"已暂停来源 #{a.id}")
    return 0


def cmd_resume(a) -> int:
    conn = db_store.connect()
    sources_store.set_enabled(conn, a.id, True)
    print(f"已启用来源 #{a.id}")
    return 0


def cmd_delete(a) -> int:
    conn = db_store.connect()
    s = sources_store.get_source(conn, a.id)
    if not s:
        print(f"没有来源 #{a.id}")
        return 1
    sources_store.delete_source(conn, a.id)
    print(f"已删除来源 #{a.id}：{s.name}（它的条目已级联删除）")
    return 0


def cmd_detect(a) -> int:
    """给一个网址，自动探测它是什么类型、该怎么解析，并预览前几条。"""
    from core.detect import detect

    print(f"探测：{a.url}\n")
    r = detect(a.url)
    print("尝试过程：")
    for at in r.get("attempts", []):
        print(f"  · {at['step']}: {at['url']}")
        print(f"      {at['result']}")
    print()
    if not r.get("ok"):
        print(f"✗ 自动探测失败：{r.get('reason')}")
        print("  可以手动指定类型，例如：")
        print(f"  python cli.py add --name 自定义 --url {a.url} --type html")
        print("  再用 preview 调规则。")
        return 1

    print(f"✓ 建议类型：{r['type']}（{r.get('note','')}）")
    print(f"  置信度：{r.get('confidence')}")
    print("  规则：" + json.dumps(r["parser_config"], ensure_ascii=False))
    if r["type"] == "html":
        print("  （界面上会让你确认这份规则，或直接改）")
    print("\n预览前 5 条：")
    for i, it in enumerate(r["preview"], 1):
        pub = (it.published_at or "")[:16].replace("T", " ")
        print(f"  {i}. [{pub}] {it.title[:44]}")
        if it.url:
            print(f"     {it.url[:80]}")
    return 0


def cmd_preview(a) -> int:
    """用指定规则抓一次并预览，不入库 —— 调 CSS 规则时反复用这个。"""
    import json as _json

    from adapters.http_fetch import fetch
    from parsers.base import parse

    import parsers.html_css  # noqa: F401
    import parsers.json      # noqa: F401
    import parsers.rss       # noqa: F401

    cfg = _json.loads(a.config) if a.config else {}
    resp = fetch(a.url)
    print(f"HTTP {resp.status}  {len(resp.body)} 字节  {resp.duration_ms}ms")
    if not resp.ok:
        print(f"失败：{resp.error_message}")
        return 1
    feed = parse(a.type, resp.body, resp.final_url or a.url, cfg)
    print(f"抽出 {len(feed.items)} 条")
    for w in feed.warnings:
        print(f"提示：{w}")
    for i, it in enumerate(feed.items[: a.n], 1):
        pub = (it.published_at or "")[:16].replace("T", " ")
        print(f"{i}. [{pub}] {it.title[:50]}")
        print(f"   {it.url[:90]}")
        if it.summary:
            print(f"   {it.summary[:70]}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="信息聚合 · 命令行（Step 1）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="建库建表").set_defaults(func=cmd_init)

    p = sub.add_parser("add", help="添加来源")
    p.add_argument("--name", required=True)
    p.add_argument("--url", required=True)
    p.add_argument("--type", default="rss", choices=["rss", "json", "html"])
    p.add_argument("--interval", type=int, default=900, help="抓取间隔秒数，最小 300")
    p.add_argument("--tags", default="")
    p.add_argument("--config", default="",
                   help="解析规则 JSON，html/json 类型需要；可用 detect 先自动探测")
    p.set_defaults(func=cmd_add)

    sub.add_parser("list", help="列出所有来源").set_defaults(func=cmd_list)

    p = sub.add_parser("fetch", help="抓一次")
    p.add_argument("--all", action="store_true", help="抓所有启用中的来源")
    p.add_argument("--id", type=int, default=0)
    p.set_defaults(func=cmd_fetch)

    p = sub.add_parser("items", help="看条目")
    p.add_argument("--source", type=int, default=None)
    p.add_argument("--n", type=int, default=10)
    p.add_argument("--q", default=None, help="关键词搜索")
    p.add_argument("--section", default=None, help="只看某个栏目")
    p.set_defaults(func=cmd_items)

    p = sub.add_parser("sections", help="看各来源识别出的栏目与条数")
    p.add_argument("--id", type=int, default=0)
    p.set_defaults(func=cmd_sections)

    p = sub.add_parser("runs", help="看抓取日志")
    p.add_argument("--source", type=int, default=None)
    p.add_argument("--n", type=int, default=10)
    p.set_defaults(func=cmd_runs)

    p = sub.add_parser("pause")
    p.add_argument("id", type=int)
    p.set_defaults(func=cmd_pause)

    p = sub.add_parser("resume")
    p.add_argument("id", type=int)
    p.set_defaults(func=cmd_resume)

    p = sub.add_parser("delete")
    p.add_argument("id", type=int)
    p.set_defaults(func=cmd_delete)

    p = sub.add_parser("detect", help="给网址自动探测来源类型与解析规则")
    p.add_argument("url")
    p.set_defaults(func=cmd_detect)

    p = sub.add_parser("preview", help="用指定规则预览解析结果（不入库）")
    p.add_argument("url")
    p.add_argument("--type", default="html", choices=["rss", "json", "html"])
    p.add_argument("--config", default="{}", help='JSON 规则，如 \'{"list":{"item":"ul li"}}\'')
    p.add_argument("--n", type=int, default=5)
    p.set_defaults(func=cmd_preview)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
