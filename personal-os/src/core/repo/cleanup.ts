import { nowISO } from '../domain/id';
import type { Note, ScheduleItem } from '../domain/types';
import { db } from './db';

/**
 * 重复数据清理。
 *
 * 为什么会重复：两台设备的示例数据（或各自录入的同一件事）id 不同，
 * 同步按 id 合并，于是两边的内容叠在一起变成两份。
 *
 * 判定"重复"的依据：
 * - 日程：类型 + 标题 + 时间（开始或截止）三者相同，正文也相同
 * - 笔记：路径相同（path 本来就该唯一）
 *
 * 处理方式是**软删除**而不是真删 —— 既能同步到另一台设备，也留有退路。
 */

export interface DupGroup {
  key: string;
  keep: { id: string; title: string; when: string };
  drop: { id: string; title: string; when: string }[];
}

function itemKey(i: ScheduleItem): string {
  const when = i.dueAt ?? i.startAt ?? '';
  return `${i.type}|${i.title.trim()}|${when}|${(i.remark ?? '').trim().slice(0, 80)}`;
}

function fmtWhen(iso: string): string {
  if (!iso) return '无时间';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 纯计算：按"类型+标题+时间+正文"给日程分组（不碰数据库，方便单测） */
export function groupDupItems(
  rows: ScheduleItem[],
): { key: string; keep: ScheduleItem; drop: ScheduleItem[] }[] {
  const byKey = new Map<string, ScheduleItem[]>();
  for (const r of rows) {
    if (r.deletedAt) continue; // 已删除的不参与
    const k = itemKey(r);
    const list = byKey.get(k) ?? [];
    list.push(r);
    byKey.set(k, list);
  }
  const out: { key: string; keep: ScheduleItem; drop: ScheduleItem[] }[] = [];
  for (const [key, list] of byKey) {
    if (list.length < 2) continue;
    // 保留最早创建的那条，其余视为重复
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const [keep, ...drop] = list;
    out.push({ key, keep, drop });
  }
  return out;
}

/** 找出重复的日程（不改数据，用于预览） */
export async function findDuplicateItems(): Promise<DupGroup[]> {
  const rows = await db.items.toArray();
  return groupDupItems(rows).map((g) => ({
    key: g.key,
    keep: {
      id: g.keep.id,
      title: g.keep.title,
      when: fmtWhen(g.keep.dueAt ?? g.keep.startAt ?? ''),
    },
    drop: g.drop.map((d) => ({
      id: d.id,
      title: d.title,
      when: fmtWhen(d.dueAt ?? d.startAt ?? ''),
    })),
  }));
}

/** 找出路径重复的笔记 */
export async function findDuplicateNotes(): Promise<DupGroup[]> {
  const rows = (await db.notes.toArray()).filter((n) => !n.deletedAt);
  const byPath = new Map<string, Note[]>();
  for (const r of rows) {
    const k = r.path.trim();
    const list = byPath.get(k) ?? [];
    list.push(r);
    byPath.set(k, list);
  }
  const out: DupGroup[] = [];
  for (const [key, list] of byPath) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const [keep, ...drop] = list;
    out.push({
      key,
      keep: { id: keep.id, title: keep.title, when: '笔记' },
      drop: drop.map((d) => ({ id: d.id, title: d.title, when: '笔记' })),
    });
  }
  return out;
}

/** 执行清理：软删除重复项，返回清理了多少条 */
export async function dedupe(): Promise<{ items: number; notes: number }> {
  const [gi, gn] = await Promise.all([findDuplicateItems(), findDuplicateNotes()]);
  let items = 0;
  let notes = 0;

  for (const g of gi) {
    for (const d of g.drop) {
      const cur = await db.items.get(d.id);
      if (!cur || cur.deletedAt) continue;
      await db.items.put({ ...cur, deletedAt: nowISO(), updatedAt: nowISO(), rev: cur.rev + 1 });
      items += 1;
    }
  }
  for (const g of gn) {
    for (const d of g.drop) {
      const cur = await db.notes.get(d.id);
      if (!cur || cur.deletedAt) continue;
      await db.notes.put({ ...cur, deletedAt: nowISO(), updatedAt: nowISO(), rev: cur.rev + 1 });
      notes += 1;
    }
  }
  return { items, notes };
}
