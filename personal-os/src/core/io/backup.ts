import { ITEM_TYPES } from '../domain/item';
import type { Note, ScheduleItem } from '../domain/types';
import { db, getMeta, setMeta } from '../repo/db';
import { nowISO } from '../domain/id';

/**
 * 导出文件到用户磁盘。
 *
 * 分两条路，因为**桌面壳里浏览器那套是失效的**：
 *   - 桌面端（Tauri）：走原生「另存为」对话框直接写盘。
 *     WebView2 的下载事件需要宿主接管，Tauri 默认不管，
 *     所以 `Blob + <a download>` 在桌面壳里点了**毫无反应**。
 *   - 浏览器 / PWA：Blob + 临时 a 标签，不依赖任何外部库。
 *
 * 返回值：'saved' 已保存（含路径） / 'cancelled' 用户取消 / 'downloaded' 已触发浏览器下载
 */
export type DownloadResult = {
  status: 'saved' | 'cancelled' | 'downloaded';
  path?: string;
};

export async function download(
  filename: string,
  content: string,
  mime: string,
): Promise<DownloadResult> {
  const { saveTextFile } = await import('../adapters/desktop');
  const r = await saveTextFile(filename, content);
  if (r === null) return { status: 'cancelled' };
  if (typeof r === 'string') return { status: 'saved', path: r };

  // 不是桌面环境（或调用失败）——回退到浏览器下载
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { status: 'downloaded' };
}

