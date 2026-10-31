"""解析器注册表（可插拔点 ②）。

新增一种来源类型 = 在这里注册一个解析函数，主流程"取 → 解析 → 归一化 → 去重 → 存储"
一行都不用改。不做动态插件加载，就是个普通字典 —— 单机自用工具，够用且好查。
"""

from __future__ import annotations

from typing import Callable, Protocol

from core.models import ParsedFeed


class ParserFn(Protocol):
    def __call__(self, body: bytes, base_url: str, config: dict) -> ParsedFeed: ...


PARSERS: dict[str, ParserFn] = {}


def register(type_name: str, fn: ParserFn) -> None:
    PARSERS[type_name] = fn


def get(type_name: str) -> ParserFn:
    try:
        return PARSERS[type_name]
    except KeyError:
        raise KeyError(f"没有注册类型为 {type_name} 的解析器，已注册：{list(PARSERS)}") from None


def parse(type_name: str, body: bytes, base_url: str, config: dict | None = None) -> ParsedFeed:
    return get(type_name)(body, base_url, config or {})
