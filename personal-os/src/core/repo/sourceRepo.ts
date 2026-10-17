import { newId, nowISO } from '../domain/id';
import { unwrapText, wrapText } from '../security/sensitive';
import type { ID, Source, SourceKind } from '../domain/types';
import { db } from './db';

/** 收集箱 = 未整理的 Source。整理后 processed 置 true，但原文仍保留用于溯源。 */
export async function createSource(input: {
  kind: SourceKind;
  rawText?: string;
  url?: string;
  attachmentId?: ID;
}): Promise<Source> {
  const now = nowISO();
  const s: Source = {
    id: newId(),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    rev: 1,
    kind: input.kind,
    // 开启"敏感正文加密"时，原文以密文落库
    rawText: await wrapText(input.rawText ?? ''),
    url: input.url ?? '',
    attachmentId: input.attachmentId ?? null,
    capturedAt: now,
    processed: false,
  };
  await db.sources.put(s);
  return s;
}

export async function listInbox(): Promise<Source[]> {
  const rows = await db.sources.toArray();
  return rows
    .filter((s) => !s.deletedAt && !s.processed)
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
}

export async function listAllSources(limit = 100): Promise<Source[]> {
  const rows = await db.sources.toArray();
  return rows
    .filter((s) => !s.deletedAt)
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
    .slice(0, limit);
}

export async function markProcessed(id: ID, processed = true): Promise<void> {
  const cur = await db.sources.get(id);
  if (!cur) return;
  await db.sources.put({ ...cur, processed, updatedAt: nowISO(), rev: cur.rev + 1 });
}

export async function softDeleteSource(id: ID): Promise<void> {
  const cur = await db.sources.get(id);
  if (!cur) return;
  await db.sources.put({ ...cur, deletedAt: nowISO(), updatedAt: nowISO(), rev: cur.rev + 1 });
}

/** 读取原文（自动解密） */
export async function readRaw(source: Source): Promise<string> {
  return unwrapText(source.rawText) ?? '';
}

/** 从一段文本里粗略识别来源类型（阶段 2 由 AI 接管） */
export function guessKind(text: string): SourceKind {
  const t = text.trim();
  if (/^https?:\/\//i.test(t)) return 'url';
  return 'text';
}
