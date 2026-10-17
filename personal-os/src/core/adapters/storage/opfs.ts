/**
 * 附件存储：OPFS（Origin Private File System）。
 * 相比把二进制塞进 IndexedDB，OPFS 更适合大文件，且不撑爆查询结果。
 * 若浏览器不支持 OPFS（Safari 较老版本），回退到 IndexedDB 的 blobs 表。
 */

const DIR = 'attachments';

export async function hasOPFS(): Promise<boolean> {
  return typeof navigator !== 'undefined' && 'storage' in navigator && !!navigator.storage?.getDirectory;
}

async function root(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

/** 返回存储键（相对路径），失败时回退 */
export async function putFile(key: string, blob: Blob): Promise<string> {
  if (await hasOPFS()) {
    const dir = await (await root()).getDirectoryHandle(DIR, { create: true });
    const fh = await dir.getFileHandle(key, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
    return `opfs:${DIR}/${key}`;
  }
  const { db } = await import('../../repo/db');
  await db.attachments.put({
    id: key,
    name: key,
    mime: blob.type,
    size: blob.size,
    storageKey: `idb:${key}`,
    ownerRefs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    rev: 1,
  } as never);
  // 二进制本体存单独的 blobs 表
  await (db as unknown as { blobs: { put: (v: { key: string; blob: Blob }) => Promise<unknown> } }).blobs.put({
    key,
    blob,
  });
  return `idb:${key}`;
}

export async function getBlob(storageKey: string): Promise<Blob | null> {
  if (storageKey.startsWith('opfs:')) {
    const path = storageKey.slice(5).split('/');
    const file = path.pop();
    if (!file) return null;
    try {
      let dir = await root();
      for (const p of path) dir = await dir.getDirectoryHandle(p);
      const fh = await dir.getFileHandle(file);
      return await fh.getFile();
    } catch {
      return null;
    }
  }
  if (storageKey.startsWith('idb:')) {
    const { db } = await import('../../repo/db');
    const row = await (
      db as unknown as { blobs: { get: (k: string) => Promise<{ blob: Blob } | undefined> } }
    ).blobs.get(storageKey.slice(4));
    return row?.blob ?? null;
  }
  return null;
}

export async function removeFile(storageKey: string): Promise<void> {
  if (storageKey.startsWith('opfs:')) {
    const path = storageKey.slice(5).split('/');
    const file = path.pop();
    if (!file) return;
    try {
      let dir = await root();
      for (const p of path) dir = await dir.getDirectoryHandle(p);
      await dir.removeEntry(file);
    } catch {
      /* 已删除就忽略 */
    }
    return;
  }
  if (storageKey.startsWith('idb:')) {
    const { db } = await import('../../repo/db');
    await (
      db as unknown as { blobs: { delete: (k: string) => Promise<void> } }
    ).blobs.delete(storageKey.slice(4));
  }
}

/** 内容哈希（SHA-256），用于去重 */
export async function sha256(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function usage(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const est = await navigator.storage.estimate();
  return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
}
