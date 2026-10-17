import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import * as draftRepo from '../../core/repo/draftRepo';
import { db } from '../../core/repo/db';
import { ITEM_TYPES, ITEM_TYPE_LIST, PRIORITY_LIST, PRIORITY_META } from '../../core/domain/item';
import { fromLocalInput, toLocalInput, fmtDateTime } from '../../core/domain/time';
import { providerLabel } from '../../core/adapters/ai';
import type { Draft, ItemType, Priority, ScheduleItem, Source } from '../../core/domain/types';
import { useUI } from '../../app/store';
import { Empty } from '../../ui/primitives';
import { Icon } from '../../ui/Icon';

const FIELD_LABEL: Record<string, string> = {
  title: '标题',
  type: '类型',
  startAt: '开始时间',
  dueAt: '截止时间',
  priority: '优先级',
  tags: '标签',
};

export function DraftsView() {
  const revision = useUI((s) => s.revision);
  const bump = useUI((s) => s.bump);
  const toast = useUI((s) => s.toast);

  const drafts = useLiveQuery(() => draftRepo.listPendingDrafts(), [revision]);
  const jobs = useLiveQuery(() => draftRepo.listJobs(20), [revision]);
  const sources = useLiveQuery(() => db.sources.toArray(), [revision]);

  const sourceOf = useMemo(() => {
    const jobMap = new Map((jobs ?? []).map((j) => [j.id, j.sourceId]));
    const srcMap = new Map((sources ?? []).map((s) => [s.id, s]));
    return (draft: Draft): Source | undefined => {
      const sid = jobMap.get(draft.jobId);
      return sid ? srcMap.get(sid) : undefined;
    };
  }, [jobs, sources]);

  /** jobId → 实际生效的 provider，用于卡片上标注"由谁解析" */
  const jobProvider = useMemo(
    () => new Map((jobs ?? []).map((j) => [j.id, j.provider])),
    [jobs],
  );

  const [busy, setBusy] = useState(false);

  async function confirm(d: Draft, edits?: Partial<ScheduleItem>) {
    await draftRepo.commitDraft(d.id, edits);
    bump();
    toast('已加入日历');
  }

  async function confirmAll() {
    if (!drafts?.length) return;
    setBusy(true);
    try {
      for (const d of drafts) await draftRepo.commitDraft(d.id);
      bump();
      toast(`已确认 ${drafts.length} 条`);
    } finally {
      setBusy(false);
    }
  }

  async function drop(d: Draft) {
    await draftRepo.rejectDraft(d.id);
    bump();
    toast('已丢弃', 'warn');
  }

  return (
    <div className="p-4 max-w-4xl mx-auto">
      <div className="flex items-end justify-between mb-3">
        <div>
          <h1 className="text-lg font-semibold">草稿箱</h1>
          <p className="text-xs text-fg-dim mt-0.5">
            AI 解析结果在这里等你确认，确认后才会写入日历和知识库。标黄字段是模型没把握的。
          </p>
        </div>
        {drafts && drafts.length > 1 && (
          <button className="btn text-xs" onClick={() => void confirmAll()} disabled={busy}>
            全部确认（{drafts.length}）
          </button>
        )}
      </div>

      {!drafts ? (
        <Empty text="加载中…" />
      ) : drafts.length === 0 ? (
        <Empty text="没有待确认的草稿" hint="去收集箱粘贴一段通知，点「AI 解析」就会生成草稿" />
      ) : (
        <div className="space-y-3">
          {drafts.map((d) => (
            <DraftCard
              key={d.id}
              draft={d}
              source={sourceOf(d)}
              providerName={providerLabel(jobProvider.get(d.jobId) ?? 'rule')}
              onConfirm={(edits) => void confirm(d, edits)}
              onDrop={() => void drop(d)}
              onChange={async (patch) => {
                await draftRepo.updateDraftPayload(d.id, patch);
              }}
              onTagsChange={async (tags) => {
                await db.drafts.put({
                  ...d,
                  suggestedTags: tags,
                  updatedAt: new Date().toISOString(),
                  rev: d.rev + 1,
                });
              }}
            />
          ))}
        </div>
      )}

      {jobs && jobs.length > 0 && (
        <div className="mt-8">
          <div className="sec-title mb-2">解析日志</div>
          <div className="card divide-y divide-line text-xs">
            {jobs.slice(0, 10).map((j) => (
              <div key={j.id} className="flex items-center gap-2 px-3 py-2">
                <span
                  className="chip"
                  style={{
                    borderColor:
                      j.status === 'success' ? '#3fb984' : j.status === 'failed' ? '#e5484d' : '#f0a13c',
                    color:
                      j.status === 'success' ? '#3fb984' : j.status === 'failed' ? '#e5484d' : '#f0a13c',
                  }}
                >
                  {j.status === 'success' ? '成功' : j.status === 'failed' ? '失败' : '进行中'}
                </span>
                <span className="text-fg-muted">{providerLabel(j.provider)}</span>
                <span className="text-fg-dim">
                  {j.outputDraftIds.length} 条草稿 · {fmtDateTime(j.createdAt)}
                </span>
                {j.error && <span className="text-[#e5484d] truncate">{j.error}</span>}
                <div className="flex-1" />
                {j.status === 'failed' && (
                  <button
                    className="btn btn-ghost text-xs"
                    onClick={async () => {
                      try {
                        await draftRepo.retryJob(j.id);
                        bump();
                        toast('重试完成');
                      } catch (e) {
                        toast(e instanceof Error ? e.message : '重试失败', 'err');
                      }
                    }}
                  >
                    重试
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DraftCard({
  draft,
  source,
  providerName,
  onConfirm,
  onDrop,
  onChange,
  onTagsChange,
}: {
  draft: Draft;
  source: Source | undefined;
  providerName: string;
  onConfirm: (edits: Partial<ScheduleItem>) => void;
  onDrop: () => void;
  onChange: (patch: Partial<ScheduleItem>) => void;
  onTagsChange: (tags: string[]) => void;
}) {
  // 编辑值放本地 state，避免每次按键都触发整表重查导致输入抖动
  const [form, setForm] = useState<Partial<ScheduleItem>>(
    draft.payload as Partial<ScheduleItem>,
  );
  const [tags, setTags] = useState<string[]>(draft.suggestedTags ?? []);
  const pending = new Set(draft.pendingConfirm ?? []);

  function setField<K extends keyof ScheduleItem>(key: K, value: ScheduleItem[K]) {
    const next = { ...form, [key]: value };
    setForm(next);
    onChange(next);
  }

  const mark = (field: string) =>
    pending.has(field) ? 'border-[#f0a13c] bg-[#f0a13c]/10' : 'border-line';

  const conf = Object.values(draft.confidence ?? {});
  const avg = conf.length ? Math.round((conf.reduce((a, b) => a + b, 0) / conf.length) * 100) : null;

  return (
    <div className="card p-3 grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-3">
      {/* 左：原文 */}
      <div>
        <div className="sec-title mb-1.5">原文</div>
        <div className="text-xs text-fg-muted whitespace-pre-wrap break-words max-h-56 overflow-y-auto bg-bg-elev rounded p-2">
          {source?.rawText || source?.url || '（原文已不可用）'}
        </div>
        <div className="text-[11px] text-fg-dim mt-1.5">
          来源：{providerName}
          {avg !== null && ` · 平均把握 ${avg}%`}
        </div>
      </div>

      {/* 右：可编辑字段 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="sec-title">{draft.target === 'item' ? '解析出的日程' : '解析出的笔记'}</div>
          {pending.size > 0 && (
            <span className="text-[11px] text-[#f0a13c]">
              待确认：{[...pending].map((f) => FIELD_LABEL[f] ?? f).join('、')}
            </span>
          )}
        </div>

        <input
          className={`field ${mark('title')}`}
          value={form.title ?? ''}
          placeholder="标题"
          onChange={(e) => setField('title', e.target.value)}
        />

        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="label">类型</div>
            <select
              className={`field ${mark('type')}`}
              value={form.type ?? 'task'}
              onChange={(e) => setField('type', e.target.value as ItemType)}
            >
              {ITEM_TYPE_LIST.map((t) => (
                <option key={t} value={t}>
                  {ITEM_TYPES[t].label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="label">优先级</div>
            <select
              className={`field ${mark('priority')}`}
              value={String(form.priority ?? 0)}
              onChange={(e) => setField('priority', Number(e.target.value) as Priority)}
            >
              {PRIORITY_LIST.map((v) => (
                <option key={v} value={v}>
                  {PRIORITY_META[v].label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="label">开始</div>
            <input
              type="datetime-local"
              className={`field ${mark('startAt')}`}
              value={toLocalInput(form.startAt)}
              onChange={(e) => setField('startAt', fromLocalInput(e.target.value))}
            />
          </div>
          <div>
            <div className="label">截止</div>
            <input
              type="datetime-local"
              className={`field ${mark('dueAt')}`}
              value={toLocalInput(form.dueAt)}
              onChange={(e) => setField('dueAt', fromLocalInput(e.target.value))}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="label">地点</div>
            <input
              className="field"
              value={form.location ?? ''}
              onChange={(e) => setField('location', e.target.value)}
            />
          </div>
          <div>
            <div className="label">标签</div>
            <input
              className={`field ${mark('tags')}`}
              value={tags.join(' ')}
              placeholder="空格分隔"
              onChange={(e) => {
                const next = e.target.value.split(/[,，\s]+/).filter(Boolean);
                setTags(next);
                onTagsChange(next);
              }}
            />
          </div>
        </div>

        <div>
          <div className="label">备注 / 摘要</div>
          <textarea
            className="field min-h-[56px]"
            value={form.remark ?? ''}
            onChange={(e) => setField('remark', e.target.value)}
          />
        </div>

        <div className="flex items-center justify-between pt-1">
          <button className="btn btn-ghost text-xs" onClick={onDrop}>
            <Icon name="Trash2" size={13} /> 丢弃
          </button>
          <div className="flex gap-2">
            <button className="btn text-xs" onClick={() => onChange(form)}>
              保存修改
            </button>
            <button className="btn btn-primary text-xs" onClick={() => onConfirm(form)}>
              <Icon name="CheckSquare" size={13} /> 确认并加入
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
