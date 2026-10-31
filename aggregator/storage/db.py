"""SQLite 连接与建表。

为什么用 SQLite：单机自用、零配置、单文件，备份就是复制一个文件。
放在 aggregator/data/ 下，已经在 .gitignore 里排除 —— 你的订阅列表和抓来的内容
不会进公开仓库。
"""

from __future__ import annotations

import os
import sqlite3

# 数据目录：aggregator/data/aggregator.db
DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
DB_PATH = os.path.join(DATA_DIR, "aggregator.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                  -- rss | json | html
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  interval_sec INTEGER NOT NULL DEFAULT 900,
  parser_config TEXT NOT NULL DEFAULT '{}',   -- JSON，按 type 不同 schema，必须带 version
  auth_config TEXT,                    -- 含 token 的配置，加密存储（Step 5 实现加密）
  fetch_policy TEXT NOT NULL DEFAULT '{}',    -- timeout/max_items/user_agent 等
  tags TEXT NOT NULL DEFAULT '',
  health_status TEXT NOT NULL DEFAULT 'unknown',  -- ok|degraded|failing|disabled
  fail_streak INTEGER NOT NULL DEFAULT 0,
  idle_streak INTEGER NOT NULL DEFAULT 0,
  last_fetched_at TEXT, last_success_at TEXT, last_error TEXT, next_due_at TEXT,
  etag TEXT, last_modified TEXT,
  created_at TEXT, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  guid TEXT NOT NULL, url TEXT, title TEXT, summary TEXT, author TEXT,
  published_at TEXT, discovered_at TEXT NOT NULL,
  url_key TEXT NOT NULL,        -- 归一化 URL（去 utm_*、去 #、host 小写）
  content_hash TEXT NOT NULL,   -- 标题+摘要指纹，兜底去重
  raw TEXT,
  section TEXT NOT NULL DEFAULT '',   -- 网页自身的栏目分类（通知公告 / 新闻动态 …）
  content TEXT,                 -- 正文（抓取/解析得到，可能为空）
  content_at TEXT,              -- 正文入库时间
  content_state TEXT NOT NULL DEFAULT ''   -- '' 未尝试 / ok / fail / skip
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_guid ON items(source_id, guid);
CREATE INDEX IF NOT EXISTS idx_items_time ON items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_url_key ON items(source_id, url_key);
CREATE INDEX IF NOT EXISTS idx_items_hash ON items(source_id, content_hash);

CREATE TABLE IF NOT EXISTS fetch_runs (
  id INTEGER PRIMARY KEY, source_id INTEGER, started_at TEXT, finished_at TEXT,
  status TEXT, http_status INTEGER, duration_ms INTEGER,
  items_found INTEGER, items_new INTEGER, error_kind TEXT, error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_source ON fetch_runs(source_id, started_at DESC);

CREATE TABLE IF NOT EXISTS item_states (
  item_id INTEGER PRIMARY KEY, read_at TEXT, starred INTEGER DEFAULT 0, muted INTEGER DEFAULT 0
);
"""


def connect(db_path: str | None = None) -> sqlite3.Connection:
    """打开数据库。

    几个 PRAGMA 都是必需的：
    - foreign_keys：默认关闭，不开的话 ON DELETE CASCADE 不起作用
    - WAL：Step 2 的调度器会和界面同时读写，WAL 能避免"数据库被锁"
    - busy_timeout：并发时等一会儿而不是立刻报错

    库路径可用环境变量 AGG_DB 覆盖（测试或临时另开一份时用）。
    """
    path = db_path or os.environ.get("AGG_DB") or DB_PATH
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    _migrate(conn)
    conn.commit()


def _migrate(conn: sqlite3.Connection) -> None:
    """给已经建好的库补新列。

    CREATE TABLE IF NOT EXISTS 不会管已有表的结构变化，
    所以后来加的字段（比如 items.section）必须单独 ALTER，否则老库会直接报
    "no such column"。这一步做成幂等的，反复跑不会出问题。
    """
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(items)")}
    if cols and "section" not in cols:
        conn.execute("ALTER TABLE items ADD COLUMN section TEXT NOT NULL DEFAULT ''")
    if cols:
        # 索引必须等列真的存在之后才能建 —— 放在 SCHEMA 里会在老库上直接报错
        conn.execute("CREATE INDEX IF NOT EXISTS idx_items_section ON items(source_id, section)")

    # 正文（content）三件套：给搜索用。老库没有这些列，逐个补。
    # content_state 用 '' 表示"还没试过"，这样补抓脚本能区分"没抓"和"抓过但失败"。
    if cols:
        if "content" not in cols:
            conn.execute("ALTER TABLE items ADD COLUMN content TEXT")
        if "content_at" not in cols:
            conn.execute("ALTER TABLE items ADD COLUMN content_at TEXT")
        if "content_state" not in cols:
            conn.execute("ALTER TABLE items ADD COLUMN content_state TEXT NOT NULL DEFAULT ''")

    # 来源上的「抓正文」开关（fetch_content）。0/1，NULL 当 0。
    scols = {r["name"] for r in conn.execute("PRAGMA table_info(sources)")}
    if scols and "fetch_content" not in scols:
        conn.execute("ALTER TABLE sources ADD COLUMN fetch_content INTEGER NOT NULL DEFAULT 0")
