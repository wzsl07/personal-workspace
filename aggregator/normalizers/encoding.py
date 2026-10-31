"""HTML 编码探测。

为什么单独写：国内高校 / 政务站点大量使用 GBK / GB2312，
如果一律按 UTF-8 解码，中文全是乱码 —— 而且**不报错**，只是悄悄变乱码，
最难排查。顺序必须是：声明优先，其次实测，最后兜底。
"""

from __future__ import annotations

import re

_META_RE = re.compile(
    rb"""<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_-]+)""", re.I
)
_XML_RE = re.compile(rb"""<\?xml[^>]+encoding\s*=\s*["']([A-Za-z0-9_-]+)""", re.I)

# 中文站点最常见的几种编码，按可能性排序
CANDIDATES = ("utf-8", "gb18030", "gbk", "big5")


def declared_encoding(body: bytes) -> str | None:
    """从 meta charset / xml 声明里读编码。"""
    head = body[:4096]
    m = _META_RE.search(head) or _XML_RE.search(head)
    if not m:
        return None
    enc = m.group(1).decode("ascii", errors="ignore").strip().lower()
    # 有些老站点写 gb2312，用 gb18030 解更全（gb18030 是超集）
    return "gb18030" if enc in ("gb2312", "gbk") else enc


def decode_html(body: bytes) -> str:
    """把 HTML 字节流解成文本：声明 → 逐个尝试 → 兜底替换。"""
    enc = declared_encoding(body)
    if enc:
        try:
            return body.decode(enc)
        except (UnicodeDecodeError, LookupError):
            pass

    for enc in CANDIDATES:
        try:
            text = body.decode(enc)
            # 解出来如果替换字符特别多，说明这个编码不对
            if text.count("\ufffd") > len(text) * 0.01:
                continue
            return text
        except (UnicodeDecodeError, LookupError):
            continue

    return body.decode("utf-8", errors="replace")
