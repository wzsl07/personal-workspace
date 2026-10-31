"""OPML 导入导出。

标准 OPML 只有 <outline type="rss" xmlUrl="…"> 这一种，只够表达 RSS 订阅。
但我们还有 html / json 两种带解析规则的来源，所以导出时：
- RSS：标准写法，任何阅读器（Feedly / Inoreader / Reeder …）都能导入；
- html/json：额外带一个 cfg 属性（base64 的解析规则），
  标准阅读器会忽略它，我们自己的工具导回来时规则还在。
"""

from __future__ import annotations

import base64
import json
import sqlite3
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

LOCAL_TZ = timezone(timedelta(hours=8))
NS_ATTR = "cfg"   # 非标准属性，用来携带我们的解析规则


def _esc(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(
        ">", "&gt;").replace('"', "&quot;")


def export_opml(sources) -> str:
    """把来源列表导出成 OPML 文本。"""
    now = datetime.now(LOCAL_TZ).strftime("%a, %d %b %Y %H:%M:%S +0800")
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<opml version="2.0">',
        "  <head>",
        "    <title>个人工作台 · 信息聚合</title>",
        f"    <dateCreated>{now}</dateCreated>",
        "  </head>",
        "  <body>",
    ]
    for s in sources:
        attrs = [
            f'type="{_esc(s.type)}"',
            f'text="{_esc(s.name)}"',
            f'title="{_esc(s.name)}"',
            f'xmlUrl="{_esc(s.url)}"',
            f'htmlUrl="{_esc(s.url)}"',
        ]
        if s.tags:
            attrs.append(f'category="{_esc(s.tags)}"')
        if s.type in ("html", "json") and s.parser_config:
            raw = json.dumps(s.parser_config, ensure_ascii=False).encode("utf-8")
            attrs.append(f'{NS_ATTR}="{base64.b64encode(raw).decode("ascii")}"')
        lines.append(f'    <outline {" ".join(attrs)} />')
    lines += ["  </body>", "</opml>", ""]
    return "\n".join(lines)


def import_opml(conn: sqlite3.Connection, content: str) -> tuple[int, int]:
    """导入 OPML。返回 (新增条数, 跳过条数)。"""
    try:
        root = ET.fromstring(content)
    except ET.ParseError as e:
        raise ValueError(f"OPML 解析失败：{e}") from e

    added = skipped = 0
    existing = {s.url for s in _all_sources(conn)}

    for el in root.iter("outline"):
        url = (el.get("xmlUrl") or el.get("htmlUrl") or "").strip()
        if not url or not urlparse(url).scheme.startswith("http"):
            skipped += 1
            continue
        if url in existing:
            skipped += 1
            continue

        name = (el.get("title") or el.get("text") or url).strip()
        rtype = (el.get("type") or "rss").strip().lower()
        if rtype not in ("rss", "json", "html"):
            rtype = "rss"

        cfg = {"version": 1}
        if el.get(NS_ATTR) and rtype in ("html", "json"):
            try:
                cfg = json.loads(base64.b64decode(el.get(NS_ATTR)).decode("utf-8"))
            except Exception:
                cfg = {"version": 1}

        try:
            sources_store_add(conn, name=name, type=rtype, url=url,
                              parser_config=cfg, tags=(el.get("category") or ""))
            existing.add(url)
            added += 1
        except Exception:
            skipped += 1
    return added, skipped


# 这两个间接引用是为了避免循环导入（storage.sources → core.models，core.models 不依赖本模块，
# 但直接在模块顶层 import 会让 storage 包初始化顺序变脆）
def _all_sources(conn: sqlite3.Connection):
    from storage import sources as sources_store

    return sources_store.list_sources(conn)


def sources_store_add(conn: sqlite3.Connection, **kw) -> int:
    from storage import sources as sources_store

    return sources_store.add_source(conn, **kw)
