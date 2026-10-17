import { newId, nowISO } from '../domain/id';
import { getBlob, putFile, removeFile, sha256 } from '../adapters/storage/opfs';
import { extractText, kindOfFile } from '../adapters/extract';
import { unwrapText, wrapText } from '../security/sensitive';
import type { Attachment, ID, Ref, SourceKind } from '../domain/types';
import { db } from './db';

/** 附件：OPFS 存二进制，IndexedDB 存元信息与抽取出的文本 */

export async function listAttachments(): Promise<Attachment[]> {
  const rows = await db.attachments.toArray();
  return rows
    .filter((a) => !a.deletedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getAttachment(id: ID): Promise<Attachment | undefined> {
  const a = await db.attachments.get(id);
  return a && !a.deletedAt ? a : undefined;
}

export async function getAttachmentBlob(a: Attachment): Promise<Blob | null> {
  return getBlob(a.storageKey);
}

export interface AddOptions {
  /** 关联到哪个笔记/条目 */
  ownerRefs?: Ref[];
  /** 是否立刻抽取文本 */
  extract?: boolean;
  onProgress?: (msg: string) => void;
}

/** 新增附件（自动按内容哈希去重） */
export async function addAttachment(
  file: File | Blob,
  name: string,
  opts: AddOptions = {},
): Promise<{ attachment: Attachment; duplicate: boolean }> {
  const hash = await sha256(file);
  const exist = hash ? await db.attachments.where('hash').equals(hash).first() : undefined;
  if (exist && !exist.deletedAt) {
    // 已存在：只补关联关系，不重复存文件
    const merged: Attachment = {
      ...exist,
      ownerRefs: mergeRefs(exist.ownerRefs, opts.ownerRefs ?? []),
      updatedAt: nowISO(),
      rev: exist.rev + 1,
    };
    await db.attachments.put(merged);
    return { attachment: merged, duplicate: true };
  }

  const id = newId();
  const kind = kindOfFile(name, file.type);
  const storageKey = await putFile(`${id}-${name.replace(/[\\/:*?"<>|]/g, '_')}`, file);

  const attachment: Attachment = {
    id,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    deletedAt: null,
    rev: 1,
    name,
    mime: file.type || 'application/octet-stream',
    size: file.size,
    storageKey,
    hash,
    ownerRefs: opts.ownerRefs ?? [],
  };
  await db.attachments.put(attachment);

  if (opts.extract !== false) {
    await runExtract(attachment.id, file, kind, opts.onProgress);
  }
  return { attachment: (await getAttachment(id))!, duplicate: false };
}

function mergeRefs(a: Ref[], b: Ref[]): Ref[] {
  const out = [...a];
  for (const r of b) {
    if (!out.some((x) => x.kind === r.kind && x.id === r.id)) out.push(r);
  }
  return out;
}

/** 抽取（或重新抽取）文本 */
export async function runExtract(
  id: ID,
  blob?: Blob,
  kind?: SourceKind,
  onProgress?: (msg: string) => void,
): Promise<Attachment | undefined> {
  const a = await getAttachment(id);
  if (!a) return undefined;
  const data = blob ?? (await getBlob(a.storageKey));
  if (!data) return a;
  const k = kind ?? kindOfFile(a.name, a.mime);
  const res = await extractText(data, k, onProgress);
  const next: Attachment = {
    ...a,
    extractedText: res.text ? await wrapText(res.text) : undefined,
    extractedAt: nowISO(),
    updatedAt: nowISO(),
    rev: a.rev + 1,
    extra: res.error ? { extractError: res.error, method: res.method } : { method: res.method },
  } as Attachment;
  await db.attachments.put(next);
  return next;
}

/** 读取抽取出的文字（自动解密） */
export async function readExtracted(a: Attachment): Promise<string> {
  return unwrapText(a.extractedText);
}

export async function attachTo(id: ID, ref: Ref): Promise<void> {
  const a = await getAttachment(id);
  if (!a) return;
  await db.attachments.put({
    ...a,
    ownerRefs: mergeRefs(a.ownerRefs, [ref]),
    updatedAt: nowISO(),
    rev: a.rev + 1,
  });
}

export async function detachFrom(id: ID, ref: Ref): Promise<void> {
  const a = await getAttachment(id);
  if (!a) return;
  await db.attachments.put({
    ...a,
    ownerRefs: a.ownerRefs.filter((r) => !(r.kind === ref.kind && r.id === ref.id)),
    updatedAt: nowISO(),
    rev: a.rev + 1,
  });
}

/** 软删除（文件本体一并清理） */
export async function softDeleteAttachment(id: ID): Promise<void> {
  const a = await getAttachment(id);
  if (!a) return;
  await removeFile(a.storageKey);
  await db.attachments.put({ ...a, deletedAt: nowISO(), updatedAt: nowISO(), rev: a.rev + 1 });
}

export async function attachmentsOf(ref: Ref): Promise<Attachment[]> {
  const rows = await listAttachments();
  return rows.filter((a) => a.ownerRefs.some((r) => r.kind === ref.kind && r.id === ref.id));
}
