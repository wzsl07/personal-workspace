/**
 * 生成发布物清单：SHA256 校验和 + 更新清单 + 发布说明。
 *
 * 产物放在 dist-release/：
 *   个人工作台-<版本>-win-x64-安装包.exe   （从 NSIS 目录拷来）
 *   个人工作台-<版本>-win-x64-便携版.zip   （make-portable 生成，可选）
 *   SHA256.txt
 *   latest.json        （给 v2 的自动更新用，现在先生成好占位）
 *   RELEASE_NOTES.md   （从 CHANGELOG 里抽出本版本那一段）
 *
 * 用法：node scripts/make-release.mjs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;

const nsisDir = join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const outDir = join(root, 'dist-release');
mkdirSync(outDir, { recursive: true });

/* ---------- 1. 收集安装包 ---------- */
const artifacts = [];

if (existsSync(nsisDir)) {
  for (const f of readdirSync(nsisDir)) {
    if (!/\.exe$/i.test(f)) continue;
    // 目录里可能有历次构建留下的旧版本，只认当前版本号的那一个
    if (!f.includes(version)) {
      console.log(`[发布] 跳过旧版本产物：${f}`);
      continue;
    }
    const src = join(nsisDir, f);
    // NSIS 通常产出「个人工作台_0.2.0_x64-setup.exe」之类，统一重命名
    const dstName = `个人工作台-${version}-win-x64-安装包.exe`;
    const dst = join(outDir, dstName);
    copyFileSync(src, dst);
    artifacts.push({ path: dst, name: dstName, kind: '安装包' });
    console.log(`[发布] 安装包：${basename(src)} → ${dstName}`);
  }
} else {
  console.warn('[发布] ⚠ 没找到 NSIS 产物，跳过安装包。先跑 npm run tauri:build。');
}

const portable = join(root, 'dist-portable', `个人工作台-${version}-win-x64-便携版.zip`);
if (existsSync(portable)) {
  const dst = join(outDir, basename(portable));
  copyFileSync(portable, dst);
  artifacts.push({ path: dst, name: basename(portable), kind: '便携版' });
  console.log(`[发布] 便携版：${basename(portable)}`);
} else {
  console.log('[发布] 便携版：未生成（可选，npm run dist:portable）');
}

if (artifacts.length === 0) {
  console.error('[发布] ❌ 没有任何产物，无法生成发布清单。');
  process.exit(1);
}

/* ---------- 2. SHA256 ---------- */
const sums = artifacts.map((a) => {
  const h = createHash('sha256').update(readFileSync(a.path)).digest('hex');
  const size = (statSync(a.path).size / 1024 / 1024).toFixed(1);
  return { ...a, sha256: h, mb: size };
});

const shaLines = [
  `# 个人工作台 ${version} · SHA256 校验和`,
  `# 校验方法（PowerShell）：`,
  `#   Get-FileHash ".\\文件名.exe" -Algorithm SHA256`,
  `#   看输出的 Hash 和下面是否一致`,
  '',
  ...sums.map((s) => `${s.sha256}  ${s.name}`),
  '',
];
writeFileSync(join(outDir, 'SHA256.txt'), shaLines.join('\n'), 'utf8');
console.log(`[发布] SHA256.txt ✓`);

for (const s of sums) {
  console.log(`         ${s.sha256.slice(0, 16)}…  ${s.name}  ${s.mb} MB`);
}

/* ---------- 3. latest.json（自动更新用） ---------- */
// v2 接 tauri-plugin-updater 后，这个文件 + 签名就是更新源。
// 现在先按 Tauri 的格式生成好，signature 留空表示"尚未签名"。
/**
 * 发布仓库：从 package.json 的 repository 读（可用 DIST_REPO 覆盖）。
 * 不写死在脚本里 —— 换个 fork、换个作者名都不用改代码。
 */
const repoUrl = process.env.DIST_REPO || pkg.repository?.url || '';
const slug = repoUrl
  .replace(/^git\+/, '')
  .replace(/\.git$/, '')
  .replace(/^https?:\/\/[^/]+\//, '')
  .replace(/\/$/, '');

const setup = sums.find((s) => s.kind === '安装包');
const latest = {
  version: `v${version}`,
  notes: `见 CHANGELOG（docs/CHANGELOG.md）的 ${version} 段落`,
  pub_date: new Date().toISOString(),
  platforms: setup
    ? {
        'windows-x86_64': {
          signature: '',
          url: slug
            ? `https://github.com/${slug}/releases/download/v${version}/${encodeURIComponent(setup.name)}`
            : '',
        },
      }
    : {},
};
writeFileSync(join(outDir, 'latest.json'), JSON.stringify(latest, null, 2), 'utf8');
console.log('[发布] latest.json ✓（signature 为空 = 未签名，自动更新启用前必须补上）');

/* ---------- 4. 发布说明 ---------- */
let notes = `## 个人工作台 ${version}\n\n（CHANGELOG 里没找到 ${version} 的段落，去补一下）\n`;
try {
  const changelog = readFileSync(join(root, '..', 'docs', 'CHANGELOG.md'), 'utf8');
  const re = new RegExp(`^##\\s+\\[?${version.replace(/\./g, '\\.')}\\]?[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|\\Z)`, 'm');
  const m = changelog.match(re);
  if (m) notes = `## 个人工作台 ${version}\n\n${m[1].trim()}\n`;
} catch {
  /* 忽略 */
}

const full = [
  notes,
  '',
  '---',
  '',
  '## 下载',
  '',
  ...sums.map((s) => `- **${s.kind}**：\`${s.name}\`（${s.mb} MB）`),
  '',
  '## 校验',
  '',
  '```',
  ...sums.map((s) => `${s.sha256}  ${s.name}`),
  '```',
  '',
  '## 系统要求',
  '',
  '- Windows 10 1809 或 Windows 11（64 位）',
  '- 约 300 MB 可用空间',
  '- 首次运行需要联网下载 WebView2 运行库（Windows 11 一般已自带）',
  '',
  '## 安装时报警怎么办',
  '',
  '未签名的安装包会触发 Windows 的蓝色/黄色警告，这是正常的（作者没买代码签名证书）。',
  '',
  '- **SmartScreen（蓝框）**：点「更多信息」→「仍要运行」',
  '- **智能应用控制（提示已阻止）**：改用「便携版 ZIP」，解压后双击 exe 即可',
  '- **杀软误报**：选择允许 / 加入白名单',
  '',
  '详见《安装指南》。',
  '',
];
writeFileSync(join(outDir, 'RELEASE_NOTES.md'), full.join('\n'), 'utf8');
console.log('[发布] RELEASE_NOTES.md ✓');

console.log(`\n[发布] ✅ 全部产物在 ${outDir}`);
console.log('[发布] 接下来：把这里面除 latest.json 之外的文件上传到 GitHub Release，打 tag v' + version);
