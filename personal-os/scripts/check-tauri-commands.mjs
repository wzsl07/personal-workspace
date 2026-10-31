/**
 * 发布前体检之一：前端 invoke 的命令名必须与 Rust 里注册的一致。
 *
 * 为什么单独查这个：Tauri **不会**去掉函数名上的 `_cmd` 后缀
 * （命令名就是 `#[tauri::command] fn xxx` 的 xxx 本身）。
 * 一旦两边不一致，invoke 会 reject，而调用方通常 catch 后静默降级——
 * 表现就是"点了没反应"，没有任何报错，极难排查。
 *
 * 用法：node scripts/check-tauri-commands.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const root = process.cwd();
const TS_EXT = new Set(['.ts', '.tsx']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === 'target') continue;
      walk(p, out);
    } else if (TS_EXT.has(extname(name))) {
      out.push(p);
    }
  }
  return out;
}

// ---- Rust 侧：带 #[tauri::command] 的函数名 ----
const mainRs = readFileSync(join(root, 'src-tauri', 'src', 'main.rs'), 'utf8');
const registered = new Set(
  [...mainRs.matchAll(/#\[tauri::command\]\s*fn\s+([a-z_]+)/g)].map((m) => m[1]),
);

// ---- 前端侧：invoke('xxx', ...) ----
const called = new Map();
for (const f of walk(join(root, 'src'))) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/invoke(?:<[^>]*>)?\(\s*'([a-z_]+)'/g)) {
    if (!called.has(m[1])) called.set(m[1], f);
  }
}

let bad = 0;
console.log('\n=== Tauri 命令名一致性 ===\n');

for (const [cmd, file] of [...called].sort()) {
  const ok = registered.has(cmd);
  if (!ok) bad += 1;
  const where = file.replace(root + '\\', '').replace(root + '/', '');
  console.log(`  ${ok ? '✅' : '❌'} ${cmd.padEnd(30)} ${where}`);
}

if (bad) {
  console.log(
    `\n  ❌ ${bad} 个命令在 Rust 侧找不到。\n` +
      '     Rust 注册的是（注意 _cmd 后缀不会被去掉）：\n' +
      [...registered].sort().map((c) => `       · ${c}`).join('\n'),
  );
  process.exit(1);
}

console.log(`\n  全部 ${called.size} 个命令都能对上 ✅\n`);
