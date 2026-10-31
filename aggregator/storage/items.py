"""条目（items 表）的读写与保留策略。"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

from core.models import RawItem

LOCAL_TZ = timezone(timedelta(hours=8))

# 保留策略：默认按**每个栏目**分别限条数。
# 为什么不是整个来源一个上限：一个页面常有"通知公告 / 新闻动态 / 学术活动"好几个并列列表，
# 共用一个上限的话，更新频繁的栏目会把其它栏目的条目全挤掉 —— 用户看到的就是
# "我的学术活动怎么只剩两条了"。各分支各留一份才符合直觉。
MAX_ITEMS_PER_SECTION = 500    # 每个栏目各留这么多
MAX_ITEMS_PER_SOURCE = 5000    # 整个来源的安全上限，防止单源无限膨胀
MAX_AGE_DAYS = 0               # 0 = 不按时间清理（想开就在 fetch_policy 里配 max_age_days）


def save_new_items(
    conn: sqlite3.Connection,
    source_id: int,
    new_items: list[tuple[RawItem, str, str]],
) -> int:
    """写入新条目，返回**真正新增**的条数。

    幂等靠 UNIQUE(source_id, guid) 兜底，重复不会写进去。
    注意：不能用 cursor.rowcount 统计 —— executemany 之后它的值不可靠，
    曾经因此显示"新增 24"而实际只进了 15 条，把去重是否生效都搞错了。
    用插入前后的 COUNT 差值才是准的。
    """
    if not new_items:
        return 0
    before = conn.execute(
        "SELECT COUNT(*) c FROM items WHERE source_id=?", (source_id,)
    ).fetchone()["c"]
    now = datetime.now(LOCAL_TZ).isoformat()
    rows = []
    for it, uk, ch in new_items:
        rows.append(
            (
                source_id,
                it.guid,
                it.url,
                it.title,
                it.summary,
                it.author,
                it.published_at,
                now,
                uk,
                ch,
                it.raw,
                it.section or "",
            )
        )
    conn.executemany(
        """INSERT OR IGNORE INTO items
           (source_id, guid, url, title, summary, author, published_at,
            discovered_at, url_key, content_hash, raw, section)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        rows,
    )
    conn.commit()
    after = conn.execute(
        "SELECT COUNT(*) c FROM items WHERE source_id=?", (source_id,)
    ).fetchone()["c"]
    return max(0, after - before)


def list_items(
    conn: sqlite3.Connection,
    *,
    source_id: int | None = None,
    limit: int = 20,
    keyword: str | None = None,
    section: str | None = None,
    only_unread: bool = False,
    only_starred: bool = False,
) -> list[sqlite3.Row]:
    """按发现时间倒序列出条目（Step 4 的界面会用同样的查询）。"""
    sql = """
        SELECT i.*, s.name AS source_name,
               st.read_at, COALESCE(st.starred,0) AS starred
        FROM items i
        JOIN sources s ON s.id = i.source_id
        LEFT JOIN item_states st ON st.item_id = i.id
    """
    where, args = [], []
    if source_id:
        where.append("i.source_id = ?")
        args.append(source_id)
    if keyword:
        where.append("(i.title LIKE ? OR i.summary LIKE ?)")
        args += [f"%{keyword}%", f"%{keyword}%"]
    if section:
        where.append("i.section = ?")
        args.append(section)
    if only_unread:
        where.append("st.read_at IS NULL")
    if only_starred:
        where.append("COALESCE(st.starred, 0) = 1")
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY COALESCE(i.published_at, i.discovered_at) DESC LIMIT ?"
    args.append(limit)
    return conn.execute(sql, args).fetchall()


def get_item(conn: sqlite3.Connection, item_id: int) -> sqlite3.Row | None:
    """按 id 取一条条目（界面上点开某条时用）。"""
    r = conn.execute(
        """SELECT i.*, s.name AS source_name, s.fetch_policy AS fetch_policy
           FROM items i JOIN sources s ON s.id = i.source_id
           WHERE i.id = ?""",
        (item_id,),
    ).fetchone()
    return r


