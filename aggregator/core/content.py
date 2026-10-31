"""正文：提取 + 抓取 + 补抓队列。

为什么单独成一个模块：
  搜索要能搜到"信息流里写了什么"，光靠标题和摘要不够（你的三个高校站
  连摘要都没有）。正文有三个来源，按代价从低到高：

  1. feed 自带全文字段（content:encoded / content_html）—— 解析时就拿到了，
     **零额外请求**，见 parsers/rss.py 与 parsers/json.py；
  2. 网页详情页 —— 要发一次 HTTP 请求，本模块负责；
  3. 都没有 —— 只有标题，content_state 记为 fail。

抓取的三条纪律：
  - **按来源开关**（sources.fetch_content）：RSS 自带全文的不该再抓一次；
  - **每域名限速**：不能一口气把人家站点打挂；
  - **失败要留痕**（content_state='fail'），否则补抓脚本会无限重试同一个坏链接。
"""

from __future__ import annotations

import json
import re
import sqlite3
import time
from datetime import datetime, timezone, timedelta
from urllib.parse import urlparse

from adapters.http_fetch import DEFAULT_UA, fetch

LOCAL_TZ = timezone(timedelta(hours=8))

# 正文上限：正常公告几千字，个别页面会把整站塞进来
MAX_CONTENT_CHARS = 20000

_re_ws = re.compile(r"\s+")

#: 正文里不该出现的"站内导航"。高校站几乎都在正文末尾放
#: 「上一条：… 下一条：…」，抓正文时会跟着进来，看起来像正文的一部分。
_NAV_TEXT_RE = re.compile(
    r"^\s*(上一条|下一条|上一篇|下一篇|上一条:|下一条:|上一条：|下一条：|"
    r"返回列表|返回上级|打印本页|打印此页|关闭窗口|返回顶部|【打印】)",
)

#: class / id 里带这些词的容器基本都是翻页或工具条
_NAV_CLASS_RE = re.compile(r"(prev|next|pager|paging|pagination|share|bdshare|print)", re.I)


def strip_html_regex(s: str) -> str:
    s = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", s, flags=re.I | re.S)
    s = re.sub(r"<[^>]+>", " ", s)
    return _re_ws.sub(" ", s).strip()


def _node_text(node) -> str:
    try:
        txt = node.root.text_content()
    except Exception:
        txt = ""
    return _re_ws.sub(" ", txt or "").strip()


def _best_content_node(html_doc: str):
    """挑出最像正文的那个节点。

    按"链接密度"评分：正文中链接少、导航区链接多，
    所以 score = 文字长度 - 链接文字*1.6 - 链接数*15。
    只按"最长"选会选中外层容器，拿到一堆菜单。
    """
    from parsel import Selector

    sel = Selector(html_doc)
    for bad in ("script", "style", "noscript"):
        for el in sel.css(bad):
            try:
                el.root.getparent().remove(el.root)
            except Exception:
                pass

    candidates = (
        "article",
        "main",
        "[class*=content]",
        "[class*=article]",
        "[class*=detail]",
        "[id*=content]",
        "[id*=article]",
        "td",
    )
    best, best_score = None, 0.0
    for sel_name in candidates:
        for node in sel.css(sel_name)[:8]:
            t = _node_text(node)
            if len(t) < 80:
                continue
            links = node.css("a")
            link_chars = sum(len(_node_text(a)) for a in links)
            score = len(t) - link_chars * 1.6 - len(links) * 15
            if score > best_score:
                best, best_score = node, score
    return best


def _strip_article_nav(node) -> None:
    """把正文节点里的翻页导航、打印/关闭之类的小工具条去掉。"""
    doomed = []
    for el in node.root.iter():
        if not isinstance(el.tag, str):
            doomed.append(el)
            continue
        marks = " ".join(filter(None, [el.get("class") or "", el.get("id") or ""]))
        if marks and _NAV_CLASS_RE.search(marks):
            doomed.append(el)
            continue
        txt = _re_ws.sub(" ", (el.text_content() or "")).strip()
        if txt and _NAV_TEXT_RE.match(txt):
            doomed.append(el)

    for el in doomed:
        parent = el.getparent()
        if parent is not None:
            parent.remove(el)


#: 页脚/导航的标志词。出现在**末尾四分之一**时才认为是垃圾尾巴，
#: 正文里正常提到"下一条"不会被误伤。
_TAIL_MARKERS = (
    "上一条", "下一条", "上一篇", "下一篇", "返回列表", "返回顶部",
    "版权所有", "沪ICP", "技术支持", "打印本页", "关闭窗口",
)


def _trim_tail(text: str) -> str:
    """切掉正文末尾的站内导航与页脚。

    评分选出的节点有时是外层容器，末尾会跟着"下一条：…""版权所有 ©…"这类东西。
    它们会进搜索索引，看起来像正文的一部分，所以再兜一道。
    """
    if len(text) < 200:
        return text
    start = int(len(text) * 0.75)
    cut = len(text)
    for m in _TAIL_MARKERS:
        p = text.find(m, start)
        if p >= 0:
            cut = min(cut, p)
    return text[:cut].rstrip()


