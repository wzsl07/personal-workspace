"""链接归一化。

两个用途：
- absolutize：把相对链接补全成绝对链接（RSS 里少见，网页列表里几乎都是相对的）
- url_key：生成用于去重的"归一化 URL"——去 utm_* 等跟踪参数、去 #、host 小写。
  同一个链接在不同来源里常常带着不同的推广参数，不去重就会出现重复条目。
"""

from __future__ import annotations

from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit

# 常见的跟踪/推广参数，判重时忽略
_TRACKING_PREFIXES = ("utm_",)
_TRACKING_EXACT = {"from", "ref", "spm", "share_token", "src", "source", "referrer"}


def absolutize(url: str | None, base: str) -> str:
    """相对链接 → 绝对链接。已经是绝对的就原样返回。"""
    if not url:
        return ""
    url = url.strip()
    if not url:
        return ""
    if url.startswith(("http://", "https://", "mailto:", "javascript:")):
        return url
    try:
        return urljoin(base, url)
    except Exception:
        return url


def url_key(url: str | None) -> str:
    """归一化后的 URL，用于判重。"""
    if not url:
        return ""
    try:
        parts = urlsplit(url.strip())
    except Exception:
        return (url or "").strip()

    if parts.scheme not in ("http", "https"):
        return (url or "").strip().lower()

    kept = []
    for k, v in parse_qsl(parts.query, keep_blank_values=True):
        lk = k.lower()
        if lk.startswith(_TRACKING_PREFIXES) or lk in _TRACKING_EXACT:
            continue
        kept.append((k, v))

    return urlunsplit(
        (
            parts.scheme.lower(),
            parts.netloc.lower(),
            parts.path.rstrip("/") or "/",
            urlencode(kept),
            "",   # 去掉 fragment
        )
    )
