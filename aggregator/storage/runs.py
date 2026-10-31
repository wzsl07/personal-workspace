"""抓取日志（fetch_runs 表）。

每次抓取都写一条 —— 这是排查"为什么这个源没更新"的唯一依据，
所以哪怕失败也要写，而且要把失败原因记清楚。
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

LOCAL_TZ = timezone(timedelta(hours=8))


def now_iso() -> str:
    return datetime.now(LOCAL_TZ).isoformat()


def start_run(conn: sqlite3.Connection, source_id: int) -> int:
    cur = conn.execute(
        "INSERT INTO fetch_runs (source_id, started_at, status) VALUES (?,?, 'running')",
        (source_id, now_iso()),
    )
    conn.commit()
    return int(cur.lastrowid)


def finish_run(
    conn: sqlite3.Connection,
    run_id: int,
    *,
    status: str,               # ok | empty | error | not_modified
    http_status: int | None = None,
    duration_ms: int = 0,
    items_found: int = 0,
    items_new: int = 0,
    error_kind: str | None = None,
    error_message: str | None = None,
) -> None:
    conn.execute(
        """UPDATE fetch_runs SET finished_at=?, status=?, http_status=?, duration_ms=?,
           items_found=?, items_new=?, error_kind=?, error_message=? WHERE id=?""",
        (
            now_iso(), status, http_status, duration_ms,
            items_found, items_new, error_kind, error_message, run_id,
        ),
    )
    conn.commit()


def recent_runs(conn: sqlite3.Connection, source_id: int | None = None, limit: int = 10):
    sql = "SELECT * FROM fetch_runs"
    args: list = []
    if source_id:
        sql += " WHERE source_id=?"
        args.append(source_id)
    sql += " ORDER BY started_at DESC LIMIT ?"
    args.append(limit)
    return conn.execute(sql, args).fetchall()
