import type { Snapshot } from '../../io/backup';

export type SyncAdapterId = 'none' | 'localFolder' | 'webdav' | 'github' | 'supabase';

export interface SyncConfig {
  adapter: SyncAdapterId;
  /** 本地文件夹：目录名（句柄存在 IndexedDB）；远程：各自含义见适配器 */
  remotePath: string;
  // webdav / 自托管
  url: string;
  username: string;
  // github
  repo: string;
  branch: string;
  // supabase
  table: string;
  /** 自动同步间隔（分钟），0 = 关闭 */
  autoMinutes: number;
  /** 同步附件抽取出的文本（不含二进制） */
  syncAttachmentText: boolean;
}

export const DEFAULT_SYNC: SyncConfig = {
  adapter: 'none',
  remotePath: 'personal-os-snapshot.json',
  url: '',
  username: '',
  repo: '',
  branch: 'main',
  table: 'snapshots',
  autoMinutes: 0,
  syncAttachmentText: true,
};

export type TestResult = { ok: boolean; message: string };

/**
 * 同步适配器统一接口。
 * 所有适配器都只做一件事：读写一份全量快照（Snapshot）。
 * 这样"增量"与"冲突"完全交给引擎用三路比对处理，适配器保持简单可替换。
 */
export interface SyncAdapter {
  id: SyncAdapterId;
  label: string;
  /** 是否需要联网 */
  remote: boolean;
  /** 一句话说明，展示在设置页 */
  hint: string;
  /** 该适配器需要的配置字段 */
  fields: ('url' | 'username' | 'password' | 'repo' | 'branch' | 'table' | 'path')[];
  test(cfg: SyncConfig, secret: string): Promise<TestResult>;
  read(cfg: SyncConfig, secret: string): Promise<Snapshot | null>;
  write(cfg: SyncConfig, secret: string, snap: Snapshot): Promise<void>;
}
