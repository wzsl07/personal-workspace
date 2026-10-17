import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { buildIndex, search, type SearchHit } from '../../core/search/searchIndex';
import { db } from '../../core/repo/db';
import { useUI } from '../../app/store';
import { Empty, Segmented } from '../../ui/primitives';
import { Icon } from '../../ui/Icon';
import { AskPanel } from './AskPanel';
import { SemanticPanel } from './SemanticPanel';

export function SearchView() {
  const revision = useUI((s) => s.revision);
  const openEdit = useUI((s) => s.openEdit);
  const openNote = useUI((s) => s.openNote);
  const setView = useUI((s) => s.setView);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | 'item' | 'note' | 'attachment'>('all');
  const [mode, setMode] = useState<'fulltext' | 'semantic' | 'ask'>('fulltext');

  const items = useLiveQuery(() => db.items.toArray(), [revision]);
  const notes = useLiveQuery(() => db.notes.toArray(), [revision]);
  const attachments = useLiveQuery(() => db.attachments.toArray(), [revision]);

  // 数据变更后重建索引（几千条内耗时可忽略）
  useEffect(() => {
    if (items && notes) buildIndex(items, notes, attachments ?? []);
  }, [items, notes, attachments]);

  const hits: SearchHit[] = useMemo(() => {
    if (!q.trim()) return [];
    return search(q).filter((h) => kind === 'all' || h.kind === kind);
  }, [q, kind, revision]);

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

      {mode === 'ask' ? (
        <AskPanel />
      ) : mode === 'semantic' ? (
        <SemanticPanel />
      ) : (
        <>
      <div className="flex items-center gap-2 mb-4">
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
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: '全部' },
            { value: 'item', label: '日程' },
            { value: 'note', label: '笔记' },
            { value: 'attachment', label: '附件' },
          ]}
        />
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
              onClick={() => {
                if (h.kind === 'item') openEdit(h.refId);
                else if (h.kind === 'note') openNote(h.refId);
                else setView('attachments');
              }}
            >
              <div className="flex items-center gap-1.5">
                <span className="chip border-line text-[10px]">{h.typeLabel}</span>
                <span className="text-sm truncate">{h.title}</span>
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
        索引条目 {items?.filter((i) => !i.deletedAt).length ?? 0} 条 · 笔记{' '}
        {notes?.filter((n) => !n.deletedAt).length ?? 0} 篇 · 附件{' '}
        {attachments?.filter((a) => !a.deletedAt && a.extractedText).length ?? 0} 份
      </div>
        </>
      )}
    </div>
  );
}
