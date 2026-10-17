import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ITEM_TYPES,
  ITEM_TYPE_LIST,
  PRIORITY_LIST,
  PRIORITY_META,
  STATUS_LIST,
  STATUS_META,
} from '../../core/domain/item';
import { fromLocalInput, toLocalInput } from '../../core/domain/time';
import * as itemRepo from '../../core/repo/itemRepo';
import * as tagRepo from '../../core/repo/tagRepo';
import * as attachmentRepo from '../../core/repo/attachmentRepo';
import { clearReminders, ensureReminder } from '../../core/notify/scheduler';
import { db } from '../../core/repo/db';
import type { ItemStatus, ItemType, Priority, ScheduleItem } from '../../core/domain/types';
import { useUI } from '../../app/store';
import { Drawer } from '../../ui/primitives';
import { Icon } from '../../ui/Icon';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

interface Form {
  title: string;
  type: ItemType;
  status: ItemStatus;
  priority: Priority;
  startAt: string;
  dueAt: string;
  allDay: boolean;
  location: string;
  remark: string;
  tagsText: string;
  repeat: 'none' | 'daily' | 'weekly';
  weekdays: number[];
}

function emptyForm(preset?: Partial<ScheduleItem>): Form {
  return {
    title: preset?.title ?? '',
    type: preset?.type ?? 'task',
    status: preset?.status ?? 'notStarted',
    priority: preset?.priority ?? 0,
    startAt: toLocalInput(preset?.startAt),
    dueAt: toLocalInput(preset?.dueAt),
    allDay: preset?.allDay ?? true,
    location: preset?.location ?? '',
    remark: preset?.remark ?? '',
    tagsText: '',
    repeat: 'none',
    weekdays: [],
  };
}

