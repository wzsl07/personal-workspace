import { applyStatus, anchorTime, sortItems } from '../domain/item';
import { newId, nowISO } from '../domain/id';
import { overlaps } from '../domain/time';
import type {
  ID,
  ItemQuery,
  ItemStatus,
  ScheduleItem,
  SortKey,
} from '../domain/types';
import { db } from './db';

/**
 * 条目仓储。所有写入都会：
 * - 递增 rev（阶段 4 冲突合并依赖）
 * - 更新 updatedAt
 * - 删除一律软删除（deletedAt），同步时才真正清理
 */

export async function getItem(id: ID): Promise<ScheduleItem | undefined> {
  const it = await db.items.get(id);
  return it && !it.deletedAt ? it : undefined;
}

export async function createItem(input: Partial<ScheduleItem> & { title: string }): Promise<ScheduleItem> {
  const now = nowISO();
  const item: ScheduleItem = {
    id: input.id ?? newId(),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    rev: 1,
    type: input.type ?? 'task',
    title: input.title.trim(),
    startAt: input.startAt ?? null,
    dueAt: input.dueAt ?? null,
    allDay: input.allDay ?? true,
    priority: input.priority ?? 0,
    status: input.status ?? 'notStarted',
    completedAt: input.completedAt ?? null,
    tags: input.tags ?? [],
    noteIds: input.noteIds ?? [],
    attachmentIds: input.attachmentIds ?? [],
    sourceId: input.sourceId ?? null,
    courseId: input.courseId ?? null,
    classId: input.classId ?? null,
    reminderIds: input.reminderIds ?? [],
    recurrence: input.recurrence ?? null,
    location: input.location ?? '',
    remark: input.remark ?? '',
    extra: input.extra ?? {},
    origin: input.origin ?? 'manual',
    pendingConfirm: input.pendingConfirm ?? [],
    confidence: input.confidence ?? {},
  };
  await db.items.put(item);
  return item;
}

export async function updateItem(
  id: ID,
  patch: Partial<ScheduleItem>,
): Promise<ScheduleItem | undefined> {
  const cur = await getItem(id);
  if (!cur) return undefined;
  const next: ScheduleItem = {
    ...cur,
    ...patch,
    id: cur.id,
    createdAt: cur.createdAt,
    updatedAt: nowISO(),
    rev: cur.rev + 1,
  };
  await db.items.put(next);
  return next;
}

export async function setStatus(id: ID, status: ItemStatus): Promise<void> {
  const cur = await getItem(id);
  if (!cur) return;
  await db.items.put(applyStatus(cur, status));
}

export async function softDeleteItem(id: ID): Promise<void> {
  const cur = await getItem(id);
  if (!cur) return;
  await db.items.put({
    ...cur,
    deletedAt: nowISO(),
    updatedAt: nowISO(),
    rev: cur.rev + 1,
  });
}

/** 真正的物理删除（仅用于"清空数据"） */
export async function purgeItem(id: ID): Promise<void> {
  await db.items.delete(id);
}

export async function listItems(opts: {
  query?: ItemQuery;
  sort?: SortKey;
  includeDeleted?: boolean;
} = {}): Promise<ScheduleItem[]> {
  const { query = {}, sort = 'dueAt', includeDeleted = false } = opts;
  let rows = await db.items.toArray();
  if (!includeDeleted) rows = rows.filter((r) => !r.deletedAt);

  const kw = query.keyword?.trim().toLowerCase();
  const from = query.from ? new Date(query.from).getTime() : null;
  const to = query.to ? new Date(query.to).getTime() : null;

  const filtered = rows.filter((r) => {
    if (query.types?.length && !query.types.includes(r.type)) return false;
    if (query.statuses?.length && !query.statuses.includes(r.status)) return false;
    if (query.openOnly && (r.status === 'done' || r.status === 'cancelled')) return false;
    if (query.priorityMin !== undefined && r.priority < query.priorityMin) return false;
    if (query.courseId && r.courseId !== query.courseId) return false;
    if (query.tags?.length && !query.tags.some((t) => r.tags.includes(t))) return false;
    if (from !== null || to !== null) {
      if (!overlaps(r.startAt, r.dueAt, {
        from: new Date(from ?? 0).toISOString(),
        to: new Date(to ?? 8.64e15).toISOString(),
      })) return false;
    }
    if (kw) {
      const hay = `${r.title} ${r.remark ?? ''} ${r.location ?? ''}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });

  const sorted = sortItems(filtered, sort);
  return query.limit ? sorted.slice(0, query.limit) : sorted;
}

/** 今日视图：逾期 / 今天 / 近期 / 无期限 */
export async function todayBuckets(now: Date = new Date()): Promise<{
  overdue: ScheduleItem[];
  today: ScheduleItem[];
  soon: ScheduleItem[];
  noDate: ScheduleItem[];
}> {
  const open = await listItems({ query: { openOnly: true } });
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  const soonEnd = new Date(now.getTime() + 7 * 86400000);

  const overdue: ScheduleItem[] = [];
  const today: ScheduleItem[] = [];
  const soon: ScheduleItem[] = [];
  const noDate: ScheduleItem[] = [];

  for (const it of open) {
    const t = anchorTime(it);
    if (!t) {
      noDate.push(it);
      continue;
    }
    const ts = new Date(t).getTime();
    if (ts < now.getTime()) overdue.push(it);
    else if (ts <= endOfToday.getTime()) today.push(it);
    else if (ts <= soonEnd.getTime()) soon.push(it);
  }

  return {
    overdue: sortItems(overdue),
    today: sortItems(today),
    soon: sortItems(soon),
    noDate: sortItems(noDate, 'createdAt').reverse(),
  };
}

export async function countByType(): Promise<Record<string, number>> {
  const open = await listItems({ query: { openOnly: true } });
  const out: Record<string, number> = {};
  for (const it of open) out[it.type] = (out[it.type] ?? 0) + 1;
  return out;
}

/** 导出用：全量（含已删除，便于备份还原） */
export async function exportAllItems(): Promise<ScheduleItem[]> {
  return db.items.toArray();
}

/** 导入 / 恢复用：整批写入 */
export async function bulkPutItems(items: ScheduleItem[]): Promise<number> {
  await db.items.bulkPut(items);
  return items.length;
}

export async function clearAll(): Promise<void> {
  await db.items.clear();
}
