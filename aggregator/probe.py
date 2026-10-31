"""Step 0：给一个 RSS 网址，打印前 N 条（标题 / 链接 / 时间）。

用法（在 aggregator 目录下）：
    python probe.py https://www.ruanyifeng.com/blog/atom.xml
    python probe.py https://www.ruanyifeng.com/blog/atom.xml --n 3

验收标准：中文不乱码、时间解析正确。
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta

# Windows 的 cmd 默认 GBK，直接打印中文会乱码。强制用 UTF-8 输出。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass

sys.path.insert(0, __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0])

from adapters.http_fetch import fetch            # noqa: E402
from normalizers.time import LOCAL_TZ             # noqa: E402
from parsers.base import parse                    # noqa: E402


def show_local(iso: str | None) -> str:
    """把 ISO 时间显示成本地时间，方便肉眼核对"时间对不对"。 """
    if not iso:
        return "(无时间)"
    try:
        dt = datetime.fromisoformat(iso).astimezone(LOCAL_TZ)
    except ValueError:
        return iso
    return dt.strftime("%Y-%m-%d %H:%M")


def main() -> int:
    ap = argparse.ArgumentParser(description="给一个 RSS 网址，打印前 N 条")
    ap.add_argument("url", help="RSS / Atom 地址")
    ap.add_argument("--n", type=int, default=5, help="打印几条，默认 5")
    args = ap.parse_args()

    print(f"抓取：{args.url}")
    resp = fetch(args.url)
    print(f"状态：HTTP {resp.status}  耗时 {resp.duration_ms}ms  "
          f"字节 {len(resp.body)}")
    if not resp.ok:
        print(f"失败：{resp.error_kind} - {resp.error_message}")
        return 1

    import parsers.rss  # noqa: F401  注册 rss 解析器

    feed = parse("rss", resp.body, resp.final_url or args.url, {})
    print(f"来源：{feed.feed_title or '(无标题)'}   共 {len(feed.items)} 条")
    for w in feed.warnings:
        print(f"提示：{w}")
    print("-" * 60)

    for i, it in enumerate(feed.items[: args.n], 1):
        print(f"{i}. {it.title}")
        print(f"   链接：{it.url}")
        print(f"   时间：{show_local(it.published_at)}")
        if it.summary:
            print(f"   摘要：{it.summary[:80]}")
        print()

    if not feed.items:
        print("一条都没解析出来 —— 这个地址可能不是 feed。")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
