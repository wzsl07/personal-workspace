"""时间归一化：把各种写法的时间转成统一的 ISO 8601（带时区）。

为什么要单独一层：
- RSS 里有 RFC 822（Mon, 31 Oct 2026 21:11:00 +0800）也有 ISO 8601；
- 网页上的时间更是五花八门：2026年10月31日、2026-10-31 21:11、10/31、昨天 21:11、3小时前。
统一成带时区的 ISO 后，排序、筛选、展示才不会乱。
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

# 默认按北京时间理解没有时区的时间（用户在中国，且这是单机自用工具）
LOCAL_TZ = timezone(timedelta(hours=8))


def to_iso(dt: datetime) -> str:
    """datetime → ISO 8601。没有时区的一律按本地时区补上，避免出现"天真时间"。 """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=LOCAL_TZ)
    return dt.isoformat()


def parse_any(value) -> str | None:
    """尽最大努力把各种时间写法解析成 ISO 字符串，失败返回 None。"""
    if value is None or value == "":
        return None

    # feedparser 给的是 struct_time（已是 UTC 的年月日时分秒）
    if hasattr(value, "tm_year"):
        try:
            return datetime(*value[:6], tzinfo=timezone.utc).isoformat()
        except Exception:
            return None

    if isinstance(value, datetime):
        return to_iso(value)

    s = str(value).strip()
    if not s:
        return None

    # 1) ISO 8601（含 Z 结尾）
    iso = _try_iso(s)
    if iso:
        return iso

    # 2) RFC 822 / RFC 2822（RSS 最常见）
    try:
        return to_iso(parsedate_to_datetime(s))
    except Exception:
        pass

    # 3) 中文与常见数字格式
    dt = _try_formats(s) or _try_chinese(s) or _try_relative(s)
    return to_iso(dt) if dt else None


def _try_iso(s: str) -> str | None:
    t = s.replace("Z", "+00:00")
    # 有些站点写成 2026-10-31T21:11:00.000+08:00，fromisoformat 在 3.11+ 都能吃
    try:
        dt = datetime.fromisoformat(t)
    except ValueError:
        return None
    return to_iso(dt)


_FORMATS = [
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",
    "%Y/%m/%d %H:%M:%S",
    "%Y/%m/%d %H:%M",
    "%Y/%m/%d",
    "%Y.%m.%d",
    "%Y年%m月%d日 %H:%M",
    "%Y年%m月%d日",
    "%d %b %Y %H:%M:%S",
    "%b %d, %Y",
]


def _try_formats(s: str) -> datetime | None:
    for fmt in _FORMATS:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


_CN_RE = re.compile(r"(?:(\d{4})\s*年)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?(?:\s*(\d{1,2}):(\d{2}))?")


def _try_chinese(s: str) -> datetime | None:
    """处理"2026年10月31日 21:11""10月31日"这类中文日期。缺年份就按当前年份。"""
    m = _CN_RE.search(s)
    if not m:
        return None
    year = int(m.group(1)) if m.group(1) else datetime.now(LOCAL_TZ).year
    month, day = int(m.group(2)), int(m.group(3))
    hour = int(m.group(4)) if m.group(4) else 0
    minute = int(m.group(5)) if m.group(5) else 0
    try:
        return datetime(year, month, day, hour, minute)
    except ValueError:
        return None


_REL_RE = re.compile(r"(\d+)\s*(分钟|小时|天)前")


def _try_relative(s: str) -> datetime | None:
    """处理"3小时前""昨天 21:11""前天"这类相对表达。"""
    now = datetime.now(LOCAL_TZ)
    m = _REL_RE.search(s)
    if m:
        n = int(m.group(1))
        unit = m.group(2)
        delta = {"分钟": timedelta(minutes=n), "小时": timedelta(hours=n), "天": timedelta(days=n)}[unit]
        return (now - delta).replace(tzinfo=None)
    if s.startswith("昨天"):
        base = (now - timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        tail = s.replace("昨天", "").strip()
        return _merge_clock(base, tail)
    if s.startswith("前天"):
        base = (now - timedelta(days=2)).replace(hour=0, minute=0, second=0, microsecond=0)
        tail = s.replace("前天", "").strip()
        return _merge_clock(base, tail)
    if s.startswith("今天"):
        base = now.replace(hour=0, minute=0, second=0, microsecond=0)
        tail = s.replace("今天", "").strip()
        return _merge_clock(base, tail)
    return None


def _merge_clock(base: datetime, tail: str) -> datetime:
    m = re.search(r"(\d{1,2}):(\d{2})", tail)
    if m:
        return base.replace(hour=int(m.group(1)), minute=int(m.group(2)))
    return base
