import { newId, nowISO } from '../domain/id';
import type { ID, Tag } from '../domain/types';
import { db } from './db';

export async function listTags(): Promise<Tag[]> {
  const rows = await db.tags.toArray();
  return rows.filter((t) => !t.deletedAt).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

/** 按名字取标签，不存在就创建（收集箱/AI 自动打标时很常用） */
export async function ensureTag(name: string): Promise<Tag> {
  const clean = name.trim().replace(/^#/, '');
  if (!clean) throw new Error('标签名不能为空');
  const exist = await db.tags.where('name').equals(clean).first();
  if (exist && !exist.deletedAt) return exist;
  if (exist) {
    const revived: Tag = { ...exist, deletedAt: null, updatedAt: nowISO(), rev: exist.rev + 1 };
    await db.tags.put(revived);
    return revived;
  }
  const tag: Tag = {
    id: newId(),
    name: clean,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    deletedAt: null,
    rev: 1,
    parentId: null,
  };
  await db.tags.put(tag);
  return tag;
}

export async function ensureTags(names: string[]): Promise<ID[]> {
  const out: ID[] = [];
  for (const n of names) {
    if (!n.trim()) continue;
    const t = await ensureTag(n);
    if (!out.includes(t.id)) out.push(t.id);
  }
  return out;
}

export async function tagMap(): Promise<Map<ID, Tag>> {
  const rows = await listTags();
  return new Map(rows.map((t) => [t.id, t]));
}

export async function softDeleteTag(id: ID): Promise<void> {
  const cur = await db.tags.get(id);
  if (!cur) return;
  await db.tags.put({ ...cur, deletedAt: nowISO(), rev: cur.rev + 1 });
}

/** 统计每个标签被多少条目/笔记引用（用于标签视图显示计数） */
export async function tagUsage(): Promise<Map<ID, number>> {
  const usage = new Map<ID, number>();
  const bump = (ids: ID[]) => ids.forEach((i) => usage.set(i, (usage.get(i) ?? 0) + 1));
  const items = await db.items.toArray();
  items.filter((i) => !i.deletedAt).forEach((i) => bump(i.tags));
  const notes = await db.notes.toArray();
  notes.filter((n) => !n.deletedAt).forEach((n) => bump(n.tags));
  return usage;
}
