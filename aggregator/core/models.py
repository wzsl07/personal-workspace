"""贯穿各层的轻量数据结构。

主流程固定为：取 → 解析 → 归一化 → 去重 → 存储。
类型差异只出现在 Adapter 与 Parser 两个注册表里，所以这两层之间传递的
中间产物必须统一，这里就是那个"统一形状"。
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class RawItem:
    """解析完成、尚未入库的单条条目。"""

    guid: str          # 来源内唯一标识（没有就用链接兜底）
    url: str           # 归一化后的绝对链接
    title: str
    summary: str = ""
    author: str = ""
    published_at: str | None = None   # ISO 8601，统一带时区
    raw: str = field(default="", repr=False)   # 原始片段，调试用
    # 所属栏目（按网页自身的分类来）。一个页面常常有好几个并列列表
    # （通知公告 / 新闻动态 / 学术活动…），界面上要能按它筛选，
    # 保留策略也要按各分支分别限条数，否则大列表会挤掉其它栏目的条目。
    section: str = ""


@dataclass
class ParsedFeed:
    """一个来源解析后的结果。"""

    feed_title: str = ""
    site_url: str = ""
    items: list[RawItem] = field(default_factory=list)
    """解析器给的提示（比如"这个 feed 有点不规范但还能读"），会写进抓取日志"""
    warnings: list[str] = field(default_factory=list)


@dataclass
class Source:
    """sources 表的一行。"""

    id: int
    name: str
    type: str                      # rss | json | html
    url: str
    enabled: bool = True
    interval_sec: int = 900
    parser_config: dict = field(default_factory=dict)
    auth_config: dict | None = None
    fetch_policy: dict = field(default_factory=dict)
    tags: str = ""
    health_status: str = "unknown"   # ok | degraded | failing | disabled
    fail_streak: int = 0
    idle_streak: int = 0
    last_fetched_at: str | None = None
    last_success_at: str | None = None
    last_error: str | None = None
    next_due_at: str | None = None
    etag: str | None = None
    last_modified: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
