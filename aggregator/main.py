"""信息聚合 · 本地服务（Web 界面 + 后台调度）。

启动（双击 启动工作台.bat 或命令行）：
    python main.py

打开后浏览器会自动跳到 http://127.0.0.1:8787
只监听 127.0.0.1 —— 外网和同一 WiFi 的其他设备都访问不到。

界面本身**零外链**：单个 HTML，CSS 和 JS 全部内联，断网也能打开。
"""

from __future__ import annotations

import os
import sys
import threading
import webbrowser
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

import uvicorn                                    # noqa: E402
from fastapi import FastAPI, HTTPException         # noqa: E402
from fastapi.responses import HTMLResponse, Response  # noqa: E402
from pydantic import BaseModel, Field              # noqa: E402

from adapters.http_fetch import fetch              # noqa: E402
from core import detect as detect_mod              # noqa: E402
from core import health                            # noqa: E402
from core import security                          # noqa: E402
from core.pipeline import run_source_once           # noqa: E402
from core.scheduler import Scheduler                # noqa: E402
from normalizers.sanitize import sanitize_html     # noqa: E402
from normalizers.time import LOCAL_TZ               # noqa: E402
from storage import db as db_store                  # noqa: E402
from storage import items as items_store            # noqa: E402
from storage import runs as runs_store              # noqa: E402
from storage import sources as sources_store         # noqa: E402
from storage.opml import export_opml, import_opml    # noqa: E402

import parsers  # noqa: F401  注册所有解析器

HOST = "127.0.0.1"
PORT = int(os.environ.get("AGG_PORT") or 8787)
WEB_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web", "index.html")

app = FastAPI(title="个人工作台 · 信息聚合", docs_url=None, redoc_url=None)

_scheduler: Scheduler | None = None


# ---------------------------------------------------------------- 数据形状

def source_payload(conn, s) -> dict:
    """把一个来源打包成界面要用的结构（含条目数、栏目、最近日志）。"""
    secs = items_store.sections_of(conn, s.id)
    last_runs = runs_store.recent_runs(conn, source_id=s.id, limit=1)
    lr = last_runs[0] if len(last_runs) else None
    return {
        "id": s.id,
        "name": s.name,
        "type": s.type,
        "url": s.url,
        "enabled": bool(s.enabled),
        "interval_sec": s.interval_sec,
        "tags": s.tags,
        "health": s.health_status,
        "health_text": health.describe(
            s.health_status, fail_streak=s.fail_streak, idle_streak=s.idle_streak
        ),
        "isolated": bool(s.fail_streak >= health.ISOLATE_AFTER),
        "idle_streak": s.idle_streak,
        "fail_streak": s.fail_streak,
        "last_fetched_at": s.last_fetched_at,
        "last_success_at": s.last_success_at,
        "last_error": s.last_error,
        "next_due_at": s.next_due_at,
        "item_count": items_store.count_items(conn, s.id),
        "sections": [{"name": n, "count": c} for n, c in secs],
        "parser_config": s.parser_config,
        "last_run": (
            {
                "status": lr["status"],
                "http_status": lr["http_status"],
                "duration_ms": lr["duration_ms"],
                "items_found": lr["items_found"],
                "items_new": lr["items_new"],
                "error_message": lr["error_message"],
                "started_at": lr["started_at"],
            }
            if lr
            else None
        ),
    }


# ---------------------------------------------------------------- 界面

@app.get("/", response_class=HTMLResponse)
def index():
    """单页界面（HTML 里内联了全部 CSS/JS，不引用任何外部资源）。"""
    try:
        with open(WEB_FILE, encoding="utf-8") as f:
            return HTMLResponse(f.read())
    except FileNotFoundError:
        return HTMLResponse("<h1>缺少 web/index.html</h1>", status_code=500)


# ---------------------------------------------------------------- 来源

