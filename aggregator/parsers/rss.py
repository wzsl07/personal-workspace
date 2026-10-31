"""RSS / Atom 解析。

用 feedparser 而不是自己写 xml 解析：现实中的 feed 有大量不规范写法
（编码声明缺失、日期格式乱来、标签大小写混用、Atom 与 RSS 字段混着用），
feedparser 已经处理了十几年，自己写会不断踩坑。

注意：这里接收的是 **bytes**，交给 feedparser 自己判断编码。
提前用错误的编码 decode 成 str 是中文乱码最常见的来源。
"""

from __future__ import annotations

import feedparser

from core.models import ParsedFeed, RawItem
from normalizers.text import make_summary, strip_html
from normalizers.time import parse_any
from normalizers.url import absolutize
from parsers.base import register


# 正文上限：防止个别 feed 把整站内容塞进来把库撑爆
MAX_CONTENT_CHARS = 20000


def _entry_content(entry) -> str:
    """取出 feed 条目里的全文字段，取不到返回 ''。"""
    # feedparser：<content:encoded> → entry.content[0].value
    lst = entry.get("content")
    if isinstance(lst, list) and lst:
        first = lst[0]
        if isinstance(first, dict):
            v = first.get("value") or first.get("data") or ""
            if v:
                return strip_html(str(v))
    for key in ("content_detail", "content_encoded", "fulltext", "full_text"):
        v = entry.get(key)
        if isinstance(v, dict):
            v = v.get("value") or ""
        if v:
            return strip_html(str(v))
    return ""


def parse_rss(body: bytes, base_url: str, config: dict) -> ParsedFeed:
    """解析 RSS/Atom 字节流。"""
    doc = feedparser.parse(body)
    warnings: list[str] = []

    if getattr(doc, "bozo", 0):
        # bozo=1 表示"有点不规范"，但多数情况下仍然解析出了条目，不应直接判死
        exc = getattr(doc, "bozo_exception", None)
        warnings.append(f"feed 不完全规范，但已尽力解析：{exc}")

    feed_meta = getattr(doc, "feed", {}) or {}
    result = ParsedFeed(
        feed_title=str(feed_meta.get("title") or ""),
        site_url=str(feed_meta.get("link") or base_url),
        warnings=warnings,
    )

    for entry in doc.entries:
        title = strip_html(str(entry.get("title") or "")) or "(无标题)"
        link = absolutize(str(entry.get("link") or ""), base_url or result.site_url)

        # 时间：优先用 feedparser 已经解析好的 struct_time（最可靠），
        # 没有再退回解析原始字符串
        published = parse_any(
            entry.get("published_parsed")
            or entry.get("updated_parsed")
            or entry.get("published")
            or entry.get("updated")
        )

        raw_summary = entry.get("summary") or entry.get("description") or ""
        summary = make_summary(strip_html(str(raw_summary)))

        # 正文：feed 里常常就带着全文（<content:encoded>），**不需要再发一次请求**。
        # feedparser 把它放在 entry.content（是个列表）里；少数写法会落在
        # content_detail / content_encoded 上。都取不到就退回 description 的原文
        # （不截断，搜索要的是全量；列表展示仍用上面那个 200 字的 summary）。
        content = _entry_content(entry) or strip_html(str(raw_summary))
        if len(content) > MAX_CONTENT_CHARS:
            content = content[:MAX_CONTENT_CHARS]

        guid = str(entry.get("id") or entry.get("guid") or link or title)
        author = str(entry.get("author") or "")

        result.items.append(
            RawItem(
                guid=guid,
                url=link,
                title=title,
                summary=summary,
                author=author,
                published_at=published,
                raw=str(entry.get("title") or ""),
                content=content,
                content_state="ok" if content else "",
            )
        )

    return result


register("rss", parse_rss)
