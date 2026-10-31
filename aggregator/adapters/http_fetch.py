"""统一发请求的地方（接入层底座）。

所有来源都走这里，好处是超时、体积上限、重定向次数、UA、编码探测
只在一处实现，后面加 robots / SSRF / ETag 也只改这一处。

Step 0 只实现了"能取回来"的基本盘；
robots.txt、SSRF 防护、ETag/Last-Modified 会在 Step 2、Step 5 补上。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import requests

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
    error_kind: str | None = None      # timeout / too_large / network / http_error
    error_message: str | None = None
    truncated: bool = False

    @property
    def text(self) -> str:
        """按响应声明或探测出的编码解成文本。

        注意：解析 RSS 时更推荐直接用 body（feedparser 自己认 XML 声明的编码），
        这个属性主要给 html / json 类型和看日志用。
        """
        from normalizers.encoding import decode_html

        return decode_html(self.body)


def fetch(
    url: str,
    *,
    user_agent: str = DEFAULT_UA,
    extra_headers: dict[str, str] | None = None,
    etag: str | None = None,
    last_modified: str | None = None,
) -> RawResponse:
    """取回一个 URL 的内容。

    - 连接 5 秒、读取 15 秒
    - 最多跟随 3 次重定向
    - 响应体超过 2MB 就停（truncated=True），避免把内存和解析时间耗光
    - 304 也当成正常结果返回，由调用方决定跳过解析（Step 2 的省流量逻辑）
    """
    started = time.monotonic()
    headers = {"User-Agent": user_agent, "Accept": "*/*"}
    if etag:
        headers["If-None-Match"] = etag
    if last_modified:
        headers["If-Modified-Since"] = last_modified
    if extra_headers:
        headers.update(extra_headers)

    session = requests.Session()
    session.max_redirects = MAX_REDIRECTS

    try:
        resp = session.get(
            url,
            headers=headers,
            timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
            stream=True,          # 边下边判断体积，不能一次性拉进来
            allow_redirects=True,
        )
    except requests.Timeout:
        return RawResponse(False, url, duration_ms=_ms(started), error_kind="timeout",
                           error_message=f"连接或读取超时（{READ_TIMEOUT}s）")
    except requests.TooManyRedirects:
        return RawResponse(False, url, duration_ms=_ms(started), error_kind="redirect",
                           error_message=f"重定向超过 {MAX_REDIRECTS} 次")
    except requests.RequestException as e:
        return RawResponse(False, url, duration_ms=_ms(started), error_kind="network",
                           error_message=str(e))

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
    )
    if resp.status_code >= 400:
        result.error_kind = "http_error"
        result.error_message = f"HTTP {resp.status_code}"
    if truncated:
        result.error_message = (result.error_message or "") + " 响应体超过上限被截断"
    return result


def _ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)
