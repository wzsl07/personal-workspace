import { getMeta, setMeta } from '../../repo/db';
import { loadSecret, saveSecret } from '../crypto';
import { localFolderAdapter } from './localFolder';
import { remoteAdapters } from './remote';
import { DEFAULT_SYNC, type SyncAdapter, type SyncAdapterId, type SyncConfig } from './types';

export * from './types';
export { SUPABASE_SQL } from './remote';
export { pickFolder, clearHandle } from './localFolder';

const none: SyncAdapter = {
  id: 'none',
  label: '不同步',
  remote: false,
  hint: '只用导出 / 导入做备份与迁移',
  fields: [],
  async test() {
    return { ok: true, message: '当前未启用同步' };
  },
  async read() {
    return null;
  },
  async write() {
    throw new Error('未启用同步');
  },
};

export const SYNC_ADAPTERS: Record<SyncAdapterId, SyncAdapter> = {
  none,
  localFolder: localFolderAdapter,
  webdav: remoteAdapters.webdav,
  github: remoteAdapters.github,
  supabase: remoteAdapters.supabase,
};

export const SYNC_LIST = Object.values(SYNC_ADAPTERS);

const CFG_KEY = 'sync:config';

export async function loadSyncConfig(): Promise<SyncConfig> {
  const stored = await getMeta<Partial<SyncConfig>>(CFG_KEY, {});
  return { ...DEFAULT_SYNC, ...stored };
}

export async function saveSyncConfig(cfg: SyncConfig): Promise<void> {
  await setMeta(CFG_KEY, cfg);
}

/** 凭据（密码 / Token / Key）一律加密存本地 */
export async function loadSyncSecret(): Promise<string> {
  try {
    return await loadSecret('sync.secret');
  } catch {
    return '';
  }
}

export async function saveSyncSecret(v: string): Promise<void> {
  await saveSecret('sync.secret', v);
}

export function adapterOf(id: SyncAdapterId): SyncAdapter {
  return SYNC_ADAPTERS[id] ?? none;
}
