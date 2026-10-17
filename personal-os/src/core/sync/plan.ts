import type { Snapshot } from '../io/backup';

/**
 * 同步计划的纯计算部分（不碰数据库，方便单测）。
 * 三路合并：本地 / 远端 / 上次同步基线（id → rev）
 */

export type SyncEntityType = 'items' | 'notes' | 'tags' | 'links' | 'sources' | 'reminders';

export const SYNC_ENTITY_TYPES: SyncEntityType[] = [
  'items',
  'notes',
  'tags',
  'links',
  'sources',
  'reminders',
];

export type AnyRecord = {
  id: string;
  rev?: number;
  updatedAt?: string;
  deletedAt?: string | null;
  [k: string]: unknown;
};

export type Baseline = Record<string, number>;

export type SyncPlan = {
  push: { type: SyncEntityType; id: string }[];
  pull: { type: SyncEntityType; id: string }[];
  /** 本地已经删掉（记录不在本地库了）、需要一并从远端删掉的 */
  deletes: { type: SyncEntityType; id: string }[];
  conflicts: { type: SyncEntityType; id: string; local: AnyRecord; remote: AnyRecord }[];
};

export function mapOf(snap: Partial<Snapshot> | null, type: SyncEntityType): Map<string, AnyRecord> {
  const rows = (snap?.[type] as AnyRecord[] | undefined) ?? [];
  return new Map(rows.map((r) => [r.id, r]));
}

export function titleOf(r: AnyRecord): string {
  const t = r.title ?? r.name ?? r.path;
  return typeof t === 'string' ? t : r.id;
}

export function planSync(
  local: Snapshot,
  remote: Snapshot | null,
  baseline: Baseline,
): SyncPlan {
  const push: SyncPlan['push'] = [];
  const pull: SyncPlan['pull'] = [];
  const deletes: SyncPlan['deletes'] = [];
  const conflicts: SyncPlan['conflicts'] = [];

  // 远端还没有快照：本地全量上传
  if (!remote) {
    for (const type of SYNC_ENTITY_TYPES) {
      for (const id of mapOf(local, type).keys()) push.push({ type, id });
    }
    return { push, pull, deletes, conflicts };
  }

  for (const type of SYNC_ENTITY_TYPES) {
    const L = mapOf(local, type);
    const R = mapOf(remote, type);
    const ids = new Set([...L.keys(), ...R.keys()]);

    for (const id of ids) {
      const l = L.get(id);
      const r = R.get(id);
      const base = baseline[`${type}:${id}`];

      if (l && !r) {
        // 只在本地有：若基线里存在，说明是本地删了或远端丢了——保守起见不推
        if (base === undefined) push.push({ type, id });
        continue;
      }
      if (!l && r) {
        // 只在远端有，分两种情况：
        // - 基线里没有：另一台设备新增的，拉下来
        // - 基线里有：说明是"本机把它删掉了"，必须一并从远端删掉，
        //   否则下次同步它又会被当成远端新增拉回来（表现为"删了又出现"）
        if (base === undefined) pull.push({ type, id });
        else deletes.push({ type, id });
        continue;
      }
      if (!l || !r) continue;

      const lr = l.rev ?? 0;
      const rr = r.rev ?? 0;
      if (lr === rr) continue; // 两边一致，不用动

      const localChanged = base === undefined || lr !== base;
      const remoteChanged = base === undefined || rr !== base;

      if (localChanged && remoteChanged) conflicts.push({ type, id, local: l, remote: r });
      else if (localChanged) push.push({ type, id });
      else if (remoteChanged) pull.push({ type, id });
    }
  }

  return { push, pull, deletes, conflicts };
}

/** 把合并结果套到远端快照上，得到一份新的全量快照 */
export function mergeSnapshots(
  local: Snapshot,
  remote: Snapshot | null,
  plan: SyncPlan,
  exportedAt: string,
): Snapshot {
  const base: Snapshot = remote
    ? (structuredClone(remote) as Snapshot)
    : {
        format: 'personal-os-snapshot',
        version: 1,
        exportedAt,
        items: [],
        notes: [],
        tags: [],
        links: [],
        sources: [],
        reminders: [],
        attachments: [],
        drafts: [],
        aiJobs: [],
      };

  for (const type of SYNC_ENTITY_TYPES) {
    const L = mapOf(local, type);
    const R = mapOf(base, type);
    const out: AnyRecord[] = [];
    const seen = new Set<string>();
    // 本机已删除的：不写进合并结果，这样远端也会跟着消失
    const drop = new Set(
      plan.deletes.filter((d) => d.type === type).map((d) => d.id),
    );

    for (const p of plan.push) {
      if (p.type !== type) continue;
      const l = L.get(p.id);
      if (l) {
        out.push(l);
        seen.add(p.id);
      }
    }
    for (const p of plan.pull) {
      if (p.type !== type) continue;
      const r = mapOf(remote, type).get(p.id);
      if (r) {
        out.push(r);
        seen.add(p.id);
      }
    }
    for (const [id, r] of R) {
      if (drop.has(id)) continue;
      if (!seen.has(id)) out.push(r);
    }

    (base as unknown as Record<string, unknown>)[type] = out;
  }

  base.exportedAt = exportedAt;
  return base;
}
