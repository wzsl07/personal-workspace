import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../ui/Icon';

/**
 * 信息流：读取本机的「信息聚合」服务（Python，默认 http://127.0.0.1:8787）。
 *
 * 为什么是读本机服务而不是自己抓：
 * 定时抓取需要一个常驻进程，浏览器（含 PWA）关掉就不跑了；
 * 而且绝大多数站点不给 CORS 头，前端直连必然失败。所以抓取交给那个服务，
 * 这里只负责展示。
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

interface AggSource {
  id: number;
  name: string;
  type: string;
  enabled: boolean;
  health: string;
  item_count: number;
  last_fetched_at: string | null;
  last_error: string | null;
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

const HEALTH: Record<string, string> = {
  ok: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  failing: 'bg-red-500',
  disabled: 'bg-gray-400',
  unknown: 'bg-gray-400',
};

export function AggregatorView() {
  const [base, setBase] = useState(loadBase);
  const [online, setOnline] = useState<boolean | null>(null);   // null=检查中
  const [sources, setSources] = useState<AggSource[]>([]);
  const [items, setItems] = useState<AggItem[]>([]);
  const [cur, setCur] = useState<number | null>(null);
  const [sec, setSec] = useState('');
  const [q, setQ] = useState('');
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [onlyStarred, setOnlyStarred] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const api = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(`${base}${path}`, init);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
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

  async function fetchNow(id: number) {
    setMsg('抓取中…');
    try {
      const r = await api(`/api/sources/${id}/fetch`, { method: 'POST' });
      setMsg(`找到 ${r.found} 条，新增 ${r.new} 条`);
      await loadSources();
      await loadItems();
    } catch {
      setMsg('抓取失败');
    }
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
        <div className="text-[11px] text-fg-dim">
          注意：手机上用不了这个功能 —— 手机访问不到你电脑的 127.0.0.1。
        </div>
      </div>
    );
  }

  const curSource = sources.find((s) => s.id === cur);

  return (
    <div className="flex h-full">
      {/* 左：来源列表，点一下主界面就切成它的内容 */}
      <div className="w-64 shrink-0 border-r border-line overflow-y-auto p-3 space-y-2">
        <button
          className={`w-full text-left px-2 py-1.5 rounded text-[13px] ${
            cur === null ? 'bg-accent/15 text-accent' : 'text-fg-muted'
          }`}
          onClick={() => {
            setCur(null);
            setSec('');
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
              }}
            >
              <div className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${HEALTH[s.health] ?? 'bg-gray-400'}`} />
                <span className="text-[13px] truncate">{s.name}</span>
                <span className="text-[11px] text-fg-dim ml-auto">{s.item_count}</span>
              </div>
              <div className="text-[11px] text-fg-dim">
                {s.type} · 上次 {s.last_fetched_at ? s.last_fetched_at.slice(5, 16).replace('T', ' ') : '从未'}
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
        {sources.length === 0 && online && (
          <div className="text-[11px] text-fg-dim px-2">还没有来源，去聚合页面添加。</div>
        )}
      </div>

      {/* 右：时间流 */}
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
            <input type="checkbox" checked={onlyUnread} onChange={(e) => setOnlyUnread(e.target.checked)} />
            未读
          </label>
          <label className="text-[11px] text-fg-muted flex items-center gap-1">
            <input type="checkbox" checked={onlyStarred} onChange={(e) => setOnlyStarred(e.target.checked)} />
            收藏
          </label>
          <button className="btn text-xs" onClick={() => void loadItems()} disabled={busy}>
            <Icon name="RefreshCw" size={13} /> 刷新
          </button>
          {cur && (
            <button className="btn text-xs" onClick={() => void fetchNow(cur)}>
              <Icon name="Download" size={13} /> 抓这个源
            </button>
          )}
          <a
            className="btn text-xs btn-ghost"
            href={base}
            target="_blank"
            rel="noopener noreferrer"
          >
            管理来源 <Icon name="ExternalLink" size={12} />
          </a>
        </div>

        {msg && <div className="text-[11px] text-fg-muted mb-2">{msg}</div>}

        <div className="space-y-3">
          {items.map((it) => (
            <div key={it.id} className="border-b border-line pb-3">
              <a
                href={it.url || undefined}
                target="_blank"
                rel="noopener noreferrer"
                className={`text-[13px] ${it.read_at ? 'text-fg-muted' : 'text-fg font-medium'}`}
                onClick={() => void setState(it, { read: true })}
              >
                {it.title}
              </a>
              <div className="text-[11px] text-fg-dim mt-0.5">
                <span className="chip mr-1">{it.source_name}</span>
                {it.section && <span className="chip mr-1">{it.section}</span>}
                {(it.published_at || it.discovered_at).slice(0, 16).replace('T', ' ')}
              </div>
              {it.summary && (
                <div className="text-[12px] text-fg-muted mt-1 line-clamp-2">{it.summary}</div>
              )}
              <div className="flex gap-2 mt-1">
                <button className="btn btn-ghost text-[11px]" onClick={() => void setState(it, { starred: !it.starred })}>
                  {it.starred ? '★ 已收藏' : '☆ 收藏'}
                </button>
                <button className="btn btn-ghost text-[11px]" onClick={() => void setState(it, { read: !it.read_at })}>
                  {it.read_at ? '标为未读' : '标为已读'}
                </button>
              </div>
            </div>
          ))}
          {items.length === 0 && !busy && (
            <div className="text-[12px] text-fg-dim">没有符合条件的条目。</div>
          )}
        </div>
      </div>
    </div>
  );
}
