"""HTML + CSS 选择器解析（用于没有 feed 的普通网页）。

parser_config 形如：
{
  "version": 1,
  "list": {
    "item": "div.blog2 ul li",
    "title": "a::text",
    "url": "a::attr(href)",
    "date": "span::text",
    "summary": "p::text"
  },
  "base_url": "https://bksy.shu.edu.cn/"
}

字段写法：
  "选择器"              取文本
  "选择器::text"        取文本（同上，写清楚一点）
  "选择器::attr(href)"  取属性值
  "选择器::html"        取原始 HTML（给摘要用）
留空或找不到就当作没有，不报错 —— 网页结构五花八门，缺字段是常态。
"""

from __future__ import annotations

from parsel import Selector

from core.models import ParsedFeed, RawItem
from normalizers.encoding import decode_html
from normalizers.text import make_summary, strip_html
from normalizers.time import parse_any
from normalizers.url import absolutize
from parsers.base import register

# 标题短到这个程度基本是导航/图标入口，不是正文条目
MIN_TITLE_LEN = 4


def _take(node, expr: str | None) -> str:
    """按字段表达式取值。"""
    if not expr:
        return ""
    expr = expr.strip()
    if not expr:
        return ""

    if expr.endswith("::html"):
        v = _first(node, expr[: -len("::html")], "html")
    elif "::attr(" in expr:
        sel, attr = expr.split("::attr(", 1)
        attr = attr.rstrip(")").strip()
        v = _first(node, sel.strip(), f"attr({attr})")
    elif expr.endswith("::text"):
        v = _first(node, expr[: -len("::text")], "text")
    else:
        v = _first(node, expr, "text")
    return (v or "").strip()


def _first(node, css: str, how: str) -> str:
    try:
        if how == "text":
            vals = node.css(css + "::text").getall()
            return " ".join(v.strip() for v in vals if v.strip())
        if how == "html":
            return node.css(css).get() or ""
        if how.startswith("attr("):
            attr = how[5:-1]
            return node.css(css + f"::attr({attr})").get() or ""
    except Exception:
        return ""
    return ""


def _sections_of(cfg: dict) -> list[dict]:
    """兼容两种写法：
    - sections：[{name, item, title, url, date, summary}, ...]（多栏目，推荐）
    - list：{item, title, ...}（单栏目，旧写法，仍支持）
    """
    secs = cfg.get("sections")
    if isinstance(secs, list) and secs:
        return [s for s in secs if isinstance(s, dict)]
    lst = cfg.get("list")
    if isinstance(lst, dict) and lst:
        return [{"name": cfg.get("name", ""), **lst}]
    return []


def parse_html(body: bytes, base_url: str, config: dict) -> ParsedFeed:
    """按 CSS 规则解析网页列表。支持一个页面里的多个并列栏目。"""
    cfg = config or {}
    base = cfg.get("base_url") or base_url
    sections = _sections_of(cfg)

    sel = Selector(decode_html(body))
    result = ParsedFeed(
        feed_title=(sel.css("title::text").get() or "").strip(),
        site_url=base,
    )

    if not sections:
        result.warnings.append("parser_config 里既没有 sections 也没有 list，不知道该取哪些元素")
        return result

    for sec in sections:
        item_sel = (sec.get("item") or "").strip()
        name = (sec.get("name") or "").strip()
        if not item_sel:
            continue
        try:
            nodes = sel.css(item_sel)
        except Exception as e:
            result.warnings.append(f"栏目「{name or '未命名'}」选择器无法解析（{item_sel}）：{e}")
            continue

        got = 0
        for node in nodes:
            title = strip_html(_take(node, sec.get("title")))
            if not title or len(title) < MIN_TITLE_LEN:
                continue
            url = absolutize(_take(node, sec.get("url")), base)
            date_raw = _take(node, sec.get("date"))
            summary = make_summary(strip_html(_take(node, sec.get("summary"))))
            result.items.append(
                RawItem(
                    guid=url or f"{name}|{title}|{date_raw}",
                    url=url,
                    title=title,
                    summary=summary,
                    author=_take(node, sec.get("author")),
                    published_at=parse_any(date_raw),
                    raw=_take(node, sec.get("title"))[:200],
                    section=name,
                )
            )
            got += 1

        if got == 0:
            result.warnings.append(
                f"栏目「{name or '未命名'}」的 {item_sel} 匹配到 {len(nodes)} 个元素，"
                "但没抽出有效条目（标题太短或字段名对不上）"
            )

    if not result.items:
        result.warnings.append("所有栏目都没抽出条目，请检查选择器")
    return result


register("html", parse_html)
