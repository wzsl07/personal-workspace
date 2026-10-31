"""来源（sources 表）的增删改查。

这一层只管"怎么存"，不管"什么时候抓" —— 调度是 Step 2 的事。
"""

from __future__ import annotations

import json
import random
import sqlite3
from datetime import datetime, timedelta, timezone

from core.models import Source

LOCAL_TZ = timezone(timedelta(hours=8))

JITTER = 0.1   # ±10% 抖动


def now_iso() -> str:
    return datetime.now(LOCAL_TZ).isoformat()


def compute_next_due(interval_sec: int, now: datetime | None = None) -> str:
    """算下一次到期时间（含 ±10% 抖动）。

    抖动必须在这里统一算。曾经在调度器里算了一次（带抖动），
    任务完成后这里又用不带抖动的值覆盖，结果抖动完全失效、
    所有来源整齐地每 300 秒一起发请求 —— 正是抖动要避免的情况。
    """
    jitter = 1 + random.uniform(-JITTER, JITTER)
    base = now or datetime.now(LOCAL_TZ)
    return (base + timedelta(seconds=interval_sec * jitter)).isoformat()


def _row_to_source(r: sqlite3.Row) -> Source:
    return Source(
        id=r["id"],
        name=r["name"],
        type=r["type"],
        url=r["url"],
        enabled=bool(r["enabled"]),
        interval_sec=r["interval_sec"],
        parser_config=json.loads(r["parser_config"] or "{}"),
        auth_config=json.loads(r["auth_config"]) if r["auth_config"] else None,
        fetch_policy=json.loads(r["fetch_policy"] or "{}"),
        tags=r["tags"] or "",
        health_status=r["health_status"],
        fail_streak=r["fail_streak"],
        idle_streak=r["idle_streak"],
        last_fetched_at=r["last_fetched_at"],
        last_success_at=r["last_success_at"],
        last_error=r["last_error"],
        next_due_at=r["next_due_at"],
        etag=r["etag"],
        last_modified=r["last_modified"],
        created_at=r["created_at"],
        updated_at=r["updated_at"],
    )


def add_source(
    conn: sqlite3.Connection,
    *,
    name: str,
    type: str,
    url: str,
    interval_sec: int = 900,
    parser_config: dict | None = None,
    fetch_policy: dict | None = None,
    tags: str = "",
) -> int:
    """新增来源。最低间隔 300 秒（5 分钟）是硬限制，防止把别人站点抓崩。"""
    if interval_sec < 300:
        raise ValueError("抓取间隔不能小于 300 秒（5 分钟）")
    if type not in ("rss", "json", "html"):
        raise ValueError(f"来源类型必须是 rss / json / html，收到：{type}")

    now = now_iso()
    cur = conn.execute(
        """INSERT INTO sources
           (name, type, url, enabled, interval_sec, parser_config, fetch_policy,
            tags, health_status, created_at, updated_at, next_due_at)
           VALUES (?,?,?,1,?,?,?,?, 'unknown', ?,?,?)""",
        (
            name,
            type,
            url,
            interval_sec,
            json.dumps(parser_config or {"version": 1}, ensure_ascii=False),
            json.dumps(fetch_policy or {}, ensure_ascii=False),
            tags,
            now,
            now,
            now,   # 新增后立刻到期，第一次抓取马上执行
        ),
    )
    conn.commit()
    return int(cur.lastrowid)


def list_sources(conn: sqlite3.Connection) -> list[Source]:
    rows = conn.execute("SELECT * FROM sources ORDER BY id").fetchall()
    return [_row_to_source(r) for r in rows]


def get_source(conn: sqlite3.Connection, source_id: int) -> Source | None:
    r = conn.execute("SELECT * FROM sources WHERE id=?", (source_id,)).fetchone()
    return _row_to_source(r) if r else None


def update_source(conn: sqlite3.Connection, source_id: int, **fields) -> None:
    """改任意字段。parser_config / fetch_policy 传 dict，这里负责 JSON 化。"""
    allowed = {
        "name", "url", "interval_sec", "parser_config", "fetch_policy",
        "tags", "enabled", "type",
    }
    bad = set(fields) - allowed
    if bad:
        raise ValueError(f"不能改这些字段：{bad}")

    if "interval_sec" in fields and fields["interval_sec"] < 300:
        raise ValueError("抓取间隔不能小于 300 秒（5 分钟）")

    sets, values = [], []
    for k, v in fields.items():
        if k in ("parser_config", "fetch_policy") and isinstance(v, dict):
            v = json.dumps(v, ensure_ascii=False)
        if k == "enabled":
            v = 1 if v else 0
        sets.append(f"{k}=?")
        values.append(v)
    sets.append("updated_at=?")
    values.append(now_iso())
    values.append(source_id)
    conn.execute(f"UPDATE sources SET {','.join(sets)} WHERE id=?", values)
    conn.commit()


def set_enabled(conn: sqlite3.Connection, source_id: int, enabled: bool) -> None:
    """启停来源。停用时状态标 disabled，启用时回到 unknown 等下一次抓取确认。"""
    update_source(conn, source_id, enabled=enabled)
    conn.execute(
        "UPDATE sources SET health_status=? WHERE id=?",
        ("unknown" if enabled else "disabled", source_id),
    )
    conn.commit()


def delete_source(conn: sqlite3.Connection, source_id: int) -> None:
    """删除来源，它的条目会被外键级联删掉（需要 PRAGMA foreign_keys=ON）。"""
    conn.execute("DELETE FROM sources WHERE id=?", (source_id,))
    conn.commit()


def record_result(
    conn: sqlite3.Connection,
    source_id: int,
    *,
    ok: bool,
    error_message: str | None = None,
    new_count: int = 0,
    next_interval: int | None = None,
) -> None:
    """一次抓取结束后更新来源的健康字段（Step 2 的退避/降频会复用这里）。"""
    src = get_source(conn, source_id)
    if not src:
        return
    now = now_iso()
    interval = next_interval or src.interval_sec
    if ok:
        health = "ok"
        fail_streak = 0
        idle_streak = 0 if new_count else src.idle_streak + 1
        if src.fail_streak >= 3 and src.fail_streak < 5:
            health = "degraded"      # 刚从失败恢复，观察一下
        last_error = None
    else:
        fail_streak = src.fail_streak + 1
        health = "failing" if fail_streak >= 3 else "degraded"
        idle_streak = src.idle_streak
        last_error = error_message

    next_due = compute_next_due(interval, datetime.now(LOCAL_TZ))
    conn.execute(
        """UPDATE sources SET last_fetched_at=?, last_success_at=?, last_error=?,
           health_status=?, fail_streak=?, idle_streak=?, next_due_at=?, updated_at=?
           WHERE id=?""",
        (
            now,
            now if ok else src.last_success_at,
            last_error,
            health,
            fail_streak,
            idle_streak,
            next_due,
            now,
            source_id,
        ),
    )
    conn.commit()
