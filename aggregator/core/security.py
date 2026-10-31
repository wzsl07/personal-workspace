"""合规与安全相关的两件事：SSRF 防护、凭据加密。

为什么这两件放在一个文件里：它们都是"用户填了任意内容，我们不能照单全收"的防线，
出问题的方式也一样 —— 静默地干了我们不该干的事。

------------------------------------------------------------------
一、SSRF 防护（重点）
------------------------------------------------------------------
来源的网址是用户自己填的。如果不校验，别人（或你自己误填）可以填：

    http://127.0.0.1:8787/api/sources      → 读写你自己的聚合服务
    http://169.254.169.254/latest/...      → 云主机的实例元数据（含临时密钥）
    http://192.168.1.1/                    → 你家路由器管理页
    http://10.0.0.5:6379                   → 内网 Redis

这些请求是从**你的电脑**发出的，目标服务会把你当成"内网可信方"。
所以必须在发出之前拦掉。

实现要点：
- 只放行 http / https（file://、gopher:// 等一律拒绝）
- 先解析域名拿到**所有** A/AAAA 记录，逐个校验 IP
  （一个域名可能同时解析到公网 IP 和 127.0.0.1，只查第一个是不够的）
- 所有私有/保留/环回/链路本地/多播段都拒绝
- **每次重定向都要重新校验**：
  `http://safe.com/redirect -> http://127.0.0.1/` 是经典的绕过手法，
  只在第一跳做校验等于没做。所以重定向由 http_fetch 手动跟随，每一跳都过这里。

已知局限（说实话）：DNS rebinding —— 校验时解析到公网 IP，真正连接时
DNS 返回内网 IP。彻底解决要在 socket 层绑定已校验的 IP，代价是要自己
实现 TLS SNI 与证书校验，对一个自用小工具不划算。这里做的是"能挡住
绝大多数误填和常见攻击"的程度。

------------------------------------------------------------------
二、凭据加密
------------------------------------------------------------------
来源的 auth_config 里可能放 API token。它存在本地 SQLite 里，
如果明文存放，别人拿到这个文件（比如你备份、分享给同学）就能看到。

做法：AES-256-GCM，密钥是首次运行时随机生成的，存在 data/ 下的独立文件里。
要说明的是 —— **这不是防黑客的**。密钥就在同一台机器上，能读数据库的人
通常也能读密钥文件。它防的是"你把 sources 配置导出/分享出去时，
token 跟着一起泄露"，这是真实会发生的情况。

密文统一带 `enc:v1:` 前缀，便于识别是否已加密、也方便以后换算法。
"""

from __future__ import annotations

import base64
import ipaddress
import os
import socket
from urllib.parse import urlsplit

# ----------------------------------------------------------------------
# SSRF：私有 / 保留网段
# ----------------------------------------------------------------------

#: 一律拒绝的网段。含环回、私有、链路本地（169.254.169.254 是云元数据服务）、
#: 未指定地址、运营商级 NAT、文档用保留段、多播与保留。
BLOCKED_NETWORKS_V4 = [
    "0.0.0.0/8",        # 未指定
    "10.0.0.0/8",       # 私有
    "100.64.0.0/10",    # 运营商级 NAT
    "127.0.0.0/8",      # 环回
    "169.254.0.0/16",   # 链路本地（含 169.254.169.254 实例元数据）
    "172.16.0.0/12",    # 私有
    "192.0.0.0/24",     # IETF 协议分配
    "192.0.2.0/24",     # 文档用
    "192.168.0.0/16",   # 私有
    "198.18.0.0/15",    # 基准测试
    "198.51.100.0/24",  # 文档用
    "203.0.113.0/24",   # 文档用
    "224.0.0.0/4",      # 多播
    "240.0.0.0/4",      # 保留
]

BLOCKED_NETWORKS_V6 = [
    "::/128",           # 未指定
    "::1/128",          # 环回
    "fc00::/7",         # 唯一本地地址
    "fe80::/10",        # 链路本地
    "ff00::/8",         # 多播
]

_V4 = [ipaddress.ip_network(c) for c in BLOCKED_NETWORKS_V4]
_V6 = [ipaddress.ip_network(c) for c in BLOCKED_NETWORKS_V6]

ALLOWED_SCHEMES = ("http", "https")


class UnsafeURLError(Exception):
    """URL 不合法或不安全。message 会直接显示给用户，所以写成能看懂的话。"""


