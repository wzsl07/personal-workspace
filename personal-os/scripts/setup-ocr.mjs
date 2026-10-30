/**
 * 准备图片 OCR 所需的本地资源，全部落在 public/ocr/，运行期不碰任何 CDN：
 *
 *   1. worker.min.js                    ← 来自 tesseract.js
 *   2. tesseract-core-simd-lstm.wasm.js ← 来自 tesseract.js-core（现代浏览器走这个）
 *      tesseract-core-lstm.wasm.js       ← 不支持 SIMD 时的回退
 *   3. chi_sim.traineddata / eng.traineddata ← tessdata_fast，从 jsdelivr 下载
 *
 * 只复制 LSTM 专用的 core：tesseract.js 默认 OEM 是 LSTM_ONLY，其余变体（约 22MB）
 * 永远不会被加载，塞进产物只会让安装包和 PWA 白白变大。
 *
 * 用法：npm run ocr:setup
 *       加 --force 可重新下载已存在的语言包
 */
import { cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'ocr');
const force = process.argv.includes('--force');

/** 运行期真正会用到的 core 文件 */
const CORE_FILES = ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'];

/** 语言包下载源，按顺序尝试（国内 jsdelivr 通常可用） */
const MIRRORS = [
  'https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@main',
  'https://fastly.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@main',
  'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main',
];

const LANGS = ['chi_sim', 'eng'];

await mkdir(out, { recursive: true });

// ---------- 1. worker ----------
const srcWorker = join(root, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js');
if (!existsSync(srcWorker)) {
  console.error('没找到 tesseract.js，请先 npm install');
  process.exit(1);
}
await cp(srcWorker, join(out, 'worker.min.js'));
console.log('✓ worker.min.js');

// ---------- 2. wasm core ----------
const coreDir = join(root, 'node_modules', 'tesseract.js-core');
if (!existsSync(coreDir)) {
  console.error('没找到 tesseract.js-core，请先 npm install');
  process.exit(1);
}
const available = new Set(await readdir(coreDir));
for (const f of CORE_FILES) {
  if (!available.has(f)) {
    console.warn(`⚠ tesseract.js-core 里没有 ${f}（版本可能变了，请检查）`);
    continue;
  }
  await cp(join(coreDir, f), join(out, f));
  const { size } = await stat(join(out, f));
  console.log(`✓ ${f}  ${(size / 1024 / 1024).toFixed(1)} MB`);
}

// ---------- 3. 语言包 ----------
async function download(lang) {
  const dest = join(out, `${lang}.traineddata`);
  if (existsSync(dest) && !force) {
    const { size } = await stat(dest);
    console.log(`✓ ${lang}.traineddata 已存在（${(size / 1024 / 1024).toFixed(1)} MB），跳过`);
    return true;
  }
  for (const base of MIRRORS) {
    const url = `${base}/${lang}.traineddata`;
    try {
      process.stdout.write(`  下载 ${lang}.traineddata ← ${new URL(url).hostname} … `);
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) {
        console.log(`HTTP ${res.status}，换下一个源`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      // 语言包是二进制，但别把 HTML 错误页当成包存下来
      if (buf.length < 100_000 || buf.subarray(0, 1).toString() === '<') {
        console.log(`返回的不是语言包（${buf.length} B），换下一个源`);
        continue;
      }
      await writeFile(dest, buf);
      console.log(`✓ ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
      return true;
    } catch (e) {
      console.log(`失败（${e instanceof Error ? e.message : e}），换下一个源`);
    }
  }
  return false;
}

let langOk = true;
for (const lang of LANGS) {
  if (!(await download(lang))) langOk = false;
}

// ---------- 汇总 ----------
const files = await readdir(out);
const total = (
  await Promise.all(files.map(async (f) => (await stat(join(out, f))).size))
).reduce((a, b) => a + b, 0);

console.log(`\nOCR 资源目录：${out}（共 ${(total / 1024 / 1024).toFixed(1)} MB）`);
console.log(files.map((f) => `  ${f}`).join('\n'));

if (!langOk) {
  console.log(
    '\n⚠ 有语言包没能自动下载。手动下载后放进上面这个目录即可（两个都要）：\n' +
      '  https://github.com/tesseract-ocr/tessdata_fast/raw/main/chi_sim.traineddata\n' +
      '  https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata\n' +
      '注意用 tessdata_fast（chi_sim 约 2.4MB）；tessdata 主仓库那份 40MB，没必要。',
  );
  process.exitCode = 1;
} else {
  console.log('\n完成。到「设置 → 附件与 OCR」勾上启用，保存即可。');
}
