/** 验证三路合并的判定逻辑（不进构建产物） */
import { planSync, mergeSnapshots, type Baseline } from '../src/core/sync/plan.ts';
import type { Snapshot } from '../src/core/io/backup.ts';

function snap(items: { id: string; rev: number; title?: string }[]): Snapshot {
  const s = {
    format: 'personal-os-snapshot' as const,
    version: 1 as const,
    exportedAt: new Date().toISOString(),
    items: items.map((i) => ({
      id: i.id,
      rev: i.rev,
      title: i.title ?? i.id,
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    })),
    notes: [],
    tags: [],
    links: [],
    sources: [],
    reminders: [],
    attachments: [],
    drafts: [],
    aiJobs: [],
  };
  return s as unknown as Snapshot;
}

const results: [string, boolean, string][] = [];
function check(name: string, ok: boolean, detail: string) {
  results.push([name, ok, detail]);
}

// 1) 首次同步（远端为空）→ 本地全量上传
{
  const local = snap([{ id: 'a', rev: 1 }]);
  const p = planSync(local, null, {});
  check('首次同步：本地全量上传', p.push.length === 1 && p.pull.length === 0 && p.conflicts.length === 0,
    `push=${p.push.length} pull=${p.pull.length} conflict=${p.conflicts.length}`);
}

// 2) 本地新增 → push
{
  const local = snap([{ id: 'a', rev: 1 }, { id: 'b', rev: 1 }]);
  const remote = snap([{ id: 'a', rev: 1 }]);
  const base: Baseline = { 'items:a': 1 };
  const p = planSync(local, remote, base);
  check('本地新增：只上传', p.push.length === 1 && p.push[0].id === 'b', JSON.stringify(p.push));
}

// 3) 远端新增 → pull
{
  const local = snap([{ id: 'a', rev: 1 }]);
  const remote = snap([{ id: 'a', rev: 1 }, { id: 'c', rev: 1 }]);
  const base: Baseline = { 'items:a': 1 };
  const p = planSync(local, remote, base);
  check('远端新增：只下载', p.pull.length === 1 && p.pull[0].id === 'c', JSON.stringify(p.pull));
}

// 4) 只有本地改过 → push
{
  const local = snap([{ id: 'a', rev: 2, title: '本地改的' }]);
  const remote = snap([{ id: 'a', rev: 1 }]);
  const base: Baseline = { 'items:a': 1 };
  const p = planSync(local, remote, base);
  check('只有本地改：上传', p.push.length === 1 && p.pull.length === 0, JSON.stringify(p.push));
}

// 5) 只有远端改过 → pull
{
  const local = snap([{ id: 'a', rev: 1 }]);
  const remote = snap([{ id: 'a', rev: 3, title: '远端改的' }]);
  const base: Baseline = { 'items:a': 1 };
  const p = planSync(local, remote, base);
  check('只有远端改：下载', p.pull.length === 1 && p.push.length === 0, JSON.stringify(p.pull));
}

// 6) 双方都改 → 冲突（关键：绝不自动覆盖）
{
  const local = snap([{ id: 'a', rev: 2, title: '本地改的' }]);
  const remote = snap([{ id: 'a', rev: 5, title: '远端改的' }]);
  const base: Baseline = { 'items:a': 1 };
  const p = planSync(local, remote, base);
  check(
    '双方都改：判定为冲突，不自动覆盖',
    p.conflicts.length === 1 && p.push.length === 0 && p.pull.length === 0,
    `conflict=${p.conflicts.length} push=${p.push.length} pull=${p.pull.length}`,
  );
}

// 7) 两边都没变 → 什么都不做
{
  const local = snap([{ id: 'a', rev: 3 }]);
  const remote = snap([{ id: 'a', rev: 3 }]);
  const base: Baseline = { 'items:a': 3 };
  const p = planSync(local, remote, base);
  check('两边一致：无操作', p.push.length === 0 && p.pull.length === 0 && p.conflicts.length === 0, 'no-op');
}

// 8) 合并结果正确：push 的用本地，pull 的用远端，没动的保持
{
  const local = snap([{ id: 'a', rev: 2, title: '本地改的' }, { id: 'b', rev: 1, title: '本地新增' }]);
  const remote = snap([{ id: 'a', rev: 1 }, { id: 'c', rev: 1, title: '远端新增' }]);
  const base: Baseline = { 'items:a': 1 };
  const p = planSync(local, remote, base);
  const merged = mergeSnapshots(local, remote, p, new Date().toISOString());
  const byId = new Map((merged.items as unknown as { id: string; title: string }[]).map((i) => [i.id, i.title]));
  check(
    '合并结果：本地改的+新增、远端新增都在',
    byId.get('a') === '本地改的' && byId.get('b') === '本地新增' && byId.get('c') === '远端新增',
    JSON.stringify([...byId]),
  );
}

// 9) 本机删掉了、远端还在、基线里有 → 必须判为"删除"，绝不能再拉回来
{
  const local = snap([]); // 本地已删（或清空）
  const remote = snap([{ id: 'a', rev: 3 }]);
  const base: Baseline = { 'items:a': 3 };
  const p = planSync(local, remote, base);
  check(
    '本机删除：远端一并删除，不拉回来',
    p.deletes.length === 1 && p.pull.length === 0 && p.push.length === 0,
    JSON.stringify({ del: p.deletes, pull: p.pull, push: p.push }),
  );
}

// 10) 基线里没有 → 那是另一台新增的，正常拉
{
  const local = snap([]);
  const remote = snap([{ id: 'b', rev: 1 }]);
  const p = planSync(local, remote, {});
  check(
    '远端新增（无基线）：正常拉取',
    p.pull.length === 1 && p.deletes.length === 0,
    JSON.stringify({ pull: p.pull, del: p.deletes }),
  );
}

// 11) 合并结果里不该再有被删掉的那条
{
  // 本地只删了 a，keep 还在（rev 与远端一致）
  const local = snap([{ id: 'keep', rev: 2 }]);
  const remote = snap([{ id: 'a', rev: 3 }, { id: 'keep', rev: 2 }]);
  const base: Baseline = { 'items:a': 3, 'items:keep': 2 };
  const p = planSync(local, remote, base);
  const merged = mergeSnapshots(local, remote, p, new Date().toISOString());
  const ids = (merged.items as unknown as { id: string }[]).map((i) => i.id);
  check(
    '删除后合并：被删的不在，其余保留',
    !ids.includes('a') && ids.includes('keep'),
    ids.join(','),
  );
}

let pass = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? '✓' : '✗'} ${name}  ${ok ? '' : detail}`);
  if (ok) pass += 1;
}
console.log(`\n${pass}/${results.length} 通过`);
if (pass !== results.length) process.exit(1);
