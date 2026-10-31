import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { buildIndex, search, type SearchHit } from '../../core/search/searchIndex';
import { db } from '../../core/repo/db';
import { useUI } from '../../app/store';
import { Empty } from '../../ui/primitives';
import { Icon } from '../../ui/Icon';
import { AskPanel } from './AskPanel';
import { SemanticPanel } from './SemanticPanel';
import { ScopeChips } from './ScopeChips';
import { loadScopes, saveScopes, type Scope } from './scope';
import { expandAndSearch } from '../../core/adapters/ai/ask';
import { pullFeed, feedAvailable, type FeedDoc } from '../../core/aggregator/client';
import { openPath } from '../../core/adapters/desktop';

const REWRITE_KEY = 'search.rewrite';

function loadRewrite(): boolean {
  try {
    return localStorage.getItem(REWRITE_KEY) === '1';
  } catch {
    return false;
  }
}

export function SearchView() {
  const revision = useUI((s) => s.revision);
  const openEdit = useUI((s) => s.openEdit);
  const openNote = useUI((s) => s.openNote);
  const setView = useUI((s) => s.setView);
  const toast = useUI((s) => s.toast);
  const [q, setQ] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(() => loadScopes());
  const [mode, setMode] = useState<'fulltext' | 'semantic' | 'ask'>('fulltext');
  const [rewrite, setRewrite] = useState<boolean>(() => loadRewrite());

  /* ---- 信息流快照 ---- */
  const [feed, setFeed] = useState<FeedDoc[]>([]);
  const [feedAt, setFeedAt] = useState('');
  const [feedFresh, setFeedFresh] = useState(false);
  const [feedNote, setFeedNote] = useState('');

  const items = useLiveQuery(() => db.items.toArray(), [revision]);
  const notes = useLiveQuery(() => db.notes.toArray(), [revision]);
  const attachments = useLiveQuery(() => db.attachments.toArray(), [revision]);

  // 每次进搜索页拉一次信息流（用户选的"每次进搜索页自动拉"）。
  // 拉不到就用本地旧快照，并把时间标出来 —— 服务没起是常态，不是错误。
  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await pullFeed();
      if (!alive) return;
      setFeed(r.docs);
      setFeedAt(r.at);
      setFeedFresh(r.fresh);
      setFeedNote(
        r.fresh
          ? ''
          : r.error
            ? `聚合服务没响应（${r.error}）${r.at ? '，显示的是上次快照' : ''}`
            : '显示的是上次快照',
      );
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function refreshFeed() {
    const r = await pullFeed();
    setFeed(r.docs);
    setFeedAt(r.at);
    setFeedFresh(r.fresh);
    setFeedNote(r.fresh ? '已更新' : (r.error ?? '没拉到'));
    toast(r.fresh ? `信息流已更新（${r.docs.length} 条）` : `没拉到：${r.error}`, r.fresh ? 'ok' : 'warn');
  }

  // 数据变更后重建索引（几千条内耗时可忽略）
  useEffect(() => {
    if (items && notes) buildIndex(items, notes, attachments ?? [], feed);
  }, [items, notes, attachments, feed]);

  /* ---- 基础命中 ---- */
  const baseHits: SearchHit[] = useMemo(() => {
    if (!q.trim()) return [];
    return search(q, 60, scopes);
  }, [q, scopes, revision, feed]);

  /* ---- 查询改写（默认关，联网才生效）---- */
  const [expandedHits, setExpandedHits] = useState<SearchHit[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [rewriting, setRewriting] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (!rewrite || !q.trim()) {
      setExpandedHits([]);
      setKeywords([]);
      return;
    }
    timer.current = window.setTimeout(async () => {
      setRewriting(true);
      try {
        const r = await expandAndSearch(q, { kinds: scopes, limit: 12 });
        setKeywords(r.keywords);
        setExpandedHits(
          r.hits.map((h) => ({
            id: `${h.kind}:${h.id}`,
            kind: h.kind === 'item' ? 'item' : h.kind === 'note' ? 'note' : 'feed',
            refId: h.id,
            title: h.title,
            typeLabel: h.typeLabel,
            snippet: h.snippet,
            score: h.score ?? 0,
          })),
        );
        if (r.reason) toast(`没能扩写关键词：${r.reason}`, 'warn');
      } finally {
        setRewriting(false);
      }
    }, 800);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [q, rewrite, scopes, revision, feed]);

  // 合并：基础命中优先，改写补进来的去重后排后面
  const hits: SearchHit[] = useMemo(() => {
    const seen = new Set(baseHits.map((h) => `${h.kind}:${h.refId}`));
    const extra = expandedHits.filter((h) => !seen.has(`${h.kind}:${h.refId}`));
    return [...baseHits, ...extra].slice(0, 60);
  }, [baseHits, expandedHits]);

  function changeScopes(s: Scope[]) {
    setScopes(s);
    saveScopes(s);
  }

  function toggleRewrite() {
    const v = !rewrite;
    setRewrite(v);
    try {
      localStorage.setItem(REWRITE_KEY, v ? '1' : '0');
    } catch {
      /* 忽略 */
    }
  }

  const counts: Partial<Record<Scope, number>> = {
    item: items?.filter((i) => !i.deletedAt).length ?? 0,
    note: notes?.filter((n) => !n.deletedAt).length ?? 0,
    attachment: attachments?.filter((a) => !a.deletedAt && a.extractedText).length ?? 0,
    feed: feed.length,
  };
  const disabledScopes: Partial<Record<Scope, string>> = feedAvailable()
    ? {}
    : { feed: '只有桌面版能访问本机的聚合服务' };

  function openHit(h: SearchHit) {
    if (h.kind === 'item') openEdit(h.refId);
    else if (h.kind === 'note') openNote(h.refId);
    else if (h.kind === 'attachment') setView('attachments');
    else {
      // 信息流：桌面端一律走系统打开（WebView 自己不处理外链）
      const doc = feed.find((f) => f.refId === String(h.refId));
      if (doc?.url) void openPath(doc.url);
      else toast('这条没有链接', 'warn');
    }
  }

  return (
    <div className="p-4 max-w-3xl mx-auto">
      <div className="flex items-end justify-between mb-3">
        <div>
          <h1 className="text-lg font-semibold">搜索</h1>
          <p className="text-xs text-fg-dim mt-0.5">
            全文检索在本地索引；问答只把命中的片段发给模型，可在设置里完全关闭。
          </p>
        </div>
        <div className="flex rounded-md bg-bg-elev border border-line p-0.5">
          {(
            [
              { v: 'fulltext', l: '全文' },
              { v: 'semantic', l: '语义' },
              { v: 'ask', l: '问答' },
            ] as const
          ).map((o) => (
            <button
              key={o.v}
              className={`px-3 py-1 rounded text-xs ${
                mode === o.v ? 'bg-accent text-white' : 'text-fg-muted hover:text-fg'
              }`}
              onClick={() => setMode(o.v)}
            >
              {o.l}
            </button>
          ))}
        </div>
      </div>

      {/* 范围选择：三个 tab 共用 */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ScopeChips value={scopes} onChange={changeScopes} counts={counts} disabled={disabledScopes} />
        <div className="flex-1" />
        {scopes.includes('feed') && (
          <button className="btn btn-ghost text-[11px]" onClick={() => void refreshFeed()}>
            <Icon name="RefreshCw" size={12} /> 刷新信息流
          </button>
        )}
      </div>

      {mode === 'ask' ? (
        <AskPanel scopes={scopes} feed={feed} onScopesChange={changeScopes} />
      ) : mode === 'semantic' ? (
        <SemanticPanel scopes={scopes} feed={feed} feedAt={feedAt} />
      ) : (
        <>
          <div className="flex items-center gap-2 mb-2">
            <div className="relative flex-1">
              <span className="absolute left-2.5 top-2.5 text-fg-dim pointer-events-none">
                <Icon name="Search" size={14} />
              </span>
              <input
                className="field pl-8"
                placeholder="搜标题、正文、备注…（中文按二字组合匹配）"
                value={q}
                autoFocus
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <label className="flex items-center gap-1.5 text-[11px] text-fg-dim cursor-pointer select-none">
              <input type="checkbox" checked={rewrite} onChange={toggleRewrite} />
              智能改写
            </label>
          </div>

          <div className="mb-3 text-[11px] text-fg-dim">
            {rewrite ? (
              rewriting ? (
                <span>正在改写查询…</span>
              ) : keywords.length ? (
                <span className="flex flex-wrap items-center gap-1">
                  <span>扩写：</span>
                  {keywords.map((k) => (
                    <span key={k} className="chip border-line text-[10px]">
                      {k}
                    </span>
                  ))}
                </span>
              ) : (
                <span>智能改写已开启（需要联网，不上传正文，只发送你的问题）</span>
              )
            ) : (
              <span>勾选「智能改写」可让模型把问法扩成同义词再搜（联网，默认关）</span>
            )}
          </div>

          {!q.trim() ? (
            <Empty text="输入关键词开始搜索" hint="数据全部在本机索引，不上传" />
          ) : hits.length === 0 ? (
            <Empty text={`没有找到与「${q}」相关的内容`} />
          ) : (
            <div className="card divide-y divide-line">
              {hits.map((h) => (
                <button
                  key={`${h.kind}:${h.refId}`}
                  className="w-full text-left px-3 py-2.5 hover:bg-bg-hover"
                  onClick={() => openHit(h)}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="chip border-line text-[10px]">
                      {h.kind === 'feed' ? h.typeLabel : h.typeLabel}
                    </span>
                    <span className="text-sm truncate">{h.title}</span>
                    {h.kind === 'feed' && <span className="text-[10px] text-fg-dim">↗</span>}
                  </div>
                  {h.snippet && (
                    <div className="text-[11px] text-fg-dim mt-0.5 line-clamp-2 break-words">
                      {h.snippet}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}

          <div className="mt-4 text-[11px] text-fg-dim">
            索引:日程 {counts.item ?? 0} 条 · 笔记 {counts.note ?? 0} 篇 · 附件{' '}
            {counts.attachment ?? 0} 份 · 信息流 {counts.feed ?? 0} 条
            {feedAt ? (
              <span className={feedFresh ? '' : 'text-[#f0a13c]'}>
                {' '}
                （{feedFresh ? '刚更新' : `快照 ${new Date(feedAt).toLocaleString('zh-CN')}`}）
              </span>
            ) : null}
            {scopes.includes('feed') && feedNote ? (
              <div className="text-[#f0a13c] mt-0.5">{feedNote}</div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
