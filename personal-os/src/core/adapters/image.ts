/**
 * 图片预处理：统一缩放到合理尺寸再送去识别。
 *
 * 为什么要做这一步：
 * - 手机截图动辄 1080×2400 甚至更大，tesseract 在这种尺寸上做版面分析很慢，
 *   中端机上几十秒都出不来，还容易把 worker 拖死；缩到长边 1600 通常快 2~3 倍，
 *   而对文字识别的准确率几乎没有影响（前提是文字本身不小于 12px）。
 * - 云端视觉模型按图片尺寸折算 token，缩小能直接省钱。
 */

/** 缩放后的长边上限（像素） */
const DEFAULT_MAX_EDGE = 1600;

export interface PreparedImage {
  blob: Blob;
  /** 是否真的做了缩放（false = 原图本来就够小，或缩放失败） */
  scaled: boolean;
  width: number;
  height: number;
}

function toBlob(canvas: HTMLCanvasElement | OffscreenCanvas, quality: number): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob 返回空'))),
      'image/jpeg',
      quality,
    );
  });
}

/**
 * 把图片缩到长边不超过 maxEdge，并转成 JPEG。
 * 任何一步失败都退回原图 —— 宁可慢一点，也不能因为预处理把功能搞坏。
 */
export async function prepareImage(
  blob: Blob,
  maxEdge = DEFAULT_MAX_EDGE,
  quality = 0.85,
): Promise<PreparedImage> {
  try {
    const bmp = await createImageBitmap(blob);
    const { width, height } = bmp;
    const longEdge = Math.max(width, height);
    if (longEdge <= maxEdge) {
      return { blob, scaled: false, width, height };
    }
    const ratio = maxEdge / longEdge;
    const w = Math.max(1, Math.round(width * ratio));
    const h = Math.max(1, Math.round(height * ratio));

    const canvas: HTMLCanvasElement | OffscreenCanvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h });

    const ctx = canvas.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) throw new Error('拿不到 canvas 2d 上下文');
    // 白底：PNG 透明区域转 JPEG 会变黑，压在白底上更接近人眼看到的效果
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();

    const out = await toBlob(canvas, quality);
    if (!out || out.size === 0) throw new Error('缩放后生成图片失败');
    return { blob: out, scaled: true, width: w, height: h };
  } catch {
    return { blob, scaled: false, width: 0, height: 0 };
  }
}

/** Blob → base64（不用 FileReader，分块避免参数过多爆栈） */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 8192;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** 人类可读的体积，给进度提示用 */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
