"""Step 5 自检：稳定性（退避/降频/隔离/ETag）与合规（SSRF/robots/清洗/加密）。

用法：
    python tests/test_step5.py

设计原则：**能确定性验证的一律用 mock，不依赖外网**。
外网相关的（真实站点的 ETag）放在最后，拿不到就标"跳过"而不是判失败 ——
测试的稳定性比覆盖度重要，一个因为网络波动而红的测试等于没有测试。
"""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PASS, FAIL = "✅", "❌"
_results: list[tuple[bool, str, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    _results.append((bool(cond), name, detail))
    print(f"  {PASS if cond else FAIL} {name}" + (f"  —— {detail}" if detail else ""))


def section(title: str) -> None:
    print(f"\n=== {title} ===")


# ----------------------------------------------------------------------
# 一、稳定性：退避 / 降频 / 隔离
# ----------------------------------------------------------------------

def test_health_policy() -> None:
    section("1. 失败退避阶梯（1m→5m→15m→1h→4h）")
    from core import health as H

    ladder = [H.backoff_seconds(i) for i in range(1, 8)]
    check("阶梯数值正确", ladder[:5] == [60, 300, 900, 3600, 14400],
          f"{ladder[:5]} … 之后封顶 {ladder[6]}")
    check("用满后停在最后一档", ladder[6] == ladder[5] == 14400)

    with_j = [H.with_jitter(300) for _ in range(6)]
    check("抖动落在 ±10% 且数值不整齐",
          all(270 <= x <= 330 for x in with_j) and len({round(x) for x in with_j}) > 3,
          f"样本 {[round(x) for x in with_j[:4]]} …")

    section("2. 自适应降频（连续无新条目 → ×1.5，上限 24h）")
    base = 900
    seq = []
    idle = 0
    for _ in range(6):
        seq.append(H.next_interval_on_success(configured=base, idle_streak=idle, new_count=0))
        idle += 1
    check("前 3 次不变（还没到降频门槛）", seq[:3] == [900, 900, 900], f"{seq[:3]}")
    check("之后逐步变长", seq[3] > seq[2] and seq[4] > seq[3], f"{seq[3:]}")
    check("上限 24h", H.next_interval_on_success(configured=900, idle_streak=99, new_count=0) == 86400)
    check("有新条目立刻回到设定值",
          H.next_interval_on_success(configured=900, idle_streak=10, new_count=3) == 900)

    section("3. 连续失败 5 次自动隔离")
    check("第 5 次触发隔离", H.should_isolate(5) and not H.should_isolate(4))
    check("隔离时状态为 disabled",
          H.health_of(ok=False, fail_streak=5, idle_streak=0, enabled=False) == "disabled")
    check("失败 3 次标 failing",
          H.health_of(ok=False, fail_streak=3, idle_streak=0) == "failing")
    check("失败 1 次只标 degraded",
          H.health_of(ok=False, fail_streak=1, idle_streak=0) == "degraded")
    check("成功且被降频也标 degraded（不是故障，只是慢）",
          H.health_of(ok=True, fail_streak=0, idle_streak=4) == "degraded")
    d = H.describe("disabled", fail_streak=5)
    check("隔离原因说人话且提到怎么恢复", "自动暂停" in d and "重试" in d, d)


def test_db_isolation() -> None:
    """隔离与"手动重试清零"要在数据库层面真的生效。"""
    section("4. 隔离写入数据库 + 手动重试可恢复")
    from storage import db as db_store
    from storage import sources as S

    path = os.path.join(tempfile.gettempdir(), "agg-step5.db")
    for suf in ("", "-wal", "-shm"):
        if os.path.exists(path + suf):
            os.remove(path + suf)

    conn = db_store.connect(path)
    db_store.init_db(conn)
    sid = S.add_source(conn, name="坏源", type="rss", url="https://bad.example/feed.xml")

    for i in range(1, 6):
        S.record_result(conn, sid, ok=False, error_message=f"HTTP 500（第 {i} 次）")
    s = S.get_source(conn, sid)
    check("连续失败 5 次后被自动停用", s.enabled is False and s.fail_streak == 5,
          f"enabled={s.enabled} fail_streak={s.fail_streak}")
    check("健康状态为 disabled", s.health_status == "disabled")
    check("错误信息里写清了原因", "自动暂停" in (s.last_error or ""), (s.last_error or "")[:40])

    due = datetime.fromisoformat(s.next_due_at)
    wait = (due - datetime.now(timezone(timedelta(hours=8)))).total_seconds()
    check("退避到 4 小时后再试", 14400 * 0.85 <= wait <= 14400 * 1.15, f"{wait/3600:.2f} 小时后")

    S.reset_health(conn, sid)
    s = S.get_source(conn, sid)
    check("手动重试后恢复启用", s.enabled is True and s.fail_streak == 0)
    check("恢复后立刻到期（不用等 4 小时）",
          datetime.fromisoformat(s.next_due_at) <= datetime.now(timezone(timedelta(hours=8))))

    # 降频也要落到 next_due_at 上
    sid2 = S.add_source(conn, name="慢源", type="rss", url="https://slow.example/feed.xml")
    for _ in range(4):
        S.record_result(conn, sid2, ok=True, new_count=0)
    s2 = S.get_source(conn, sid2)
    check("连续空跑后 idle_streak 累加", s2.idle_streak == 4, f"idle_streak={s2.idle_streak}")
    conn.close()
    for suf in ("", "-wal", "-shm"):
        if os.path.exists(path + suf):
            os.remove(path + suf)


# ----------------------------------------------------------------------
# 二、合规：SSRF
# ----------------------------------------------------------------------

def test_ssrf() -> None:
    section("5. SSRF 防护")
    from core import security

    bad = [
        "http://127.0.0.1:8787/api/sources",
        "http://localhost:8787/",
        "http://169.254.169.254/latest/meta-data/",
        "http://192.168.1.1/",
        "http://10.1.2.3:6379/",
        "http://172.16.0.1/",
        "http://[::1]:80/",
        "file:///C:/Windows/win.ini",
        "gopher://x/",
        "ftp://example.com/x",
    ]
    for u in bad:
        ok, why = security.is_safe_url(u)
        check(f"拒绝 {u[:42]}", not ok, why[:44])

    for u in ["https://sspai.com/feed", "http://example.com/rss"]:
        ok, _ = security.is_safe_url(u)
        check(f"放行 {u}", ok)

    # 域名解析到内网也要拦（用一个确实解析到 127.0.0.1 的公共域名）
    ok, why = security.is_safe_url("http://localtest.me/")
    check("域名解析到 127.0.0.1 时也被拦下", not ok, why[:44])


def test_ssrf_on_redirect() -> None:
    """重定向的每一跳都要校验 —— 这是最容易漏的一处。

    用假的 requests.get 模拟"第一跳正常、第二跳跳到内网"，
    不依赖外网，结果也确定。
    """
    section("6. 重定向每一跳都做 SSRF 校验")
    import adapters.http_fetch as hf

    class FakeResp:
        def __init__(self, status, location=None):
            self.status_code = status
            self.headers = {"Location": location} if location else {}
            self.url = "https://example.com/feed"

        def iter_content(self, _n=8192, **_kw):
            yield b""

        def close(self):
            pass

    calls: list[str] = []
    orig = hf.requests.get

    def fake_get(url, **kw):
        calls.append(url)
        if url == "https://example.com/feed":
            return FakeResp(302, "http://169.254.169.254/latest/meta-data/")
        return FakeResp(200)

    hf.requests.get = fake_get
    try:
        r = hf.fetch("https://example.com/feed", respect_robots=False)
        check("重定向到内网地址被拒", (not r.ok) and r.error_kind == "unsafe",
              (r.error_message or "")[:52])
        check("第二跳根本没有发出请求", len(calls) == 1, f"实际请求 {calls}")
    finally:
        hf.requests.get = orig


def test_etag_304() -> None:
    """304 要被当成成功，并且跳过解析（既不入库也不算失败）。"""
    section("7. ETag / Last-Modified → 304 跳过解析")
    import adapters.http_fetch as hf

    class FakeResp:
        def __init__(self, status, etag):
            self.status_code = status
            self.headers = {"ETag": etag, "Last-Modified": "Wed, 21 Oct 2026 07:28:00 GMT"}
            self.url = "https://example.com/feed"

        def iter_content(self, _n=8192, **_kw):
            yield b"<rss></rss>"

        def close(self):
            pass

    orig = hf.requests.get
    hf.requests.get = lambda url, **kw: FakeResp(304, '"abc123"')
    try:
        r = hf.fetch("https://example.com/feed", etag='"abc123"', respect_robots=False)
        check("304 被识别为 not_modified", r.not_modified and r.status == 304)
        check("304 算成功（不清零失败计数就错了）", r.ok)
        check("能取到新的 ETag / Last-Modified",
              r.etag == '"abc123"' and bool(r.last_modified))
    finally:
        hf.requests.get = orig


def test_etag_real() -> None:
    """真机上跑一次真实站点，看看 304 是不是真的会发生（外网不通就跳过）。"""
    section("8. 真实站点的 ETag（外网不通会跳过）")
    import adapters.http_fetch as hf

    url = "https://api.github.com/repos/wzsl07/personal-workspace"
    try:
        r1 = hf.fetch(url, respect_robots=False)
    except Exception as e:
        print(f"  ⚠️  跳过：{type(e).__name__}")
        return
    if not r1.ok:
        print(f"  ⚠️  跳过：首次请求就失败（HTTP {r1.status}）")
        return
    if not r1.etag and not r1.last_modified:
        print("  ⚠️  该站点没给 ETag / Last-Modified，跳过（不是代码问题）")
        return
    r2 = hf.fetch(url, etag=r1.etag, last_modified=r1.last_modified, respect_robots=False)
    check("带指纹再请求得到 304", r2.status == 304,
          f"第二次 HTTP {r2.status}，指纹 {str(r1.etag or r1.last_modified)[:24]}")


# ----------------------------------------------------------------------
# 三、合规：robots / 清洗 / 加密
# ----------------------------------------------------------------------

def test_robots() -> None:
    section("9. robots.txt")
    from core import robots as R

    rp = R._parse("User-agent: *\nDisallow: /private/\nAllow: /")
    check("Disallow 生效", not rp.can_fetch(R.DEFAULT_UA, "https://x.com/private/a"))
    check("其它路径允许", rp.can_fetch(R.DEFAULT_UA, "https://x.com/public/a"))

    R.CACHE["x.com"] = (time.monotonic(), rp)
    ok, why = R.allowed("https://x.com/private/a")
    check("allowed() 返回拒绝", not ok, why)
    ok2, _ = R.allowed("https://x.com/public/a")
    check("allowed() 返回允许", ok2)

    try:
        R.check("https://x.com/private/a")
        check("check() 会抛异常", False)
    except R.RobotsDenied:
        check("check() 会抛 RobotsDenied", True)

    # 取不到 robots 时用兜底规则：禁掉动态/私人路径
    fb = R._fallback()
    check("兜底规则禁掉 /admin", not fb.can_fetch(R.DEFAULT_UA, "https://x.com/admin/x"))
    check("兜底规则放行普通路径", fb.can_fetch(R.DEFAULT_UA, "https://x.com/news/1"))


def test_sanitize() -> None:
    section("10. HTML 白名单清洗")
    from normalizers.sanitize import sanitize_html

    cases = [
        ("on* 事件", '<p onclick="alert(1)">文字</p>', ["onclick"]),
        ("script 标签", '<script>alert(1)</script><p>正文</p>', ["<script", "alert(1)"]),
        ("javascript: 协议", '<a href="javascript:alert(1)">点</a>', ["javascript"]),
        ("img onerror", '<img src=x onerror="alert(1)" alt="图">', ["onerror"]),
        ("iframe", '<iframe src="https://evil.com"></iframe><p>后</p>', ["<iframe"]),
        ("style", '<p style="background:url(javascript:alert(1))">x</p>', ["style"]),
        ("data: 协议", '<a href="data:text/html,x">x</a>', ["data:text"]),
        ("svg", '<svg onload="alert(1)"></svg><p>后</p>', ["<svg", "onload"]),
    ]
    for name, frag, must_not in cases:
        out = sanitize_html(frag)
        bad = [m for m in must_not if m in out]
        check(f"{name} 被清掉", not bad, (f"残留 {bad}" if bad else out[:44]))

    out = sanitize_html('<a href="https://a.com/x">外链</a>')
    check("正常外链保留", "https://a.com/x" in out)
    check("外链加 rel=noopener noreferrer", 'rel="noopener noreferrer"' in out, out[:70])
    check("外链加 target=_blank", 'target="_blank"' in out)

    check("保留加粗等安全标签", "<strong>粗</strong>" in sanitize_html("<strong>粗</strong>"))
    check("表格标签保留", "<td>" in sanitize_html("<table><tr><td>a</td></tr></table>"))


def test_secret() -> None:
    section("11. 凭据加密与脱敏")
    from core import security

    token = "ghp_abcdefghijklmnopqrstuvwxyz012345"
    enc = security.encrypt_secret(token)
    check("密文带 enc:v1: 前缀", enc.startswith(security.PREFIX), enc[:18] + "…")
    check("密文里不含原文", token not in enc)
    check("能解回来", security.decrypt_secret(enc) == token)

    enc2 = security.encrypt_secret(token)
    check("每次加密结果不同（有随机 nonce）", enc != enc2)

    masked = security.mask_secret(enc)
    check("脱敏后不含原文", token not in masked, masked)
    check("非密文原样返回", security.decrypt_secret("plain-text") == "plain-text")
    check("空值不炸", security.decrypt_secret("") == "" and security.encrypt_secret("") == "")


# ----------------------------------------------------------------------

def main() -> int:
    print("\n" + "=" * 62)
    print("  Step 5 自检：稳定性 + 合规 + 安全")
    print("=" * 62)

    for fn in (
        test_health_policy,
        test_db_isolation,
        test_ssrf,
        test_ssrf_on_redirect,
        test_etag_304,
        test_etag_real,
        test_robots,
        test_sanitize,
        test_secret,
    ):
        try:
            fn()
        except Exception as e:
            import traceback

            check(f"{fn.__name__} 崩溃", False, f"{type(e).__name__}: {e}")
            traceback.print_exc()

    total = len(_results)
    passed = sum(1 for ok, _, _ in _results if ok)
    failed = [f"{n} —— {d}" for ok, n, d in _results if not ok]

    print("\n" + "=" * 62)
    print(f"  结果：{passed}/{total} 通过")
    if failed:
        print("\n  未通过：")
        for f in failed:
            print(f"    ❌ {f}")
    print("=" * 62)
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