def extract_main_text(html_doc: str) -> str:
    """从网页里取出正文纯文本（搜索用它建索引）。"""
    try:
        node = _best_content_node(html_doc)
        if node is not None:
            _strip_article_nav(node)
            return _trim_tail(_node_text(node))[:MAX_CONTENT_CHARS]
        from parsel import Selector

        sel = Selector(html_doc)
        if sel.css("body"):
            return _trim_tail(_node_text(sel.css("body")[0]))[:MAX_CONTENT_CHARS]
        return ""
    except Exception:
        return _trim_tail(strip_html_regex(html_doc))[:MAX_CONTENT_CHARS]


def _absolutize(fragment: str, base_url: str) -> str:
    from urllib.parse import urljoin

    out = re.sub(r'src="([^"]+)"', lambda m: f'src="{urljoin(base_url, m.group(1))}"', fragment)
    out = re.sub(r'href="([^"]+)"', lambda m: f'href="{urljoin(base_url, m.group(1))}"', out)
    return out


def extract_main_html(html_doc: str, base_url: str) -> str:
    """取出正文的 HTML，清洗成可以安全渲染的样子（界面「显示原文」用）。"""
    from lxml import html as lxml_html
    from normalizers.sanitize import sanitize_html

    node = _best_content_node(html_doc)
    if node is None:
        return ""
    _strip_article_nav(node)
    try:
        inner = (node.root.text or "") + "".join(
            lxml_html.tostring(c, encoding="unicode") for c in node.root.iterchildren()
        )
    except Exception:
        return ""
    return _absolutize(sanitize_html(inner), base_url)


def fetch_content(url: str, policy: dict | None = None) -> tuple[str | None, str, str]:
    """抓一篇正文。

    返回 (text, state, message)：
      state = 'ok'   —— 拿到正文（text 非空）
      state = 'fail' —— 失败，message 说明原因（安全策略/robots/HTTP 错误/正文为空）
    """
    policy = policy or {}
    try:
        resp = fetch(
            url,
            user_agent=policy.get("user_agent") or DEFAULT_UA,
            respect_robots=not bool(policy.get("ignore_robots")),
        )
    except Exception as e:  # 网络层异常不能让整批补抓崩掉
        return None, "fail", f"请求异常：{e}"

    if resp.error_kind == "unsafe":
        return None, "fail", resp.error_message or "地址被安全策略拒绝"
    if resp.error_kind == "robots":
        return None, "fail", resp.error_message or "robots.txt 不允许"
    if not resp.ok:
        return None, "fail", resp.error_message or f"HTTP {resp.status}"

    # PDF / 二进制：链接直接指向附件时，正文提取会把二进制当文本读进来，
    # 存进去就是一堆 %PDF-1.7 乱码，还会把索引撑大。宁可标记失败。
    ctype = (resp.headers.get("Content-Type") or resp.headers.get("content-type") or "").lower()
    if "pdf" in ctype or (resp.body or b"")[:5] == b"%PDF-":
        return None, "fail", "是 PDF 附件，暂不提取正文"

    text = extract_main_text(resp.text or "")
    if len(text) < 20:
        return None, "fail", "页面里没找到正文"
    return text, "ok", ""


def _domain(url: str) -> str:
    try:
        return urlparse(url).netloc.lower()
    except Exception:
        return ""


def save_content(
    conn: sqlite3.Connection,
    item_id: int,
    text: str | None,
    state: str,
) -> None:
    """把正文写回条目（成功写内容，失败只记状态，方便以后重试或排查）。"""
    now = datetime.now(LOCAL_TZ).isoformat()
    if state == "ok" and text:
        conn.execute(
            "UPDATE items SET content=?, content_at=?, content_state='ok' WHERE id=?",
            (text, now, item_id),
        )
    else:
        conn.execute(
            "UPDATE items SET content_at=?, content_state=? WHERE id=?",
            (now, state, item_id),
        )
    conn.commit()


