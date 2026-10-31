"""时间解析自检（不依赖 pytest，直接 `python tests/test_time.py` 就能跑）。

为什么要单独测这一块：时间解析错了不会报错，只会让你看到的顺序悄悄错乱，
是最难发现的一类 bug。
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from normalizers.time import LOCAL_TZ, parse_any, to_iso  # noqa: E402

CASES = [
    # (输入, 期望的本地时间字符串 %Y-%m-%d %H:%M)
    ("Mon, 31 Oct 2026 21:11:00 +0800", "2026-10-31 21:11"),          # RFC 822，RSS 最常见
    ("Mon, 31 Oct 2026 13:11:00 GMT", "2026-10-31 21:11"),            # RFC 822，GMT 需转本地
    ("2026-10-31T21:11:00+08:00", "2026-10-31 21:11"),                # ISO 8601 带时区
    ("2026-10-31T13:11:00Z", "2026-10-31 21:11"),                     # ISO 8601 UTC
    ("2026-10-31 21:11:00", "2026-10-31 21:11"),                      # 无时区，按本地算
    ("2026/10/31 21:11", "2026-10-31 21:11"),                         # 斜杠
    ("2026年10月31日 21:11", "2026-10-31 21:11"),                      # 中文带时间
    ("2026年10月31日", "2026-10-31 00:00"),                            # 中文只有日期
]


def show(iso: str | None) -> str:
    if not iso:
        return "(解析失败)"
    return datetime.fromisoformat(iso).astimezone(LOCAL_TZ).strftime("%Y-%m-%d %H:%M")


def check_relative() -> bool:
    """相对时间是按"现在"算的，只能验证它落在合理区间里。"""
    now = datetime.now(LOCAL_TZ)
    ok = True
    got = parse_any("3小时前")
    delta = now - datetime.fromisoformat(got) if got else None
    ok &= bool(delta and timedelta(hours=2, minutes=50) <= delta <= timedelta(hours=3, minutes=10))
    print(f"  3小时前 -> {show(got)}  {'✓' if ok else '✗'}")

    got = parse_any("昨天 21:11")
    expect = (now - timedelta(days=1)).strftime("%Y-%m-%d") + " 21:11"
    ok &= show(got) == expect
    print(f"  昨天 21:11 -> {show(got)}（期望 {expect}） {'✓' if show(got)==expect else '✗'}")
    return ok


def main() -> int:
    failed = 0
    print("绝对时间：")
    for raw, expect in CASES:
        got = show(parse_any(raw))
        ok = got == expect
        failed += 0 if ok else 1
        print(f"  {raw}  ->  {got}  {'✓' if ok else f'✗ 期望 {expect}'}")

    print("相对时间：")
    if not check_relative():
        failed += 1

    print("struct_time（feedparser 给的格式）：")
    import time as _t

    st = _t.struct_time((2026, 10, 31, 13, 11, 0, 5, 304, 0))   # UTC 13:11
    got = show(parse_any(st))
    ok = got == "2026-10-31 21:11"
    failed += 0 if ok else 1
    print(f"  struct_time(UTC 13:11) -> {got}  {'✓' if ok else '✗ 期望 2026-10-31 21:11'}")

    print()
    print("全部通过 ✓" if failed == 0 else f"有 {failed} 项没通过 ✗")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
