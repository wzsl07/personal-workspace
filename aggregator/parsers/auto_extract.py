"""自动正文提取：对一个没有 feed 的网页，猜出一份可用的 CSS 规则。

思路（可解释，不靠玄学）：
1. 先找"看起来像条目"的元素：里面有链接，且标题有一定长度；
   如果页面上能找到日期，就优先要带日期的那些（新闻列表几乎都有日期）。
2. 按父容器分组，给每个容器打分：条目数、带日期比例、平均标题长度；
   明显是导航/页脚/轮播的容器直接淘汰。
3. 得分最高的容器就是列表，从它的第一个条目里反推 title/url/date/summary 选择器。
4. **必须回放验证**：生成的规则要能抽出 >=3 条，否则继续试下一个候选。

产出的是"建议规则"，由用户在界面上确认 —— 猜错了不丢人，猜错了不吭声才要命。
"""

from __future__ import annotations

import os
import re
from collections import Counter

from parsel import Selector

from normalizers.encoding import decode_html
from normalizers.text import strip_html

# 一看就是导航 / 页脚 / 轮播，不是正文列表
BAD_HINT = re.compile(
    r"nav|menu|bread|crumb|foot|head|slider|banner|friendlink|link|sitemap|pagination|page",
    re.I,
)

DATE_HINT = re.compile(
    r"20\d{2}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}"
    r"|\d{1,2}\s*[-/]\s*\d{1,2}\s*(?!\d)"   # 10-29 这种短日期
)

ITEM_TAGS = ("li", "tr", "div", "p", "article")

# 一个页面最多认几个并列栏目，防止把整页零碎链接都收进来
MAX_SECTIONS = 6

# 栏目名里常见的噪音（"more" 是很多站点的"更多"按钮文字）
_NAME_NOISE = re.compile(r"more|更多|>>|»|list", re.I)


def _node_text(node) -> str:
    """取一个 lxml 节点的文本（不用 Selector，因为这里是原生节点）。

    必须挡掉注释节点：lxml 的 itertext() 碰到 <!-- --> 会直接抛 ValueError，
    而网页里的注释到处都是，遍历兄弟节点时必然会撞上。
    """
    if node is None:
        return ""
    if not isinstance(getattr(node, "tag", None), str):
        return ""      # 注释 / 处理指令，不是元素
    parts = [t.strip() for t in node.itertext() if t.strip()]
    return re.sub(r"\s+", " ", " ".join(parts)).strip()


def _guess_section_name(node) -> str:
    """猜栏目名：看容器前面最近的兄弟节点里有没有像标题的短文本。

    比如 <div class="title"><span>通知公告</span></div> 后面跟着 <ul>…，
    那这个 ul 的栏目名就是"通知公告"。
    """
    cur = node
    for _ in range(3):
        if cur is None:
            break
        prev = cur.getprevious()
        steps = 0
        while prev is not None and steps < 3:
            txt = _node_text(prev)
            txt = _NAME_NOISE.sub("", txt).strip(" |·-—>")
            if 2 <= len(txt) <= 20 and not DATE_HINT.search(txt):
                return txt
            prev = prev.getprevious()
            steps += 1
        # 有些站点把栏目标题放在容器**内部**的第一个子元素里
        # （<div class="box"><div class="title">通知公告</div><ul>…</ul></div>）
        for child in list(cur)[:3]:
            txt = _NAME_NOISE.sub("", _node_text(child)).strip(" |·-—>")
            if 2 <= len(txt) <= 20 and not DATE_HINT.search(txt):
                return txt
        cur = cur.getparent()
    return ""


def _attr(el, name: str) -> str:
    return (el.get(name) or "") if hasattr(el, "get") else ""


def _hints(el) -> str:
    """把元素自己的 class/id 以及两级祖先的 class/id 拼起来，用于判断是不是导航。"""
    parts = []
    cur = el
    for _ in range(3):
        if cur is None or not hasattr(cur, "get"):
            break
        parts.append(_attr(cur, "class"))
        parts.append(_attr(cur, "id"))
        cur = cur.getparent()
    return " ".join(p for p in parts if p)


def _text_of(el) -> str:
    return " ".join(t.strip() for t in el.css("::text").getall() if t.strip())


def _build_path(el, max_depth: int = 3) -> str:
    """给容器构造 CSS 路径：有 class/id 就用，没有就退回 nth-of-type。"""
    parts = []
    cur = el
    depth = 0
    while cur is not None and hasattr(cur, "tag") and depth < max_depth:
        tag = cur.tag
        cls = _attr(cur, "class").strip()
        idd = _attr(cur, "id").strip()
        if idd and not idd[0].isdigit():
            parts.append(f"{tag}#{idd.split()[0]}")
            break
        if cls:
            first = cls.split()[0]
            if not first[0].isdigit():
                parts.append(f"{tag}.{first}")
                cur = cur.getparent()
                depth += 1
                continue
        # 没有可用的 class/id：用 nth-of-type 定位
        parent = cur.getparent()
        if parent is not None:
            idx = [c for c in parent if getattr(c, "tag", None) == tag].index(cur) + 1
            parts.append(f"{tag}:nth-of-type({idx})")
        else:
            parts.append(tag)
        cur = cur.getparent()
        depth += 1
    return " > ".join(reversed(parts))


