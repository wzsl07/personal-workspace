import type { Attachment } from '../domain/types';

/**
 * OCR 适配器。
 *
 * 为了守住"零外链"，这里**默认关闭**，且：
 * - worker / core(wasm) 从本地 ./ocr/ 目录加载（由 `npm run ocr:setup` 复制出来）
 * - 语言包 chi_sim.traineddata 体积约 15~25MB，不随产物分发，
 *   需要你自己放进 public/ocr/；设置页也可以填一个自托管的 langPath。
 * - 缺语言包时报明确错误，绝不偷偷去 CDN 下载。
 */

export interface OcrConfig {
  enabled: boolean;
  /** 语言包目录或完整 URL，默认 ./ocr/ */
  langPath: string;
  lang: string;
}

export const DEFAULT_OCR: OcrConfig = {
  enabled: false,
  langPath: './ocr/',
  lang: 'chi_sim+eng',
};

/** 语言包是否已就位（同源请求一次 HEAD） */
export async function langReady(cfg: OcrConfig): Promise<boolean> {
  const base = cfg.langPath.replace(/\/$/, '');
  const url = `${base}/${cfg.lang.split('+')[0]}.traineddata`;
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

export interface OcrProgress {
  status: string;
  progress: number;
}

export async function ocrImage(
  blob: Blob,
  cfg: OcrConfig,
  onProgress?: (p: OcrProgress) => void,
): Promise<string> {
  if (!cfg.enabled) throw new Error('OCR 未启用（设置 → 附件与 OCR）');
  if (!(await langReady(cfg))) {
    throw new Error(
      `缺少语言包：请把 ${cfg.lang.split('+')[0]}.traineddata 放到 ${cfg.langPath} 目录，或在设置里填写可访问的语言包地址`,
    );
  }

  // 懒加载：只有真的要用 OCR 时才把 tesseract.js 拉进内存
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker(cfg.lang.split('+'), undefined, {
    workerPath: './ocr/worker.min.js',
    corePath: './ocr/',
    langPath: cfg.langPath,
    logger: (m: { status?: string; progress?: number }) =>
      onProgress?.({ status: m.status ?? '', progress: m.progress ?? 0 }),
  });
  try {
    const { data } = await worker.recognize(blob);
    return data.text ?? '';
  } finally {
    await worker.terminate();
  }
}

export function isImage(a: Attachment): boolean {
  return a.mime.startsWith('image/');
}

/** 人类可读的体积 */
export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