def backfill_from_feed(
    conn: sqlite3.Connection,
    source_id: int | None = None,
    log=print,
) -> dict:
    """RSS / JSON 源：重新拉一次 feed，用解析器带出来的全文字段补正文。

    这些源的 feed 里可能本来就带着全文（content:encoded / content_html），
    老条目入库时解析器还没支持，所以 content 是空的。
    重新拉一次 feed（1 个请求，不是 62 个）就能补上，比挨个抓详情页便宜得多。

    注意不要传 etag —— 传了会拿到 304，等于什么都没干。
    """
    from parsers.base import parse

    sql = "SELECT * FROM sources WHERE type IN ('rss','json')"
    args: list = []
    if source_id:
        sql += " AND id=?"
        args.append(source_id)
    sources = conn.execute(sql, args).fetchall()

    stats = {"sources": 0, "updated": 0, "empty_feed": 0, "fetch_failed": 0}
    for s in sources:
        policy = {}
        try:
            policy = json.loads(s["fetch_policy"] or "{}") if s["fetch_policy"] else {}
        except Exception:
            policy = {}
        try:
            resp = fetch(
                s["url"],
                user_agent=policy.get("user_agent") or DEFAULT_UA,
                respect_robots=not bool(policy.get("ignore_robots")),
            )
        except Exception as e:
            stats["fetch_failed"] += 1
            log(f"  ✗ [{s['id']}] {s['name']} 拉取失败：{e}")
            continue

        stats["sources"] += 1
        if not resp.ok:
            log(f"  ✗ [{s['id']}] {s['name']} HTTP {resp.status}")
            continue

        parsed = parse(s["type"], resp.body, resp.final_url or s["url"],
                       json.loads(s["parser_config"] or "{}"))
        got = 0
        for it in parsed.items:
            if not it.content:
                continue
            row = conn.execute(
                "SELECT id, content_state FROM items WHERE source_id=? AND guid=?",
                (s["id"], it.guid),
            ).fetchone()
            if not row:
                continue
            if row["content_state"] == "ok":
                continue
            save_content(conn, row["id"], it.content[:MAX_CONTENT_CHARS], "ok")
            got += 1
        stats["updated"] += got
        log(f"  ✓ [{s['id']}] {s['name']} 补上 {got} 条正文（feed 自带）")
        if got == 0:
            stats["empty_feed"] += 1
    conn.commit()
    return stats


def pending_items(
    conn: sqlite3.Connection,
    source_id: int | None = None,
    limit: int | None = None,
) -> list[sqlite3.Row]:
    """列出"还缺正文"的条目：状态是空（没试过）且本身没有正文。

    只看 content_state='' —— 抓过失败的（fail）不重复折磨源站，
    要重试得显式指定 retry_failed=True。
    """
    sql = """
        SELECT i.id, i.url, i.title, s.id AS sid, s.name AS sname, s.fetch_policy, s.fetch_content
        FROM items i JOIN sources s ON s.id = i.source_id
        WHERE i.content_state = '' AND COALESCE(i.content,'') = '' AND COALESCE(i.url,'') <> ''
    """
    args: list = []
    if source_id:
        sql += " AND i.source_id = ?"
        args.append(source_id)
    sql += " ORDER BY i.id"
    if limit:
        sql += " LIMIT ?"
        args.append(limit)
    return conn.execute(sql, args).fetchall()


def backfill(
    conn: sqlite3.Connection,
    *,
    source_id: int | None = None,
    limit: int | None = None,
    delay: float = 1.5,
    retry_failed: bool = False,
    log=print,
) -> dict:
    """补抓正文。

    每域名限速：同一个域名两次请求之间至少等 delay 秒（默认 1.5s），
    换域名才不用等。这样即使一次性补 62 条，对单个站点也是慢慢来的。

    返回统计：{'total':…, 'ok':…, 'fail':…, 'skip':…}
    """
    if retry_failed:
        rows = conn.execute(
            """SELECT i.id, i.url, i.title, s.id AS sid, s.name AS sname,
                      s.fetch_policy, s.fetch_content
               FROM items i JOIN sources s ON s.id = i.source_id
               WHERE i.content_state <> 'ok' AND COALESCE(i.url,'') <> ''
               ORDER BY i.id""",
        ).fetchall()
    else:
        rows = pending_items(conn, source_id=source_id, limit=limit)

    stats = {"total": len(rows), "ok": 0, "fail": 0, "skip": 0}
    last_hit: dict[str, float] = {}
    failures: list[tuple[str, str]] = []

    for r in rows:
        url = r["url"]
        # 该来源关了"抓正文"：直接标记 skip，下次不会再来问
        if not r["fetch_content"]:
            save_content(conn, r["id"], None, "skip")
            stats["skip"] += 1
            continue

        dom = _domain(url)
        waited = 0.0
        if dom in last_hit:
            waited = delay - (time.time() - last_hit[dom])
            if waited > 0:
                time.sleep(waited)
        last_hit[dom] = time.time()

        policy = {}
        try:
            policy = json.loads(r["fetch_policy"] or "{}") if r["fetch_policy"] else {}
        except Exception:
            policy = {}

        text, state, msg = fetch_content(url, policy)
        save_content(conn, r["id"], text, state)
        if state == "ok":
            stats["ok"] += 1
            log(f"  ✓ [{r['sid']}] {r['title'][:28]}  {len(text)} 字")
        else:
            stats["fail"] += 1
            failures.append((r["title"][:28], msg))
            log(f"  ✗ [{r['sid']}] {r['title'][:28]}  {msg}")

    if failures:
        log(f"\n失败 {len(failures)} 条（已记 fail，不会自动重试）。前几条：")
        for t, m in failures[:5]:
            log(f"  - {t}：{m}")
    return stats
