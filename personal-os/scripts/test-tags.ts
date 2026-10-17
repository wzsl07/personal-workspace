/** 验证导入/同步时标签的同名合并（&name 是唯一索引，撞了会 ConstraintError） */
import { planTagMerge } from '../src/core/io/backup.ts';

const results: [string, boolean, string][] = [];
function check(name: string, ok: boolean, detail = '') {
  results.push([name, ok, detail]);
}

// 场景：手机和电脑各自建了"课程"标签，id 不同
{
  const existing = [{ id: 'local-1', name: '课程', deletedAt: null, rev: 1 }];
  const incoming = [
    { id: 'remote-1', name: '课程', deletedAt: null, rev: 1 },
    { id: 'remote-2', name: '作业', deletedAt: null, rev: 1 },
  ];
  const { toPut, idMap } = planTagMerge(existing, incoming);
  check(
    '同名标签合并：不重复写入，且建立 id 映射',
    toPut.length === 1 &&
      (toPut[0] as { id: string }).id === 'remote-2' &&
      idMap.get('remote-1') === 'local-1',
    JSON.stringify({ toPut, map: [...idMap] }),
  );
}

// 场景：本地同名标签被软删过 → 复活它
{
  const existing = [{ id: 'dead-1', name: '班费', deletedAt: '2026-10-01', rev: 3 }];
  const incoming = [{ id: 'remote-9', name: '班费', deletedAt: null, rev: 1 }];
  const { toPut, idMap } = planTagMerge(existing, incoming);
  const first = toPut[0] as { id: string; deletedAt: string | null };
  check(
    '已删除的同名标签：复活并映射',
    toPut.length === 1 && first.id === 'dead-1' && first.deletedAt === null && idMap.get('remote-9') === 'dead-1',
    JSON.stringify({ toPut, map: [...idMap] }),
  );
}

// 场景：全新标签直接写入
{
  const { toPut, idMap } = planTagMerge([], [{ id: 'n1', name: '考试' }]);
  check('全新标签：正常写入', toPut.length === 1 && idMap.size === 0, JSON.stringify(toPut));
}

// 场景：空名字跳过（否则唯一索引会报键无效）
{
  const { toPut } = planTagMerge([], [
    { id: 'x1', name: '   ' },
    { id: 'x2', name: '' },
    { id: 'x3', name: '有效' },
  ]);
  check('空名字被跳过', toPut.length === 1, JSON.stringify(toPut));
}

// 场景：一份快照内部自带重名（不同 id 同名）→ 只写一条
{
  const { toPut } = planTagMerge([], [
    { id: 'a', name: '读书' },
    { id: 'b', name: '读书' },
  ]);
  check('快照内部重名：只保留一条', toPut.length === 1, JSON.stringify(toPut));
}

// 场景：id 完全一致（正常同步）→ 直接覆盖，不产生映射
{
  const existing = [{ id: 'same', name: '课程', deletedAt: null, rev: 2 }];
  const { toPut, idMap } = planTagMerge(existing, [{ id: 'same', name: '课程', rev: 3 }]);
  check(
    'id 相同的标签：覆盖更新，不误判为冲突',
    toPut.length === 1 && (toPut[0] as { id: string }).id === 'same' && idMap.size === 0,
    JSON.stringify({ toPut, map: [...idMap] }),
  );
}

let pass = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  ${detail}`}`);
  if (ok) pass += 1;
}
console.log(`\n${pass}/${results.length} 通过`);
if (pass !== results.length) process.exit(1);
