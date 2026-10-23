/**
 * 手机版精简：删掉体积巨大的本地模型与运行时库。
 *
 * 原因：手机跑 22MB 的向量模型又慢又耗电，而且首次打开要下载几十 MB 不现实。
 * 所以手机版不提供"本地语义搜索"（界面会提示未安装），
 * 其余功能（收集箱、日程、全文检索、问答、图谱、同步）完全一致。
 *
 * 语义搜索仍然可以在桌面版用，两边通过同步共享同一份数据。
 */
import { cp, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

async function sizeOf(p) {
  try {
    const s = await stat(p);
    return (s.size / 1024 / 1024).toFixed(1);
  } catch {
    return '0';
  }
}

for (const dir of ['models', 'libs']) {
  const p = join(dist, dir);
  const before = await sizeOf(p);
  await rm(p, { recursive: true, force: true });
  console.log(`已移除 dist/${dir}（${before} MB）`);
}

/* ------------------------------------------------------------------ */
/* 同步到 mobile-app/ —— 这才是"手机版"这个目录的正式来源              */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ 别删这段。
 * 以前 `npm run build:mobile` 只更新 dist/，`mobile-app/` 是个没人维护的手工目录，
 * 结果线上部署的一直是几个月前的旧代码 —— 同步 bug 修了，手机端却还在报错，
 * 而且从界面上完全看不出来。构建脚本必须自己维护对外发布的目录。
 */
const mobileApp = join(root, 'mobile-app');
if (existsSync(mobileApp)) {
  await rm(mobileApp, { recursive: true, force: true });
}
await cp(dist, mobileApp, { recursive: true });
console.log(`已同步到 mobile-app/（部署网页版请拷这个目录）`);

console.log('\n手机版构建完成。语义搜索在手机上不可用（体积原因），桌面版保留。');
