"""统一发请求的地方（接入层底座）。

所有来源都走这里，超时 / 体积上限 / 重定向 / UA / 编码探测 / SSRF / robots
只在这一处实现，加来源类型时不用重复考虑这些。

Step 5 补上的三件事：

1. **SSRF 防护，且每一跳重定向都校验**
   原来交给 requests 自动跟随重定向，而重定向的目标是对端说了算的：
   `https://看起来正常的站/redirect -> http://127.0.0.1:8787/` 就能绕过校验。
   所以改成手动跟随，每一跳都过 core.security.assert_safe_url。

2. **robots.txt**
   发请求前先问一次"这个地址允许我抓吗"。默认开启，
   来源的 fetch_policy 里可以关（界面上会提示风险自负）。

3. **ETag / Last-Modified**
   带上次的指纹去问，对方回 304 就说明内容没变，直接跳过解析。
   对 RSS 尤其有用 —— 大多数 feed 的请求都是 304，能省下大量流量和解析时间。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from urllib.parse import urljoin

import requests

from core.security import UnsafeURLError, assert_safe_url
from core.robots import check as robots_check

# ---- 稳定性约束（需求里写死的数值，改之前先想清楚）----
CONNECT_TIMEOUT = 5.0      # 连接超时
READ_TIMEOUT = 15.0        # 总超时
MAX_BYTES = 2 * 1024 * 1024   # 响应体上限 2MB，超过直接截断
MAX_REDIRECTS = 3          # 重定向最多 3 次

DEFAULT_UA = (
    "PersonalWorkspace-Aggregator/0.1 "
    "(local single-user tool; https://github.com/wzsl07/personal-workspace)"
)


@dataclass
class RawResponse:
    """一次请求的结果。失败也返回对象，不抛异常，方便写 fetch_runs 日志。"""

    ok: bool
    final_url: str = ""
    status: int | None = None
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""
    duration_ms: int = 0
    error_kind: str | None = None      # timeout / network / http_error / unsafe / robots
    error_message: str | None = None
    truncated: bool = False
    not_modified: bool = False         # 304：内容没变，调用方应跳过解析

    @property
    def text(self) -> str:
        """按响应声明或探测出的编码解成文本。

        注意：解析 RSS 时更推荐直接用 body（feedparser 自己认 XML 声明的编码），
        这个属性主要给 html / json 类型和看日志用。
        """
        from normalizers.encoding import decode_html

        return decode_html(self.body)

    @property
    def etag(self) -> str | None:
        return self.headers.get("ETag") or self.headers.get("etag")

    @property
    def last_modified(self) -> str | None:
        return self.headers.get("Last-Modified") or self.headers.get("last-modified")


def _error(kind: str, msg: str, url: str = "", started: float | None = None) -> RawResponse:
    return RawResponse(
        False, url, duration_ms=_ms(started) if started is not None else 0,
        error_kind=kind, error_message=msg,
    )


def fetch(
    url: str,
    *,
    user_agent: str = DEFAULT_UA,
    extra_headers: dict[str, str] | None = None,
    etag: str | None = None,
    last_modified: str | None = None,
    respect_robots: bool = True,
) -> RawResponse:
    """取回一个 URL 的内容。

    - 连接 5 秒、读取 15 秒
    - 最多跟随 3 次重定向，**每一跳都做 SSRF 校验**
    - 响应体超过 2MB 就停（truncated=True），避免把内存和解析时间耗光
    - 304 当成正常结果返回（not_modified=True），由调用方跳过解析
    - 默认遵守 robots.txt
    """
    started = time.monotonic()

    # ---- 第一跳的安全校验 ----
    try:
        assert_safe_url(url)
    except UnsafeURLError as e:
        return _error("unsafe", str(e), url, started)

    # ---- robots.txt ----
    if respect_robots:
        try:
            robots_check(url, user_agent)
        except Exception as e:
            return _error("robots", str(e) or "robots.txt 不允许抓取这个地址", url, started)

    headers = {"User-Agent": user_agent, "Accept": "*/*"}
    if etag:
        headers["If-None-Match"] = etag
    if last_modified:
        headers["If-Modified-Since"] = last_modified
    if extra_headers:
        headers.update(extra_headers)

    current = url
    # ---- 手动跟随重定向：每一跳都要重新校验 ----
    for _hop in range(MAX_REDIRECTS + 1):
        try:
            resp = requests.get(
                current,
                headers=headers,
                timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
                stream=True,
                allow_redirects=False,   # 关键：不让它自动跳，每一跳我们都要审
            )
        except requests.Timeout:
            return _error("timeout", f"连接或读取超时（{READ_TIMEOUT}s）", current, started)
        except requests.RequestException as e:
            return _error("network", str(e), current, started)

        location = resp.headers.get("Location") or resp.headers.get("location")
        if 300 <= resp.status_code < 400 and location:
            resp.close()
            nxt = urljoin(current, location)
            try:
                assert_safe_url(nxt)     # ← 每一跳都校验，这是 SSRF 防护的重点
            except UnsafeURLError as e:
                return _error("unsafe", f"重定向目标不安全：{e}", current, started)
            current = nxt
            continue

        return _read_body(resp, current, started)

    return _error("redirect", f"重定向超过 {MAX_REDIRECTS} 次", current, started)


def _read_body(resp: requests.Response, url: str, started: float) -> RawResponse:
    chunks: list[bytes] = []
    total = 0
    truncated = False
    try:
        for chunk in resp.iter_content(chunk_size=8192):
            if not chunk:
                continue
            chunks.append(chunk)
            total += len(chunk)
            if total >= MAX_BYTES:
                truncated = True
                break
    except requests.RequestException as e:
        return RawResponse(False, resp.url, resp.status_code, dict(resp.headers),
                           b"".join(chunks), _ms(started), "network", str(e))

    body = b"".join(chunks)
    result = RawResponse(
        ok=resp.status_code < 400,
        final_url=resp.url,
        status=resp.status_code,
        headers=dict(resp.headers),
        body=body,
        duration_ms=_ms(started),
        truncated=truncated,
        not_modified=(resp.status_code == 304),
    )
    if resp.status_code >= 400:
        result.error_kind = "http_error"
        result.error_message = f"HTTP {resp.status_code}"
    if truncated:
        result.error_message = (result.error_message or "") + " 响应体超过上限被截断"
    resp.close()
    return result


def _ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)
