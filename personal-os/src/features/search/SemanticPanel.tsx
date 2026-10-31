import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../core/repo/db';
import {
  buildVectorIndex,
  clearVectors,
  collectDocs,
  vectorCount,
  vectorSearch,
  FEED_VECTOR_MAX,
  type VectorHit,
} from '../../core/search/vectorIndex';
import { checkModelDetailed, modelReady } from '../../core/adapters/embed';
import { expandAndSearch } from '../../core/adapters/ai/ask';
import { useUI } from '../../app/store';
import { Empty } from '../../ui/primitives';
import { Icon } from '../../ui/Icon';
import type { FeedDoc } from '../../core/aggregator/client';
import { openPath } from '../../core/adapters/desktop';
import type { Scope } from './scope';

/**
 * 语义搜索面板（**可选功能，默认关**）。
 *
 * 为什么默认关：它要装一个 25MB 的中文向量模型，首次建索引按每条 30–60ms 计，
 * 上千条要好几分钟。已经有"全文 + 智能改写"能覆盖大部分"按意思找"的需求，
 * 所以这里做成开关，想要的人自己开，不想要的人完全不用付出体积和等待。
 */
const IS_MOBILE =
  typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

const ON_KEY = 'search.semanticOn';

function loadOn(): boolean {
  try {
    return localStorage.getItem(ON_KEY) === '1';
  } catch {
    return false;
  }
}

