import { newId, nowISO } from '../domain/id';
import { db } from '../repo/db';
import { buildSnapshot, importSnapshot, type Snapshot } from '../io/backup';
import { adapterOf, loadSyncConfig, loadSyncSecret } from '../adapters/sync';
import type { Conflict, SyncLog } from '../domain/types';
import { getMeta, setMeta } from '../repo/db';
import {
  SYNC_ENTITY_TYPES,
  mergeSnapshots,
  planSync,
  titleOf,
  type AnyRecord,
  type Baseline,
  type SyncEntityType,
} from './plan';

/** 按表名取 Dexie 表（绕开索引类型检查） */
function table(name: string): { put: (v: unknown) => Promise<unknown> } {
  return (db as unknown as Record<string, { put: (v: unknown) => Promise<unknown> }>)[name];
}

/**
 * 同步引擎：全量快照 + 三路合并。
 *
 * 为什么用"全量快照"而不是逐条增量：个人数据量在几千条以内，
 * 快照比对简单、可靠、适配器好写；增量同步留到数据量真成问题时再做。
 *
 * 冲突判定（标准三路合并）：
 *   baseline = 上次同步后双方一致的状态（id → rev）
 *   - 只有本地变了 → 推
 *   - 只有远端变了 → 拉
 *   - 都变了且 rev 不同 → 冲突（交给人决定，绝不自动覆盖）
 */

const BASELINE_KEY = 'sync:baseline';

async function loadBaseline(): Promise<Baseline> {
  return getMeta<Baseline>(BASELINE_KEY, {});
}

async function saveBaseline(b: Baseline): Promise<void> {
  await setMeta(BASELINE_KEY, b);
}

export {
  SYNC_ENTITY_TYPES,
  planSync,
  mergeSnapshots,
  titleOf,
  type AnyRecord,
  type Baseline,
  type SyncEntityType,
  type SyncPlan,
} from './plan';

export interface SyncOutcome {
  status: 'success' | 'conflict' | 'failed';
  pushed: number;
  pulled: number;
  deleted: number;
  conflicts: number;
  message: string;
}

/** 执行一次同步。遇到冲突不自动解决，落 conflicts 表等人处理。 */
export async function runSync(): Promise<SyncOutcome> {
  const cfg = await loadSyncConfig();
  if (cfg.adapter === 'none') {
    return { status: 'failed', pushed: 0, pulled: 0, deleted: 0, conflicts: 0, message: '未启用同步' };
  }
  const adapter = adapterOf(cfg.adapter);
  const secret = await loadSyncSecret();

  const logId = newId();
  const startedAt = nowISO();
  const log: SyncLog = {
    id: logId,
    createdAt: startedAt,
    updatedAt: startedAt,
    deletedAt: null,
    rev: 1,
    adapter: cfg.adapter,
    startedAt,
    pushed: 0,
    pulled: 0,
    status: 'success',
  };
  await db.syncLogs.put(log);

  const fail = async (message: string): Promise<SyncOutcome> => {
    await db.syncLogs.put({ ...log, status: 'failed', finishedAt: nowISO(), message, updatedAt: nowISO(), rev: log.rev + 1 });
    await setMeta('sync:lastStatus', 'failed');
    return { status: 'failed', pushed: 0, pulled: 0, deleted: 0, conflicts: 0, message };
  };

  let remote: Snapshot | null;
  try {
    remote = await adapter.read(cfg, secret);
  } catch (e) {
    return fail(`读取远端失败：${e instanceof Error ? e.message : e}`);
  }

  const local = await buildSnapshot();
  const baseline = await loadBaseline();
  const plan = planSync(local, remote, baseline);

  // 冲突：写库，等人解决
  if (plan.conflicts.length > 0) {
    for (const c of plan.conflicts) {
      const conflict: Conflict = {
        id: newId(),
        createdAt: nowISO(),
        updatedAt: nowISO(),
        deletedAt: null,
        rev: 1,
        entityType: c.type.replace(/s$/, '') as Conflict['entityType'],
        entityId: c.id,
        localRev: (c.local.rev ?? 0) as number,
        remoteRev: (c.remote.rev ?? 0) as number,
        localSnapshot: { ...c.local, _title: titleOf(c.local) },
        remoteSnapshot: { ...c.remote, _title: titleOf(c.remote) },
      };
      await db.conflicts.put(conflict);
    }
    await db.syncLogs.put({
      ...log,
      status: 'conflict',
      finishedAt: nowISO(),
      message: `${plan.conflicts.length} 处冲突待处理`,
      updatedAt: nowISO(),
      rev: log.rev + 1,
    });
    await setMeta('sync:lastStatus', 'conflict');
    return {
      status: 'conflict',
      pushed: 0,
      pulled: 0,
      deleted: 0,
      conflicts: plan.conflicts.length,
      message: `发现 ${plan.conflicts.length} 处冲突，需要你决定保留哪一份`,
    };
  }

  // 合并：远端为底，用本地覆盖要推的、用远端覆盖要拉的
  const merged = mergeSnapshots(local, remote, plan, nowISO());

  // 应用合并结果到本地，并把同一份写回远端
  try {
    await importSnapshot(JSON.stringify(merged));
    await adapter.write(cfg, secret, merged);
  } catch (e) {
    return fail(`写入失败：${e instanceof Error ? e.message : e}`);
  }

  // 更新基线 = 合并后的 rev
  const nextBaseline: Baseline = { ...baseline };
  for (const type of SYNC_ENTITY_TYPES) {
    for (const r of (merged[type] as AnyRecord[] | undefined) ?? []) {
      nextBaseline[`${type}:${r.id}`] = r.rev ?? 0;
    }
  }
  // 已删除的：把基线里的记录也清掉，保持基线干净
  for (const d of plan.deletes) delete nextBaseline[`${d.type}:${d.id}`];
  await saveBaseline(nextBaseline);

  // outbox 流水（审计用：本次推了什么、拉了什么）
  for (const p of plan.push) {
    await db.outbox.put({
      id: newId(),
      createdAt: nowISO(),
      updatedAt: nowISO(),
      deletedAt: null,
      rev: 1,
      seq: Date.now(),
      entityType: p.type,
      entityId: p.id,
      op: 'update',
      payload: { dir: 'push' },
      status: 'synced',
    });
  }
  for (const p of plan.pull) {
    await db.outbox.put({
      id: newId(),
      createdAt: nowISO(),
      updatedAt: nowISO(),
      deletedAt: null,
      rev: 1,
      seq: Date.now(),
      entityType: p.type,
      entityId: p.id,
      op: 'update',
      payload: { dir: 'pull' },
      status: 'synced',
    });
  }

  await db.syncLogs.put({
    ...log,
    status: 'success',
    pushed: plan.push.length,
    pulled: plan.pull.length,
    finishedAt: nowISO(),
    updatedAt: nowISO(),
    rev: log.rev + 1,
  });
  await setMeta('sync:lastStatus', 'success');
  await setMeta('sync:lastAt', nowISO());

  return {
    status: 'success',
    pushed: plan.push.length,
    pulled: plan.pull.length,
    deleted: plan.deletes.length,
    conflicts: 0,
    message: `已同步：上传 ${plan.push.length} 项，下载 ${plan.pull.length} 项`
      + (plan.deletes.length ? `，删除 ${plan.deletes.length} 项` : ''),
  };
}