def _ip_blocked(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    nets = _V4 if ip.version == 4 else _V6
    return any(ip in n for n in nets)


def resolve_ips(host: str) -> list[str]:
    """解析主机名的所有 IP。失败返回空列表（由调用方决定怎么处理）。"""
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except Exception:
        return []
    return sorted({i[4][0] for i in infos})


def assert_safe_url(url: str) -> None:
    """校验一个 URL 可以安全请求。不安全就抛 UnsafeURLError。

    每次发请求前都要调用，包括重定向的每一跳。
    """
    try:
        parts = urlsplit(url)
    except Exception:
        raise UnsafeURLError(f"网址无法解析：{url}")

    scheme = (parts.scheme or "").lower()
    if scheme not in ALLOWED_SCHEMES:
        raise UnsafeURLError(
            f"只支持 http / https 网址，收到的是 {scheme or '（空）'}：{url[:80]}"
        )

    host = parts.hostname
    if not host:
        raise UnsafeURLError(f"网址里没有主机名：{url[:80]}")

    # 字面量 IP 直接判（不用查 DNS）
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        if _ip_blocked(literal):
            raise UnsafeURLError(
                f"拒绝访问内网/保留地址 {host} —— 这是本机或局域网地址，"
                "聚合服务不会去请求它（防止被用来探测你的内网）"
            )
        return

    ips = resolve_ips(host)
    if not ips:
        raise UnsafeURLError(f"域名解析失败：{host}")

    for s in ips:
        try:
            ip = ipaddress.ip_address(s)
        except ValueError:
            continue
        if _ip_blocked(ip):
            raise UnsafeURLError(
                f"拒绝访问：{host} 解析到内网/保留地址 {s}。"
                "聚合服务不会请求内网地址（防止被用来探测你的局域网）"
            )


def is_safe_url(url: str) -> tuple[bool, str]:
    """assert_safe_url 的非抛异常版本，给界面用。"""
    try:
        assert_safe_url(url)
        return True, ""
    except UnsafeURLError as e:
        return False, str(e)


# ----------------------------------------------------------------------
# 凭据加密
# ----------------------------------------------------------------------

PREFIX = "enc:v1:"

_KEY_ENV = "AGG_SECRET_KEY"      # 测试/高级用法：直接给 base64 密钥
_KEY_REL = ("data", ".secretkey")


def _key_path() -> str:
    """密钥文件路径。放在 data/ 下（该目录已在 .gitignore 中）。"""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(here, *_KEY_REL)


def _load_or_create_key() -> bytes:
    """取密钥；没有就生成一个新的（32 字节随机）。"""
    env = os.environ.get(_KEY_ENV)
    if env:
        try:
            return base64.b64decode(env)
        except Exception:
            pass

    path = _key_path()
    if os.path.exists(path):
        with open(path, "rb") as f:
            data = f.read().strip()
        if data:
            try:
                k = base64.b64decode(data)
                if len(k) == 32:
                    return k
            except Exception:
                pass

    key = os.urandom(32)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(base64.b64encode(key))
    # Windows 上尽量收紧权限（失败也无所谓，见文件头的说明）
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass
    return key


def encrypt_secret(plain: str) -> str:
    """加密一段文本。返回带 enc:v1: 前缀的字符串。"""
    if not plain:
        return ""
    if plain.startswith(PREFIX):
        return plain          # 已经是密文

    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    key = _load_or_create_key()
    nonce = os.urandom(12)
    ct = AESGCM(key).encrypt(nonce, plain.encode("utf-8"), None)
    return PREFIX + base64.b64encode(nonce + ct).decode("ascii")


def decrypt_secret(value: str) -> str:
    """解密。不是密文（或密钥丢了）就原样返回，不抛异常 —— 配置读不出来不算致命错误。"""
    if not value or not value.startswith(PREFIX):
        return value
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        raw = base64.b64decode(value[len(PREFIX):])
        key = _load_or_create_key()
        return AESGCM(key).decrypt(raw[:12], raw[12:], None).decode("utf-8")
    except Exception:
        return ""


def mask_secret(value: str) -> str:
    """脱敏显示：只留头尾各 2 位。用于日志和界面。"""
    if not value:
        return ""
    plain = decrypt_secret(value) if value.startswith(PREFIX) else value
    if len(plain) <= 6:
        return "*" * len(plain)
    return f"{plain[:2]}…{plain[-2:]}（共 {len(plain)} 位）"