export function ItemEditor() {
  const editing = useUI((s) => s.editing);
  const closeEditor = useUI((s) => s.closeEditor);
  const bump = useUI((s) => s.bump);
  const toast = useUI((s) => s.toast);

  const tags = useLiveQuery(() => tagRepo.listTags(), []);
  const existing = useLiveQuery(
    async () => (editing && editing.id !== 'new' ? itemRepo.getItem(editing.id) : undefined),
    [editing?.id],
  );

  const [form, setForm] = useState<Form>(() => emptyForm(editing?.preset));

  useEffect(() => {
    if (!editing) return;
    if (editing.id === 'new') {
      setForm(emptyForm(editing.preset));
      return;
    }
    if (existing) {
      const names = existing.tags.map((t) => tags?.find((x) => x.id === t)?.name ?? '');
      setForm({
        title: existing.title,
        type: existing.type,
        status: existing.status,
        priority: existing.priority,
        startAt: toLocalInput(existing.startAt),
        dueAt: toLocalInput(existing.dueAt),
        allDay: existing.allDay,
        location: existing.location ?? '',
        remark: existing.remark ?? '',
        tagsText: names.filter(Boolean).join(' '),
        repeat:
          existing.recurrence?.freq === 'daily'
            ? 'daily'
            : existing.recurrence?.freq === 'weekly'
              ? 'weekly'
              : 'none',
        weekdays: existing.recurrence?.byWeekday ?? [],
      });
    }
  }, [editing?.id, existing?.id, existing?.rev, tags]);

  const patch = (p: Partial<Form>) => setForm((f) => ({ ...f, ...p }));

  const [remind, setRemind] = useState<string>('none');
  useEffect(() => {
    if (!existing) return;
    void (async () => {
      const rows = (await db.reminders.where('itemId').equals(existing.id).toArray()).filter(
        (r) => !r.fired,
      );
      setRemind(rows.length ? String(rows[0].offsetMinutes) : 'none');
    })();
  }, [existing?.id, existing?.rev]);

  async function save() {
    if (!form.title.trim()) {
      toast('标题不能为空', 'warn');
      return;
    }
    const tagNames = form.tagsText
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const tagIds = tagNames.length ? await tagRepo.ensureTags(tagNames) : [];
    const recurrence =
      form.repeat === 'none'
        ? null
        : {
            freq: form.repeat as 'daily' | 'weekly',
            interval: 1,
            byWeekday: form.repeat === 'weekly' ? form.weekdays : undefined,
          };

    const payload: Partial<ScheduleItem> = {
      title: form.title.trim(),
      type: form.type,
      status: form.status,
      priority: form.priority,
      startAt: fromLocalInput(form.startAt),
      dueAt: fromLocalInput(form.dueAt),
      allDay: form.allDay,
      location: form.location,
      remark: form.remark,
      tags: tagIds,
      recurrence,
    };

    let savedId = editing?.id;
    if (editing?.id === 'new') {
      const item = await itemRepo.createItem({ ...payload, title: form.title.trim() });
      savedId = item.id;
      toast('已添加到日程');
    } else if (editing?.id) {
      await itemRepo.updateItem(editing.id, payload);
      toast('已保存');
    }

    // 提醒：选了提前量就建/更新，选"不提醒"就取消
    if (savedId && savedId !== 'new') {
      const item = await itemRepo.getItem(savedId);
      if (item) {
        if (remind === 'none') await clearReminders(savedId);
        else await ensureReminder(item, Number(remind));
      }
    }
    bump();
    closeEditor();
  }

  async function remove() {
    if (!editing?.id || editing.id === 'new') return;
    await itemRepo.softDeleteItem(editing.id);
    bump();
    toast('已删除', 'warn');
    closeEditor();
  }

  const typeMeta = ITEM_TYPES[form.type];
  const open = Boolean(editing);

  if (!open) return null;

  return (
    <Drawer
      open={open}
      onClose={closeEditor}
      title={
        <span className="flex items-center gap-2">
          <Icon name={typeMeta.icon} size={15} color={typeMeta.color} />
          {editing?.id === 'new' ? '新建条目' : '编辑条目'}
        </span>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="label">标题</label>
          <input
            className="field"
            value={form.title}
            autoFocus
            placeholder="例如：高等数学 第三章习题"
            onChange={(e) => patch({ title: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
            }}
          />
        </div>

        <div>
          <label className="label">类型</label>
          <div className="grid grid-cols-3 gap-1.5">
            {ITEM_TYPE_LIST.map((t) => {
              const m = ITEM_TYPES[t];
              const active = form.type === t;
              return (
                <button
                  key={t}
                  onClick={() => patch({ type: t, allDay: !m.timed })}
                  className="flex items-center gap-1.5 px-2 py-1.5 rounded-md border text-xs transition-colors"
                  style={{
                    borderColor: active ? m.color : '#2a3145',
                    background: active ? `${m.color}22` : '#1b2030',
                    color: active ? m.color : '#9aa4bd',
                  }}
                >
                  <Icon name={m.icon} size={13} color={active ? m.color : '#9aa4bd'} />
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">开始时间</label>
            <input
              type="datetime-local"
              className="field"
              value={form.startAt}
              onChange={(e) => patch({ startAt: e.target.value })}
            />
          </div>
          <div>
            <label className="label">截止时间</label>
            <input
              type="datetime-local"
              className="field"
              value={form.dueAt}
              onChange={(e) => patch({ dueAt: e.target.value })}
            />
          </div>
        </div>

        <div className="flex gap-2">
          <button
            className="btn text-xs"
            onClick={() => patch({ startAt: '', dueAt: '' })}
          >
            清除时间
          </button>
          <button
            className="btn text-xs"
            onClick={() => {
              const d = new Date();
              d.setHours(23, 59, 0, 0);
              patch({ dueAt: toLocalInput(d.toISOString()) });
            }}
          >
            今天截止
          </button>
          <button
            className="btn text-xs"
            onClick={() => {
              const d = new Date(Date.now() + 86400000);
              d.setHours(23, 59, 0, 0);
              patch({ dueAt: toLocalInput(d.toISOString()) });
            }}
          >
            明天截止
          </button>
        </div>

        <div>
          <label className="label">状态</label>
          <div className="flex flex-wrap gap-1.5">
            {STATUS_LIST.map((s) => (
              <button
                key={s}
                onClick={() => patch({ status: s })}
                className="chip"
                style={{
                  borderColor: form.status === s ? STATUS_META[s].color : '#2a3145',
                  color: form.status === s ? STATUS_META[s].color : '#9aa4bd',
                  background: form.status === s ? `${STATUS_META[s].color}1e` : 'transparent',
                }}
              >
                {STATUS_META[s].label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="label">优先级</label>
          <div className="flex gap-1.5">
            {PRIORITY_LIST.map((p) => (
              <button
                key={p}
                onClick={() => patch({ priority: p })}
                className="chip"
                style={{
                  borderColor: form.priority === p ? PRIORITY_META[p].color : '#2a3145',
                  color: form.priority === p ? PRIORITY_META[p].color : '#6b7590',
                  background: form.priority === p ? `${PRIORITY_META[p].color}1e` : 'transparent',
                }}
              >
                {PRIORITY_META[p].label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="label">重复</label>
          <div className="flex gap-1.5">
            {(['none', 'daily', 'weekly'] as const).map((r) => (
              <button
                key={r}
                onClick={() => patch({ repeat: r })}
                className={`chip ${form.repeat === r ? 'border-accent text-accent' : 'border-line text-fg-muted'}`}
              >
                {r === 'none' ? '不重复' : r === 'daily' ? '每天' : '每周'}
              </button>
            ))}
          </div>
          {form.repeat === 'weekly' && (
            <div className="flex gap-1 mt-2">
              {WEEKDAYS.map((w, i) => (
                <button
                  key={w}
                  onClick={() =>
                    patch({
                      weekdays: form.weekdays.includes(i)
                        ? form.weekdays.filter((x) => x !== i)
                        : [...form.weekdays, i],
                    })
                  }
                  className={`w-7 h-7 rounded text-xs border ${
                    form.weekdays.includes(i)
                      ? 'border-accent text-accent bg-accent/15'
                      : 'border-line text-fg-muted'
                  }`}
                >
                  {w}
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="label">标签（空格或逗号分隔）</label>
          <input
            className="field"
            value={form.tagsText}
            placeholder="高数 作业 #班级/班费"
            onChange={(e) => patch({ tagsText: e.target.value })}
          />
          {tags && tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {tags.slice(0, 12).map((t) => (
                <button
                  key={t.id}
                  className="chip border-line text-fg-dim hover:text-fg"
                  onClick={() => {
                    const has = form.tagsText.split(/[,，\s]+/).includes(t.name);
                    patch({
                      tagsText: has
                        ? form.tagsText.split(/[,，\s]+/).filter((x) => x && x !== t.name).join(' ')
                        : `${form.tagsText} ${t.name}`.trim(),
                    });
                  }}
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {editing?.id && editing.id !== 'new' && (
          <div>
            <label className="label">提醒</label>
            <div className="flex gap-1.5 flex-wrap">
              {[
                { v: 'none', l: '不提醒' },
                { v: '0', l: '准点' },
                { v: '10', l: '提前10分钟' },
                { v: '30', l: '提前30分钟' },
                { v: '1440', l: '提前1天' },
              ].map((o) => (
                <button
                  key={o.v}
                  className={`chip ${remind === o.v ? 'border-accent text-accent bg-accent/10' : 'border-line text-fg-muted'}`}
                  onClick={() => setRemind(o.v)}
                >
                  {o.l}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-fg-dim mt-1">
              浏览器里只在应用打开时提醒；装了桌面壳后才会准点弹出系统通知。
            </p>
          </div>
        )}

        <div>
          <label className="label">地点</label>
          <input
            className="field"
            value={form.location}
            placeholder="教学楼 A301"
            onChange={(e) => patch({ location: e.target.value })}
          />
        </div>

        <div>
          <label className="label">备注</label>
          <textarea
            className="field min-h-[90px]"
            value={form.remark}
            onChange={(e) => patch({ remark: e.target.value })}
          />
        </div>

        {editing?.id && editing.id !== 'new' && <AttachmentBlock itemId={editing.id} />}

        {existing?.origin === 'ai' && existing.pendingConfirm && existing.pendingConfirm.length > 0 && (
          <div className="card p-3 text-xs text-fg-muted">
            AI 解析结果，以下字段待确认：{existing.pendingConfirm.join('、')}
          </div>
        )}

        <div className="flex items-center justify-between pt-2 border-t border-line">
          {editing?.id === 'new' ? (
            <span />
          ) : (
            <button className="btn text-xs text-[#e5484d]" onClick={() => void remove()}>
              <Icon name="Trash2" size={13} /> 删除
            </button>
          )}
          <div className="flex gap-2">
            <button className="btn" onClick={closeEditor}>
              取消
            </button>
            <button className="btn btn-primary" onClick={() => void save()}>
              保存
            </button>
          </div>
        </div>
      </div>
    </Drawer>
  );
}

/** 条目上挂的附件 */
function AttachmentBlock({ itemId }: { itemId: string }) {
  const revision = useUI((s) => s.revision);
  const bump = useUI((s) => s.bump);
  const toast = useUI((s) => s.toast);
  const ref = useRef<HTMLInputElement>(null);
  const list = useLiveQuery(
    () => attachmentRepo.attachmentsOf({ kind: 'item', id: itemId }),
    [itemId, revision],
  );

  return (
    <div>
      <label className="label">附件</label>
      {list && list.length > 0 && (
        <div className="space-y-1 mb-2">
          {list.map((a) => (
            <div key={a.id} className="flex items-center gap-2 text-xs bg-bg-elev rounded px-2 py-1">
              <Icon name="FileText" size={12} />
              <span className="truncate flex-1" title={a.name}>
                {a.name}
              </span>
              {a.extractedText && <span className="text-fg-dim">{a.extractedText.length} 字</span>}
              <button
                className="text-fg-dim hover:text-[#e5484d]"
                onClick={async () => {
                  await attachmentRepo.detachFrom(a.id, { kind: 'item', id: itemId });
                  bump();
                }}
                aria-label="取消关联"
              >
                <Icon name="X" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <button className="btn text-xs w-full justify-center" onClick={() => ref.current?.click()}>
        <Icon name="Upload" size={13} /> 上传并关联附件
      </button>
      <input
        ref={ref}
        type="file"
        multiple
        accept="image/*,.pdf,.doc,.docx,.md,.txt"
        className="hidden"
        onChange={async (e) => {
          const files = e.target.files;
          if (!files?.length) return;
          for (const f of Array.from(files)) {
            await attachmentRepo.addAttachment(f, f.name, {
              ownerRefs: [{ kind: 'item', id: itemId }],
            });
          }
          e.target.value = '';
          bump();
          toast(`已关联 ${files.length} 个附件`);
        }}
      />
    </div>
  );
}

/** 供其他视图复用的小组件：类型色点 */
export function TypeDot({ type, size = 8 }: { type: ItemType; size?: number }) {
  const m = ITEM_TYPES[type];
  return (
    <span
      className="inline-block rounded-full shrink-0"
      style={{ width: size, height: size, background: m.color }}
    />
  );
}

export function ItemMetaChips({ item }: { item: ScheduleItem }) {
  const tags = useLiveQuery(() => tagRepo.listTags(), []);
  const names = useMemo(
    () => item.tags.map((id) => tags?.find((t) => t.id === id)?.name).filter(Boolean) as string[],
    [item.tags, tags],
  );
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-fg-dim">
      <span style={{ color: STATUS_META[item.status].color }}>{STATUS_META[item.status].label}</span>
      {item.priority > 0 && (
        <span style={{ color: PRIORITY_META[item.priority].color }}>
          {PRIORITY_META[item.priority].label}
        </span>
      )}
      {names.map((n) => (
        <span key={n} className="chip border-line">
          {n}
        </span>
      ))}
    </span>
  );
}
