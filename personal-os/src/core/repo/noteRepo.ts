import { newId, nowISO } from '../domain/id';
import type { ID, Link, Note } from '../domain/types';
import { db } from './db';

/** 从 Markdown 里抽出 [[双链]]，支持 [[标题]] 与 [[标题|别名]] */
export function parseWikiLinks(content: string): { target: string; alias?: string }[] {
  const re = /\[\[([^\[\]]+?)\]\]/g;
  const out: { target: string; alias?: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const raw = m[1];
    const [target, alias] = raw.split('|');
    out.push({ target: target.trim(), alias: alias?.trim() });
  }
  return out;
}

/** 抽出 #标签（避免把 Markdown 标题 # 误判为标签） */
export function parseInlineTags(content: string): string[] {
  const re = /(?:^|\s)#([^\s#]+\/[^\s#]+|[^\s#]+)/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) out.add(m[1]);
  return [...out];
}

export async function listNotes(): Promise<Note[]> {
  const rows = await db.notes.toArray();
  return rows
    .filter((n) => !n.deletedAt)
    .sort((a, b) => (a.pinned === b.pinned ? b.updatedAt.localeCompare(a.updatedAt) : a.pinned ? -1 : 1));
}

export async function getNote(id: ID): Promise<Note | undefined> {
  const n = await db.notes.get(id);
  return n && !n.deletedAt ? n : undefined;
}

export async function createNote(input: Partial<Note> & { title: string }): Promise<Note> {
  const now = nowISO();
  const title = input.title.trim();
  const note: Note = {
    id: input.id ?? newId(),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    rev: 1,
    title,
    path: input.path ?? `/${title}.md`,
    content: input.content ?? '',
    tags: input.tags ?? [],
    itemIds: input.itemIds ?? [],
    attachmentIds: input.attachmentIds ?? [],
    backlinks: input.backlinks ?? [],
    sourceId: input.sourceId ?? null,
    pinned: input.pinned ?? false,
  };
  await db.notes.put(note);
  return note;
}

export async function updateNote(id: ID, patch: Partial<Note>): Promise<Note | undefined> {
  const cur = await getNote(id);
  if (!cur) return undefined;
  const next: Note = { ...cur, ...patch, id: cur.id, createdAt: cur.createdAt, updatedAt: nowISO(), rev: cur.rev + 1 };
  await db.notes.put(next);
  return next;
}

export async function softDeleteNote(id: ID): Promise<void> {
  const cur = await getNote(id);
  if (!cur) return;
  await db.notes.put({ ...cur, deletedAt: nowISO(), updatedAt: nowISO(), rev: cur.rev + 1 });
}

/**
 * 保存笔记并重建它的出链 + 全库反链。
 * 链接目标按「标题」匹配；匹配不到就跳过（UI 可提示"创建该笔记"）。
 */
export async function saveNoteWithLinks(
  id: ID,
  content: string,
  patch: Partial<Note> = {},
): Promise<{ note: Note; unresolved: string[] }> {
  const updated = await updateNote(id, { ...patch, content });
  if (!updated) throw new Error('笔记不存在');
  const all = await listNotes();
  const byTitle = new Map(all.map((n) => [n.title.toLowerCase(), n]));
  const targets = parseWikiLinks(content);

  const unresolved: string[] = [];
  const links: Link[] = [];
  for (const t of targets) {
    const hit = byTitle.get(t.target.toLowerCase());
    if (!hit || hit.id === id) {
      if (!hit) unresolved.push(t.target);
      continue;
    }
    links.push({
      id: newId(),
      createdAt: nowISO(),
      updatedAt: nowISO(),
      deletedAt: null,
      rev: 1,
      fromType: 'note',
      fromId: id,
      toType: 'note',
      toId: hit.id,
      context: t.alias ?? t.target,
    });
  }

  await db.transaction('rw', db.links, db.notes, async () => {
    await db.links.where('[fromType+fromId]').equals(['note', id]).delete();
    if (links.length) await db.links.bulkPut(links);
  });

  await rebuildBacklinks();
  return { note: (await getNote(id))!, unresolved };
}

/** 重算所有笔记的 backlinks 冗余字段（量小，直接全量重算） */
export async function rebuildBacklinks(): Promise<void> {
  const [notes, links] = await Promise.all([db.notes.toArray(), db.links.toArray()]);
  const incoming = new Map<ID, ID[]>();
  for (const l of links) {
    if (l.deletedAt) continue;
    if (l.toType !== 'note') continue;
    const arr = incoming.get(l.toId) ?? [];
    if (!arr.includes(l.fromId)) arr.push(l.fromId);
    incoming.set(l.toId, arr);
  }
  const updates = notes.map((n) => {
    const bl = incoming.get(n.id) ?? [];
    const same = bl.length === n.backlinks.length && bl.every((x) => n.backlinks.includes(x));
    return same ? null : { ...n, backlinks: bl, updatedAt: n.updatedAt, rev: n.rev };
  }).filter((x): x is Note => x !== null);
  if (updates.length) await db.notes.bulkPut(updates);
}

export async function backlinksOf(id: ID): Promise<Note[]> {
  const notes = await listNotes();
  return notes.filter((n) => n.backlinks.includes(id));
}
