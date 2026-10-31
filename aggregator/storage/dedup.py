"""三级判重：guid → url_key → content_hash。

为什么需要三级：
- guid 最可靠，但有些站点的 guid 是随机生成的，每次抓都不一样；
- url_key 次之（已去掉 utm_* 之类跟踪参数），能挡住"同一篇被推了两次"；
- content_hash 兜底：连链接都变了、但标题摘要一模一样时（比如站点换域名批量重发），
  靠内容指纹挡住。

判重是"信息聚合"类工具的核心体验 —— 重复条目一多，这个工具就没法用了。
"""

from __future__ import annotations

import hashlib
import re

from core.models import RawItem
from normalizers.text import one_line
from normalizers.url import url_key as normalize_url_key

_WS = re.compile(r"\s+")


def content_hash(item: RawItem) -> str:
    """标题 + 摘要的内容指纹。先压空白再算，避免换行差异导致误判。"""
    basis = f"{one_line(item.title)}|{one_line(item.summary)}".strip().lower()
    return hashlib.sha1(basis.encode("utf-8")).hexdigest()


def enrich(item: RawItem) -> tuple[str, str]:
    """补齐 url_key 与 content_hash，返回 (url_key, hash)。"""
    return normalize_url_key(item.url), content_hash(item)


def classify(
    conn,
    source_id: int,
    items: list[RawItem],
) -> tuple[list[tuple[RawItem, str, str]], list[RawItem]]:
    """把条目分成"新的"和"重复的"两类。

    返回 (新的[(item, url_key, hash)], 重复的[item])
    """
    new_items: list[tuple[RawItem, str, str]] = []
    dup_items: list[RawItem] = []

    # 一次把该来源已有的三种键全捞出来，避免逐条查库（几千条时会很慢）
    rows = conn.execute(
        "SELECT guid, url_key, content_hash FROM items WHERE source_id=?", (source_id,)
    ).fetchall()
    seen_guid = {r["guid"] for r in rows}
    seen_url = {r["url_key"] for r in rows if r["url_key"]}
    seen_hash = {r["content_hash"] for r in rows}

    # 本批次内部也要去重：有些 feed 自己就带重复条目
    batch_guid: set[str] = set()
    batch_url: set[str] = set()
    batch_hash: set[str] = set()

    for it in items:
        uk, ch = enrich(it)
        if not it.guid:
            it.guid = uk or ch

        if it.guid in batch_guid or (uk and uk in batch_url) or ch in batch_hash:
            dup_items.append(it)
            continue
        if it.guid in seen_guid or (uk and uk in seen_url) or ch in seen_hash:
            dup_items.append(it)
            continue

        batch_guid.add(it.guid)
        if uk:
            batch_url.add(uk)
        batch_hash.add(ch)
        new_items.append((it, uk, ch))

    return new_items, dup_items