def _ancestor(node, depth: int):
    cur = node
    for _ in range(depth):
        if cur is None:
            return None
        cur = cur.getparent()
    return cur


def _guess_fields(item_el) -> dict:
    """从第一个条目里反推字段选择器。"""
    fields = {"title": "", "url": "", "date": "", "summary": ""}

    # 链接：取第一个有文字的 a
    for a in item_el.css("a"):
        href = a.css("::attr(href)").get()
        txt = " ".join(a.css("::text").getall()).strip()
        if href and (txt or a.css("::attr(title)").get()):
            fields["url"] = "a::attr(href)"
            # title 属性常比截断的正文更完整，优先用它
            fields["title"] = "a::attr(title)" if len(txt) < 8 and a.css("::attr(title)").get() else "a::text"
            break
    if not fields["title"]:
        fields["title"] = "::text"

    # 日期：找"整段文字就是一个日期"的最内层元素。
    # 关键是不能选中条目自身 —— 它的文本是"标题+日期"，解析必然失败。
    best, best_key = None, None
    self_root = item_el.root
    for el in item_el.css("*"):
        if el.root is self_root:
            continue
        t = _text_of(el)
        if not t or len(t) > 20 or not DATE_HINT.search(t):
            continue
        # 优先选"叶子节点"（里面没有别的标签）：
        # 一个 <tr> 里往往有多个 <td>，"td::text" 会取到第一个（那是标题），
        # 而日期通常在最内层的 <span>/<em> 里，选它才不会歧义。
        is_leaf = len(el.css("*")) == 0
        # 越深越可信：<tr><td>标题</td><td><span>日期</span></td></tr> 里，
        # td 和 span 的文字一样长，但 span 更深 —— 选 td 会让 "td::text" 取到标题那个 td。
        depth = 0
        p = el.root.getparent()
        while p is not None and p is not self_root:
            depth += 1
            p = p.getparent()
        key = (-depth, 0 if is_leaf else 1, len(t))
        if best_key is None or key < best_key:
            best, best_key = el, key
    if best is not None:
        fields["date"] = f"{best.root.tag}::text"

    # 摘要：有 p 就用 p
    if item_el.css("p"):
        fields["summary"] = "p::text"

    return {k: v for k, v in fields.items() if v}


