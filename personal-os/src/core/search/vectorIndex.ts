import { db } from '../repo/db';
import { embed, cosine, loadModel, modelReady } from '../adapters/embed';
import { ITEM_TYPES } from '../domain/item';
import { indexable } from '../security/sensitive';
import type { Attachment, Note, ScheduleItem } from '../domain/types';

/**
 * 语义搜索索引（本地 embedding）。
 * 增量策略：用内容哈希判断是否需要重算，内容没变的文档直接跳过。
 */

function hashOf(s: string): string {
  // 简单的 32 位哈希，够用且不引入依赖
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${h}`;
}

export type VectorKind = 'item' | 'note' | 'attachment' | 'feed';

/**
 * 信息流参与向量索引的条数上限。
 *
 * 每条约 30–60ms 算一次向量、占 2KB 存储。几百条无所谓，
 * 上千条首次建索引就要好几分钟，所以设个上限，只索引**最新的**那些。
 */
export const FEED_VECTOR_MAX = 2000;

export interface Doc {
  id: string;
  kind: VectorKind;
  refId: string;
  title: string;
  typeLabel: string;
  text: string;
}

/** 喂给向量索引的信息流条目（最小字段） */
export interface FeedVectorInput {
  id: string;
  refId: string;
  title: string;
  summary: string;
  content: string;
  sourceName: string;
  section: string;
}

export function collectDocs(
  items: ScheduleItem[],
  notes: Note[],
  attachments: Attachment[] = [],
  feed: FeedVectorInput[] = [],
): Doc[] {
  const docs: Doc[] = [];
  for (const i of items) {
    if (i.deletedAt) continue;
    docs.push({
      id: `item:${i.id}`,
      kind: 'item',
      refId: i.id,
      title: i.title,
      typeLabel: ITEM_TYPES[i.type].label,
      text: [i.title, i.remark ?? '', i.location ?? ''].join(' ').slice(0, 800),
    });
  }
  for (const n of notes) {
    if (n.deletedAt) continue;
    docs.push({
      id: `note:${n.id}`,
      kind: 'note',
      refId: n.id,
      title: n.title,
      typeLabel: '笔记',
      text: `${n.title}\n${n.content}`.slice(0, 800),
    });
  }
  for (const a of attachments) {
    // 加密正文不进索引（开了"敏感正文加密"就是这个后果）
    if (a.deletedAt || !a.extractedText || !indexable(a.extractedText)) continue;
    docs.push({
      id: `attachment:${a.id}`,
      kind: 'attachment',
      refId: a.id,
      title: a.name,
      typeLabel: '附件',
      text: a.extractedText.slice(0, 800),
    });
  }
  // 信息流：只取最新的 FEED_VECTOR_MAX 条，避免首次建索引跑太久
  for (const f of feed.slice(0, FEED_VECTOR_MAX)) {
    docs.push({
      id: f.id,
      kind: 'feed',
      refId: f.refId,
      title: f.title,
      typeLabel: f.sourceName || f.section || '信息流',
      text: [f.title, f.summary ?? '', f.content ?? ''].filter(Boolean).join('\n').slice(0, 800),
    });
  }
  return docs;
}

export interface BuildProgress {
  done: number;
  total: number;
  phase: 'load' | 'index' | 'done';
}

/** 增量建索引：只算内容变了的文档 */
export async function buildVectorIndex(
  docs: Doc[],
  onProgress?: (p: BuildProgress) => void,
): Promise<{ added: number; skipped: number }> {
  await loadModel(() => onProgress?.({ done: 0, total: docs.length, phase: 'load' }));

  const existing = await db.vectors.toArray();
  const byId = new Map(existing.map((v) => [v.id, v]));

  let added = 0;
  let skipped = 0;
  const total = docs.length;

  for (let i = 0; i < docs.length; i += 1) {
    const d = docs[i];
    const prev = byId.get(d.id);
    const hash = hashOf(d.text);
    if (prev && prev.hash === hash) {
      skipped += 1;
    } else {
      const vec = await embed(d.text);
      await db.vectors.put({
        id: d.id,
        kind: d.kind,
        refId: d.refId,
        hash,
        title: d.title,
        typeLabel: d.typeLabel,
        vec,
      });
      added += 1;
    }
    onProgress?.({ done: i + 1, total, phase: 'index' });
  }

  // 清理已删除的文档
  const alive = new Set(docs.map((d) => d.id));
  for (const v of existing) {
    if (!alive.has(v.id)) await db.vectors.delete(v.id);
  }

  onProgress?.({ done: total, total, phase: 'done' });
  return { added, skipped };
}

export interface VectorHit {
  id: string;
  kind: VectorKind;
  refId: string;
  title: string;
  typeLabel: string;
  score: number;
}

/** 语义检索：query 向量与全库向量比余弦相似度 */
export async function vectorSearch(
  q: string,
  limit = 20,
  kinds?: VectorKind[],
): Promise<VectorHit[]> {
  if (!modelReady()) await loadModel();
  const qv = await embed(q);
  const rows = await db.vectors.toArray();
  const pool = kinds && kinds.length ? rows.filter((r) => kinds.includes(r.kind as VectorKind)) : rows;
  const scored = pool
    .map((r) => ({ r, s: cosine(qv, r.vec) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit);
  return scored.map(({ r, s }) => ({
    id: r.id,
    kind: r.kind,
    refId: r.refId,
    title: r.title,
    typeLabel: r.typeLabel,
    score: s,
  }));
}

export async function vectorCount(): Promise<number> {
  return db.vectors.count();
}

export async function clearVectors(): Promise<void> {
  await db.vectors.clear();
}