@app.get("/api/sources")
def list_sources():
    conn = db_store.connect()
    try:
        db_store.init_db(conn)
        return [source_payload(conn, s) for s in sources_store.list_sources(conn)]
    finally:
        conn.close()


class SourceIn(BaseModel):
    name: str = ""
    url: str
    type: str = ""
    parser_config: dict | None = None
    interval_sec: int = 900
    tags: str = ""


@app.post("/api/sources")
def create_source(body: SourceIn):
    """新增来源。不传 type 时先自动探测（界面上的"粘贴网址 → 探测 → 保存"流程）。"""
    # 保存时就挡住内网地址：与其让它存进去、每次抓取都失败一次，
    # 不如在用户点"保存"的那一刻就说清楚为什么不行。
    safe, why = security.is_safe_url(body.url)
    if not safe:
        raise HTTPException(400, why)

    conn = db_store.connect()
    try:
        db_store.init_db(conn)
        rtype, cfg, name = body.type, body.parser_config or {"version": 1}, body.name
        if not rtype:
            det = detect_mod.detect(body.url)
            if not det.get("ok"):
                raise HTTPException(400, f"自动探测失败：{det.get('reason')}")
            rtype = det["type"]
            cfg = det["parser_config"]
            name = name or (det.get("url") or body.url)
        try:
            sid = sources_store.add_source(
                conn, name=name or body.url, type=rtype, url=body.url,
                interval_sec=body.interval_sec, parser_config=cfg, tags=body.tags,
            )
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        return source_payload(conn, sources_store.get_source(conn, sid))
    finally:
        conn.close()


@app.get("/api/sources/{sid}")
def get_source(sid: int):
    conn = db_store.connect()
    try:
        s = sources_store.get_source(conn, sid)
        if not s:
            raise HTTPException(404, "没有这个来源")
        return source_payload(conn, s)
    finally:
        conn.close()


class SourcePatch(BaseModel):
    name: str | None = None
    url: str | None = None
    interval_sec: int | None = None
    parser_config: dict | None = None
    tags: str | None = None
    enabled: bool | None = None


@app.patch("/api/sources/{sid}")
def patch_source(sid: int, body: SourcePatch):
    conn = db_store.connect()
    try:
        if not sources_store.get_source(conn, sid):
            raise HTTPException(404, "没有这个来源")
        fields = {k: v for k, v in body.model_dump().items() if v is not None}
        if "url" in fields:
            safe, why = security.is_safe_url(fields["url"])
            if not safe:
                raise HTTPException(400, why)
        if "enabled" in fields:
            sources_store.set_enabled(conn, sid, bool(fields.pop("enabled")))
        if fields:
            try:
                sources_store.update_source(conn, sid, **fields)
            except ValueError as e:
                raise HTTPException(400, str(e)) from e
        return source_payload(conn, sources_store.get_source(conn, sid))
    finally:
        conn.close()


@app.delete("/api/sources/{sid}")
def delete_source(sid: int):
    conn = db_store.connect()
    try:
        if not sources_store.get_source(conn, sid):
            raise HTTPException(404, "没有这个来源")
        sources_store.delete_source(conn, sid)
        return {"ok": True}
    finally:
        conn.close()


class DetectIn(BaseModel):
    url: str


@app.post("/api/detect")
def detect(body: DetectIn):
    """给一个网址，自动探测类型与解析规则（不入库）。"""
    r = detect_mod.detect(body.url)
    if not r.get("ok"):
        return {"ok": False, "reason": r.get("reason"), "attempts": r.get("attempts", [])}
    return {
        "ok": True,
        "type": r["type"],
        "url": r["url"],
        "parser_config": r["parser_config"],
        "confidence": r.get("confidence"),
        "note": r.get("note"),
        "attempts": r.get("attempts", []),
        "preview": [
            {
                "title": it.title,
                "url": it.url,
                "published_at": it.published_at,
                "section": it.section,
                "summary": it.summary,
            }
            for it in r.get("preview", [])
        ],
    }


