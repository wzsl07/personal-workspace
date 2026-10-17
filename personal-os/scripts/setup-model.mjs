/**
 * 下载中文向量模型到本地 public/models/，保证语义搜索完全离线、零外链。
 *
 * 用法：npm run model:setup
 * 来源：HuggingFace Xenova/bge-small-zh-v1.5（量化 ONNX，约 25MB）
 * 这一步是"一次性"的——下完之后应用永不联网取模型（env.allowRemoteModels=false）。
 */
import { mkdir, writeFile, stat, readdir, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'models', 'bge-small-zh');

// 国内直连 huggingface.co 通常不通，先试镜像，再回退官方源
const MIRRORS = [
  'https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main',
  'https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main',
];
const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'onnx/model_quantized.onnx',
];
const OPTIONAL = ['onnx/model.onnx'];

async function download(path, label) {
  const dest = join(outDir, path);
  await mkdir(dirname(dest), { recursive: true });
  if (existsSync(dest)) {
    const s = await stat(dest);
    console.log(`= 已存在 ${label}（${(s.size / 1024 / 1024).toFixed(1)} MB）`);
    return true;
  }
  console.log(`↓ 下载 ${label} …`);
  let lastErr = null;
  for (const base of MIRRORS) {
    try {
      const res = await fetch(`${base}/${path}`);
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(dest, buf);
      console.log(`✓ ${label}（${(buf.length / 1024 / 1024).toFixed(1)} MB）`);
      return true;
    } catch (e) {
      lastErr = e;
    }
  }
  console.error(`✗ ${label}: ${lastErr?.message ?? '未知错误'}`);
  return false;
}

let ok = true;
for (const f of FILES) {
  const r = await download(f, f);
  if (!r) ok = false;
}

// 量化版不在时再试完整版
if (!existsSync(join(outDir, 'onnx', 'model_quantized.onnx'))) {
  for (const f of OPTIONAL) await download(f, `${f}（备用）`);
}

// 关键：把 transformers.js 的浏览器 bundle 和它配套的 onnxruntime wasm
// 原样复制到 public/libs/，前端用原生 ESM 动态加载（绕过 Vite 的模块处理）。
// 原因：transformers.js 是 webpack 打包产物，wasm 加载器路径在打包时就写死了，
// 交给 Vite 处理会被改写成 /node_modules/... 从而加载失败（dev 下报
// "Failed to fetch dynamically imported module"）。
const libSrc = join(root, 'node_modules', '@huggingface', 'transformers', 'dist');
const libOut = join(root, 'public', 'libs');
await mkdir(libOut, { recursive: true });

// bundle 本体 + 它同级引用的 wasm 加载器/二进制（必须放在一起，它按相对路径找）
const WANTED = ['transformers.min.js'];
const PREFIX = ['ort-wasm'];
let libCount = 0;
for (const f of await readdir(libSrc)) {
  const hit = WANTED.includes(f) || (PREFIX.some((p) => f.startsWith(p)) && /\.(mjs|wasm)$/.test(f));
  if (!hit) continue;
  await cp(join(libSrc, f), join(libOut, f));
  console.log(`✓ libs/${f}`);
  libCount += 1;
}
if (libCount === 0) console.log('⚠ 没找到 transformers bundle，语义搜索将无法离线运行');

// 旧方案残留（public/ort）已不再需要
const oldOrt = join(root, 'public', 'ort');
if (existsSync(oldOrt)) {
  await rm(oldOrt, { recursive: true, force: true });
  console.log('已清理旧的 public/ort（改用 public/libs）');
}

console.log(`\n模型目录：${outDir}`);
if (!ok) {
  console.log('部分文件下载失败，请检查网络后重跑；或手动从镜像站下载放到上述目录。');
} else {
  console.log('模型已就位，刷新应用后在「搜索 → 语义」里点「加载模型并建索引」。');
}
console.log('之后应用只会从这里加载，不会联网取模型。');
console.log('注意：public/models 会打进构建产物，不需要语义搜索时可删除该目录。');
