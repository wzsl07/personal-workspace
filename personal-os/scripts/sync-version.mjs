/**
 * 版本号单一真相源：package.json -> tauri.conf.json -> src/core/version.ts
 *
 * 用法：node scripts/sync-version.mjs
 * 构建前必须跑一次，否则「关于」里显示的版本、安装包文件名、CHANGELOG 会对不上。
 *
 * 为什么要这个脚本：
 *   版本号散落在 3 个文件里，人手改必漏。发布物上写着 0.2.0，
 *   页面「关于」里却显示 0.1.0，用户报 bug 时就无法确认他跑的是哪一代。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function readJSON(p) {
  return JSON.parse(readFileSync(join(root, p), 'utf8'));
}

const pkg = readJSON('package.json');
const version = pkg.version;

if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`[版本] package.json 里的 version 不是语义化版本：${version}`);
  process.exit(1);
}

// 1) tauri.conf.json
const confPath = join(root, 'src-tauri', 'tauri.conf.json');
const rawConf = readFileSync(confPath, 'utf8');
const conf = JSON.parse(rawConf);
if (conf.version === version) {
  console.log(`[版本] tauri.conf.json 已是 ${version}，无需写入`);
} else {
  const before = conf.version;
  // 只替换顶层 "version"，避免误伤其它字段
  const next = rawConf.replace(
    /("version"\s*:\s*)"[^"]*"/,
    (_, head) => `${head}"${version}"`,
  );
  writeFileSync(confPath, next, 'utf8');
  console.log(`[版本] tauri.conf.json: ${before} -> ${version}`);
}

// 1.5) src-tauri/Cargo.toml（crate 版本，只影响 cargo，但保持一致更省心）
const cargoPath = join(root, 'src-tauri', 'Cargo.toml');
if (existsSync(cargoPath)) {
  const raw = readFileSync(cargoPath, 'utf8');
  const before = raw.match(/^version\s*=\s*"([^"]*)"/m)?.[1];
  if (before === version) {
    console.log(`[版本] Cargo.toml 已是 ${version}，无需写入`);
  } else {
    // 只替换 [package] 段里的第一个 version
    const next = raw.replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`);
    writeFileSync(cargoPath, next, 'utf8');
    console.log(`[版本] Cargo.toml: ${before ?? '?'} -> ${version}`);
  }
}

// 2) src/core/version.ts（页面「关于」与诊断包读取）
const buildId = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d+Z$/, '');
const versionTs = `/**
 * 由 scripts/sync-version.mjs 自动生成，不要手改。
 * 真相源是 package.json 的 version。
 */

/** 语义化版本号，例如 0.2.0 */
export const APP_VERSION = '${version}';

/** 构建号（UTC 时间戳，形如 20261013T153200），用于区分同一版本的多次构建 */
export const BUILD_ID = '${buildId}';

/** 展示用：0.2.0 (build 20261013T153200) */
export const APP_VERSION_FULL = \`\${APP_VERSION} (build \${BUILD_ID})\`;
`;
writeFileSync(join(root, 'src', 'core', 'version.ts'), versionTs, 'utf8');
console.log(`[版本] src/core/version.ts -> ${version} / build ${buildId}`);

// 3) 校验 CHANGELOG 里有这个版本的段落
let changelogOk = false;
try {
  const changelog = readFileSync(join(root, '..', 'docs', 'CHANGELOG.md'), 'utf8');
  changelogOk = changelog.includes(`## ${version}`) || changelog.includes(`## [${version}]`);
} catch {
  changelogOk = false;
}
if (!changelogOk) {
  console.warn(`[版本] ⚠ docs/CHANGELOG.md 里没有 ${version} 的段落，发布前请补上。`);
} else {
  console.log(`[版本] CHANGELOG 已包含 ${version} ✓`);
}

console.log(`\n[版本] 同步完成：${version}`);
