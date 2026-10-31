import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { invoke, isTauri, openPath, saveTextFile } from '../../core/adapters/desktop';
import { cloudBlockReason, cloudReady, loadConfig } from '../../core/adapters/ai';
import { chatText } from '../../core/adapters/ai/openaiCompat';

/**
 * 信息流：读取本机的「信息聚合」服务（Python，默认 http://127.0.0.1:8787）。
 *
 * 为什么是读本机服务而不是自己抓：
 * 定时抓取需要一个常驻进程，浏览器（含 PWA）关掉就不跑了；
 * 而且绝大多数站点不给 CORS 头，前端直连必然失败。所以抓取交给那个服务，
 * 这里只负责展示。
 *
 * 为什么来源管理也做在这个页面里（而不是跳到浏览器）：
 * 1. Tauri 的 WebView 不处理 <a target="_blank">，点了没反应；
 * 2. 靠系统默认程序打开也不稳（explorer 传 URL 未必弹浏览器）；
 * 3. 更根本的是——能在一个界面里做完的事，就不该让人换窗口。
 *    所以新增 / 编辑规则 / 启停 / 日志 / 删除全都在这里完成。
 *
 * 因此**只有桌面版能用到它**（手机上访问不到你电脑的 127.0.0.1），
 * 服务没启动时要给出清楚的说明，而不是白屏或报错。
 */

const DEFAULT_BASE = 'http://127.0.0.1:8787';

function loadBase(): string {
  try {
    return localStorage.getItem('aggregator.base') || DEFAULT_BASE;
  } catch {
    return DEFAULT_BASE;
  }
}

/** 聚合服务启动脚本的位置（桌面端用来一键拉起服务） */
function loadLauncher(): string {
  try {
    return localStorage.getItem('aggregator.launcher') || '';
  } catch {
    return '';
  }
}

interface AggSource {
  id: number;
  name: string;
  type: string;
  url: string;
  enabled: boolean;
  health: string;
  health_text?: string;
  isolated?: boolean;
  interval_sec: number;
  item_count: number;
  last_fetched_at: string | null;
  last_error: string | null;
  parser_config?: unknown;
  sections: { name: string; count: number }[];
}

interface AggItem {
  id: number;
  source_id: number;
  source_name: string;
  section: string;
  title: string;
  url: string;
  summary: string;
  published_at: string | null;
  discovered_at: string;
  read_at: string | null;
  starred: boolean;
}

interface RunRow {
  started_at: string;
  status: string;
  http_status: number | null;
  duration_ms: number | null;
  items_found: number;
  items_new: number;
  error_message: string | null;
}

const HEALTH: Record<string, string> = {
  ok: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  failing: 'bg-red-500',
  disabled: 'bg-gray-400',
  unknown: 'bg-gray-400',
};

const HEALTH_TEXT: Record<string, string> = {
  ok: '正常',
  degraded: '降级',
  failing: '失败',
  disabled: '已暂停',
  unknown: '未知',
};

