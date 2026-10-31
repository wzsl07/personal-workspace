"""解析器注册入口。

新增一种来源类型时，在这里加一行 import 即可 —— 其余地方（主流程、界面、探测）
都不用改。之前漏了 html/json，就是因为注册散落在各个调用点，加新类型很容易忘。
"""

from parsers import html_css, json as json_parser, rss  # noqa: F401

__all__ = ["rss", "json_parser", "html_css"]