/* ------------------------------------------------------------------ */
/* 冲突解决                                                            */
/* ------------------------------------------------------------------ */

export type Resolution = 'local' | 'remote' | 'both' | 'manual';

/** 解决一条冲突；'both' 会把本地版本另存为副本（标题加后缀），远端版本作为本体 */
export async function resolveConflict(conflictId: string, how: Resolution): Promise<string> {
  const c = await db.conflicts.get(conflictId);
  if (!c) throw new Error('冲突记录不存在');
  const type = `${c.entityType}s` as SyncEntityType;

  const local = c.localSnapshot as AnyRecord;
  const remote = c.remoteSnapshot as AnyRecord;

  if (how === 'local') {
    await table(type).put({ ...local, rev: (local.rev ?? 0) + 1, updatedAt: nowISO() });
  } else if (how === 'remote') {
    await table(type).put({ ...remote, rev: (remote.rev ?? 0) + 1, updatedAt: nowISO() });
  } else if (how === 'both') {
    const copy: AnyRecord = {
      ...local,
      id: newId(),
      title: `${titleOf(local)}（冲突副本）`,
      rev: 1,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      deletedAt: null,
    };
    await table(type).put(copy);
    await table(type).put({ ...remote, rev: (remote.rev ?? 0) + 1, updatedAt: nowISO() });
  } else {
    // manual：保留本地，稍后自己在编辑器里改
    await table(type).put({ ...local, rev: (local.rev ?? 0) + 1, updatedAt: nowISO() });
  }

  await db.conflicts.put({
    ...c,
    resolution: how,
    resolvedAt: nowISO(),
    updatedAt: nowISO(),
    rev: c.rev + 1,
  });

  // 基线与本地对齐，避免下次再判成冲突
  const baseline = await loadBaseline();
  const chosen = how === 'remote' ? remote : local;
  baseline[`${type}:${c.entityId}`] = (chosen.rev ?? 0) + 1;
  await saveBaseline(baseline);

  return how === 'both' ? '已保留两份（本地另存为副本）' : how === 'remote' ? '已采用远端版本' : '已保留本地版本';
}

export async function unresolvedConflicts(): Promise<Conflict[]> {
  const rows = await db.conflicts.toArray();
  return rows.filter((c) => !c.resolvedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function lastSyncInfo(): Promise<{ status: string; at?: string }> {
  const status = await getMeta<string>('sync:lastStatus', 'never');
  const at = await getMeta<string>('sync:lastAt', '');
  return { status, at: at || undefined };
}