export function SemanticPanel({
  scopes,
  feed,
  feedAt,
}: {
  scopes: Scope[];
  feed: FeedDoc[];
  feedAt?: string;
}) {
  const revision = useUI((s) => s.revision);
  const openEdit = useUI((s) => s.openEdit);
  const openNote = useUI((s) => s.openNote);
  const setView = useUI((s) => s.setView);
  const toast = useUI((s) => s.toast);

  const items = useLiveQuery(() => db.items.toArray(), [revision]);
  const notes = useLiveQuery(() => db.notes.toArray(), [revision]);
  const attachments = useLiveQuery(() => db.attachments.toArray(), [revision]);

  const [on, setOn] = useState<boolean>(() => loadOn());
  const [hasModel, setHasModel] = useState<boolean | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [count, setCount] = useState(0);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<VectorHit[] | null>(null);
  const [modelError, setModelError] = useState('');
  const [expanded, setExpanded] = useState<string[]>([]);

  // 只在开关打开后才去探测模型 —— 关着的时候连 24MB 的探测请求都不发
  useEffect(() => {
    if (!on) {
      setReady(modelReady());
      return;
    }
    void checkModelDetailed().then((r) => {
      setHasModel(r.ok);
      if (!r.ok) setModelError(`未检测到模型：${r.reason}`);
    });
    void vectorCount().then(setCount);
    setReady(modelReady());
  }, [on]);

  function toggleOn() {
    const v = !on;
    setOn(v);
    try {
      localStorage.setItem(ON_KEY, v ? '1' : '0');
    } catch {
      /* 忽略 */
    }
  }

  async function build() {
    if (!items || !notes) return;
    setBusy('准备中…');
    try {
      // 信息流只在勾选了"信息流"范围时才进索引（条数上限 FEED_VECTOR_MAX）
      const feedDocs = scopes.includes('feed') ? feed : [];
      const docs = collectDocs(items, notes, attachments ?? [], feedDocs);
      const r = await buildVectorIndex(docs, (p) => {
        setProgress({ done: p.done, total: p.total });
        setBusy(p.phase === 'load' ? '加载本地模型中…' : `建立索引 ${p.done}/${p.total}`);
      });
      setReady(true);
      setCount(await vectorCount());
      setBusy('');
      setProgress(null);
      toast(`索引完成：新增 ${r.added} 条，跳过未变更 ${r.skipped} 条`);
    } catch (e) {
      setBusy('');
      setProgress(null);
      const msg = e instanceof Error ? e.message : String(e);
      setModelError(msg);
      toast(msg, 'err');
    }
  }

  /** 向量模型跑不起来时的降级：让模型把问法扩成多个同义词，再走全文检索 */
  async function fallbackExpand() {
    const text = q.trim();
    if (!text) {
      toast('先在上面输入要搜的内容，再点这里改写', 'warn');
      return;
    }
    setBusy('改写查询中…');
    try {
      const r = await expandAndSearch(text, { kinds: scopes, limit: 12 });
      setExpanded(r.keywords);
      if (r.reason) toast(`没能扩写关键词：${r.reason}`, 'warn');
      setHits(
        r.hits.map((h) => ({
          id: `${h.kind}:${h.id}`,
          kind: h.kind,
          refId: h.id,
          title: h.title,
          typeLabel: h.typeLabel,
          score: h.score ?? 0,
        })),
      );
      setBusy('');
    } catch (e) {
      setBusy('');
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  }

  async function run() {
    const text = q.trim();
    if (!text) {
      toast('先在上面输入要搜的内容', 'warn');
      return;
    }
    if (!ready) {
      toast('先点上面的「加载模型并建索引」', 'warn');
      return;
    }
    setBusy('检索中…');
    try {
      setHits(await vectorSearch(text, 20, scopes));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setBusy('');
    }
  }

  function openHit(h: VectorHit) {
    if (h.kind === 'item') openEdit(h.refId);
    else if (h.kind === 'note') openNote(h.refId);
    else if (h.kind === 'attachment') setView('attachments');
    else {
      const doc = feed.find((f) => f.refId === String(h.refId));
      if (doc?.url) void openPath(doc.url);
      else toast('这条没有链接', 'warn');
    }
  }

  /* ---------- 关闭状态：说清楚它是什么、代价是什么 ---------- */
  if (!on) {
    return (
      <div className="card p-4">
        <div className="text-sm mb-2">语义搜索（可选，默认关）</div>
        <p className="text-xs text-fg-dim mb-3 leading-6">
          它用一个 25MB 的中文向量模型把内容变成向量，能召回"用词不同但意思相近"的内容。
          代价是：首次加载模型十几秒，建索引每条约 30–60 毫秒（上千条要几分钟），
          索引约占每条 2KB。
          <b className="text-fg-muted">
            如果你只是偶尔想不起用词，全文搜索里的「智能改写」更划算
          </b>
          （联网、零体积）。
        </p>
        <button className="btn btn-primary text-xs" onClick={toggleOn}>
          启用语义搜索
        </button>
        <span className="text-[11px] text-fg-dim ml-2">
          手机端不支持（25MB 模型在手机上又慢又耗电）
        </span>
      </div>
    );
  }

  if (IS_MOBILE) {
    return (
      <div className="card p-4">
        <div className="text-sm mb-2">手机上不提供本地语义搜索</div>
        <p className="text-xs text-fg-dim mb-3 leading-6">
          本地向量模型有 22MB，放在手机上既慢又耗电，所以手机版没带它。
          <b className="text-fg-muted">数据同步到电脑后，可以在桌面版用语义搜索</b>。
        </p>
        <p className="text-[11px] text-fg-dim leading-5">
          手机上想找"意思相近但用词不同"的内容，可以用下面的
          <b className="text-fg-muted">「用查询改写搜索」</b>
          ——它把你的问法扩成多个同义词再检索，效果接近，体积为零（需要配置 AI 服务）。
        </p>
        <button className="btn text-xs mt-2" onClick={() => void fallbackExpand()}>
          用查询改写搜索
        </button>
      </div>
    );
  }

  if (hasModel === null) return <Empty text="检查模型中…" />;

  if (!hasModel) {
    return (
      <div className="card p-4">
        <div className="text-sm mb-2">本地向量模型还没装</div>
        {modelError && (
          <div className="text-[11px] text-[#f0a13c] mb-2 break-all">{modelError}</div>
        )}
        <p className="text-xs text-fg-dim mb-3 leading-6">
          语义搜索需要一个中文向量模型（bge-small-zh，约 25MB）。
          为了保持零外链，它不随产物分发，需要你下载一次放到本地目录：
        </p>
        <pre className="text-[11px] bg-bg-elev rounded p-2 overflow-x-auto mb-3">npm run model:setup</pre>
        <p className="text-[11px] text-fg-dim mb-3">
          下载完成后刷新本页即可。之后所有向量计算都在本机完成，不会联网。
        </p>
        <button className="btn btn-ghost text-xs" onClick={toggleOn}>
          关闭语义搜索
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="chip border-line text-[11px]">
          {ready ? `模型已加载 · 索引 ${count} 条` : `模型已就位 · 索引 ${count} 条`}
        </span>
        {scopes.includes('feed') && (
          <span className="chip border-line text-[11px]">
            信息流 {Math.min(feed.length, FEED_VECTOR_MAX)} 条
            {feedAt ? `（${new Date(feedAt).toLocaleString('zh-CN')}）` : ''}
          </span>
        )}
        <div className="flex-1" />
        <button className="btn text-xs" onClick={() => void build()} disabled={Boolean(busy)}>
          {ready ? '更新索引' : '加载模型并建索引'}
        </button>
        {count > 0 && (
          <button
            className="btn btn-ghost text-xs"
            onClick={async () => {
              await clearVectors();
              setCount(0);
              setHits(null);
              toast('已清空向量索引');
            }}
          >
            清空索引
          </button>
        )}
        <button className="btn btn-ghost text-xs" onClick={toggleOn}>
          关闭
        </button>
      </div>

      {busy && (
        <div className="card p-2 mb-3 text-xs text-fg-muted">
          {busy}
          {progress && progress.total > 0 && (
            <div className="mt-1 h-1 bg-bg-elev rounded overflow-hidden">
              <div
                className="h-full bg-accent"
                style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
              />
            </div>
          )}
        </div>
      )}

      <div className="flex gap-2 mb-3">
        <input
          className="field flex-1"
          placeholder="用一句话描述你要找的内容，例如：班级收班费的记录"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run();
          }}
          disabled={Boolean(busy)}
        />
        <button className="btn btn-primary" onClick={() => void run()} disabled={Boolean(busy)}>
          <Icon name="Search" size={14} /> 语义搜索
        </button>
      </div>

      {modelError && (
        <div className="card p-3 mb-3 border-[#f0a13c]/50">
          <div className="text-xs text-[#f0a13c] mb-1">本地向量模型加载失败</div>
          <div className="text-[11px] text-fg-dim break-all mb-2">{modelError}</div>
          <div className="text-[11px] text-fg-muted mb-2">
            可以先用「查询改写」兜底：让模型把你的问法扩成多个同义关键词，再走全文检索。
            效果不如向量检索，但零下载、零体积代价。
          </div>
          <button className="btn text-xs" onClick={() => void fallbackExpand()} disabled={Boolean(busy)}>
            用查询改写搜索
          </button>
          <span className="text-[10px] text-fg-dim ml-2">需要先在上面输入搜索内容</span>
        </div>
      )}

      {expanded.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          <span className="text-[11px] text-fg-dim">扩写关键词：</span>
          {expanded.map((k) => (
            <span key={k} className="chip border-line text-[10px]">
              {k}
            </span>
          ))}
        </div>
      )}

      {!ready ? (
        <Empty text="先点「加载模型并建索引」" hint="首次加载模型需要十几秒，之后按内容增量更新" />
      ) : hits === null ? (
        <Empty text="输入一句话，按意思找内容" hint="和全文检索的区别：字面不同但意思相近也能命中" />
      ) : hits.length === 0 ? (
        <Empty text="没有相似的内容" />
      ) : (
        <div className="card divide-y divide-line">
          {hits.map((h) => (
            <button
              key={h.id}
              className="w-full text-left px-3 py-2.5 hover:bg-bg-hover"
              onClick={() => openHit(h)}
            >
              <div className="flex items-center gap-2">
                <span className="chip border-line text-[10px]">{h.typeLabel}</span>
                <span className="text-sm truncate flex-1">{h.title}</span>
                <span className="text-[11px] text-fg-dim">{Math.round(h.score * 100)}%</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
