import type { Snapshot } from '../../io/backup';
import type { SyncAdapter, TestResult } from './types';

/**
 * 本地文件夹同步：用 File System Access API 直接读写你磁盘上的一个 JSON 文件。
 * 不需要任何服务器、不联网，最符合"本地优先"。
 * 支持：Chrome / Edge（桌面）。Safari / Firefox 暂不支持该 API。
 */

const HANDLE_KEY = 'personal-os-dir-handle';
const dbName = 'personal-os-handles';
const storeName = 'handles';

function openHandleDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(storeName);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openHandleDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(handle, HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openHandleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(HANDLE_KEY);
    req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearHandle(): Promise<void> {
  const db = await openHandleDB();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(HANDLE_KEY);
    tx.oncomplete = () => resolve();
  });
}

/** 让用户选一个文件夹（必须在用户手势里调用） */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!('showDirectoryPicker' in window)) {
    throw new Error('当前浏览器不支持本地文件夹同步（需要 Chrome / Edge 桌面版）');
  }
  const handle = await window.showDirectoryPicker?.({ mode: 'readwrite' });
  if (!handle) throw new Error('浏览器不支持选择本地文件夹');
  await saveHandle(handle);
  return handle;
}

async function ensurePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const opts = { mode: 'readwrite' as const };
  const q = await (handle as unknown as {
    queryPermission: (o: typeof opts) => Promise<PermissionState>;
  }).queryPermission?.(opts);
  if (q === 'granted') return true;
  const r = await (handle as unknown as {
    requestPermission: (o: typeof opts) => Promise<PermissionState>;
  }).requestPermission?.(opts);
  return r === 'granted';
}

async function getHandle(): Promise<FileSystemDirectoryHandle | null> {
  const h = await loadHandle();
  if (!h) return null;
  const ok = await ensurePermission(h);
  return ok ? h : null;
}

export const localFolderAdapter: SyncAdapter = {
  id: 'localFolder',
  label: '本地文件夹',
  remote: false,
  hint: '直接读写你磁盘上的一个 JSON 文件，不联网、不需要服务器（Chrome / Edge）',
  fields: ['path'],

  async test(): Promise<TestResult> {
    const h = await getHandle();
    if (!h) return { ok: false, message: '还没选择文件夹，或权限已失效' };
    return { ok: true, message: `已连接文件夹：${h.name}` };
  },

  async read(cfg): Promise<Snapshot | null> {
    const h = await getHandle();
    if (!h) throw new Error('未选择文件夹');
    try {
      const fh = await h.getFileHandle(cfg.remotePath || 'personal-os-snapshot.json');
      const file = await fh.getFile();
      const text = await file.text();
      if (!text.trim()) return null;
      return JSON.parse(text) as Snapshot;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not found|NotFoundError/i.test(msg)) return null;
      throw e;
    }
  },

  async write(cfg, _secret, snap): Promise<void> {
    const h = await getHandle();
    if (!h) throw new Error('未选择文件夹');
    const fh = await h.getFileHandle(cfg.remotePath || 'personal-os-snapshot.json', { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(snap, null, 2));
    await w.close();
  },
};

export { getHandle };
