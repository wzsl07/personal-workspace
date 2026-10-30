import type { Attachment } from '../domain/types';
import { fmtBytes, prepareImage } from './image';

/**
 * OCR 适配器（本地）。
 *
 * 为了守住"零外链"，这里只在本机跑：
 * - worker / core(wasm) 从本地 ./ocr/ 目录加载（由 `npm run ocr:setup` 复制出来）
 * - 语言包 chi_sim/eng.traineddata 体积约 6.6MB，不随产物分发，
 *   需要你自己放进 public/ocr/；设置页也可以填一个自托管的 langPath。
 * - 缺语言包时报明确错误，绝不偷偷去 CDN 下载。
 *
 * 想更快更准可以走云端视觉模型，见 `ai/vision.ts`。
 */

/**
 * 图片识别走哪条路：
 * - auto  优先云端，失败自动退回本地（默认）
 * - cloud 只用云端，本地不参与
 * - local 只用本地，绝不联网
 */
export type OcrMode = 'auto' | 'cloud' | 'local';

export interface OcrConfig {
  enabled: boolean;
  /** 语言包目录或完整 URL，默认 ./ocr/ */
  langPath: string;
  lang: string;
  /** 识别策略，默认 auto（云端优先，失败退回本地） */
  mode: OcrMode;
}

export const DEFAULT_OCR: OcrConfig = {
  enabled: true,
  langPath: './ocr/',
  lang: 'chi_sim+eng',
  mode: 'auto',
};

/** 'chi_sim+eng' → ['chi_sim', 'eng'] */
export function langList(cfg: OcrConfig): string[] {
  return cfg.lang
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
}

function baseOf(cfg: OcrConfig): string {
  return cfg.langPath.replace(/\/$/, '');
}

/**
 * 哪些语言包没找到（逐个 HEAD 请求）。
 *
 * 注意：这里查的是 **不带 .gz** 的原名，因为 ocrImage 里传了 `gzip: false`。
 * 两处必须一致 —— 曾经这里查 .traineddata、tesseract 却去取 .traineddata.gz，
 * 结果是"检测通过、识别 404"。
 */
export async function missingLangs(cfg: OcrConfig): Promise<string[]> {
  const base = baseOf(cfg);
  const missing: string[] = [];
  for (const l of langList(cfg)) {
    const ok = await fetch(`${base}/${l}.traineddata`, { method: 'HEAD' })
      .then((r) => r.ok)
      .catch(() => false);
    if (!ok) missing.push(l);
  }
  return missing;
}

/** 语言包是否全部就位 */
export async function langReady(cfg: OcrConfig): Promise<boolean> {
  return (await missingLangs(cfg)).length === 0;
}

export interface OcrProgress {
  status: string;
  progress: number;
}

type TessWorker = Awaited<ReturnType<typeof import('tesseract.js').createWorker>>;

/** 语言包体积参考（tessdata_fast：chi_sim 2.4MB + eng 3.9MB） */
export const LANG_SIZE_HINT = '约 6.6MB（chi_sim 2.4MB + eng 3.9MB）';

/**
 * worker 复用：每张图都新建 worker 要花 1~3 秒初始化（加载 wasm + 语言包），
 * 连续导入几张截图时这个开销很扎眼。语言/路径变了才重建。
 */
let cached: { key: string; worker: TessWorker } | null = null;

function workerKey(cfg: OcrConfig): string {
  return `${cfg.langPath}|${cfg.lang}`;
}

async function makeWorker(cfg: OcrConfig, onProgress?: (p: OcrProgress) => void): Promise<TessWorker> {
  const { createWorker } = await import('tesseract.js');
  try {
    return await createWorker(langList(cfg), undefined, {
      // worker 与 core 固定在应用自带的 ./ocr/ 下：它们是程序的一部分，
      // 不跟着用户填的 langPath 走（langPath 只用来找语言包）。
      workerPath: './ocr/worker.min.js',
      corePath: './ocr/',
      langPath: baseOf(cfg),
      // 必须显式关掉：tesseract 默认去取 <lang>.traineddata.gz，
      // 而官方 tessdata 仓库给的是未压缩的 .traineddata。
      gzip: false,
      logger: (m: { status?: string; progress?: number }) =>
        onProgress?.({ status: m.status ?? '', progress: m.progress ?? 0 }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `OCR 引擎启动失败：${msg}\n` +
        '多半是 public/ocr/ 里缺 worker.min.js 或 tesseract-core-*-lstm.wasm.js —— 跑一次 npm run ocr:setup 可补齐。',
    );
  }
}

async function getWorker(cfg: OcrConfig, onProgress?: (p: OcrProgress) => void): Promise<TessWorker> {
  const key = workerKey(cfg);
  if (cached?.key === key) return cached.worker;
  if (cached) {
    await cached.worker.terminate().catch(() => undefined);
    cached = null;
  }
  const worker = await makeWorker(cfg, onProgress);
  cached = { key, worker };
  return worker;
}

/** 预热（可选）：在导入图片前先把 worker 建好，省掉第一张的等待 */
export async function warmUp(cfg: OcrConfig): Promise<void> {
  if (!cfg.enabled) return;
  if (!(await langReady(cfg))) return;
  await getWorker(cfg).catch(() => undefined);
}

export interface OcrImageOptions {
  onProgress?: (p: OcrProgress) => void;
  /**
   * 超时（毫秒）。必须要有：tesseract 在手机上跑大图可能几十秒不出结果，
   * 万一 worker 被系统杀掉，Promise 永远不会 settle —— 界面就永远转圈。
   */
  timeoutMs?: number;
}

export async function ocrImage(
  blob: Blob,
  cfg: OcrConfig,
  opts: OcrImageOptions = {},
): Promise<string> {
  if (!cfg.enabled) throw new Error('图片 OCR 未启用（设置 → 附件与 OCR）');

  const missing = await missingLangs(cfg);
  if (missing.length > 0) {
    const names = missing.map((m) => `${m}.traineddata`).join('、');
    throw new Error(
      `缺少语言包 ${names}。请放进 ${cfg.langPath} 目录` +
        '（目录里该有 chi_sim.traineddata 与 eng.traineddata），' +
        '或把「语言包路径」改成一个能访问到它们的地址。',
    );
  }

  // 缩放到长边 1600：手机上能快 2~3 倍，还能显著降低被系统杀掉的概率
  const prepared = await prepareImage(blob);
  if (prepared.scaled) {
    opts.onProgress?.({ status: `已缩放至 ${prepared.width}×${prepared.height}`, progress: 0 });
  }

  const worker = await getWorker(cfg, opts.onProgress);
  const limit = opts.timeoutMs ?? 120_000;
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`本地识别超时（${Math.round(limit / 1000)} 秒），可改用云端识别`)), limit),
  );
  try {
    const { data } = await Promise.race([worker.recognize(prepared.blob), timer]);
    return data.text ?? '';
  } catch (e) {
    if (e instanceof Error && e.message.includes('超时')) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`图片识别失败：${msg}`);
  }
}

/** 本地这条路现在能不能用（语言包是否齐全） */
export async function localOcrStatus(cfg: OcrConfig): Promise<string> {
  const missing = await missingLangs(cfg);
  if (missing.length === 0) return '';
  return `缺少语言包 ${missing.map((m) => `${m}.traineddata`).join('、')}`;
}

export { fmtBytes };

export function isImage(a: Attachment): boolean {
  return a.mime.startsWith('image/');
}

/** 人类可读的体积 */
export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
