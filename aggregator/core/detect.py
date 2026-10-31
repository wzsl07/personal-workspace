"""自动探测：给一个网址，依次尝试各种可能，产出一份"建议配置"。

降级链（前一步失败才走下一步）：
  1. RSS 自动发现：页面 <link rel="alternate" type="application/rss+xml">
  2. 常见 feed 路径：/feed  /rss  /atom.xml  /feed.xml  /index.xml ...
  3. JSON Feed：/feed.json、或 <link type="application/feed+json">
  4. 自动正文提取：分析页面结构，猜一份 CSS 规则

每一步都会**真正解析一遍**并要求至少 1 条条目，才认为这一步成功 ——
光看 HTTP 200 不算数，很多站点的 /feed 返回的是 404 页面。
"""

from __future__ import annotations

from urllib.parse import urljoin, urlsplit

from adapters.http_fetch import fetch
from core.models import RawItem
from normalizers.encoding import decode_html
from normalizers.url import absolutize
from parsers import auto_extract
from parsers.base import parse
from parsers.rss import parse_rss

import parsers.html_css  # noqa: F401  注册 html
import parsers.json      # noqa: F401  注册 json

# 常见的 feed 路径，按顺序试（前几个最常用）
FEED_PATHS = (
    "/feed", "/feed/", "/rss", "/rss.xml", "/atom.xml", "/feed.xml",
    "/index.xml", "/feed/atom", "/rss/atom", "/?feed=rss2", "/feed/rss",
)

JSON_PATHS = ("/feed.json", "/json", "/api/feed")

RSS_TYPES = ("application/rss+xml", "application/atom+xml", "text/xml", "application/xml")
JSON_TYPES = ("application/feed+json", "application/json")


def _looks_like_feed(body: bytes, type_name: str) -> list[RawItem]:
    """真解析一遍，能出条目才算数。"""
    try:
        if type_name == "rss":
            doc = parse_rss(body, "", {})
            return doc.items
        doc = parse(type_name, body, "", {})
        return doc.items
    except Exception:
        return []


def detect(url: str) -> dict:
    """返回 {'ok':bool, 'type':..., 'parser_config':..., 'attempts':[...], 'preview':[...]}"""
    attempts: list[dict] = []

    resp = fetch(url)
    if not resp.ok:
        return {
            "ok": False,
            "reason": f"打不开这个地址：{resp.error_message}",
            "attempts": attempts,
        }

    base = resp.final_url or url
    parts = urlsplit(base)
    root = f"{parts.scheme}://{parts.netloc}"

    # ---- 0. 这个地址本身是不是 feed？（用户直接粘贴 feed 链接是最常见的情况）----
    for type_name in ("rss", "json"):
        items = _looks_like_feed(resp.body, type_name)
        if items:
            attempts.append({
                "step": "直接解析该地址", "url": base,
                "result": f"解析出 {len(items)} 条",
            })
            return _ok(type_name, {"version": 1}, base, items, attempts,
                       "这个地址本身就是 feed")

    # ---- 1. RSS 自动发现 ----
    html_text = decode_html(resp.body)
    import re

    for m in re.finditer(
        r"<link[^>]+rel=[\"']alternate[\"'][^>]*>", html_text, re.I
    ):
        tag = m.group(0)
        href = re.search(r"href=[\"']([^\"']+)[\"']", tag)
        ttype = re.search(r"type=[\"']([^\"']+)[\"']", tag)
        if not href:
            continue
        t = (ttype.group(1) if ttype else "").lower()
        feed_url = absolutize(href.group(1), base)
        if t in RSS_TYPES or "rss" in t or "atom" in t:
            attempts.append({"step": "RSS 自动发现", "url": feed_url, "result": "尝试中"})
            fr = fetch(feed_url)
            if fr.ok:
                items = _looks_like_feed(fr.body, "rss")
                attempts[-1]["result"] = f"HTTP {fr.status}，解析出 {len(items)} 条"
                if items:
                    return _ok("rss", {"version": 1}, feed_url, items, attempts,
                               "页面里声明的 feed 地址")
            else:
                attempts[-1]["result"] = f"失败：{fr.error_message}"
        elif t in JSON_TYPES or "json" in t:
            attempts.append({"step": "JSON Feed 自动发现", "url": feed_url, "result": "尝试中"})
            fr = fetch(feed_url)
            if fr.ok:
                items = _looks_like_feed(fr.body, "json")
                attempts[-1]["result"] = f"HTTP {fr.status}，解析出 {len(items)} 条"
                if items:
                    return _ok("json", {"version": 1, "items_path": "$.items"},
                               feed_url, items, attempts, "页面里声明的 JSON Feed")
            else:
                attempts[-1]["result"] = f"失败：{fr.error_message}"

    # ---- 2. 常见 feed 路径 ----
    for p in FEED_PATHS:
        cand = urljoin(root + "/", p.lstrip("/"))
        fr = fetch(cand)
        if not fr.ok:
            attempts.append({"step": "常见 feed 路径", "url": cand,
                             "result": f"HTTP {fr.status} 跳过"})
            continue
        items = _looks_like_feed(fr.body, "rss")
        attempts.append({"step": "常见 feed 路径", "url": cand,
                         "result": f"HTTP {fr.status}，解析出 {len(items)} 条"})
        if items:
            return _ok("rss", {"version": 1}, cand, items, attempts, f"试到了 {p}")

    # ---- 3. JSON Feed 路径 ----
    for p in JSON_PATHS:
        cand = urljoin(root + "/", p.lstrip("/"))
        fr = fetch(cand)
        if not fr.ok:
            continue
        items = _looks_like_feed(fr.body, "json")
        attempts.append({"step": "JSON Feed 路径", "url": cand,
                         "result": f"HTTP {fr.status}，解析出 {len(items)} 条"})
        if items:
            return _ok("json", {"version": 1, "items_path": "$.items"}, cand, items,
                       attempts, f"试到了 {p}")

    # ---- 4. 自动正文提取 ----
    attempts.append({"step": "自动正文提取", "url": base, "result": "分析页面结构…"})
    sug = auto_extract.suggest_config(resp.body, base)
    if sug.get("ok"):
        attempts[-1]["result"] = (
            f"匹配 {sug['match_count']} 个元素，抽出 {sug['extracted_count']} 条"
            f"（带日期比例 {sug['date_ratio']}）"
        )
        return {
            "ok": True,
            "type": "html",
            "url": base,
            "parser_config": sug["parser_config"],
            "confidence": sug["confidence"],
            "preview": sug["preview"],
            "attempts": attempts,
            "note": "这个站点没有 feed，已自动生成 CSS 规则，请确认后使用",
        }
    attempts[-1]["result"] = f"失败：{sug.get('reason')}"
    return {
        "ok": False,
        "reason": sug.get("reason", "所有自动方式都失败了"),
        "attempts": attempts,
    }


def _ok(type_name, config, url, items, attempts, note) -> dict:
    for it in items:
        pass
    return {
        "ok": True,
        "type": type_name,
        "url": url,
        "parser_config": config,
        "confidence": "high",
        "preview": items[:5],
        "attempts": attempts,
        "note": note,
    }
