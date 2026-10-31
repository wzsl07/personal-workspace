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
    etag: str | None = ...,
    last_modified: str | None = ...,
) -> None:
    """一次抓取结束后更新来源的健康字段（退避 / 降频 / 隔离都在这里落地）。

    etag / last_modified 用 `...` 作默认值表示"调用方没传，保持原值"；
    传 None 表示"这一轮确实没有，清掉"。
    """
    from core import health as H

    src = get_source(conn, source_id)
    if not src:
        return
    now = now_iso()

    if ok:
        fail_streak = 0
        idle_streak = 0 if new_count else src.idle_streak + 1
        interval = next_interval or H.next_interval_on_success(
            configured=src.interval_sec, idle_streak=idle_streak, new_count=new_count
        )
        last_error = None
    else:
        fail_streak = src.fail_streak + 1
        idle_streak = src.idle_streak          # 失败不算"无新条目"，否则坏源会被一路降频
        interval = next_interval or H.next_interval_on_failure(fail_streak)
        last_error = error_message

    isolate = H.should_isolate(fail_streak)
    enabled = 0 if isolate else 1
    health = H.health_of(
        ok=ok, fail_streak=fail_streak, idle_streak=idle_streak, enabled=bool(enabled)
    )
    if isolate:
        last_error = (last_error or "") + f"（连续失败 {fail_streak} 次，已自动暂停）"

    new_etag = src.etag if etag is ... else etag
    new_lm = src.last_modified if last_modified is ... else last_modified

    next_due = compute_next_due(interval, datetime.now(LOCAL_TZ))
    conn.execute(
        """UPDATE sources SET last_fetched_at=?, last_success_at=?, last_error=?,
           health_status=?, fail_streak=?, idle_streak=?, next_due_at=?, updated_at=?,
           enabled=?, etag=?, last_modified=?
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
            enabled,
            new_etag,
            new_lm,
            source_id,
        ),
    )
    conn.commit()


def reset_health(conn: sqlite3.Connection, source_id: int) -> None:
    """手动重试：清零失败计数、解除隔离，并让它立刻到期。

    这是"隔离必须可逆"的那一半 —— 自动停掉很容易，能一键救回来才不会逼用户删了重加。
    """
    conn.execute(
        """UPDATE sources
           SET fail_streak=0, idle_streak=0, health_status='unknown',
               enabled=1, last_error=NULL, next_due_at=?, updated_at=?
           WHERE id=?""",
        (now_iso(), now_iso(), source_id),
    )
    conn.commit()
