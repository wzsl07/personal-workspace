/** 验证重复清理的判定（这是删除操作，判错了会误删，必须测） */
import { groupDupItems } from '../src/core/repo/cleanup.ts';
import type { ScheduleItem } from '../src/core/domain/types.ts';

const results: [string, boolean, string][] = [];
function check(name: string, ok: boolean, detail = '') {
  results.push([name, ok, detail]);
}

function item(p: Partial<ScheduleItem> & { id: string; createdAt: string }): ScheduleItem {
  return {
    id: p.id,
    createdAt: p.createdAt,
    updatedAt: p.createdAt,
    deletedAt: null,
    rev: 1,
    type: 'assignment',
    title: '高等数学第三章习题',
    status: 'notStarted',
    priority: 2,
    noteIds: [],
    tags: [],
    dueAt: '2026-10-15T23:59:00.000Z',
    remark: '第三章课后题',
    location: '',
    ...p,
  } as ScheduleItem;
}

// 三台设备各自录入了同一件事 → 保留最早的，删 2 条
{
  const rows = [
    item({ id: 'a', createdAt: '2026-10-01T10:00:00.000Z' }),
    item({ id: 'b', createdAt: '2026-10-05T10:00:00.000Z' }),
    item({ id: 'c', createdAt: '2026-10-09T10:00:00.000Z' }),
  ];
  const g = groupDupItems(rows);
  check(
    '内容完全相同的三条：保留最早一条，删掉另外两条',
    g.length === 1 && g[0].keep.id === 'a' && g[0].drop.map((d) => d.id).join(',') === 'b,c',
    JSON.stringify(g.map((x) => ({ keep: x.keep.id, drop: x.drop.map((d) => d.id) }))),
  );
}

// 标题相同但时间不同 → 不是重复（比如每周都要交的作业）
{
  const rows = [
    item({ id: 'a', createdAt: '2026-10-01T10:00:00.000Z' }),
    item({ id: 'b', createdAt: '2026-10-02T10:00:00.000Z', dueAt: '2026-10-22T23:59:00.000Z' }),
  ];
  const g = groupDupItems(rows);
  check('标题相同但时间不同：不算重复', g.length === 0, JSON.stringify(g));
}

// 标题和时间相同但正文不同 → 不算重复
{
  const rows = [
    item({ id: 'a', createdAt: '2026-10-01T10:00:00.000Z' }),
    item({ id: 'b', createdAt: '2026-10-02T10:00:00.000Z', remark: '第三章 + 第四章' }),
  ];
  const g = groupDupItems(rows);
  check('正文不同：不算重复', g.length === 0, JSON.stringify(g));
}

// 已软删的条目不参与去重（避免把删掉的再算一遍）
{
  const rows = [
    item({ id: 'a', createdAt: '2026-10-01T10:00:00.000Z' }),
    item({ id: 'b', createdAt: '2026-10-02T10:00:00.000Z', deletedAt: '2026-10-03T10:00:00.000Z' }),
  ];
  const g = groupDupItems(rows);
  check('已删除的条目不参与', g.length === 0, JSON.stringify(g));
}

// 只有一条 → 绝不误判
{
  const g = groupDupItems([item({ id: 'solo', createdAt: '2026-10-01T10:00:00.000Z' })]);
  check('单条内容：不误判为重复', g.length === 0, JSON.stringify(g));
}

// 两组互不相同的重复 → 分别处理
{
  const rows = [
    item({ id: 'a1', createdAt: '2026-10-01T10:00:00.000Z' }),
    item({ id: 'a2', createdAt: '2026-10-02T10:00:00.000Z' }),
    item({ id: 'b1', createdAt: '2026-10-01T10:00:00.000Z', title: '大学物理实验报告' }),
    item({ id: 'b2', createdAt: '2026-10-03T10:00:00.000Z', title: '大学物理实验报告' }),
  ];
  const g = groupDupItems(rows);
  const total = g.reduce((s, x) => s + x.drop.length, 0);
  check('两组重复：各自保留一条，共删 2 条', g.length === 2 && total === 2, JSON.stringify(g.map((x) => x.keep.id)));
}

let pass = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  ${detail}`}`);
  if (ok) pass += 1;
}
console.log(`\n${pass}/${results.length} 通过`);
if (pass !== results.length) process.exit(1);
