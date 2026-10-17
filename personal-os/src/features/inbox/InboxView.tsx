import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as attachmentRepo from '../../core/repo/attachmentRepo';
import { kindOfFile } from '../../core/adapters/extract';
import * as sourceRepo from '../../core/repo/sourceRepo';
import * as noteRepo from '../../core/repo/noteRepo';
import * as draftRepo from '../../core/repo/draftRepo';
import type { Attachment, Source } from '../../core/domain/types';
import { useUI } from '../../app/store';
import { Empty, SectionHeader } from '../../ui/primitives';
import { Icon } from '../../ui/Icon';

export function InboxView() {
  const revision = useUI((s) => s.revision);
  const bump = useUI((s) => s.bump);
  const toast = useUI((s) => s.toast);
  const openNew = useUI((s) => s.openNew);
  const openNote = useUI((s) => s.openNote);

  const setView = useUI((s) => s.setView);

  const items = useLiveQuery(() => sourceRepo.listInbox(), [revision]);
  const atts = useLiveQuery(() => attachmentRepo.listAttachments(), [revision]);
  const attMap = useMemo(() => new Map((atts ?? []).map((a) => [a.id, a])), [atts]);

  /** 原文可能是加密的，读的时候统一解一次 */
  const [plainText, setPlainText] = useState<Record<string, string>>({});
  useEffect(() => {
    void (async () => {
      const out: Record<string, string> = {};
      for (const s of items ?? []) out[s.id] = await sourceRepo.readRaw(s);
      setPlainText(out);
    })();
  }, [items]);
  const [text, setText] = useState('');
  const [parsing, setParsing] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string>('');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  /** 拖入 / 选择文件：存附件 → 抽文本 → 作为一条待整理内容进收集箱 */
  async function ingestFiles(files: FileList | File[]) {
    for (const f of Array.from(files)) {
      setUploading(`正在处理 ${f.name}…`);
      try {
        const { attachment } = await attachmentRepo.addAttachment(f, f.name, {
          onProgress: (m) => setUploading(`${f.name}：${m}`),
        });
        const kind = kindOfFile(f.name, f.type);
        await sourceRepo.createSource({
          kind,
          rawText: attachment.extractedText ?? '',
          attachmentId: attachment.id,
        });
        bump();
        toast(
          attachment.extractedText
            ? `已收录《${f.name}》，抽出 ${attachment.extractedText.length} 字`
            : `已收录《${f.name}》，但没能抽出文字（${(attachment.extra as { extractError?: string })?.extractError ?? '未知原因'}）`,
          attachment.extractedText ? 'ok' : 'warn',
        );
      } catch (e) {
        toast(`${f.name} 处理失败：${e instanceof Error ? e.message : e}`, 'err');
      }
    }
    setUploading('');
  }

  async function capture() {
    const t = text.trim();
    if (!t) return;
    await sourceRepo.createSource({ kind: sourceRepo.guessKind(t), rawText: t });
    setText('');
    bump();
    toast('已收入收集箱');
  }

  /** AI 解析 → 生成草稿（不写正式数据），然后跳到草稿箱 */
  async function parse(s: Source) {
    setParsing(s.id);
    try {
      const out = await draftRepo.parseSource(s);
      bump();
      toast(
        `生成 ${out.drafts.length} 条草稿（${out.notes[out.notes.length - 1] ?? ''}）`,
        out.notes.length ? 'warn' : 'ok',
      );
      setView('drafts');
    } catch (e) {
      toast(`解析失败：${e instanceof Error ? e.message : e}`, 'err');
    } finally {
      setParsing(null);
    }
  }

  async function parseAll() {
    if (!items?.length) return;
    let total = 0;
    for (const s of items) {
      try {
        const out = await draftRepo.parseSource(s);
        total += out.drafts.length;
      } catch {
        /* 单条失败不阻断其余 */
      }
    }
    bump();
    toast(`共生成 ${total} 条草稿`);
    setView('drafts');
  }

  return (
    <div className="p-4 max-w-3xl mx-auto">
      <h1 className="text-lg font-semibold mb-1">收集箱</h1>
      <p className="text-xs text-fg-dim mb-3">
        先把东西丢进来，之后再整理成日程或笔记。数据只存在本机。
      </p>

      <div
        className={`card p-3 mb-5 border-dashed ${dragOver ? 'border-accent bg-accent/5' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) void ingestFiles(e.dataTransfer.files);
        }}
      >
        <textarea
          className="field min-h-[76px] resize-none"
          placeholder="粘贴一段通知、作业要求、活动消息，或贴一个链接…（Ctrl+Enter 收录）"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void capture();
          }}
        />
        <div className="flex justify-between items-center mt-2">
          <span className="text-[11px] text-fg-dim">
            {uploading ||
              (text.trim() ? `${text.trim().length} 字` : '支持文本 / 链接，也可以把图片、PDF、Word 拖到这里')}
          </span>
          <div className="flex gap-2">
            <button className="btn text-xs" onClick={() => fileRef.current?.click()}>
              <Icon name="Upload" size={13} /> 添加文件
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*,.pdf,.doc,.docx,.md,.txt"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) void ingestFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <button className="btn btn-primary" onClick={() => void capture()} disabled={!text.trim()}>
              <Icon name="Inbox" size={14} /> 收录
            </button>
          </div>
        </div>
      </div>

      <SectionHeader
        title="待整理"
        count={items?.length ?? 0}
        action={
          items && items.length > 1 ? (
            <button className="text-[11px] text-fg-dim hover:text-fg" onClick={() => void parseAll()}>
              全部解析
            </button>
          ) : null
        }
      />
      {!items ? (
        <Empty text="加载中…" />
      ) : items.length === 0 ? (
        <Empty text="收集箱是空的" hint="班级群通知、作业要求随手丢进来就行" />
      ) : (
        <div className="card divide-y divide-line">
          {items.map((s) => (
            <SourceRow
              key={s.id}
              source={s}
              plain={plainText[s.id] ?? ''}
              attachment={s.attachmentId ? attMap.get(s.attachmentId) : undefined}
              parsing={parsing === s.id}
              onParse={() => void parse(s)}
              onToItem={() => {
                openNew({ title: firstLine(s.rawText ?? ''), sourceId: s.id });
              }}
              onToNote={async () => {
                const raw = s.rawText ?? '';
                const n = await noteRepo.createNote({
                  title: firstLine(raw).slice(0, 40) || '未命名笔记',
                  content: raw,
                  sourceId: s.id,
                });
                await sourceRepo.markProcessed(s.id);
                bump();
                openNote(n.id);
              }}
              onDone={async () => {
                await sourceRepo.markProcessed(s.id);
                bump();
              }}
              onDelete={async () => {
                await sourceRepo.softDeleteSource(s.id);
                bump();
                toast('已删除', 'warn');
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim())?.trim().slice(0, 60) ?? '';
}

function SourceRow({
  source,
  plain,
  attachment,
  parsing,
  onParse,
  onToItem,
  onToNote,
  onDone,
  onDelete,
}: {
  source: Source;
  plain: string;
  attachment?: Attachment;
  parsing: boolean;
  onParse: () => void;
  onToItem: () => void;
  onToNote: () => void;
  onDone: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="p-3">
      {attachment && attachment.extractedText && (
        <div className="flex items-center gap-1.5 mb-1.5 text-[11px] text-fg-muted">
          <Icon name="FileText" size={12} />
          <span className="truncate">{attachment.name}</span>
          <span className="text-fg-dim">
            {attachment.extractedText
              ? `已抽出 ${attachment.extractedText.length} 字`
              : '未抽出文字'}
          </span>
        </div>
      )}
      <div className="text-sm whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
        {plain || source.url || '（这段文字没能自动抽出来，可手动补充后解析）'}
      </div>
      <div className="flex items-center gap-2 mt-2">
        <span className="text-[11px] text-fg-dim">
          {new Date(source.capturedAt).toLocaleString('zh-CN', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
        <span className="chip border-line text-fg-dim">{KIND_LABEL[source.kind]}</span>
        <div className="flex-1" />
        <button
          className="btn text-xs border-accent/60 text-accent"
          onClick={onParse}
          disabled={parsing}
        >
          <Icon name="Sparkles" size={13} />
          {parsing ? '解析中…' : 'AI 解析'}
        </button>
        <button className="btn btn-ghost text-xs" onClick={onToItem}>
          转为日程
        </button>
        <button className="btn btn-ghost text-xs" onClick={() => void onToNote()}>
          存为笔记
        </button>
        <button className="btn btn-ghost text-xs" onClick={() => void onDone()}>
          标记已处理
        </button>
        <button
          className="btn btn-ghost text-xs text-[#e5484d] px-1.5"
          onClick={() => void onDelete()}
          aria-label="删除"
        >
          <Icon name="Trash2" size={13} />
        </button>
      </div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  text: '文本',
  image: '图片',
  pdf: 'PDF',
  word: 'Word',
  markdown: 'Markdown',
  url: '链接',
  manual: '手动',
};
