import type { Attachment, SourceKind } from '../domain/types';
import { loadConfig } from './ai';
import { cloudVisionStatus, ocrViaCloud, resolveVisionModel } from './ai/vision';
import { DEFAULT_OCR, ocrImage, type OcrConfig } from './ocr';

/**
 * 文本抽取：把 PDF / Word / 图片 / 纯文本 变成可搜索、可交给 AI 的纯文本。
 *
 * PDF / Word / 纯文本一律在本机完成，不上传任何文件。
 * 图片有两条路：云端视觉模型（快而准，但图片会离开本机）与本地 tesseract
 * （离线、隐私，但手机上慢）。默认云端优先、失败自动退回本地。
 */

const OCR_CFG_KEY = 'ocr:config';

export async function loadOcrConfig(): Promise<OcrConfig> {
  const { getMeta } = await import('../repo/db');
  const stored = await getMeta<Partial<OcrConfig>>(OCR_CFG_KEY, {});
  return { ...DEFAULT_OCR, ...stored };
}

export async function saveOcrConfig(cfg: OcrConfig): Promise<void> {
  const { setMeta } = await import('../repo/db');
  await setMeta(OCR_CFG_KEY, cfg);
}

export function kindOfFile(name: string, mime: string): SourceKind {
  const lower = name.toLowerCase();
  if (mime === 'application/pdf' || lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx') || lower.endsWith('.doc') || mime.includes('word')) return 'word';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (mime.startsWith('image/')) return 'image';
  return 'text';
}

/** 纯文本 / Markdown 直接读 */
async function extractPlain(blob: Blob): Promise<string> {
  const text = await blob.text();
  return text.slice(0, 200_000);
}

/** PDF：pdf.js 逐页取 textContent，按页拼接 */
async function extractPdf(blob: Blob): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const buf = await blob.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const parts: string[] = [];
  const maxPages = Math.min(doc.numPages, 50);
  for (let i = 1; i <= maxPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const line = (content.items as { str?: string }[])
      .map((it) => it.str ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (line) parts.push(`[第${i}页] ${line}`);
  }
  await doc.destroy();
  return parts.join('\n').slice(0, 200_000);
}

/** Word：mammoth 转 HTML 再去标签 */
async function extractDocx(blob: Blob): Promise<string> {
  const mammoth = await import('mammoth');
  const buf = await blob.arrayBuffer();
  const res = await mammoth.convertToHtml({ arrayBuffer: buf });
  return res.value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 200_000);
}

export interface ExtractResult {
  text: string;
  /** ocr = 本地 tesseract，ocr-cloud = 云端视觉模型 */
  method: 'pdf' | 'docx' | 'plain' | 'ocr' | 'ocr-cloud' | 'none';
  error?: string;
}

export async function extractText(
  blob: Blob,
  kind: SourceKind,
  onProgress?: (msg: string) => void,
): Promise<ExtractResult> {
  try {
    if (kind === 'pdf') {
      onProgress?.('正在抽取 PDF 文本…');
      return { text: await extractPdf(blob), method: 'pdf' };
    }
    if (kind === 'word') {
      onProgress?.('正在解析 Word…');
      return { text: await extractDocx(blob), method: 'docx' };
    }
    if (kind === 'image') {
      const cfg = await loadOcrConfig();
      if (!cfg.enabled) {
        return { text: '', method: 'none', error: '图片需要 OCR，当前未启用（设置 → 附件与 OCR）' };
      }
      const mode = cfg.mode ?? 'auto';
      const ai = await loadConfig();

      /* ---- 先试云端（auto / cloud） ---- */
      let cloudErr = '';
      if (mode !== 'local') {
        const why = cloudVisionStatus(ai);
        if (why && mode === 'cloud') {
          return { text: '', method: 'none', error: `云端识别不可用：${why}（设置 → AI 解析）` };
        }
        if (!why) {
          try {
            const r = await ocrViaCloud(blob, ai, { onProgress, timeoutMs: 45_000 });
            return { text: r.text, method: 'ocr-cloud' };
          } catch (e) {
            cloudErr = e instanceof Error ? e.message : String(e);
            if (mode === 'cloud') return { text: '', method: 'none', error: cloudErr };
            onProgress?.('云端没成功，改用本机识别…');
          }
        } else {
          cloudErr = why;
        }
      }

      /* ---- 再走本地 ---- */
      try {
        onProgress?.('正在本机识别图片文字…');
        const text = await ocrImage(blob, cfg, {
          onProgress: (p) => onProgress?.(p.status ? `本机识别：${p.status}` : '正在本机识别图片文字…'),
          timeoutMs: 120_000,
        });
        return { text, method: 'ocr' };
      } catch (e) {
        const localErr = e instanceof Error ? e.message : String(e);
        return {
          text: '',
          method: 'none',
          error: cloudErr ? `云端：${cloudErr}\n本机：${localErr}` : localErr,
        };
      }
    }
    return { text: await extractPlain(blob), method: 'plain' };
  } catch (e) {
    return { text: '', method: 'none', error: e instanceof Error ? e.message : String(e) };
  }
}

/** 是否需要 AI 兜底（扫描版 PDF 抽不出文字时） */
export async function needsAIVision(a: Attachment): Promise<boolean> {
  void a;
  const cfg = await loadConfig();
  return cfg.allowCloud;
}

/**
 * 图片当前会走哪条路（给界面显示用）。
 * 返回的是**意图**，实际是否成功要看运行时。
 */
export async function ocrRoute(): Promise<{
  mode: OcrConfig['mode'];
  route: 'cloud' | 'local' | 'none';
  detail: string;
}> {
  const cfg = await loadOcrConfig();
  if (!cfg.enabled) return { mode: cfg.mode ?? 'auto', route: 'none', detail: '图片 OCR 未启用' };
  const mode = cfg.mode ?? 'auto';
  if (mode !== 'local') {
    const ai = await loadConfig();
    const why = cloudVisionStatus(ai);
    if (!why) {
      return { mode, route: 'cloud', detail: `云端视觉模型（${resolveVisionModel(ai)}）` };
    }
    if (mode === 'cloud') return { mode, route: 'none', detail: `云端不可用：${why}` };
    return { mode, route: 'local', detail: `云端不可用（${why}），将退回本机` };
  }
  return { mode, route: 'local', detail: '本机 tesseract（不联网）' };
}
