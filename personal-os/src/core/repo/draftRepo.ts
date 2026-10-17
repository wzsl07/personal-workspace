import { newId, nowISO } from '../domain/id';
import { runParse } from '../adapters/ai';
import type { AIProviderId } from '../domain/types';
import type { Draft, AIParseJob, ID, ScheduleItem, Source } from '../domain/types';
import { db } from './db';
import * as itemRepo from './itemRepo';
import * as noteRepo from './noteRepo';
import * as tagRepo from './tagRepo';
import * as sourceRepo from './sourceRepo';

/**
 * AI 解析任务与草稿。
 * 硬约束：AI 只能写 drafts，确认后才由 commitDraft 写入正式表。
 */

const CONFIRM_THRESHOLD = 0.7;

/** 低于阈值的字段标为"待确认" */
function pendingOf(confidence: Record<string, number | undefined>): string[] {
  return Object.entries(confidence)
    .filter(([, v]) => typeof v === 'number' && v < CONFIRM_THRESHOLD)
    .map(([k]) => k);
}

export async function listPendingDrafts(): Promise<Draft[]> {
  const rows = await db.drafts.toArray();
  return rows
    .filter((d) => !d.deletedAt && d.state === 'pending')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listJobs(limit = 30): Promise<AIParseJob[]> {
  const rows = await db.aiJobs.toArray();
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

export interface ParseOutcome {
  job: AIParseJob;
  drafts: Draft[];
  notes: string[];
}

/** 对一个 Source 跑一次解析，产出草稿（不写正式数据） */
export async function parseSource(source: Source): Promise<ParseOutcome> {
  const now = new Date();
  const job: AIParseJob = {
    id: newId(),
    createdAt: nowISO(),
    updatedAt: nowISO(),
    deletedAt: null,
    rev: 1,
    sourceId: source.id,
    provider: 'rule' as AIProviderId,
    status: 'running',
    retries: 0,
    inputKind: source.kind,
    outputDraftIds: [],
    startedAt: now.toISOString(),
  };
  await db.aiJobs.put(job);

  try {
    const plain = await sourceRepo.readRaw(source);
    const result = await runParse(plain || source.url || '', now);
    const drafts: Draft[] = [];
    for (const it of result.items) {
      const draft: Draft = {
        id: newId(),
        createdAt: nowISO(),
        updatedAt: nowISO(),
        deletedAt: null,
        rev: 1,
        jobId: job.id,
        target: 'item',
        payload: {
          title: it.title,
          type: it.type,
          startAt: it.startAt,
          dueAt: it.dueAt,
          allDay: it.allDay,
          priority: it.priority,
          status: it.status,
          location: it.location,
          remark: it.summary,
          sourceId: source.id,
          origin: 'ai',
        } as Partial<ScheduleItem>,
        pendingConfirm: pendingOf(it.confidence as unknown as Record<string, number | undefined>),
        confidence: it.confidence as Record<string, number>,
        state: 'pending',
        suggestedTags: it.tags,
      };
      drafts.push(draft);
    }

    if (result.note) {
      drafts.push({
        id: newId(),
        createdAt: nowISO(),
        updatedAt: nowISO(),
        deletedAt: null,
        rev: 1,
        jobId: job.id,
        target: 'note',
        payload: { title: result.note.title, content: result.note.content } as Partial<
          import('../domain/types').Note
        >,
        pendingConfirm: ['title'],
        confidence: { title: 0.6 },
        state: 'pending',
      });
    }

    await db.drafts.bulkPut(drafts);

    const done: AIParseJob = {
      ...job,
      provider: result.provider,
      status: 'success',
      outputDraftIds: drafts.map((d) => d.id),
      finishedAt: nowISO(),
      updatedAt: nowISO(),
      rev: job.rev + 1,
    };
    await db.aiJobs.put(done);
    return { job: done, drafts, notes: result.notes };
  } catch (e) {
    const failed: AIParseJob = {
      ...job,
      status: 'failed',
      error: e instanceof Error ? e.message.slice(0, 300) : String(e),
      finishedAt: nowISO(),
      updatedAt: nowISO(),
      rev: job.rev + 1,
    };
    await db.aiJobs.put(failed);
    throw e;
  }
}

/** 失败重试（最多 3 次） */
export async function retryJob(jobId: ID): Promise<ParseOutcome | null> {
  const job = await db.aiJobs.get(jobId);
  if (!job) return null;
  if (job.retries >= 3) throw new Error('已重试 3 次仍然失败，请检查网络或 API 配置');
  await db.aiJobs.put({ ...job, retries: job.retries + 1, rev: job.rev + 1 });
  const source = await db.sources.get(job.sourceId);
  if (!source) throw new Error('原始内容已不存在');
  return parseSource(source);
}

/** 确认草稿 → 写入正式条目。这是唯一允许 AI 结果落库的出口。 */
export async function commitDraft(
  draftId: ID,
  edits?: Partial<ScheduleItem> | Partial<import('../domain/types').Note>,
): Promise<{ itemId?: ID; noteId?: ID }> {
  const d = await db.drafts.get(draftId);
  if (!d || d.deletedAt) throw new Error('草稿不存在');

  if (d.target === 'item') {
    const payload = { ...(d.payload as Partial<ScheduleItem>), ...(edits ?? {}) };
    const tagNames = d.suggestedTags ?? [];
    const tagIds = tagNames.length ? await tagRepo.ensureTags(tagNames) : [];
    const item = await itemRepo.createItem({
      ...payload,
      title: payload.title ?? '未命名条目',
      tags: [...(payload.tags ?? []), ...tagIds],
    });
    await db.drafts.put({
      ...d,
      state: edits ? 'edited' : 'accepted',
      updatedAt: nowISO(),
      rev: d.rev + 1,
    });
    if (item.sourceId) await sourceRepo.markProcessed(item.sourceId);
    return { itemId: item.id };
  }

  const payload = { ...(d.payload as Partial<import('../domain/types').Note>), ...(edits ?? {}) };
  const note = await noteRepo.createNote({
    ...payload,
    title: payload.title ?? '未命名笔记',
  });
  await db.drafts.put({ ...d, state: edits ? 'edited' : 'accepted', updatedAt: nowISO(), rev: d.rev + 1 });
  return { noteId: note.id };
}

export async function rejectDraft(draftId: ID): Promise<void> {
  const d = await db.drafts.get(draftId);
  if (!d) return;
  await db.drafts.put({ ...d, state: 'rejected', updatedAt: nowISO(), rev: d.rev + 1 });
}

export async function updateDraftPayload(
  draftId: ID,
  payload: Partial<ScheduleItem> | Partial<import('../domain/types').Note>,
): Promise<void> {
  const d = await db.drafts.get(draftId);
  if (!d) return;
  await db.drafts.put({ ...d, payload, updatedAt: nowISO(), rev: d.rev + 1 });
}

/** 丢弃某个任务产生的全部草稿 */
export async function rejectAllOfJob(jobId: ID): Promise<number> {
  const rows = await db.drafts.where('jobId').equals(jobId).toArray();
  let n = 0;
  for (const d of rows) {
    if (d.state === 'pending') {
      await db.drafts.put({ ...d, state: 'rejected', updatedAt: nowISO(), rev: d.rev + 1 });
      n += 1;
    }
  }
  return n;
}
