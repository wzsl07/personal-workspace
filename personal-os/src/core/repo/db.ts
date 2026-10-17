import Dexie, { type Table } from 'dexie';
import type {
  Attachment,
  Conflict,
  Draft,
  AIParseJob,
  ID,
  Link,
  Note,
  OutboxOp,
  Reminder,
  ScheduleItem,
  Source,
  SyncLog,
  Tag,
} from '../domain/types';

/**
 * 本地主库（IndexedDB）。
 * 阶段 1 只用 items / notes / tags / links / sources / reminders / meta；
 * 其余表按 v0 设计提前建好，阶段 4（同步）与阶段 2（AI）直接可用，无需迁移。
 */
export interface VectorRow {
  id: string;
  kind: 'item' | 'note' | 'attachment';
  refId: string;
  /** 内容哈希：内容没变就不重算向量 */
  hash: string;
  title: string;
  typeLabel: string;
  vec: Float32Array;
}

export class PersonalDB extends Dexie {
  items!: Table<ScheduleItem, ID>;
  notes!: Table<Note, ID>;
  links!: Table<Link, ID>;
  attachments!: Table<Attachment, ID>;
  tags!: Table<Tag, ID>;
  sources!: Table<Source, ID>;
  reminders!: Table<Reminder, ID>;
  drafts!: Table<Draft, ID>;
  aiJobs!: Table<AIParseJob, ID>;
  outbox!: Table<OutboxOp, ID>;
  conflicts!: Table<Conflict, ID>;
  syncLogs!: Table<SyncLog, ID>;
  meta!: Table<{ key: string; value: unknown }, string>;
  /** OPFS 不可用时的二进制回退存储 */
  blobs!: Table<{ key: string; blob: Blob }, string>;
  /** 语义搜索向量：id = `${kind}:${refId}` */
  vectors!: Table<VectorRow, string>;

  constructor() {
    super('personal-os');
    this.version(1).stores({
      items:
        'id, type, status, dueAt, startAt, updatedAt, createdAt, deletedAt, [type+dueAt], [status+dueAt], *tags, courseId',
      notes: 'id, path, updatedAt, createdAt, deletedAt, *tags',
      links: 'id, fromId, toId, [fromType+fromId], [toType+toId], deletedAt',
      attachments: 'id, name, hash, updatedAt, deletedAt',
      tags: 'id, &name, parentId, deletedAt',
      sources: 'id, kind, capturedAt, processed, deletedAt',
      reminders: 'id, itemId, triggerAt, fired, deletedAt',
      drafts: 'id, jobId, state, deletedAt',
      aiJobs: 'id, status, createdAt, deletedAt',
      outbox: 'id, seq, status, entityId',
      conflicts: 'id, entityId, resolvedAt',
      syncLogs: 'id, status, startedAt',
      meta: 'key',
    });

    // v2：OPFS 不可用时的二进制回退表（只在没有 OPFS 的浏览器上才会用到）
    this.version(2).stores({
      blobs: 'key',
    });

    // v3：语义搜索的向量（本地 embedding，可选功能）
    this.version(3).stores({
      vectors: 'id, refId, hash',
    });
  }
}

export const db = new PersonalDB();

/** 打开失败时给一个明确提示，而不是白屏 */
export async function openDB(): Promise<void> {
  try {
    await db.open();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`本地数据库打开失败：${msg}（可能处于隐私模式或浏览器禁用了 IndexedDB）`);
  }
}

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const row = await db.meta.get(key);
  return row === undefined ? fallback : (row.value as T);
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}