/** 把 download 的结果翻成人话，给调用方 toast 用 */
export function downloadMessage(
  r: { status: 'saved' | 'cancelled' | 'downloaded'; path?: string },
  fallback: string,
): string {
  if (r.status === 'saved') return `已保存到 ${r.path}`;
  if (r.status === 'cancelled') return '已取消，没有导出';
  return fallback;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ */
/* JSON：完整备份 / 恢复                                               */
/* ------------------------------------------------------------------ */

export interface Snapshot {
  format: 'personal-os-snapshot';
  version: 1;
  exportedAt: string;
  items: ScheduleItem[];
  notes: Note[];
  tags: unknown[];
  links: unknown[];
  sources: unknown[];
  reminders: unknown[];
  attachments: unknown[];
  drafts: unknown[];
  aiJobs: unknown[];
}

export async function buildSnapshot(): Promise<Snapshot> {
  const [items, notes, tags, links, sources, reminders, attachments, drafts, aiJobs] =
    await Promise.all([
      db.items.toArray(),
      db.notes.toArray(),
      db.tags.toArray(),
      db.links.toArray(),
      db.sources.toArray(),
      db.reminders.toArray(),
      db.attachments.toArray(),
      db.drafts.toArray(),
      db.aiJobs.toArray(),
    ]);
  return {
    format: 'personal-os-snapshot',
    version: 1,
    exportedAt: new Date().toISOString(),
    items,
    notes,
    tags,
    links,
    sources,
    reminders,
    attachments,
    drafts,
    aiJobs,
  };
}

export async function exportJSON(): Promise<DownloadResult> {
  const snap = await buildSnapshot();
  const r = await download(
    `personal-os-备份-${stamp()}.json`,
    JSON.stringify(snap, null, 2),
    'application/json',
  );
  if (r.status !== 'cancelled') await setMeta('backup:lastAt', new Date().toISOString());
  return r;
}

/** 上次备份时间（空串 = 从没备份过） */
export async function lastBackupAt(): Promise<string> {
  return getMeta<string>('backup:lastAt', '');
}

/** 把快照直接写进同步目标（本地文件夹 / WebDAV …），不产生下载文件 */
export async function backupToSyncTarget(): Promise<string> {
  const { loadSyncConfig, loadSyncSecret, adapterOf } = await import('../adapters/sync');
  const cfg = await loadSyncConfig();
  if (cfg.adapter === 'none') throw new Error('还没配置同步方式，去设置里先选一个');
  const adapter = adapterOf(cfg.adapter);
  const secret = await loadSyncSecret();
  const snap = await buildSnapshot();
  await adapter.write(cfg, secret, snap);
  await setMeta('backup:lastAt', snap.exportedAt);
  return `已备份到「${adapter.label}」（${snap.items.length} 条日程、${snap.notes.length} 篇笔记）`;
}

/**
 * 标签按"名字"合并。
 *
 * tags.name 是**唯一索引**（`&name`），而手机和电脑各自创建的同名标签 id 不同，
 * 直接 bulkPut 会撞 ConstraintError（"Unable to add key to index"）。
 * 所以导入时要把"同名标签"合并到本地已有的那一条上，并把引用它的 id 重映射过去。
 */
/** 纯计算部分（不碰数据库，方便单测） */
export function planTagMerge(
  existing: { id: string; name: string; deletedAt?: string | null; rev: number }[],
  incoming: { id: string; name?: string; [k: string]: unknown }[],
): { toPut: Record<string, unknown>[]; idMap: Map<string, string> } {
  const idMap = new Map<string, string>(); // 快照里的 id -> 本地 id
  const localByName = new Map<string, string>(); // name -> 本地 id（未删除）
  const deadByName = new Map<string, (typeof existing)[number]>();
  for (const t of existing) {
    if (t.deletedAt) deadByName.set(t.name, t);
    else localByName.set(t.name, t.id);
  }

  const toPut: Record<string, unknown>[] = [];
  for (const raw of incoming) {
    const name = (raw?.name ?? '').trim();
    // 空名字写不进唯一索引，直接跳过（顺带避免"键无效"的错误）
    if (!name) continue;

    const aliveId = localByName.get(name);
    if (aliveId) {
      if (aliveId === raw.id) {
        // 同一条记录（id 一致）：正常覆盖，否则标签的改动永远同步不过来
        toPut.push({ ...raw, name });
      } else {
        // 名字相同但 id 不同（两端各自创建的）：合并到已有的那条上
        idMap.set(raw.id, aliveId);
      }
      continue;
    }
    const dead = deadByName.get(name);
    if (dead) {
      // 本地同名标签被删过：复活它，并把引用指过来
      toPut.push({ ...dead, deletedAt: null, updatedAt: nowISO(), rev: dead.rev + 1 });
      localByName.set(name, dead.id);
      deadByName.delete(name);
      if (dead.id !== raw.id) idMap.set(raw.id, dead.id);
      continue;
    }
    toPut.push({ ...raw, name });
    localByName.set(name, raw.id);
  }
  return { toPut, idMap };
}

async function mergeTags(incoming: unknown[]): Promise<Map<string, string>> {
  if (!incoming?.length) return new Map();
  const existing = (await db.tags.toArray()) as {
    id: string;
    name: string;
    deletedAt?: string | null;
    rev: number;
  }[];
  const { toPut, idMap } = planTagMerge(existing, incoming as { id: string; name?: string }[]);
  if (toPut.length) await db.tags.bulkPut(toPut as never[]);
  return idMap;
}

/** 恢复：整批覆盖写入（会保留 id 与 rev，便于后续同步合并） */
export async function importSnapshot(raw: string): Promise<{ items: number; notes: number }> {
  const snap = JSON.parse(raw) as Snapshot;
  if (snap.format !== 'personal-os-snapshot') throw new Error('不是有效的备份文件');
  await db.transaction(
    'rw',
    [db.items, db.notes, db.tags, db.links, db.sources, db.reminders, db.attachments, db.drafts, db.aiJobs],
    async () => {
      // 先合并标签，拿到 id 映射；items/notes 里的标签引用要跟着改
      const tagIdMap = await mergeTags(snap.tags as unknown[]);
      const remap = (ids: unknown) =>
        Array.isArray(ids) ? (ids as string[]).map((id) => tagIdMap.get(id) ?? id) : ids;
      const withTags = <T extends { tags?: string[] }>(rows: T[]): T[] =>
        tagIdMap.size ? rows.map((r) => ({ ...r, tags: remap(r.tags) }) ) : rows;

      if (snap.items?.length) await db.items.bulkPut(withTags(snap.items as never[] as { tags?: string[] }[]) as never[]);
      if (snap.notes?.length) await db.notes.bulkPut(withTags(snap.notes as never[] as { tags?: string[] }[]) as never[]);
      if (snap.links?.length) await db.links.bulkPut(snap.links as never[]);
      if (snap.sources?.length) await db.sources.bulkPut(snap.sources as never[]);
      if (snap.reminders?.length) await db.reminders.bulkPut(snap.reminders as never[]);
      if (snap.attachments?.length) await db.attachments.bulkPut(snap.attachments as never[]);
      if (snap.drafts?.length) await db.drafts.bulkPut(snap.drafts as never[]);
      if (snap.aiJobs?.length) await db.aiJobs.bulkPut(snap.aiJobs as never[]);
    },
  );
  return { items: snap.items?.length ?? 0, notes: snap.notes?.length ?? 0 };
}

/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */

function fm(obj: Record<string, unknown>): string {
  const lines = Object.entries(obj)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`);
  return `---\n${lines.join('\n')}\n---\n\n`;
}

export async function exportMarkdown(): Promise<DownloadResult> {
  const [items, notes, tags] = await Promise.all([
    db.items.toArray(),
    db.notes.toArray(),
    db.tags.toArray(),
  ]);
  const tagName = new Map((tags as { id: string; name: string }[]).map((t) => [t.id, t.name]));
  const alive = items.filter((i) => !i.deletedAt);

  const md = alive
    .map((i) =>
      fm({
        id: i.id,
        title: i.title,
        type: ITEM_TYPES[i.type].label,
        startAt: i.startAt ?? '',
        dueAt: i.dueAt ?? '',
        status: i.status,
        priority: i.priority,
        tags: i.tags.map((t) => tagName.get(t) ?? t),
        location: i.location ?? '',
      }) + `# ${i.title}\n\n${i.remark ?? '（无备注）'}\n`,
    )
    .join('\n\n');

  const notesMd = notes
    .filter((n) => !n.deletedAt)
    .map((n) => fm({ id: n.id, title: n.title, path: n.path, tags: n.tags.map((t) => tagName.get(t) ?? t) }) + n.content)
    .join('\n\n');

  return download(
    `personal-os-导出-${stamp()}.md`,
    `# 个人工作台导出\n\n导出时间：${new Date().toLocaleString('zh-CN')}\n\n` +
      `## 日程条目（${alive.length}）\n\n${md}\n\n## 笔记（${notes.filter((n) => !n.deletedAt).length}）\n\n${notesMd}\n`,
    'text/markdown',
  );
}