def suggest_config(body: bytes, base_url: str) -> dict:
    """分析网页，返回一份建议的 html 规则（含回放验证结果）。"""
    text = decode_html(body)
    sel = Selector(text)

    # 1) 找候选条目
    candidates: list = []
    for tag in ITEM_TAGS:
        for el in sel.css(tag):
            if not el.css("a::attr(href)").get():
                continue
            title = " ".join(el.css("a::text").getall()).strip()
            if len(title) < 6:
                continue
            parent = el.root.getparent()
            if parent is None:
                continue
            candidates.append((el, parent, title))

    if not candidates:
        return {"ok": False, "reason": "页面上找不到像列表条目的元素（带链接且标题够长）"}

    # 去掉"外层套内层"的候选：很多老站点用表格布局，外层 <tr> 里还嵌着一个
    # <table><tr>…</tr></table>，两个都匹配就会每条新闻重复两遍（实测碰到过）。
    # 规则：只要一个候选内部还包含别的候选，就丢掉外面那个。
    cand_ids = {id(el.root) for el, _, _ in candidates}

    def has_nested(root) -> bool:
        for d in root.iterdescendants():
            if id(d) in cand_ids:
                return True
        return False

    candidates = [c for c in candidates if not has_nested(c[0].root)]

    # 2) 按容器分组打分。
    #    同一个容器要往上多试几级：很多站点把新闻拆成几个并列 <ul>（各 8~10 条），
    #    只认直接父容器会漏掉三分之二；往上并入共同的 div 才能一次拿全。
    groups: dict = {}
    for el, parent, title in candidates:
        tag = el.root.tag
        # 往上多找几级：有些站点每篇文章各包一层 table，只看直接父容器会每组只剩 1 条
        for depth in (1, 2, 3, 4, 5, 6, 7):
            node = _ancestor(el.root, depth)
            if node is None:
                continue
            key = (id(node), tag)
            g = groups.setdefault(key, {"node": node, "tag": tag, "items": []})
            if not any(x.root is el.root for x in g["items"]):
                g["items"].append(el)

    scored = []
    for (_, tag), g in groups.items():
        node = g["node"]
        n = len(g["items"])
        if n < 3:
            continue
        if BAD_HINT.search(_hints(node)):
            continue
        avg_title = sum(len(_text_of(i)) for i in g["items"]) / n
        if avg_title < 8:
            continue
        dates = sum(1 for i in g["items"] if DATE_HINT.search(_text_of(i)))
        date_ratio = dates / n
        # 一条新闻通常只有 1~2 个链接；如果一个"条目"里塞了十几个链接，
        # 说明选中的是整块栏目而不是单条 —— 抽出来的标题会是好几条拼在一起的。
        avg_links = sum(len(i.css("a")) for i in g["items"]) / n
        link_penalty = max(0.0, avg_links - 2.0) * 12

        path = _build_path(node)
        # 太泛的容器（html/body 这种）会靠"条数多"赢，但它把导航栏也一并收进来了。
        # 给它重罚，并给带 class/id 的精确容器加分。
        generic_penalty = 100 if (not path or path.startswith("html") or " body" in f" {path}") else 0
        specific_bonus = 8 if ("." in path or "#" in path) else 0

        score = (
            n * 1.0 + date_ratio * 20 + min(avg_title, 60) * 0.3
            + specific_bonus - link_penalty - generic_penalty - (50 if n > 60 else 0)
        )
        if os.environ.get("AGG_DEBUG"):
            print(f"[debug] 容器 {_build_path(node)} 条目<{tag}> n={n} "
                  f"带日期={date_ratio:.2f} 平均链接={avg_links:.1f} "
                  f"平均字={avg_title:.0f} 得分={score:.1f}")
        scored.append((score, node, g, date_ratio, avg_title))

    # 排序时**优先要有名字的栏目**：
    # 同一个列表常常既能被"大容器"一次收全（24 条，没名字），
    # 也能被拆成"通知公告 / 新闻动态 / 政策文件"三个分支（各 8 条，都有名字）。
    # 用户要的是按网页自身的分类分开看，所以有名字的分支优先。
    def _name_of(entry) -> str:
        return _guess_section_name(entry[1])

    def _depth(node) -> int:
        d, cur = 0, node
        while getattr(cur, "getparent", None) and cur.getparent() is not None:
            d += 1
            cur = cur.getparent()
        return d

    # 排序：有名字的优先 → 同有名字时**更深的容器优先**。
    # 深的那层才是真正的单个栏目（外层 div 会把子栏目的标题也认成自己的名字）。
    scored.sort(key=lambda x: (0 if _name_of(x) else 1, -_depth(x[1]), -x[0]))

    # 3) 依次回放验证，收集**多个**并列栏目（而不是只取第一个）
    from parsers.html_css import parse_html

    accepted: list[dict] = []
    seen_urls: set[str] = set()
    all_preview: list = []

    for score, parent, g, date_ratio, avg_title in scored[:15]:
        tag = g["tag"]
        n = len(g["items"])
        container_path = _build_path(parent)
        # 用后代选择器而不是子选择器：条目往往还隔着一层 ul
        item_sel = f"{container_path} {tag}" if container_path else tag

        try:
            found = sel.css(item_sel)
        except Exception:
            continue
        # 规则匹配到的元素不能比分组里的条目多太多 ——
        # 多太多说明这个容器太宽，把导航之类不该收的也收进来了。
        if len(found) < 3 or len(found) > n * 3 + 3:
            continue

        fields = _guess_fields(g["items"][0])
        name = _guess_section_name(parent)
        section = {"name": name, "item": item_sel, **fields}

        # 用规则真抽一遍，确认可用（表格布局常匹配到内外两层，先去重）
        preview = parse_html(body, base_url,
                             {"version": 1, "sections": [section], "base_url": base_url})
        seen, uniq = set(), []
        for it in preview.items:
            k = it.url or it.title
            if k in seen:
                continue
            seen.add(k)
            uniq.append(it)
        if len(uniq) < 3:
            continue

        # 与已接受的栏目重复就跳过：同一个列表常被好几个祖先层级同时命中
        urls = {it.url for it in uniq if it.url}
        if urls and seen_urls:
            overlap = len(urls & seen_urls) / max(1, len(urls))
            if overlap > 0.5:
                continue
        seen_urls |= urls
        accepted.append(section)
        all_preview.extend(uniq[:5])

        if len(accepted) >= MAX_SECTIONS:
            break

    if not accepted:
        return {
            "ok": False,
            "reason": "找到了一些候选列表，但生成的规则抽不出足够条目，需要手动指定选择器",
            "candidates": [{"count": len(g["items"])} for _, _, g, _, _ in scored[:3]],
        }

    # 只有一个栏目时退化成 list 写法，配置更简洁；多个栏目用 sections
    if len(accepted) == 1:
        single = {k: v for k, v in accepted[0].items() if k != "name"}
        config = {"version": 1, "list": single, "base_url": base_url}
    else:
        config = {"version": 1, "sections": accepted, "base_url": base_url}

    avg_date = sum(1 for it in all_preview if it.published_at) / max(1, len(all_preview))
    return {
        "ok": True,
        "type": "html",
        "parser_config": config,
        "sections": [s["name"] or "未命名" for s in accepted],
        "match_count": len(accepted),
        "extracted_count": len(all_preview),
        "date_ratio": round(avg_date, 2),
        "confidence": "high" if avg_date >= 0.6 else ("medium" if avg_date > 0 else "low"),
        "preview": all_preview[:8],
    }
