"""主流程：取 → 解析 → 归一化 → 去重 → 存储。

**这个文件是全模块最重要的一处约定**：类型差异只允许出现在
adapters（怎么取）与 parsers（怎么解析）两个注册表里。
将来新增来源类型（比如 Step 3 的 html、以后的邮件列表、API），
只要注册一对 adapter + parser，这里一行都不用改。
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

from adapters.http_fetch import fetch
from normalizers.text import make_summary, strip_html
from parsers.base import parse
from storage import items as items_store
from storage import runs as runs_store
from storage import sources as sources_store
from storage.dedup import classify

LOCAL_TZ = timezone(timedelta(hours=8))

import parsers  # noqa: F401  注册所有解析器（rss / json / html）


def normalize(item) -> None:
    """归一化：清洗标题摘要、补全链接、确保 guid 存在。"""
    item.title = strip_html(item.title or "").strip() or "(无标题)"
    item.summary = make_summary(strip_html(item.summary or ""))
    if not item.guid:
        item.guid = item.url or item.title


def run_source_once(conn: sqlite3.Connection, source, *, verbose: bool = False) -> dict:
    """抓取一个来源并把新条目入库。返回结果字典，供 CLI / 界面 / 调度器共用。"""
    run_id = runs_store.start_run(conn, source.id)
    result = {
        "source_id": source.id,
        "name": source.name,
        "status": "error",
        "http_status": None,
        "found": 0,
        "new": 0,
        "dup": 0,
        "duration_ms": 0,
        "error": None,
    }

    try:
        resp = fetch(source.url)
        result["http_status"] = resp.status
        result["duration_ms"] = resp.duration_ms

        if not resp.ok:
            result["error"] = resp.error_message or f"HTTP {resp.status}"
            runs_store.finish_run(
                conn, run_id, status="error", http_status=resp.status,
                duration_ms=resp.duration_ms,
                error_kind=resp.error_kind or "network",
                error_message=result["error"],
            )
            sources_store.record_result(conn, source.id, ok=False, error_message=result["error"])
            return result

        parsed = parse(source.type, resp.body, resp.final_url or source.url, source.parser_config)
        for it in parsed.items:
            normalize(it)

        # 只有明确配了 max_age_days 才按时间过滤：默认不按时间删，
        # 但一旦开了，就要在入库前过滤 —— 否则"插进去又被 prune 删掉"，
        # 每轮白写库，还让"新增 N 条"变成一个骗人的数字。
        max_age = int((source.fetch_policy or {}).get("max_age_days") or 0)
        fresh, old_skipped = parsed.items, 0
        if max_age > 0:
            cutoff = (datetime.now(LOCAL_TZ) - timedelta(days=max_age)).isoformat()
            fresh, old_skipped = [], 0
            for it in parsed.items:
                if it.published_at and it.published_at < cutoff:
                    old_skipped += 1
                    continue
                fresh.append(it)
            parsed.items = fresh
        result["old_skipped"] = old_skipped

        new_items, dup_items = classify(conn, source.id, fresh)
        written = items_store.save_new_items(conn, source.id, new_items)
        policy = source.fetch_policy or {}
        items_store.prune(
            conn,
            source.id,
            per_section=int(policy.get("max_items_per_section") or items_store.MAX_ITEMS_PER_SECTION),
            per_source=int(policy.get("max_items") or items_store.MAX_ITEMS_PER_SOURCE),
            max_age_days=max_age,
        )
        result["sections"] = sorted({it.section for it in fresh if it.section})

        result["found"] = len(parsed.items)
        result["new"] = written
        result["dup"] = len(dup_items)
        result["status"] = "ok" if written else "empty"
        result["feed_title"] = parsed.feed_title
        result["warnings"] = parsed.warnings

        runs_store.finish_run(
            conn, run_id,
            status=result["status"],
            http_status=resp.status,
            duration_ms=resp.duration_ms,
            items_found=len(parsed.items),
            items_new=written,
            error_message="; ".join(parsed.warnings) or None,
        )
        sources_store.record_result(conn, source.id, ok=True, new_count=written)

        if verbose:
            extra = f"，跳过 {result['old_skipped']} 条过期" if result.get("old_skipped") else ""
            print(f"  [{source.name}] 抓到 {result['found']} 条，新增 {written}，"
                  f"重复 {len(dup_items)}{extra}")
        return result

    except Exception as e:  # 解析器等抛出的意外错误，也要记账，不能静默
        msg = f"{type(e).__name__}: {e}"
        result["error"] = msg
        runs_store.finish_run(
            conn, run_id, status="error", duration_ms=result["duration_ms"],
            error_kind="exception", error_message=msg,
        )
        sources_store.record_result(conn, source.id, ok=False, error_message=msg)
        return result
