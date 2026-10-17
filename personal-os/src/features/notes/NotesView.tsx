import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import MarkdownIt from 'markdown-it';
import * as noteRepo from '../../core/repo/noteRepo';
import type { Note } from '../../core/domain/types';
import { useUI } from '../../app/store';
import { Empty } from '../../ui/primitives';
import { Icon } from '../../ui/Icon';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

/** 把 [[双链]] 渲染成可点击的链接（href 用 #note:标题，点击时由容器拦截） */
function renderMarkdown(content: string): string {
  const withLinks = content.replace(/\[\[([^\[\]]+?)\]\]/g, (_m, raw: string) => {
    const [target, alias] = raw.split('|');
    return `[${alias?.trim() || target.trim()}](#note:${encodeURIComponent(target.trim())})`;
  });
  return md.render(withLinks);
}

export function NotesView() {
  const revision = useUI((s) => s.revision);
  const editingNoteId = useUI((s) => s.editingNoteId);
  const openNote = useUI((s) => s.openNote);
  const closeNote = useUI((s) => s.closeNote);
  const bump = useUI((s) => s.bump);
  const toast = useUI((s) => s.toast);

  const notes = useLiveQuery(() => noteRepo.listNotes(), [revision]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ title: string; content: string }>({ title: '', content: '' });
  const [mode, setMode] = useState<'edit' | 'split' | 'preview'>('split');
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const active: Note | undefined = useMemo(
    () => notes?.find((n) => n.id === activeId),
    [notes, activeId],
  );

  // 外部（收集箱"存为笔记"）要求打开某篇笔记
  useEffect(() => {
    if (editingNoteId && editingNoteId !== 'new') {
      setActiveId(editingNoteId);
      closeNote();
    }
    if (editingNoteId === 'new') {
      void (async () => {
        const n = await noteRepo.createNote({ title: '未命名笔记', content: '' });
        bump();
        setActiveId(n.id);
        closeNote();
      })();
    }
  }, [editingNoteId, closeNote, bump]);

  useEffect(() => {
    if (active) {
      setDraft({ title: active.title, content: active.content });
      setDirty(false);
    }
  }, [active?.id, active?.rev]);

  async function save() {
    if (!active) return;
    if (!draft.title.trim()) {
      toast('标题不能为空', 'warn');
      return;
    }
    const { unresolved } = await noteRepo.saveNoteWithLinks(active.id, draft.content, {
      title: draft.title.trim(),
    });
    setDirty(false);
    bump();
    toast(unresolved.length ? `已保存 · ${unresolved.length} 个链接暂无目标笔记` : '已保存');
  }

  // Ctrl+S 保存（用 ref 拿最新的 save，避免闭包拿到旧草稿）
  const saveRef = useRef<() => void>(() => {});
  saveRef.current = () => void save();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirtyRef.current) saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active?.id]);

  const backlinks = useMemo(
    () => (active ? (notes ?? []).filter((n) => n.backlinks.includes(active.id)) : []),
    [notes, active],
  );

  return (
    <div className="h-full flex">
      {/* 列表 */}
      <div className="w-60 shrink-0 border-r border-line flex flex-col">
        <div className="flex items-center justify-between px-3 h-10 border-b border-line">
          <span className="text-xs text-fg-dim">{notes?.length ?? 0} 篇</span>
          <button className="btn btn-ghost px-1.5" onClick={() => openNote('new')} aria-label="新建笔记">
            <Icon name="Plus" size={15} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {!notes || notes.length === 0 ? (
            <Empty text="还没有笔记" />
          ) : (
            notes.map((n) => (
              <button
                key={n.id}
                onClick={() => setActiveId(n.id)}
                className={`w-full text-left px-3 py-2 border-b border-line/60 hover:bg-bg-hover ${
                  n.id === activeId ? 'bg-bg-elev' : ''
                }`}
              >
                <div className="text-sm truncate">{n.title}</div>
                <div className="text-[11px] text-fg-dim">
                  {new Date(n.updatedAt).toLocaleString('zh-CN', {
                    month: 'numeric',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {n.backlinks.length > 0 && ` · ${n.backlinks.length} 反链`}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* 编辑区 */}
      <div className="flex-1 flex flex-col min-w-0">
        {!active ? (
          <Empty text="选择或新建一篇笔记" hint="用 [[标题]] 可以链接到另一篇笔记" />
        ) : (
          <>
            <div className="flex items-center gap-2 px-3 h-10 border-b border-line shrink-0">
              <input
                className="field flex-1 max-w-sm"
                value={draft.title}
                onChange={(e) => {
                  setDraft((d) => ({ ...d, title: e.target.value }));
                  setDirty(true);
                }}
              />
              <div className="flex-1" />
              {dirty && <span className="text-[11px] text-fg-dim">未保存</span>}
              <button
                className="btn text-xs"
                onClick={() => void save()}
                disabled={!dirty}
              >
                保存
              </button>
              <button
                className="btn btn-ghost px-1.5 text-xs"
                onClick={async () => {
                  await noteRepo.softDeleteNote(active.id);
                  setActiveId(null);
                  bump();
                }}
                aria-label="删除笔记"
              >
                <Icon name="Trash2" size={13} />
              </button>
              <div className="w-px h-4 bg-line" />
              {(['edit', 'split', 'preview'] as const).map((m) => (
                <button
                  key={m}
                  className={`text-[11px] px-1.5 py-0.5 rounded ${
                    mode === m ? 'bg-bg-elev text-fg' : 'text-fg-dim'
                  }`}
                  onClick={() => setMode(m)}
                >
                  {m === 'edit' ? '编辑' : m === 'split' ? '分屏' : '预览'}
                </button>
              ))}
            </div>

            <div className="flex-1 flex min-h-0">
              {mode !== 'preview' && (
                <textarea
                  className={`flex-1 p-4 bg-transparent resize-none text-sm leading-7 font-mono outline-none ${
                    mode === 'split' ? 'border-r border-line' : ''
                  }`}
                  value={draft.content}
                  placeholder="用 Markdown 写。输入 [[ 可链接到其它笔记。"
                  onChange={(e) => {
                    setDraft((d) => ({ ...d, content: e.target.value }));
                    setDirty(true);
                  }}
                />
              )}
              {mode !== 'edit' && (
                <div
                  className="flex-1 overflow-y-auto p-4 md-body"
                  onClick={(e) => {
                    const el = (e.target as HTMLElement).closest('a');
                    if (!el) return;
                    const href = el.getAttribute('href') ?? '';
                    if (href.startsWith('#note:')) {
                      e.preventDefault();
                      const title = decodeURIComponent(href.slice(6));
                      const hit = notes?.find((n) => n.title.toLowerCase() === title.toLowerCase());
                      if (hit) setActiveId(hit.id);
                      else toast(`还没有《${title}》这篇笔记`, 'warn');
                    }
                  }}
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(draft.content) }}
                />
              )}
            </div>

            {backlinks.length > 0 && (
              <div className="border-t border-line px-3 py-2 shrink-0">
                <div className="sec-title mb-1">反向链接 {backlinks.length}</div>
                <div className="flex flex-wrap gap-1.5">
                  {backlinks.map((n) => (
                    <button
                      key={n.id}
                      className="chip border-line text-fg-muted hover:text-fg"
                      onClick={() => setActiveId(n.id)}
                    >
                      {n.title}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
