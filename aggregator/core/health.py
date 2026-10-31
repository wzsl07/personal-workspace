"""来源健康策略：失败退避、自适应降频、连续失败隔离。

放在单独文件里的原因：这些都是"给定状态，算出下一步该怎么做"的纯函数，
不碰数据库。这样能单独测试，不至于为了验证退避逻辑去跑一晚上调度器。

三条规则的动机：

**1. 失败指数退避（1m → 5m → 15m → 1h → 4h）**
站点挂了的时候，你越勤快地重试，越像在攻击它；而它恢复得越慢。
退避既是对对方客气，也是省自己的网络。抖动是必须的 —— 否则多个坏源
会在同一秒一起重试。

**2. 自适应降频（连续无新条目 → 间隔 ×1.5，上限 24h）**
有些站一周才更新一次，却配了 15 分钟抓一次。一年下来几千次请求全是浪费。
连续 3 次没新东西就开始降频；一旦有新条目，立刻回到设定值。
注意：**抓取失败不算"无新条目"**，否则坏源会被一路降到 24h，
等它修好了你也要等一天才发现。

**3. 连续失败 5 次自动隔离（禁用）**
一直失败的来源会持续占用并发名额、写垃圾日志，还会让你误以为"模块坏了"。
到 5 次就停掉，界面显示红点，等你手动处理 —— 手动重试会清零计数。

隔离为什么是"自动"的：如果只降频不隔离，一个挂掉的源会永远留在轮询里。
而隔离必须是**可逆**的：手动点一次「重试」就清零，不需要删掉重加。
"""

from __future__ import annotations

import random

#: 失败退避阶梯（秒）。用满之后停留在最后一档。
BACKOFF_LADDER = (60, 300, 900, 3600, 14400)   # 1m → 5m → 15m → 1h → 4h

#: 连续失败多少次后自动隔离
ISOLATE_AFTER = 5

#: 连续多少次"抓成功但没新条目"后开始降频
IDLE_BEFORE_SLOWDOWN = 3

#: 降频系数与上限
SLOWDOWN_FACTOR = 1.5
MAX_INTERVAL_SEC = 24 * 3600    # 24 小时
MIN_INTERVAL_SEC = 300          # 5 分钟（硬下限，需求里定的）

JITTER = 0.1


def with_jitter(seconds: float) -> float:
    """加 ±10% 抖动。多源同时重试会撞在一起，抖动是唯一简单的解法。"""
    return seconds * (1 + random.uniform(-JITTER, JITTER))


def backoff_seconds(fail_streak: int) -> int:
    """连续失败 n 次后该等多久。"""
    if fail_streak <= 0:
        return 0
    idx = min(fail_streak - 1, len(BACKOFF_LADDER) - 1)
    return BACKOFF_LADDER[idx]


def next_interval_on_success(*, configured: int, idle_streak: int, new_count: int) -> int:
    """抓取成功后的下一次间隔（秒）。

    有新条目 → 回到设定值；连续空跑 → 逐步降频（上限 24h）。
    """
    if new_count > 0:
        return configured
    if idle_streak < IDLE_BEFORE_SLOWDOWN:
        return configured
    steps = idle_streak - IDLE_BEFORE_SLOWDOWN + 1
    grown = configured * (SLOWDOWN_FACTOR ** steps)
    return int(min(MAX_INTERVAL_SEC, max(MIN_INTERVAL_SEC, grown)))


def next_interval_on_failure(fail_streak: int) -> int:
    """抓取失败后的下一次间隔（秒）：按退避阶梯。"""
    return backoff_seconds(fail_streak)


def should_isolate(fail_streak: int) -> bool:
    return fail_streak >= ISOLATE_AFTER


def health_of(*, ok: bool, fail_streak: int, idle_streak: int, enabled: bool = True) -> str:
    """算健康状态灯。四个值：ok / degraded / failing / disabled。"""
    if not enabled:
        return "disabled"
    if not ok:
        return "failing" if fail_streak >= 3 else "degraded"
    # 成功，但刚从失败里恢复 —— 观察一轮再回到 ok
    if 0 < fail_streak < ISOLATE_AFTER:
        return "degraded"
    # 成功但连续空跑（被降频了）—— 不是故障，只是慢
    if idle_streak >= IDLE_BEFORE_SLOWDOWN:
        return "degraded"
    return "ok"


def describe(health: str, *, fail_streak: int = 0, idle_streak: int = 0) -> str:
    """给界面用的一句话说明。说人话，不要只给一个状态字。"""
    if health == "disabled":
        if fail_streak >= ISOLATE_AFTER:
            return (f"连续失败 {fail_streak} 次，已自动暂停。"
                    "确认网址没填错后点「重试」，失败计数会清零")
        return "已暂停"
    if health == "failing":
        return f"连续失败 {fail_streak} 次，退避中（再失败 {max(0, ISOLATE_AFTER - fail_streak)} 次会自动暂停）"
    if health == "degraded":
        if idle_streak >= IDLE_BEFORE_SLOWDOWN:
            return f"连续 {idle_streak} 次没有新内容，已自动降低抓取频率"
        return "刚从失败中恢复，观察中"
    if health == "ok":
        return "正常"
    return "尚未抓取"
