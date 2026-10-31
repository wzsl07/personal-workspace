"""JSON 接口解析（json 类型）与 JSON Feed。

parser_config 形如：
{
  "version": 1,
  "items_path": "$.data.list",
  "fields": {"title": "$.title", "url": "$.link", "published_at": "$.date", "guid": "$.id"}
}

路径语法只支持最基本的一档（够用且零依赖）：
  $           根
  .key        取字段
  [0]         取数组下标
  [*] / []    展开数组（只能出现在末尾）
"""

from __future__ import annotations

import json
import re

from core.models import ParsedFeed, RawItem
from normalizers.encoding import decode_html
from normalizers.text import make_summary, strip_html
from normalizers.time import parse_any
from normalizers.url import absolutize
from parsers.base import register

_TOKEN = re.compile(r"([A-Za-z0-9_\u4e00-\u9fff]+)|\[(\d+|\*)\]")

# 正文上限，与 RSS 解析器保持一致
MAX_CONTENT_CHARS = 20000


def resolve_path(data, path: str):
    """按简化路径表达式取值。出错返回 None，不抛异常。"""
    if not path:
        return data
    p = path.strip()
    if not p.startswith("$"):
        return None
    cur = data
    for m in _TOKEN.finditer(p[1:]):
        key, idx = m.group(1), m.group(2)
        if cur is None:
            return None
        if key is not None:
            if not isinstance(cur, dict):
                return None
            cur = cur.get(key)
        else:
            if not isinstance(cur, list):
                return None
            if idx == "*":
                return cur
            i = int(idx)
            cur = cur[i] if i < len(cur) else None
    return cur


def _first_str(obj, names: tuple[str, ...]) -> str:
    if not isinstance(obj, dict):
        return ""
    for n in names:
        v = obj.get(n)
        if isinstance(v, (str, int, float)):
            return str(v)
    return ""


def _pick(raw: dict, fields: dict, key: str, fallbacks: tuple[str, ...]) -> str:
    """优先用用户配的路径；没配或取不到才退回常见字段名。

    注意：不能拿空路径去 resolve_path —— 它会把整个对象原样返回，
    再交给 strip_html 就会炸（dict 不是字符串）。
    """
    expr = (fields.get(key) or "").strip()
    if expr:
        v = resolve_path(raw, expr)
        if isinstance(v, (str, int, float)):
            return str(v)
        if isinstance(v, dict):
            # 常见情况：{"rendered": "..."}（WordPress 就是这么返回的）
            for k in ("rendered", "value", "text", "name", "title"):
                if isinstance(v.get(k), (str, int, float)):
                    return str(v[k])
    return _first_str(raw, fallbacks)


def _guess_array(data):
    """没配 items_path 时，按 JSON Feed / 常见接口的结构猜数组在哪。"""
    for cand in ("$.items", "$.data.list", "$.data", "$.list", "$.results",
                 "$.articles", "$.entries", "$.feeds"):
        got = resolve_path(data, cand)
        if isinstance(got, list) and got:
            return got
    return data if isinstance(data, list) else []


def parse_json_feed(body: bytes, base_url: str, config: dict) -> ParsedFeed:
    """解析 JSON 接口（或 JSON Feed）。

    如果 config 里给了 items_path 就按它取数组；否则按 JSON Feed 的常见结构猜：
    items / data.list / list / results / articles / feeds。
    """
    try:
        data = json.loads(decode_html(body))
    except Exception as e:
        return ParsedFeed(warnings=[f"JSON 解析失败：{e}"])

    cfg = config or {}
    result = ParsedFeed(
        feed_title=_first_str(data, ("title", "feed_title", "name")) if isinstance(data, dict) else "",
        site_url=_first_str(data, ("home_page_url", "site_url", "link")) or base_url,
    )

    # 支持按栏目分段：sections=[{name, items_path, fields}]；没有就当成一个栏目
    sections = cfg.get("sections") if isinstance(cfg.get("sections"), list) else None
    groups: list[tuple[str, dict, list]] = []
    if sections:
        for s in sections:
            if not isinstance(s, dict):
                continue
            arr = resolve_path(data, s.get("items_path", "")) if s.get("items_path") else None
            if not isinstance(arr, list):
                arr = _guess_array(data)
            groups.append((s.get("name", "") or "", s.get("fields") or {}, arr or []))
    else:
        arr = resolve_path(data, cfg.get("items_path", "")) if cfg.get("items_path") else None
        if not isinstance(arr, list):
            arr = _guess_array(data)
        groups.append(("", cfg.get("fields") or {}, arr or []))

    for section_name, fields, arr in groups:
        for raw in arr:
            if not isinstance(raw, dict):
                continue
            title = strip_html(_pick(raw, fields, "title", ("title", "name", "subject", "heading")))
            if not title:
                continue
            url = _pick(raw, fields, "url", ("url", "link", "id"))
            url = absolutize(str(url or ""), result.site_url or base_url)
            date_raw = _pick(raw, fields, "published_at",
                             ("published_at", "date_published", "published", "date", "time", "pubDate"))
            summary = make_summary(strip_html(_pick(
                raw, fields, "summary",
                ("summary", "content_text", "content", "description", "desc"))))
            guid = str(_pick(raw, fields, "guid", ("id", "guid", "url", "link")) or url or title)

            # 正文：JSON Feed 规范里 content_html / content_text 就是全文，
            # 同样不需要再发请求。取不到就退回 summary 的原文。
            content = strip_html(_pick(
                raw, fields, "content",
                ("content_html", "content_text", "content", "text", "description", "desc")))
            if len(content) > MAX_CONTENT_CHARS:
                content = content[:MAX_CONTENT_CHARS]

            result.items.append(
                RawItem(
                    guid=guid, url=url, title=title, summary=summary,
                    author=_first_str(raw, ("author", "author_name")),
                    published_at=parse_any(date_raw),
                    raw=json.dumps(raw, ensure_ascii=False)[:300],
                    section=section_name,
                    content=content,
                    content_state="ok" if content else "",
                )
            )

    if not result.items:
        result.warnings.append("没解析出条目：检查 items_path 是否指向真正的数组")
    return result


register("json", parse_json_feed)
