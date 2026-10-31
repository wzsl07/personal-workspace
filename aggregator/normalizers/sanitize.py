"""HTML 白名单清洗（展示层用）。

为什么不能只靠 strip_html：
- strip_html 做的是"变成纯文本"，入库时用；
- 但界面上有时要**保留富文本**（比如 RSS 里带链接的正文）。
  直接把抓来的 HTML 塞进 innerHTML 是最常见的 XSS 来源。

抓来的内容来自**任意第三方网站**，等同于用户输入。必须白名单过滤：

- 只保留一份很小的标签白名单（p/br/a/ul/ol/li/strong/em/code/blockquote…）
- 只保留安全属性（a 的 href/title，img 的 src/alt）
- 移除所有 on* 事件属性（onclick / onerror / onload …）
- 移除 javascript: / data: / vbscript: 协议的链接
- 外链强制加 rel="noopener noreferrer" 与 target="_blank"

用 lxml（parsel 已带）实现，不新增依赖。
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit

from lxml import html as lxml_html

#: 允许的标签。刻意保持很小 —— 多一个标签就多一处风险。
ALLOWED_TAGS = {
    "p", "br", "div", "span", "section", "article",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li",
    "strong", "b", "em", "i", "u", "s", "code", "pre", "blockquote",
    "a", "img", "figure", "figcaption",
    "table", "thead", "tbody", "tr", "th", "td",
    "hr", "small", "sup", "sub",
}

#: 允许的属性（按标签限定）
ALLOWED_ATTRS = {
    "a": {"href", "title"},
    "img": {"src", "alt", "title", "width", "height"},
    "td": {"colspan", "rowspan"},
    "th": {"colspan", "rowspan"},
}
#: 所有标签都允许的属性
GLOBAL_ATTRS = {"title"}

#: 危险协议。注意 data: 也禁 —— 它能用来承载可执行的 SVG/HTML。
BAD_SCHEMES = re.compile(r"^\s*(javascript|vbscript|data|file)\s*:", re.I)


def _safe_url(value: str) -> bool:
    """链接是否安全（只放行 http/https/mailto 和相对路径）。"""
    v = (value or "").strip()
    if not v:
        return False
    if BAD_SCHEMES.match(v):
        return False
    # 协议相对路径 //host/path 允许
    parts = urlsplit(v)
    if parts.scheme and parts.scheme.lower() not in ("http", "https", "mailto"):
        return False
    return True


#: 这些标签连同**内容**一起丢掉。留着文字没意义（script 的正文就是代码）。
DROP_WITH_CONTENT = {"script", "style", "noscript", "template", "iframe",
                     "object", "embed", "svg", "math"}


def _drop_dangerous(root) -> None:
    """整棵删掉危险元素（含文字）。先做这步，后面的白名单才不会把代码当正文留下。"""
    for el in list(root.iter()):
        tag = el.tag
        if not isinstance(tag, str):
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)
            continue
        if tag.lower() in DROP_WITH_CONTENT:
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)


def _clean_tree(root) -> None:
    """就地清洗一棵 lxml 树。"""
    for el in list(root.iter()):
        tag = el.tag
        if not isinstance(tag, str):
            # 注释 / 处理指令：直接删
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)
            continue

        tag_lower = tag.lower()
        if tag_lower not in ALLOWED_TAGS:
            # 不在白名单：把它的**文字内容**留下，标签本身去掉
            # （不能连带删文字，否则正文会缺一大块）
            text = el.text_content() if hasattr(el, "text_content") else ""
            tail = el.tail or ""
            parent = el.getparent()
            if parent is None:
                continue
            idx = list(parent).index(el)
            if text:
                if idx == 0:
                    parent.text = (parent.text or "") + text
                else:
                    prev = parent[idx - 1]
                    prev.tail = (prev.tail or "") + text
            if tail:
                if idx == 0:
                    parent.text = (parent.text or "") + tail
                else:
                    prev = parent[idx - 1]
                    prev.tail = (prev.tail or "") + tail
            parent.remove(el)
            continue

        # 属性白名单
        allowed = GLOBAL_ATTRS | ALLOWED_ATTRS.get(tag_lower, set())
        for attr in list(el.attrib):
            low = attr.lower()
            if low.startswith("on"):          # 所有事件属性
                del el.attrib[attr]
                continue
            if low in ("style",):             # style 可以藏 expression()/url()
                del el.attrib[attr]
                continue
            if low not in allowed:
                del el.attrib[attr]
                continue

        # 链接协议校验 + 外链加固
        if tag_lower == "a":
            href = el.get("href")
            if href and not _safe_url(href):
                del el.attrib["href"]
            elif href:
                parts = urlsplit(href)
                if parts.scheme in ("http", "https"):
                    el.set("target", "_blank")
                    el.set("rel", "noopener noreferrer")
        elif tag_lower == "img":
            src = el.get("src")
            if src and not _safe_url(src):
                del el.attrib["src"]


def sanitize_html(fragment: str) -> str:
    """把一段不可信 HTML 洗成可以安全 innerHTML 的 HTML。"""
    if not fragment or not fragment.strip():
        return ""

    try:
        root = lxml_html.fragment_fromstring(fragment, create_parent="div")
    except Exception:
        # 解析不了就当纯文本（转义后再返回，至少不会执行）
        import html as _h

        return _h.escape(fragment)

    # 注：lxml.html.clean 在新版已拆成独立包（lxml_html_clean），
    # 这里不依赖它 —— 白名单是自己实现的，行为可预期，也不多一个依赖。
    _drop_dangerous(root)
    _clean_tree(root)

    try:
        inner = root.text or ""
        inner += "".join(
            lxml_html.tostring(c, encoding="unicode") for c in root.iterchildren()
        )
        return inner.strip()
    except Exception:
        return ""


def sanitize_or_text(fragment: str) -> str:
    """有标签就清洗后返回；全是文本就转义。界面上按需选用。"""
    s = (fragment or "").strip()
    if not s:
        return ""
    if "<" in s and ">" in s:
        return sanitize_html(s)
    import html as _h

    return _h.escape(s)