/* ------------------------------------------------------------------ */
/* ICS                                                                 */
/* ------------------------------------------------------------------ */

function icsDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function escapeICS(s: string): string {
  return s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
}

export async function exportICS(): Promise<DownloadResult> {
  const items = (await db.items.toArray()).filter((i) => !i.deletedAt && (i.startAt || i.dueAt));
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//personal-os//ZH//CN',
    'CALSCALE:GREGORIAN',
    'X-WR-CALNAME:个人工作台',
  ];
  for (const i of items) {
    const start = i.startAt ?? i.dueAt!;
    const end = i.dueAt && i.startAt ? i.dueAt : new Date(new Date(start).getTime() + 3600000).toISOString();
    lines.push(
      'BEGIN:VEVENT',
      `UID:${i.id}@personal-os`,
      `DTSTAMP:${icsDate(new Date().toISOString())}`,
      `DTSTART:${icsDate(start)}`,
      `DTEND:${icsDate(end)}`,
      `SUMMARY:${escapeICS(`[${ITEM_TYPES[i.type].label}] ${i.title}`)}`,
      `DESCRIPTION:${escapeICS(i.remark ?? '')}`,
      `STATUS:${i.status === 'done' ? 'COMPLETED' : i.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return download(`personal-os-日历-${stamp()}.ics`, lines.join('\r\n'), 'text/calendar');
}

/** 危险操作：清空本地全部数据 */
/**
 * 清空所有本地数据。
 *
 * **必须保留同步基线（sync:baseline）**：它是"上次同步后双方一致的状态"。
 * 如果连同它一起清掉，下次同步时远端所有记录都会被当成"另一台新增的"拉回来，
 * 表现为"清空了又自己长回来"。保留基线后，同步才知道这些是本机删掉的，
 * 从而把它们从远端一并删除。
 */
export async function wipeAll(): Promise<void> {
  const baseline = await getMeta<Record<string, number>>('sync:baseline', {});
  await db.transaction(
    'rw',
    [db.items, db.notes, db.tags, db.links, db.sources, db.reminders, db.attachments, db.drafts, db.aiJobs, db.outbox, db.conflicts, db.syncLogs, db.meta],
    async () => {
      await Promise.all([
        db.items.clear(),
        db.notes.clear(),
        db.tags.clear(),
        db.links.clear(),
        db.sources.clear(),
        db.reminders.clear(),
        db.attachments.clear(),
        db.drafts.clear(),
        db.aiJobs.clear(),
        db.outbox.clear(),
        db.conflicts.clear(),
        db.syncLogs.clear(),
        db.meta.clear(),
      ]);
    },
  );
  // 清完把同步基线写回去，这样下次同步会把"清空"本身同步到远端
  await setMeta('sync:baseline', baseline);
}