export function AggregatorView() {
  const [base, setBase] = useState(loadBase);
  const [online, setOnline] = useState<boolean | null>(null);
  const [sources, setSources] = useState<AggSource[]>([]);
  const [items, setItems] = useState<AggItem[]>([]);
  const [cur, setCur] = useState<number | null>(null);
  const [sec, setSec] = useState('');
  const [q, setQ] = useState('');
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [onlyStarred, setOnlyStarred] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  /** 内嵌面板：null | 'edit' | 'runs' | 'new' | 'opml' */
  const [panel, setPanel] = useState<null | 'edit' | 'runs' | 'new' | 'opml'>(null);
  const [cfgText, setCfgText] = useState('');
  const [testOut, setTestOut] = useState('');
  const [runs, setRuns] = useState<RunRow[]>([]);

  /** 新增来源表单 */
  const [newUrl, setNewUrl] = useState('');
  const [newName, setNewName] = useState('');
  const [newTags, setNewTags] = useState('');
  const [newInterval, setNewInterval] = useState('15');
  const [newCfg, setNewCfg] = useState('');
  const [newType, setNewType] = useState('');
  const [newPreview, setNewPreview] = useState<{ title: string }[]>([]);
  const [opmlText, setOpmlText] = useState('');

  /** 展开的条目 id 与它的 AI 摘要 */
  const [summaryFor, setSummaryFor] = useState<number | null>(null);
  const [summaryText, setSummaryText] = useState('');
  /** 打开网址失败时摆出来给人复制的地址 */
  const [openFail, setOpenFail] = useState('');
  /** 启动脚本路径（桌面端可以一键拉起服务，省得去资源管理器里找） */
  const [launcher, setLauncher] = useState(loadLauncher);
  const [starting, setStarting] = useState(false);

  /** 重命名：正在改哪个来源、输入框内容 */
  const [renameId, setRenameId] = useState<number | null>(null);
  const [renameText, setRenameText] = useState('');

  /** 右侧「显示原文」抽屉 */
  const [reader, setReader] = useState<{
    title: string;
    url: string;
    source: string;
    html: string;
    loading: boolean;
    error: string;
  } | null>(null);

  const api = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(`${base}${path}`, init);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get('content-type') || '';
      return ct.includes('application/json') ? res.json() : res.text();
    },
    [base],
  );

  const check = useCallback(async () => {
    try {
      await api('/api/status');
      setOnline(true);
      return true;
    } catch {
      setOnline(false);
      return false;
    }
  }, [api]);

  const loadSources = useCallback(async () => {
    try {
      setSources(await api('/api/sources'));
    } catch {
      setSources([]);
    }
  }, [api]);

  const loadItems = useCallback(async () => {
    setBusy(true);
    try {
      const p = new URLSearchParams({ limit: '80' });
      if (cur) p.set('source_id', String(cur));
      if (sec) p.set('section', sec);
      if (q) p.set('q', q);
      if (onlyUnread) p.set('only_unread', '1');
      if (onlyStarred) p.set('only_starred', '1');
      setItems(await api(`/api/items?${p}`));
    } catch {
      setItems([]);
    } finally {
      setBusy(false);
    }
  }, [api, cur, sec, q, onlyUnread, onlyStarred]);

  useEffect(() => {
    void (async () => {
      if (await check()) await loadSources();
    })();
  }, [check, loadSources]);

  useEffect(() => {
    if (online) void loadItems();
  }, [online, loadItems]);

  const curSource = sources.find((s) => s.id === cur) ?? null;

  /* ---------------- 条目的 AI 摘要与打开网址 ---------------- */

  /** 打开网址：WebView 里 target=_blank 点了没反应，必须走系统默认浏览器 */
  async function openArticle(url: string) {
    if (!url) return;
    const ok = await openPath(url);
    if (!ok) {
      // 光提示一句没用 —— 用户还得手打这串网址。
      // 直接把地址摆出来让他复制。
      setOpenFail(url);
      setMsg('没能自动打开浏览器，下面是完整地址，可以复制后粘贴到浏览器');
    } else {
      setOpenFail('');
    }
  }

  /** 在工作台里直接看原文：正文由聚合服务抓取并清洗，前端只负责显示 */
  async function showArticle(item: AggItem) {
    setReader({
      title: item.title,
      url: item.url,
      source: item.source_name,
      html: '',
      loading: true,
      error: '',
    });
    try {
      const a = await api(`/api/items/${item.id}/article`, { method: 'POST' });
      if (!a?.ok) {
        setReader((r) =>
          r
            ? { ...r, loading: false, error: a?.error || '取不到正文' }
            : r,
        );
        return;
      }
      setReader((r) => (r ? { ...r, loading: false, html: a.html || '' } : r));
    } catch (e) {
      setReader((r) =>
        r ? { ...r, loading: false, error: e instanceof Error ? e.message : String(e) } : r,
      );
    }
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMsg('已复制到剪贴板');
    } catch {
      setMsg('复制失败，请手动选中下面的地址');
    }
  }

  async function summarize(item: AggItem) {
    setSummaryFor(item.id);
    setSummaryText('正在生成…');
    try {
      const cfg = await loadConfig();
      if (!cloudReady(cfg)) {
        setSummaryText(`AI 不可用：${cloudBlockReason(cfg)}（到「设置 → AI 解析」里配置）`);
        return;
      }
      // 先尽量拿到正文：聚合服务那边取，不受浏览器跨域限制
      let body = `标题：${item.title}\n`;
      if (item.summary) body += `已有摘要：${item.summary}\n`;
      try {
        const a = await api(`/api/items/${item.id}/article`, { method: 'POST' });
        if (a?.ok && a.text) {
          body += `\n正文：\n${a.text}`;
        } else if (a?.error) {
          body += `\n（取不到正文：${a.error}）`;
        }
      } catch {
        /* 取不到正文就用标题+摘要，不阻断 */
      }
      setSummaryText('正在让 AI 阅读…');
      const out = await chatText(
        cfg,
        '你是给大学生看的通知助手。用中文写，不超过 120 字，只讲这条通知讲了什么、' +
          '谁要注意、有没有截止时间。不要复述原文，不要加客套话。如果信息不足够，' +
          '就基于已有内容给出最合理的概括，不要编造具体日期和数字。',
        body,
      );
      setSummaryText(out || 'AI 没返回内容');
    } catch (e) {
      setSummaryText(`生成失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /* ---------------- 条目状态 ---------------- */

  async function setState(item: AggItem, patch: { read?: boolean; starred?: boolean }) {
    try {
      await api(`/api/items/${item.id}/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      void loadItems();
    } catch {
      setMsg('操作失败，聚合服务可能已停止');
    }
  }

  /* ---------------- 来源操作 ---------------- */

  async function fetchNow(id: number) {
    setMsg('抓取中…');
    try {
      const r = await api(`/api/sources/${id}/fetch`, { method: 'POST' });
      setMsg(r.not_modified ? '内容没有变化（304），已跳过' : `找到 ${r.found} 条，新增 ${r.new} 条`);
      await loadSources();
      await loadItems();
    } catch {
      setMsg('抓取失败');
    }
  }

  async function retry(id: number) {
    setMsg('重试中…');
    try {
      await api(`/api/sources/${id}/retry`, { method: 'POST' });
      setMsg('已清零失败计数并重新启用');
      await loadSources();
    } catch {
      setMsg('重试失败');
    }
  }

  async function toggleEnabled(id: number, enabled: boolean) {
    try {
      await api(`/api/sources/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      setMsg(enabled ? '已启用' : '已暂停');
      await loadSources();
    } catch {
      setMsg('操作失败');
    }
  }

  async function delSource(id: number) {
    const s = sources.find((x) => x.id === id);
    const label = s ? `「${s.name}」` : '这个来源';
    if (!window.confirm(`删除${label}？它的条目会一起删掉，不可恢复。`)) return;
    setMsg('删除中…');
    try {
      await api(`/api/sources/${id}`, { method: 'DELETE' });
      setCur(null);
      setSec('');
      setPanel(null);
      await loadSources();
      await loadItems();
      setMsg(`已删除${label}`);
    } catch {
      setMsg('删除失败，聚合服务可能已停止');
    }
  }

  /* ---------------- 编辑规则 ---------------- */

  function openEdit(s: AggSource) {
    setCfgText(JSON.stringify(s.parser_config ?? { version: 1 }, null, 2));
    setTestOut('');
    setRenameId(null);
    setPanel('edit');
  }

  async function testCfg(id: number, text: string, apply: boolean) {
    setMsg(apply ? '保存并测试中…' : '测试中…');
    try {
      if (apply) {
        const cfg = JSON.parse(text);
        await api(`/api/sources/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parser_config: cfg }),
        });
      }
      const r = await api(`/api/sources/${id}/test`, { method: 'POST' });
      if (!r.ok) {
        setTestOut(`失败：${r.error ?? '未知原因'}`);
      } else {
        const lines = [
          `抽出 ${r.count} 条 · HTTP ${r.http_status} · ${r.duration_ms}ms · ${r.bytes} 字节`,
          r.sections?.length ? `栏目：${r.sections.join('、')}` : '',
          ...(r.items ?? []).slice(0, 5).map((it: { title: string }) => `· ${it.title}`),
        ];
        setTestOut(lines.filter(Boolean).join('\n'));
      }
      setMsg(apply ? '规则已保存' : '测试完成');
      await loadSources();
      await loadItems();
    } catch (e) {
      setTestOut(`出错：${e instanceof Error ? e.message : String(e)}`);
      setMsg('');
    }
  }

  /* ---------------- 日志 ---------------- */

  async function openRuns(id: number) {
    setPanel('runs');
    try {
      setRuns(await api(`/api/sources/${id}/runs?limit=15`));
    } catch {
      setRuns([]);
    }
  }

  /* ---------------- 新增来源 ---------------- */

  async function doDetect() {
    if (!newUrl.trim()) return;
    setMsg('探测中…');
    try {
      // 先做安全预检：内网地址当场说清楚，别让人猜
      const chk = await api('/api/security/check-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: newUrl.trim(), check_robots: false }),
      });
      if (chk && chk.safe === false) {
        setMsg(`这个网址不能用：${chk.reason}`);
        return;
      }
      const r = await api('/api/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: newUrl.trim() }),
      });
      if (!r.ok) {
        setMsg(`自动探测失败：${r.reason ?? '未知原因'}`);
        return;
      }
      setNewType(r.type);
      setNewCfg(JSON.stringify(r.parser_config ?? {}, null, 2));
      // 服务端现在会返回网页标题，用它当默认名比一串网址好认
      setNewName(r.title || r.url || newUrl.trim());
      setNewPreview(r.preview ?? []);
      setMsg(`识别为 ${r.type}，确认后点保存`);
    } catch {
      setMsg('探测失败，聚合服务可能已停止');
    }
  }

  async function saveNew() {
    if (!newUrl.trim()) return;
    setMsg('保存中…');
    try {
      const body: Record<string, unknown> = {
        url: newUrl.trim(),
        name: newName.trim() || newUrl.trim(),
      };
      if (newType) body.type = newType;
      if (newCfg.trim()) {
        try {
          body.parser_config = JSON.parse(newCfg);
        } catch {
          setMsg('规则 JSON 格式不对，请检查后再保存');
          return;
        }
      }
      body.interval_sec = Math.max(5, Number(newInterval) || 15) * 60;
      body.tags = newTags.trim();
      const s = await api('/api/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setPanel(null);
      setNewUrl('');
      setNewName('');
      setNewTags('');
      setNewCfg('');
      setNewType('');
      setNewPreview([]);
      await loadSources();
      if (s?.id) await fetchNow(s.id);
      setMsg('已添加并抓取了一次');
    } catch {
      setMsg('保存失败');
    }
  }

  /* ---------------- OPML ---------------- */

  async function exportOpml() {
    try {
      const xml = await api('/api/opml');
      const text = typeof xml === 'string' ? xml : String(xml);
      // 桌面端不能用浏览器下载（Blob + a[download] 在 WebView 里会被吞掉），
      // 必须走原生「另存为」对话框。
      const saved = await saveTextFile('sources.opml', text);
      if (saved) setMsg(`已导出到：${saved}`);
      else if (saved === false) setMsg('导出失败或已取消');
      else setMsg('已导出');
    } catch {
      setMsg('导出失败');
    }
  }

  async function importOpml() {
    if (!opmlText.trim()) return;
    setMsg('导入中…');
    try {
      const r = await api('/api/opml', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: opmlText }),
      });
      setOpmlText('');
      setPanel(null);
      await loadSources();
      setMsg(`导入完成：新增 ${r.added} 个，跳过 ${r.skipped} 个（已存在的会跳过）`);
    } catch {
      setMsg('导入失败');
    }
  }

  /** 兜底：真需要用浏览器打开时走系统默认程序 */
  async function openManage() {
    const ok = await openPath(base);
    if (!ok) setMsg(`没能自动打开浏览器，请手动访问：${base}`);
  }

  /** 给来源改个好认的名字 */
  async function renameSource(id: number, name: string) {
    const v = name.trim();
    if (!v) return;
    try {
      await api(`/api/sources/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: v }),
      });
      setRenameId(null);
      setRenameText('');
      setMsg('已重命名');
      await loadSources();
    } catch {
      setMsg('重命名失败');
    }
  }

  /** 名字还是一串网址的来源：抓一下网页标题来命名 */
  async function autoName(s: AggSource) {
    setMsg('正在取网页标题…');
    try {
      const r = await api('/api/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: s.url }),
      });
      const t = (r?.title || '').trim();
      if (!t) {
        setMsg('没取到标题，可以手动重命名');
        return;
      }
      await renameSource(s.id, t);
    } catch {
      setMsg('取标题失败，可以手动重命名');
    }
  }

  /** 没填过启动脚本位置时，让 Rust 在常见目录里找一次 */
  useEffect(() => {
    if (!isTauri() || launcher) return;
    void (async () => {
      try {
        const found = await invoke<string | null>('find_aggregator_launcher_cmd');
        if (found) {
          setLauncher(found);
          try {
            localStorage.setItem('aggregator.launcher', found);
          } catch {
            /* 隐私模式，忽略 */
          }
        }
      } catch {
        /* 找不到就让用户在界面上手填 */
      }
    })();
  }, [launcher]);

  /** 一键启动聚合服务，然后反复探测直到它起来 */
  async function startService() {
    if (!launcher.trim()) {
      setMsg('请先填启动脚本的路径（一般是 aggregator 目录下的「启动工作台.bat」）');
      return;
    }
    setStarting(true);
    setMsg('正在启动服务…');
    try {
      await invoke('start_aggregator_cmd', { path: launcher.trim() });
    } catch (e) {
      setStarting(false);
      setMsg(`启动失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // 服务启动需要几秒，轮询等待而不是让用户自己再点一次「重试连接」
    for (let i = 0; i < 12; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      if (await check()) {
        await loadSources();
        setMsg('服务已启动');
        setStarting(false);
        return;
      }
    }
    setStarting(false);
    setMsg('等了 24 秒还是连不上 —— 看看那个黑窗口里有没有报错');
  }

  function saveBase(v: string) {
    setBase(v);
    try {
      localStorage.setItem('aggregator.base', v);
    } catch {
      /* 隐私模式下写不了，忽略即可 */
    }
  }

  /* ---------- 服务没启动时的说明 ---------- */
  if (online === false) {
    return (
      <div className="p-6 space-y-3">
        <h2 className="text-sm font-medium">信息流</h2>
        <div className="rounded border border-line bg-panel p-4 text-[13px] leading-6">
          <b>信息聚合服务没启动。</b>
          <br />
          它是一台跑在你电脑上的小服务，负责定时抓取 RSS 和网页公告 ——
          浏览器页面做不到定时任务，所以必须有个常驻进程。
        </div>
        <div className="text-[13px] leading-6">
          启动方法：打开
          <code className="mx-1 px-1 border border-line rounded">
            WorkBuddy日常管理库\aggregator
          </code>
          目录，双击 <b>启动工作台.bat</b>（或在该目录里执行 <code>python main.py</code>）。
        </div>
        <div className="flex items-center gap-2">
          <input
            className="field flex-1"
            value={base}
            onChange={(e) => saveBase(e.target.value)}
            placeholder={DEFAULT_BASE}
          />
          <button className="btn btn-primary" onClick={() => void check()}>
            <Icon name="RefreshCw" size={14} /> 重试连接
          </button>
        </div>

        {isTauri() && (
          <div className="rounded border border-line bg-panel p-3 space-y-2">
            <div className="text-[13px] font-medium">或者，在这里直接启动它</div>
            <div className="text-[11px] text-fg-dim">
              下面是启动脚本的位置。一般不用改；如果你的项目放在别处，就改成那里的
              「启动工作台.bat」。
            </div>
            <div className="flex items-center gap-2">
              <input
                className="field flex-1 font-mono text-[11px]"
                value={launcher}
                onChange={(e) => {
                  setLauncher(e.target.value);
                  try {
                    localStorage.setItem('aggregator.launcher', e.target.value);
                  } catch {
                    /* 隐私模式，忽略 */
                  }
                }}
                placeholder="...\aggregator\启动工作台.bat"
              />
              <button className="btn btn-primary" onClick={() => void startService()} disabled={starting}>
                {starting ? '启动中…' : '▶ 启动聚合服务'}
              </button>
            </div>
            <div className="text-[11px] text-fg-dim">
              点了之后会开一个黑窗口（那就是服务在跑），关掉它就停止抓取。
            </div>
          </div>
        )}

        <div className="text-[11px] text-fg-dim">
          注意：手机上用不了这个功能 —— 手机访问不到你电脑的 127.0.0.1。
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full relative">
      {/* 左：来源列表，点一下主界面就切成它的内容 */}
      <div className="w-64 shrink-0 border-r border-line overflow-y-auto p-3 space-y-2">
        <button
          className={`w-full text-left px-2 py-1.5 rounded text-[13px] ${
            cur === null ? 'bg-accent/15 text-accent' : 'text-fg-muted'
          }`}
          onClick={() => {
            setCur(null);
            setSec('');
            setPanel(null);
          }}
        >
          全部来源
        </button>
        {sources.map((s) => (
          <div key={s.id}>
            <button
              className={`w-full text-left rounded border px-2 py-1.5 ${
                cur === s.id ? 'border-accent bg-accent/10' : 'border-line'
              }`}
              onClick={() => {
                setCur(cur === s.id ? null : s.id);
                setSec('');
                setPanel(null);
              }}
            >
              <div className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${HEALTH[s.health] ?? 'bg-gray-400'}`} />
                <span className="text-[13px] truncate">{s.name}</span>
                <span className="text-[11px] text-fg-dim ml-auto">{s.item_count}</span>
              </div>
              <div className="text-[11px] text-fg-dim">
                {s.type} · 上次{' '}
                {s.last_fetched_at ? s.last_fetched_at.slice(5, 16).replace('T', ' ') : '从未'}
              </div>
            </button>
            {cur === s.id && s.sections.length > 0 && (
              <div className="mt-1 pl-1">
                {s.sections.map((x) => (
                  <button
                    key={x.name || '_'}
                    className={`chip text-[11px] mr-1 mb-1 ${
                      sec === (x.name || '') ? 'border-accent text-accent' : ''
                    }`}
                    onClick={() => setSec(sec === (x.name || '') ? '' : x.name || '')}
                  >
                    {x.name || '未命名'} {x.count}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        <button
          className="w-full text-left px-2 py-1.5 rounded text-[12px] text-accent border border-dashed border-line"
          onClick={() => {
            setPanel(panel === 'new' ? null : 'new');
            setCur(null);
          }}
        >
          + 新增来源
        </button>
        {sources.length === 0 && online && (
          <div className="text-[11px] text-fg-dim px-2">还没有来源，点上面添加一个。</div>
        )}
      </div>

      {/* 右：管理面板 + 时间流 */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <h2 className="text-sm font-medium mr-1">
            {curSource ? `${curSource.name}${sec ? ' · ' + sec : ''}` : '信息流'}
          </h2>
          <input
            className="field flex-1 min-w-[140px]"
            placeholder="搜索标题 / 摘要"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <label className="text-[11px] text-fg-muted flex items-center gap-1">
            <input
              type="checkbox"
              checked={onlyUnread}
              onChange={(e) => setOnlyUnread(e.target.checked)}
            />
            未读
          </label>
          <label className="text-[11px] text-fg-muted flex items-center gap-1">
            <input
              type="checkbox"
              checked={onlyStarred}
              onChange={(e) => setOnlyStarred(e.target.checked)}
            />
            收藏
          </label>
          <button className="btn text-xs" onClick={() => void loadItems()} disabled={busy}>
            <Icon name="RefreshCw" size={13} /> 刷新
          </button>
          {isTauri() && (
            <button className="btn text-xs btn-ghost" onClick={() => void openManage()}>
              在浏览器中打开 <Icon name="ExternalLink" size={12} />
            </button>
          )}
        </div>

        {msg && <div className="text-[11px] text-fg-muted mb-2">{msg}</div>}

        {openFail && (
          <div className="flex items-center gap-2 mb-3">
            <input className="field flex-1 text-[11px] font-mono" value={openFail} readOnly />
            <button className="btn text-xs" onClick={() => void copyText(openFail)}>
              复制
            </button>
            <button className="btn text-xs btn-ghost" onClick={() => setOpenFail('')}>
              关闭
            </button>
          </div>
        )}

        {/* ---------- 选中来源后的操作区 ---------- */}
        {curSource && (
          <div className="rounded border border-line bg-panel p-3 mb-3">
            <div className="flex items-start gap-2">
              <span
                className={`w-2 h-2 mt-1.5 rounded-full ${HEALTH[curSource.health] ?? 'bg-gray-400'}`}
              />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium truncate">{curSource.name}</div>
                <div className="text-[11px] text-fg-dim">
                  {curSource.type} · {curSource.item_count} 条 · 每{' '}
                  {Math.round(curSource.interval_sec / 60)} 分钟
                </div>
                <div className="text-[11px] text-fg-dim">
                  {HEALTH_TEXT[curSource.health] ?? curSource.health}
                  {curSource.health_text ? ` — ${curSource.health_text}` : ''}
                </div>
                <div className="text-[11px] text-fg-dim truncate">{curSource.url}</div>
                {curSource.last_error && (
                  <div className="text-[11px] text-red-500 mt-0.5">{curSource.last_error}</div>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-2 mt-2">
              <button className="btn text-xs" onClick={() => void fetchNow(curSource.id)}>
                <Icon name="Download" size={13} /> 立即抓取
              </button>
              <button className="btn text-xs" onClick={() => openEdit(curSource)}>
                <Icon name="Settings" size={13} /> 编辑规则
              </button>
              <button
                className="btn text-xs"
                onClick={() => void toggleEnabled(curSource.id, !curSource.enabled)}
              >
                {curSource.enabled ? '暂停' : '启用'}
              </button>
              <button className="btn text-xs" onClick={() => void openRuns(curSource.id)}>
                <Icon name="FileText" size={13} /> 日志
              </button>
              <button
                className="btn text-xs"
                onClick={() => {
                  setRenameId(curSource.id);
                  setRenameText(curSource.name);
                }}
              >
                重命名
              </button>
              {/^https?:\/\//i.test(curSource.name) && (
                <button className="btn text-xs btn-ghost" onClick={() => void autoName(curSource)}>
                  用网页标题命名
                </button>
              )}
              {curSource.isolated && (
                <button className="btn text-xs" onClick={() => void retry(curSource.id)}>
                  <Icon name="RefreshCw" size={13} /> 重试（解除暂停）
                </button>
              )}
              <button className="btn text-xs" onClick={() => void delSource(curSource.id)}>
                <Icon name="Trash2" size={13} /> 删除
              </button>
            </div>

            {/* 重命名 */}
            {renameId === curSource.id && (
              <div className="mt-3 border-t border-line pt-3">
                <div className="text-[11px] text-fg-dim mb-1">
                  给这个来源起个好认的名字（侧边栏里显示的就是它）
                </div>
                <div className="flex gap-2">
                  <input
                    className="field flex-1"
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void renameSource(curSource.id, renameText);
                    }}
                  />
                  <button
                    className="btn text-xs btn-primary"
                    onClick={() => void renameSource(curSource.id, renameText)}
                  >
                    保存
                  </button>
                  <button
                    className="btn text-xs btn-ghost"
                    onClick={() => {
                      setRenameId(null);
                      setRenameText('');
                    }}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            {/* 编辑规则 */}
            {panel === 'edit' && (
              <div className="mt-3 border-t border-line pt-3">
                <div className="text-[11px] text-fg-dim mb-1">
                  解析规则（JSON）。改完先点「测试」看抽出什么，确认了再保存 ——
                  测试不会改动已入库的数据。
                </div>
                <textarea
                  className="field w-full font-mono text-[11px]"
                  rows={8}
                  value={cfgText}
                  onChange={(e) => setCfgText(e.target.value)}
                />
                <div className="flex gap-2 mt-2">
                  <button className="btn text-xs" onClick={() => void testCfg(curSource.id, cfgText, false)}>
                    测试
                  </button>
                  <button
                    className="btn text-xs btn-primary"
                    onClick={() => void testCfg(curSource.id, cfgText, true)}
                  >
                    保存并测试
                  </button>
                  <button className="btn text-xs btn-ghost" onClick={() => setPanel(null)}>
                    收起
                  </button>
                </div>
                {testOut && (
                  <pre className="mt-2 text-[11px] whitespace-pre-wrap bg-bg-elev p-2 rounded border border-line">
                    {testOut}
                  </pre>
                )}
              </div>
            )}

            {/* 抓取日志 */}
            {panel === 'runs' && (
              <div className="mt-3 border-t border-line pt-3">
                <div className="text-[11px] text-fg-dim mb-1">最近 15 次抓取</div>
                {runs.length === 0 ? (
                  <div className="text-[11px] text-fg-dim">还没有记录。</div>
                ) : (
                  <div className="space-y-1">
                    {runs.map((r, i) => (
                      <div key={i} className="text-[11px] text-fg-muted">
                        <span className="font-mono">{r.started_at.slice(5, 19).replace('T', ' ')}</span>
                        {' · '}
                        {r.status}
                        {' · HTTP '}
                        {r.http_status ?? '-'}
                        {' · 找到 '}
                        {r.items_found} 新增 {r.items_new}
                        {r.duration_ms != null && ` · ${r.duration_ms}ms`}
                        {r.error_message && <span className="text-red-500"> · {r.error_message}</span>}
                      </div>
                    ))}
                  </div>
                )}
                <button className="btn text-xs btn-ghost mt-2" onClick={() => setPanel(null)}>
                  收起
                </button>
              </div>
            )}
          </div>
        )}

        {/* ---------- 新增来源 ---------- */}
        {panel === 'new' && (
          <div className="rounded border border-line bg-panel p-3 mb-3">
            <div className="text-[13px] font-medium mb-2">新增来源</div>
            <div className="flex gap-2 mb-2">
              <input
                className="field flex-1"
                placeholder="粘贴网址，比如 https://sspai.com/feed 或学院公告页"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
              />
              <button className="btn text-xs" onClick={() => void doDetect()}>
                探测
              </button>
            </div>
            {newName && (
              <>
                <div className="grid grid-cols-3 gap-2 mb-2">
                  <input
                    className="field"
                    placeholder="名称"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                  <input
                    className="field"
                    placeholder="间隔（分钟，最小 5）"
                    value={newInterval}
                    onChange={(e) => setNewInterval(e.target.value)}
                  />
                  <input
                    className="field"
                    placeholder="标签，逗号分隔"
                    value={newTags}
                    onChange={(e) => setNewTags(e.target.value)}
                  />
                </div>
                {newCfg && (
                  <>
                    <div className="text-[11px] text-fg-dim mb-1">解析规则（自动生成，可以改）</div>
                    <textarea
                      className="field w-full font-mono text-[11px]"
                      rows={6}
                      value={newCfg}
                      onChange={(e) => setNewCfg(e.target.value)}
                    />
                  </>
                )}
                {newPreview.length > 0 && (
                  <div className="text-[11px] text-fg-dim mt-2">
                    预览：
                    {newPreview.slice(0, 3).map((p, i) => (
                      <div key={i} className="truncate">· {p.title}</div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2 mt-2">
                  <button className="btn text-xs btn-primary" onClick={() => void saveNew()}>
                    保存并抓一次
                  </button>
                  <button className="btn text-xs btn-ghost" onClick={() => setPanel(null)}>
                    取消
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ---------- OPML ---------- */}
        {!curSource && (
          <div className="flex gap-2 mb-3">
            <button className="btn text-xs" onClick={() => void exportOpml()}>
              导出 OPML
            </button>
            <button className="btn text-xs" onClick={() => setPanel(panel === 'opml' ? null : 'opml')}>
              导入 OPML
            </button>
          </div>
        )}
        {panel === 'opml' && (
          <div className="rounded border border-line bg-panel p-3 mb-3">
            <div className="text-[11px] text-fg-dim mb-1">
              把 OPML 内容粘贴进来（别的阅读器导出的文件可以用记事本打开后复制）。
            </div>
            <textarea
              className="field w-full font-mono text-[11px]"
              rows={6}
              value={opmlText}
              onChange={(e) => setOpmlText(e.target.value)}
            />
            <div className="flex gap-2 mt-2">
              <button className="btn text-xs btn-primary" onClick={() => void importOpml()}>
                导入
              </button>
              <button className="btn text-xs btn-ghost" onClick={() => setPanel(null)}>
                取消
              </button>
            </div>
          </div>
        )}

        {/* ---------- 时间流 ---------- */}
        <div className="space-y-3">
          {items.map((it) => (
            <div key={it.id} className="border-b border-line pb-3">
              {/*
                标题不再做成 <a target="_blank">：Tauri 的 WebView 点了没反应。
                改成就地展开——点开就生成 AI 摘要，想看完整内容再点「打开网址」。
              */}
              <button
                className={`text-[13px] text-left w-full ${
                  it.read_at ? 'text-fg-muted' : 'text-fg font-medium'
                }`}
                onClick={() => {
                  if (summaryFor === it.id) {
                    setSummaryFor(null);
                    setSummaryText('');
                  } else {
                    void setState(it, { read: true });
                    void summarize(it);
                  }
                }}
              >
                {it.title}
              </button>
              <div className="text-[11px] text-fg-dim mt-0.5">
                <span className="chip mr-1">{it.source_name}</span>
                {it.section && <span className="chip mr-1">{it.section}</span>}
                {(it.published_at || it.discovered_at).slice(0, 16).replace('T', ' ')}
              </div>
              {it.summary && summaryFor !== it.id && (
                <div className="text-[12px] text-fg-muted mt-1 line-clamp-2">{it.summary}</div>
              )}

              {summaryFor === it.id && (
                <div className="mt-2 rounded border border-line bg-bg-elev p-2">
                  <div className="text-[11px] text-fg-dim mb-1">AI 摘要</div>
                  <div className="text-[12px] leading-6 whitespace-pre-wrap">
                    {summaryText || '（空）'}
                  </div>
                  <div className="flex gap-2 mt-2">
                    {it.url && (
                      <button className="btn text-[11px]" onClick={() => void openArticle(it.url)}>
                        打开网址 <Icon name="ExternalLink" size={11} />
                      </button>
                    )}
                    <button className="btn btn-ghost text-[11px]" onClick={() => void summarize(it)}>
                      重新生成
                    </button>
                    <button
                      className="btn btn-ghost text-[11px]"
                      onClick={() => {
                        setSummaryFor(null);
                        setSummaryText('');
                      }}
                    >
                      收起
                    </button>
                  </div>
                </div>
              )}

              <div className="flex gap-2 mt-1">
                <button
                  className="btn btn-ghost text-[11px]"
                  onClick={() => void setState(it, { starred: !it.starred })}
                >
                  {it.starred ? '★ 已收藏' : '☆ 收藏'}
                </button>
                <button
                  className="btn btn-ghost text-[11px]"
                  onClick={() => void setState(it, { read: !it.read_at })}
                >
                  {it.read_at ? '标为未读' : '标为已读'}
                </button>
                <button
                  className="btn btn-ghost text-[11px]"
                  onClick={() => void showArticle(it)}
                >
                  显示原文
                </button>
                {it.url && (
                  <button
                    className="btn btn-ghost text-[11px]"
                    onClick={() => void openArticle(it.url)}
                  >
                    打开网址
                  </button>
                )}
              </div>
            </div>
          ))}
          {items.length === 0 && !busy && (
            <div className="text-[12px] text-fg-dim">没有符合条件的条目。</div>
          )}
        </div>

        {/* ---------- 右侧抽屉：在工作台里直接看原文 ---------- */}
        {reader && (
          <>
            <div
              className="absolute inset-0 bg-black/20"
              onClick={() => setReader(null)}
              aria-hidden
            />
            <div className="absolute inset-y-0 right-0 w-full max-w-[560px] flex flex-col border-l border-line bg-panel shadow-lg">
              {/* 正文是从别的网站抓来的，只给最基本的排版，避免原站样式污染界面 */}
              <style>{`
                .prose-article p{margin:6px 0}
                .prose-article img{max-width:100%;height:auto;margin:8px 0}
                .prose-article a{text-decoration:underline}
                .prose-article table{max-width:100%}
              `}</style>
              <div className="flex items-start gap-2 p-3 border-b border-line">
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium leading-5">{reader.title}</div>
                  <div className="text-[11px] text-fg-dim mt-0.5">{reader.source}</div>
                </div>
                <button className="btn btn-ghost text-[11px]" onClick={() => setReader(null)}>
                  关闭
                </button>
              </div>

              <div className="flex gap-2 px-3 py-2 border-b border-line">
                {reader.url && (
                  <button className="btn text-[11px]" onClick={() => void openArticle(reader.url)}>
                    打开网址 <Icon name="ExternalLink" size={11} />
                  </button>
                )}
                {reader.url && (
                  <button className="btn btn-ghost text-[11px]" onClick={() => void copyText(reader.url)}>
                    复制链接
                  </button>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-4">
                {reader.loading && <div className="text-[12px] text-fg-dim">正在取正文…</div>}
                {reader.error && (
                  <div className="text-[12px]">
                    <div className="text-red-500 mb-1">取不到正文</div>
                    <div className="text-fg-muted">{reader.error}</div>
                    <div className="text-fg-dim mt-2">
                      有些内容（比如 PDF）抓不出文字，用「打开网址」看原页面。
                    </div>
                  </div>
                )}
                {!reader.loading && !reader.error && reader.html && (
                  /*
                    这里的 HTML 来自聚合服务，服务端已做过白名单清洗
                    （去掉脚本、事件属性、危险协议），所以可以安全地直接渲染。
                    链接的点击走 openArticle —— WebView 里普通跳转不生效。
                  */
                  <div
                    className="text-[13px] leading-7 prose-article"
                    onClick={(e) => {
                      const a = (e.target as HTMLElement).closest('a');
                      if (a && a.getAttribute('href')) {
                        e.preventDefault();
                        void openArticle(a.getAttribute('href') as string);
                      }
                    }}
                    dangerouslySetInnerHTML={{ __html: reader.html }}
                  />
                )}
                {!reader.loading && !reader.error && !reader.html && (
                  <div className="text-[12px] text-fg-dim">这篇没有可显示的正文内容。</div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