@app.post("/api/sources/{sid}/test")
def test_source(sid: int):
    """按当前规则抓一次并预览，**不入库** —— 调 CSS 规则时反复用这个。"""
    conn = db_store.connect()
    try:
        s = sources_store.get_source(conn, sid)
        if not s:
            raise HTTPException(404, "没有这个来源")
    finally:
        conn.close()

    resp = fetch(s.url)
    if not resp.ok:
        return {"ok": False, "http_status": resp.status, "error": resp.error_message}
    from parsers.base import parse

    try:
        feed = parse(s.type, resp.body, resp.final_url or s.url, s.parser_config)
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    return {
        "ok": True,
        "http_status": resp.status,
        "duration_ms": resp.duration_ms,
        "bytes": len(resp.body),
        "count": len(feed.items),
        "warnings": feed.warnings,
        "sections": sorted({it.section for it in feed.items if it.section}),
        "items": [
            {
                "title": it.title, "url": it.url,
                "published_at": it.published_at, "section": it.section,
                "summary": it.summary,
            }
            for it in feed.items[:20]
        ],
    }


@app.post("/api/sources/{sid}/fetch")
def fetch_source(sid: int):
    """立刻抓一次并入库。"""
    conn = db_store.connect()
    try:
        s = sources_store.get_source(conn, sid)
        if not s:
            raise HTTPException(404, "没有这个来源")
        r = run_source_once(conn, s)
        # 必须重新读一次：run_source_once 会更新健康字段，
        # 用抓取前那个对象打包的话，界面上会一直显示上一次的结果
        # —— 表现为"点了立即抓取，状态灯却没变"，很容易误以为没生效。
        s2 = sources_store.get_source(conn, sid)
        return {"ok": not r["error"], **r, "source": source_payload(conn, s2)}
    finally:
        conn.close()


@app.post("/api/sources/{sid}/retry")
def retry_source(sid: int):
    """手动重试：清零失败计数、解除自动隔离，并让它立刻到期。

    隔离必须可逆 —— 否则一个网址填错的来源会永远卡在"已暂停"，
    用户只能删掉重加。
    """
    conn = db_store.connect()
    try:
        db_store.init_db(conn)
        s = sources_store.get_source(conn, sid)
        if not s:
            raise HTTPException(404, "没有这个来源")
        sources_store.reset_health(conn, sid)
        return {"ok": True, "source": source_payload(conn, sources_store.get_source(conn, sid))}
    finally:
        conn.close()


class UrlCheckIn(BaseModel):
    url: str
    check_robots: bool = True


@app.post("/api/security/check-url")
def check_url(body: UrlCheckIn):
    """新增来源前的预检：网址是否安全、robots 是否允许。

    放在保存之前，是为了让"内网地址 / 不支持的协议"这类问题在
    用户点保存的那一刻就看见，而不是等第一次抓取失败后再猜。
    """
    safe, why = security.is_safe_url(body.url)
    out = {"url": body.url, "safe": safe, "reason": why, "robots": None}
    if safe and body.check_robots:
        from core import robots as robots_mod

        try:
            allowed, reason = robots_mod.allowed(body.url)
            out["robots"] = {"allowed": allowed, "reason": reason}
        except Exception as e:
            out["robots"] = {"allowed": True, "reason": f"检查失败：{e}"}
    return out


@app.get("/api/sources/{sid}/runs")
def source_runs(sid: int, limit: int = 20):
    conn = db_store.connect()
    try:
        rows = runs_store.recent_runs(conn, source_id=sid, limit=limit)
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ---------------------------------------------------------------- 条目

