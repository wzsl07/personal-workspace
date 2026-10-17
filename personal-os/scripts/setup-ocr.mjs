/**
 * 把 tesseract.js 的 worker 与 wasm 从 node_modules 复制到 public/ocr/，
 * 这样 OCR 完全走本地资源，不碰任何 CDN。
 * 语言包（chi_sim.traineddata，15~25MB）不随应用分发，需自行下载放入同目录。
 *
 * 用法：npm run ocr:setup
 */
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'ocr');

await mkdir(out, { recursive: true });

const srcWorker = join(root, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js');
const coreDir = join(root, 'node_modules', 'tesseract.js-core');

if (!existsSync(srcWorker)) {
  console.error('没找到 tesseract.js，请先 npm install tesseract.js');
  process.exit(1);
}
await cp(srcWorker, join(out, 'worker.min.js'));
console.log('✓ worker.min.js');

if (existsSync(coreDir)) {
  const files = await readdir(coreDir);
  for (const f of files) {
    if (f.endsWith('.wasm') || f.endsWith('.js')) {
      await cp(join(coreDir, f), join(out, f));
      console.log(`✓ ${f}`);
    }
  }
}

const files = await readdir(out);
const hasLang = files.some((f) => f.endsWith('.traineddata'));
console.log('\nOCR 运行时资源已就位：', out);
if (!hasLang) {
  console.log(
    '⚠ 还没有语言包。请下载 chi_sim.traineddata 放进该目录：\n' +
      '  https://github.com/tesseract-ocr/tessdata/blob/main/chi_sim.traineddata\n' +
      '（不放也能用，只是图片 OCR 会提示缺少语言包）',
  );
} else {
  const s = await stat(join(out, files.find((f) => f.endsWith('.traineddata'))));
  console.log(`✓ 语言包已存在（${(s.size / 1024 / 1024).toFixed(1)} MB）`);
}
