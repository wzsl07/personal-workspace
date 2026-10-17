import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as attachmentRepo from '../../core/repo/attachmentRepo';
import { db } from '../../core/repo/db';
import { fmtDateTime } from '../../core/domain/time';
import { fmtSize } from '../../core/adapters/ocr';
import { isEncrypted } from '../../core/security/sensitive';
import { usage } from '../../core/adapters/storage/opfs';
import type { Attachment, Ref } from '../../core/domain/types';
import { useUI } from '../../app/store';
import { Empty, Drawer } from '../../ui/primitives';
import { Icon } from '../../ui/Icon';

const METHOD_LABEL: Record<string, string> = {
  pdf: 'PDF 抽取',
  docx: 'Word 解析',
  plain: '文本读取',
  ocr: 'OCR 识别',
  none: '未抽取',
};

export function AttachmentsView() {
  const revision = useUI((s) => s.revision);
  const bump = useUI((s) => s.bump);
  const toast = useUI((s) => s.toast);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState('');
  const [linkTarget, setLinkTarget] = useState<Attachment | null>(null);
  const [space, setSpace] = useState<{ usage: number; quota: number } | null>(null);

  const list = useLiveQuery(() => attachmentRepo.listAttachments(), [revision]);

  useEffect(() => {
    void usage().then(setSpace);
  }, [list?.length]);

  async function add(files: FileList) {
    for (const f of Array.from(files)) {
      setBusy(`处理 ${f.name}…`);
      try {
        const { duplicate } = await attachmentRepo.addAttachment(f, f.name, {
          onProgress: (m) => setBusy(`${f.name}：${m}`),
        });
        toast(duplicate ? `《${f.name}》已存在，已跳过重复存储` : `已添加《${f.name}》`);
      } catch (e) {
        toast(`失败：${e instanceof Error ? e.message : e}`, 'err');
      }
    }
    setBusy('');
    bump();
  }

  async function reExtract(a: Attachment) {
    setBusy(`重新抽取 ${a.name}…`);
    const next = await attachmentRepo.runExtract(a.id, undefined, undefined, (m) =>
      setBusy(`${a.name}：${m}`),
    );
    setBusy('');
    bump();
    toast(
      next?.extractedText
        ? `抽出 ${next.extractedText.length} 字`
        : `没能抽出文字：${(next?.extra as { extractError?: string })?.extractError ?? '未知原因'}`,
      next?.extractedText ? 'ok' : 'warn',
    );
  }

  return (
    <div className="p-4 max-w-4xl mx-auto">
      <div className="flex items-end justify-between mb-3">
        <div>
          <h1 className="text-lg font-semibold">附件</h1>
          <p className="text-xs text-fg-dim mt-0.5">
            文件本体存在浏览器私有文件系统（OPFS），抽取出的文字会进全文搜索。
            {space && ` · 已用 ${fmtSize(space.usage)}`}
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => fileRef.current?.click()}>
          <Icon name="Upload" size={14} /> 添加文件
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*,.pdf,.doc,.docx,.md,.txt"
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void add(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {busy && <div className="card p-2 mb-3 text-xs text-fg-muted">{busy}</div>}

      {!list ? (
        <Empty text="加载中…" />
      ) : list.length === 0 ? (
        <Empty text="还没有附件" hint="把 PDF、Word、图片拖到收集箱也能自动收录" />
      ) : (
        <div className="card divide-y divide-line">
          {list.map((a) => (
            <div key={a.id} className="p-3">
              <div className="flex items-start gap-2">
                <Icon name="FileText" size={14} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate" title={a.name}>
                    {a.name}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-[11px] text-fg-dim flex-wrap">
                    <span>{fmtSize(a.size)}</span>
                    <span>{a.mime || '未知类型'}</span>
                    <span>{fmtDateTime(a.createdAt)}</span>
                    {a.extractedText ? (
                      <span className={isEncrypted(a.extractedText) ? 'text-[#b06cf0]' : 'text-[#3fb984]'}>
                        {isEncrypted(a.extractedText)
                          ? '正文已加密（不可搜索）'
                          : `${METHOD_LABEL[(a.extra as { method?: string })?.method ?? ''] ?? '已抽取'} · ${a.extractedText.length} 字`}
                      </span>
                    ) : (
                      <span className="text-[#f0a13c]">
                        {(a.extra as { extractError?: string })?.extractError ?? '未抽取'}
                      </span>
                    )}
                    {a.ownerRefs.length > 0 && <span>已关联 {a.ownerRefs.length} 处</span>}
                  </div>
                  {a.extractedText && !isEncrypted(a.extractedText) && (
                    <div className="mt-1.5 text-[11px] text-fg-muted line-clamp-2 bg-bg-elev rounded p-1.5 break-words">
                      {a.extractedText.slice(0, 220)}
                    </div>
                  )}
                </div>
                <div className="flex gap-1 shrink-0">
                  <button className="btn btn-ghost text-xs" onClick={() => void reExtract(a)}>
                    重新抽取
                  </button>
                  <button className="btn btn-ghost text-xs" onClick={() => setLinkTarget(a)}>
                    关联
                  </button>
                  <button
                    className="btn btn-ghost text-xs px-1.5 text-[#e5484d]"
                    onClick={async () => {
                      await attachmentRepo.softDeleteAttachment(a.id);
                      bump();
                      toast('已删除', 'warn');
                    }}
                    aria-label="删除"
                  >
                    <Icon name="Trash2" size={13} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {linkTarget && (
        <LinkDrawer
          attachment={linkTarget}
          onClose={() => setLinkTarget(null)}
          onDone={() => {
            bump();
            setLinkTarget(null);
          }}
        />
      )}
    </div>
  );
}

/** 关联抽屉：把附件挂到某个条目或笔记上 */
function LinkDrawer({
  attachment,
  onClose,
  onDone,
}: {
  attachment: Attachment;
  onClose: () => void;
  onDone: () => void;
}) {
  const items = useLiveQuery(() => db.items.toArray(), []);
  const notes = useLiveQuery(() => db.notes.toArray(), []);
  const [q, setQ] = useState('');

  const owns = useMemo(
    () => new Set(attachment.ownerRefs.map((r: Ref) => `${r.kind}:${r.id}`)),
    [attachment.ownerRefs],
  );

  const candidates = useMemo(() => {
    const kw = q.trim().toLowerCase();
    const list: { ref: Ref; label: string; kindLabel: string }[] = [
      ...(items ?? [])
        .filter((i) => !i.deletedAt)
        .map((i) => ({
          ref: { kind: 'item' as const, id: i.id },
          label: i.title,
          kindLabel: '日程',
        })),
      ...(notes ?? [])
        .filter((n) => !n.deletedAt)
        .map((n) => ({
          ref: { kind: 'note' as const, id: n.id },
          label: n.title,
          kindLabel: '笔记',
        })),
    ];
    return (kw ? list.filter((x) => x.label.toLowerCase().includes(kw)) : list).slice(0, 60);
  }, [items, notes, q]);

  return (
    <Drawer open onClose={onClose} title={`关联《${attachment.name}》`}>
      <input
        className="field mb-3"
        placeholder="搜索条目或笔记"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="space-y-1">
        {candidates.length === 0 && <Empty text="没有匹配的对象" />}
        {candidates.map((c) => {
          const on = owns.has(`${c.ref.kind}:${c.ref.id}`);
          return (
            <button
              key={`${c.ref.kind}:${c.ref.id}`}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm ${
                on ? 'bg-accent/15 text-accent' : 'hover:bg-bg-hover text-fg'
              }`}
              onClick={async () => {
                if (on) await attachmentRepo.detachFrom(attachment.id, c.ref);
                else await attachmentRepo.attachTo(attachment.id, c.ref);
                onDone();
              }}
            >
              <span className="chip border-line text-[10px]">{c.kindLabel}</span>
              <span className="truncate flex-1 text-left">{c.label}</span>
              {on && <Icon name="CheckSquare" size={13} />}
            </button>
          );
        })}
      </div>
    </Drawer>
  );
}
