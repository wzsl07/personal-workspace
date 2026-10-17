/**
 * 发布前体检：扫描源码与构建产物里是否残留「不该出现在别人电脑上」的东西。
 *
 * 用法：node scripts/check-dist.mjs
 * 命中任意一条即 exit 1（CI / 手工发布都会被挡住）。
 *
 * 检查项：
 *   1. API Key / Token 形态的字符串（sk-、ghp_、github_pat_、AIza、xox*-）
 *   2. 作者本机的个人路径（C:\Users\<作者>、/Users/<作者>）
 *   3. 作者的用户名出现在不该出现的地方（identifier 里的例外已放行）
 *   4. 开发服务器地址（127.0.0.1:5173）混进了生产产物
 *   5. 源码里把密钥写进 console.log 的模式
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 作者标识：全部来自环境变量，不留默认值。
 *
 * 为什么不给默认值：这个文件要进公开仓库，写死本机用户名等于把个人信息发出去。
 * 用法：
 *   DIST_AUTHOR_USER=你的用户名 DIST_AUTHOR_GITHUB=你的GitHub名 node scripts/check-dist.mjs
 * 两个都不设时，扫描只跑"与作者无关"的规则（密钥、开发地址、日志泄密）。
 */
const AUTHOR_USER = (process.env.DIST_AUTHOR_USER || '').toLowerCase();
const AUTHOR_GITHUB = process.env.DIST_AUTHOR_GITHUB || '';

const SCAN_DIRS = ['src', 'dist', 'public', 'scripts', 'src-tauri/src', 'src-tauri'];

/**
 * 直接跳过的文件（相对路径，endsWith 匹配）。
 * 跳过的都是「必然包含这些字符串但不构成风险」的文件：
 *   - 本脚本自己（规则定义里就带着样例字符串）
 *   - 第三方打包产物（transformers.min.js：webpack 产物里有 node_modules 路径）
 *   - 桌面壳配置（devUrl 只在开发模式生效，不会进产物逻辑）
 */
const SKIP_FILES = [
  'scripts/check-dist.mjs',
  'libs/transformers.min.js',
  'src-tauri/tauri.conf.json',
  'vite.config.ts',
];
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  'mobile-app',
  '.backup-identifier-migration',
]);
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2',
  '.ttf', '.otf', '.eot', '.wasm', '.onnx', '.bin', '.pdf', '.zip',
  '.exe', '.msi', '.dll', '.pdb', '.lock',
]);

const RULES = [
  {
    id: 'openai-key',
    desc: 'OpenAI / DeepSeek 风格的 API Key',
    re: /sk-[A-Za-z0-9_\-]{20,}/g,
  },
  {
    id: 'github-token',
    desc: 'GitHub Token',
    re: /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g,
  },
  {
    id: 'google-key',
    desc: 'Google API Key',
    re: /AIza[0-9A-Za-z_\-]{30,}/g,
  },
  {
    id: 'slack-token',
    desc: 'Slack Token',
    re: /xox[baprs]-[A-Za-z0-9\-]{10,}/g,
  },
  {
    id: 'author-path',
    desc: `作者本机个人路径（含 ${AUTHOR_USER}）`,
    re: new RegExp(
      `(?:C:\\\\\\\\Users\\\\\\\\${AUTHOR_USER}|C:/Users/${AUTHOR_USER}|/Users/${AUTHOR_USER}|/home/${AUTHOR_USER})`,
      'gi',
    ),
  },
  {
    id: 'dev-server',
    // 只匹配带协议的完整地址；裸的 "127.0.0.1:5173" 常出现在给用户的说明文案里，不算问题
    desc: '开发服务器地址（带协议）混进了产物',
    re: /https?:\/\/(?:127\.0\.0\.1|localhost):5173/g,
  },
  {
    id: 'log-secret',
    // 不匹配裸 "token"：transformers.js 里有大量 "tokenizer"，会误报
    desc: '把密钥/Token 打进日志',
    re: /console\.(?:log|info|debug|warn)\([^)]{0,200}?(?:apiKey|api_key|accessToken|secretKey|password|Authorization)\b/gi,
  },
];

/** 没提供作者标识时，跳过依赖它的规则（空正则会匹配一切，反而全是误报） */
const ACTIVE_RULES = RULES.filter((r) => !(r.id === 'author-path' && !AUTHOR_USER));

/** identifier 里出现作者 GitHub 名是刻意的，放行 */
function isAllowedContext(line, id) {
  if (id === 'author-github') return line.includes('com.github.');
  return false;
}

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(p, out);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

const findings = [];
let scanned = 0;

for (const d of SCAN_DIRS) {
  const abs = join(root, d);
  if (!existsSync(abs)) continue;
  const files = statSync(abs).isDirectory() ? await walk(abs) : [abs];
  for (const f of files) {
    if (SKIP_EXT.has(extname(f).toLowerCase())) continue;
    const rel = relative(root, f).replace(/\\/g, '/');
    if (SKIP_FILES.some((s) => rel.endsWith(s))) continue;
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    scanned += 1;

    // 作者 GitHub 名：只在 identifier 上下文放行（没配置就整段跳过）
    if (!AUTHOR_GITHUB) {
      /* 不扫 */
    } else {
    const ghRe = new RegExp(AUTHOR_GITHUB, 'g');
    let m;
    while ((m = ghRe.exec(text))) {
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      const lineEnd = text.indexOf('\n', m.index);
      const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
      if (!isAllowedContext(line, 'author-github')) {
        findings.push({
          file: relative(root, f),
          rule: 'author-github',
          desc: `作者的 GitHub 用户名（${AUTHOR_GITHUB}）`,
          snippet: line.trim().slice(0, 160),
        });
        break; // 每个文件只报一次，避免刷屏
      }
    }
    } // end if (AUTHOR_GITHUB)

    for (const rule of ACTIVE_RULES) {
      rule.re.lastIndex = 0;
      let r;
      while ((r = rule.re.exec(text))) {
        const lineStart = text.lastIndexOf('\n', r.index) + 1;
        const lineEnd = text.indexOf('\n', r.index);
        const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
        if (isAllowedContext(line, rule.id)) continue;
        findings.push({
          file: relative(root, f),
          rule: rule.id,
          desc: rule.desc,
          snippet: line.trim().slice(0, 160),
        });
        break;
      }
    }
  }
}

console.log(`\n[体检] 已扫描 ${scanned} 个文件（目录：${SCAN_DIRS.join(', ')}）`);

if (findings.length === 0) {
  console.log('[体检] ✅ 未发现密钥、个人路径或开发地址残留。可以发布。\n');
  process.exit(0);
}

console.log(`[体检] ❌ 发现 ${findings.length} 处需要处理的残留：\n`);
const byRule = new Map();
for (const f of findings) {
  if (!byRule.has(f.rule)) byRule.set(f.rule, []);
  byRule.get(f.rule).push(f);
}
for (const [rule, list] of byRule) {
  console.log(`── ${rule}（${list[0].desc}）── ${list.length} 处`);
  for (const f of list.slice(0, 8)) {
    console.log(`   ${f.file}`);
    console.log(`      ${f.snippet}`);
  }
  if (list.length > 8) console.log(`   …还有 ${list.length - 8} 处`);
  console.log('');
}
process.exit(1);
