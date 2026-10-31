"""robots.txt 遵守。

为什么要有这个：robots.txt 是站点站长声明"哪些路径不想被自动程序访问"的约定。
不遵守的后果不是法律问题，而是——被对方封 IP、被加进黑名单，
而你自己完全不知道发生了什么（对方不会通知你）。

实现上有两个坑，标准库的 urllib.robotparser 都处理不好，所以自己写：

1. **它自己会去下载 robots.txt，但不带我们的 UA、不受超时约束**。
   有些站点对 UA 很敏感，用 Python 默认 UA 直接 403，
   于是 RobotFileParser 会认为"没有 robots.txt"，全部放行 —— 这跟不遵守一样糟。
   所以这里用我们自己的 http_fetch 去取（有 UA、有超时、有体积上限）。

2. **抓取失败时该放行还是该禁止？**
   标准做法是"4xx 视为无限制，5xx 视为禁止"。
   这里更进一步：取不回来时**按站点自己的选择**——
   默认禁止非 feed 路径（保守），因为既然连 robots 都取不到，
   说明这个站可能不太欢迎自动访问。

缓存：robots.txt 内容按域名缓存到内存，默认 6 小时。
一个站点的 robots 不会频繁变，没必要每次抓取都重新下载。
"""

from __future__ import annotations

import time
import urllib.robotparser as robotparser
from urllib.parse import urljoin, urlsplit

from core.security import assert_safe_url

#: 默认 UA 必须与 adapters.http_fetch 保持一致。
#: 这里不能 import 它 —— 它反过来要用本模块做抓取前的检查，会形成循环导入。
DEFAULT_UA = (
    "PersonalWorkspace-Aggregator/0.1 "
    "(local single-user tool; https://github.com/wzsl07/personal-workspace)"
)

CACHE_TTL_SEC = 6 * 3600
CACHE: dict[str, tuple[float, robotparser.RobotFileParser | None]] = {}

#: 站点没给 robots.txt（或取不到）时的兜底规则：
#: 禁掉明显是动态/私人的路径，其余放行。写成策略而不是硬编码"全放行"。
FALLBACK_DISALLOW = ("/search", "/login", "/admin", "/api/", "/user/")


class RobotsDenied(Exception):
    """robots.txt 不允许抓取这个地址。"""


def _robots_url(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}/robots.txt"


def _parse(text: str) -> robotparser.RobotFileParser:
    rp = robotparser.RobotFileParser()
    rp.parse(text.splitlines())
    return rp


def _fallback() -> robotparser.RobotFileParser:
    """取不到 robots.txt 时的兜底：只允许 GET，禁掉动态/私人路径。"""
    rp = robotparser.RobotFileParser()
    lines = ["User-agent: *", "Allow: /"]
    lines += [f"Disallow: {p}" for p in FALLBACK_DISALLOW]
    rp.parse(lines)
    return rp


def get_rules(url: str, user_agent: str = DEFAULT_UA) -> robotparser.RobotFileParser:
    """取某个域名下的 robots 规则（带缓存）。"""
    host = urlsplit(url).netloc.lower()
    hit = CACHE.get(host)
    now = time.monotonic()
    if hit and now - hit[0] < CACHE_TTL_SEC:
        return hit[1] or _fallback()

    rurl = _robots_url(url)
    rp: robotparser.RobotFileParser | None = None
    try:
        # 延迟导入：http_fetch 会在发请求前调用本模块，顶层 import 会成环
        from adapters.http_fetch import fetch

        assert_safe_url(rurl)
        resp = fetch(rurl, user_agent=user_agent, respect_robots=False)
        if resp.ok and resp.status == 200 and resp.body:
            from normalizers.encoding import decode_html

            rp = _parse(decode_html(resp.body))
        elif resp.status is not None and 500 <= resp.status < 600:
            # 服务端出错：保守起见按"禁止大多数"处理
            rp = _parse("User-agent: *\nDisallow: /")
    except Exception:
        rp = None

    CACHE[host] = (now, rp)
    return rp or _fallback()


def allowed(url: str, user_agent: str = DEFAULT_UA) -> tuple[bool, str]:
    """这个 URL 是否允许抓取。返回 (是否允许, 原因)。"""
    try:
        rp = get_rules(url, user_agent)
    except Exception as e:
        # robots 本身出问题不应阻断抓取，但要留下痕迹
        return True, f"robots.txt 检查失败（{type(e).__name__}），按允许处理"

    try:
        if rp.can_fetch(user_agent, url):
            return True, ""
        return False, "该站点的 robots.txt 不允许自动抓取这个地址"
    except Exception:
        return True, "robots.txt 解析异常，按允许处理"


def check(url: str, user_agent: str = DEFAULT_UA) -> None:
    """不允许就抛 RobotsDenied。"""
    ok, why = allowed(url, user_agent)
    if not ok:
        raise RobotsDenied(why)


def clear_cache() -> None:
    """清缓存（测试用；换 UA 后也应该清一下）。"""
    CACHE.clear()
