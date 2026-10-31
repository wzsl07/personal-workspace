"""文本与链接的归一化。

注意分工：
- 这里做的是"变成纯文本"（去标签、去脚本、压空白），用于生成摘要和入库；
- 真正的**白名单清洗**（防 XSS）在展示层做，Step 5 会实现。
  两步不能混：入库时过度清洗会丢信息，展示时不清洗会出安全问题。
"""

from __future__ import annotations

import html
import re

_SCRIPT_RE = re.compile(r"<(script|style|noscript)[^>]*>.*?</\1>", re.I | re.S)
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"[ \t\u00a0]+")
_BLANK_LINES_RE = re.compile(r"\n{3,}")


def strip_html(fragment: str) -> str:
    """HTML 片段 → 纯文本。"""
    if not fragment:
        return ""
    s = _SCRIPT_RE.sub("", fragment)
    s = re.sub(r"<(br|/p|/div|/li|/tr)[^>]*>", "\n", s, flags=re.I)
    s = _TAG_RE.sub("", s)
    s = html.unescape(s)
    s = _WS_RE.sub(" ", s)
    s = re.sub(r" *\n *", "\n", s)
    s = _BLANK_LINES_RE.sub("\n\n", s)
    return s.strip()


def make_summary(text: str, limit: int = 200) -> str:
    """生成摘要：截断到 limit 字，超出加省略号，不切断单词中间（中英混排下按字符截）。"""
    t = (text or "").strip()
    if len(t) <= limit:
        return t
    return t[:limit].rstrip() + "…"


def one_line(text: str) -> str:
    """压成单行（列表展示用）。"""
    return re.sub(r"\s+", " ", text or "").strip()