@app.get("/api/items")
def list_items(
    source_id: int | None = None,
    section: str | None = None,
    q: str | None = None,
    only_unread: bool = False,
    only_starred: bool = False,
    limit: int = 60,
):
    conn = db_store.connect()
    try:
        rows = items_store.list_items(
            conn, source_id=source_id, section=section, keyword=q,
            limit=limit, only_unread=only_unread, only_starred=only_starred,
        )
        return [
            {
                "id": r["id"],
                "source_id": r["source_id"],
                "source_name": r["source_name"],
                "section": r["section"],
                "title": r["title"],
                "url": r["url"],
                "summary": r["summary"],
                # 给界面用的富文本版本：经过白名单清洗，可以安全地 innerHTML。
                # 现在大多数来源的摘要在入库时就已被 strip_html 压成纯文本，
                # 这一层是兜底 —— 万一哪个解析器留下了标签，也不会被执行。
                "summary_html": sanitize_html(r["summary"] or ""),
                "published_at": r["published_at"],
                "discovered_at": r["discovered_at"],
                "read_at": r["read_at"],
                "starred": bool(r["starred"]),
            }
            for r in rows
        ]
    finally:
        conn.close()


class StateIn(BaseModel):
    read: bool | None = None
    starred: bool | None = None


@app.post("/api/items/{item_id}/state")
def set_item_state(item_id: int, body: StateIn):
    conn = db_store.connect()
    try:
        items_store.set_state(conn, item_id, read=body.read, starred=body.starred)
        return {"ok": True}
    finally:
        conn.close()


# ---------------------------------------------------------------- OPML

@app.get("/api/opml")
def get_opml():
    conn = db_store.connect()
    try:
        srcs = sources_store.list_sources(conn)
        xml = export_opml(srcs)
        return Response(
            content=xml, media_type="application/xml; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="sources.opml"'},
        )
    finally:
        conn.close()


class OpmlIn(BaseModel):
    content: str


@app.post("/api/opml")
def post_opml(body: OpmlIn):
    """导入 OPML。RSS 来源任何阅读器都能读懂；
    html/json 来源会把解析规则一起带回来（我们自己的工具之间可以互导）。"""
    conn = db_store.connect()
    try:
        db_store.init_db(conn)
        added, skipped = import_opml(conn, body.content)
        return {"ok": True, "added": added, "skipped": skipped}
    finally:
        conn.close()


# ---------------------------------------------------------------- 服务状态

@app.get("/api/status")
def status():
    conn = db_store.connect()
    try:
        db_store.init_db(conn)
        srcs = sources_store.list_sources(conn)
        return {
            "sources": len(srcs),
            "enabled": sum(1 for s in srcs if s.enabled),
            "items": items_store.count_items(conn),
            "now": datetime.now(LOCAL_TZ).isoformat(),
            "scheduler": "running" if _scheduler else "stopped",
        }
    finally:
        conn.close()


def start_scheduler() -> None:
    global _scheduler
    _scheduler = Scheduler()
    t = threading.Thread(target=_scheduler.run_forever, name="scheduler", daemon=True)
    t.start()


def main() -> None:
    url = f"http://{HOST}:{PORT}/"

    # 先探端口，再动别的。不能只靠 try/except OSError ——
    # uvicorn 内部会走自己的退出路径，异常捕获不一定轮得到我们，
    # 结果就是双击 .bat 后窗口闪一下就没了，用户完全不知道发生了什么。
    if not _port_free(HOST, PORT):
        print()
        print(f"[错误] 端口 {PORT} 已经被占用 —— 服务很可能已经在运行了。")
        print(f"       直接打开 {url} 看看；")
        print("       如果确实要重启，先关掉那个黑窗口（或在任务管理器里结束 python.exe）。")
        print()
        sys.exit(1)

    db_store.init_db(db_store.connect())
    start_scheduler()
    print(f"服务已启动：{url}（只监听本机）")
    print("按 Ctrl+C 停止")
    # 用 AGG_NO_BROWSER=1 可以只起服务不弹浏览器（自动化测试用）
    if not os.environ.get("AGG_NO_BROWSER"):
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")


def _port_free(host: str, port: int) -> bool:
    """端口能不能独占绑定。"""
    import socket

    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        s.bind((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


if __name__ == "__main__":
    main()