def count_items(conn: sqlite3.Connection, source_id: int | None = None) -> int:
    if source_id:
        return conn.execute(
            "SELECT COUNT(*) c FROM items WHERE source_id=?", (source_id,)
        ).fetchone()["c"]
    return conn.execute("SELECT COUNT(*) c FROM items").fetchone()["c"]


def prune(
    conn: sqlite3.Connection,
    source_id: int | None = None,
    *,
    per_section: int = MAX_ITEMS_PER_SECTION,
    per_source: int = MAX_ITEMS_PER_SOURCE,
    max_age_days: int = MAX_AGE_DAYS,
) -> int:
    """保留策略（分级）：

    1. 可选：超过 max_age_days 天的清掉（默认 0 = 不按时间清理，
       因为很多站点会长期挂着"学生手册""学位法"这类常青文档，按时间删会丢）；
    2. **每个栏目**各保留最新的 per_section 条；
    3. 整个来源再加一道 per_source 的安全上限。

    返回删掉的条数。
    """
    deleted = 0

    if max_age_days and max_age_days > 0:
        cutoff = (datetime.now(LOCAL_TZ) - timedelta(days=max_age_days)).isoformat()
        cur = conn.execute(
            "DELETE FROM items WHERE published_at IS NOT NULL AND published_at < ?", (cutoff,)
        )
        deleted += cur.rowcount or 0

    ids = [source_id] if source_id else [
        r["id"] for r in conn.execute("SELECT id FROM sources").fetchall()
    ]
    for sid in ids:
        # 按栏目分别限条数
        secs = [
            r["section"]
            for r in conn.execute(
                "SELECT DISTINCT section FROM items WHERE source_id=?", (sid,)
            ).fetchall()
        ]
        for sec in secs:
            cur = conn.execute(
                """DELETE FROM items WHERE source_id=? AND section=? AND id NOT IN (
                       SELECT id FROM items WHERE source_id=? AND section=?
                       ORDER BY COALESCE(published_at, discovered_at) DESC LIMIT ?
                   )""",
                (sid, sec, sid, sec, per_section),
            )
            deleted += cur.rowcount or 0

        # 整个来源的安全上限
        cur = conn.execute(
            """DELETE FROM items WHERE source_id=? AND id NOT IN (
                   SELECT id FROM items WHERE source_id=?
                   ORDER BY COALESCE(published_at, discovered_at) DESC LIMIT ?
               )""",
            (sid, sid, per_source),
        )
        deleted += cur.rowcount or 0

    conn.commit()
    return deleted


def set_state(
    conn: sqlite3.Connection,
    item_id: int,
    *,
    read: bool | None = None,
    starred: bool | None = None,
) -> None:
    """标记已读/未读、收藏/取消收藏。

    read=True 记当前时间，read=False 清掉（回到未读）。
    """
    now = datetime.now(LOCAL_TZ).isoformat()
    row = conn.execute(
        "SELECT read_at, starred FROM item_states WHERE item_id=?", (item_id,)
    ).fetchone()

    if row is None:
        conn.execute(
            "INSERT INTO item_states (item_id, read_at, starred, muted) VALUES (?,?,?,0)",
            (item_id, now if read else None, 1 if starred else 0),
        )
    else:
        new_read = row["read_at"]
        if read is True:
            new_read = now
        elif read is False:
            new_read = None
        new_star = row["starred"] if starred is None else (1 if starred else 0)
        conn.execute(
            "UPDATE item_states SET read_at=?, starred=? WHERE item_id=?",
            (new_read, new_star, item_id),
        )
    conn.commit()


def sections_of(conn: sqlite3.Connection, source_id: int) -> list[tuple[str, int]]:
    """列出一个来源下的栏目及条数（界面做分类筛选要用）。"""
    rows = conn.execute(
        """SELECT section, COUNT(*) c FROM items WHERE source_id=?
           GROUP BY section ORDER BY c DESC""",
        (source_id,),
    ).fetchall()
    return [(r["section"], r["c"]) for r in rows]
