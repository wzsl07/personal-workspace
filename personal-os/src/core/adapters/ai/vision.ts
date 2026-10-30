import type { AIConfig } from './types';
import { blobToBase64, fmtBytes, prepareImage } from '../image';

/**
 * 云端视觉识别：把图片交给支持图片的聊天模型，让它把图片里的文字逐字转录出来。
 *
 * 与本地 tesseract 的分工：
 * - 本地：离线、隐私、零成本，但手机上很慢（30s 起）、小字和手写基本废。
 * - 云端：3~10 秒、中文截图/课件照片/手写都更准，代价是**图片会离开本机**，
 *   且需要联网和 API Key。
 *
 * 这里用 OpenAI 兼容的 `image_url` 块传 base64，DeepSeek（deepseek-flash）、
 * 通义千问 VL、GLM-4V、GPT-4o 系列、Ollama 的 llava 等都吃这个格式。
 */

const SYSTEM_PROMPT =
  '你是一个高精度的 OCR 引擎。请逐字转录图片中的所有文字，' +
  '保留原有的段落、列表与表格结构。不要翻译、不要总结、不要补充图片里没有的内容。' +
  '如果图片里没有文字，只回复一个空字符串。直接输出纯文本，不要用 markdown 代码块包裹。';

/** 传给模型的图片长边上限：够看清 12px 的字，又能省下不少 token */
const MAX_EDGE = 1600;

/**
 * 识图用哪个模型。
 *
 * 单独配一个字段是必要的：文本解析用的模型未必支持图片。
 * 典型情况就是 DeepSeek —— deepseek-chat / deepseek-reasoner 只吃文本，
 * 识图必须用 deepseek-flash。
 */
export function resolveVisionModel(cfg: AIConfig): string {
  if (cfg.visionModel?.trim()) return cfg.visionModel.trim();
  if (cfg.provider === 'deepseek') return 'deepseek-flash';
  return cfg.model || 'deepseek-flash';
}

/** 云端识图是否具备条件（有地址、允许联网；Ollama 本地地址不需要 Key） */
export function cloudVisionReady(cfg: AIConfig): boolean {
  if (!cfg.allowCloud) return false;
  if (!cfg.baseURL?.trim()) return false;
  const isLocal = /localhost|127\.0\.0\.1/.test(cfg.baseURL);
  return isLocal || !!cfg.apiKey;
}

/** 给界面用的说明：云端那条链路现在能不能用、为什么 */
export function cloudVisionStatus(cfg: AIConfig): string {
  if (!cfg.allowCloud) return '总开关「允许联网」是关的';
  if (!cfg.baseURL?.trim()) return '还没填接口地址';
  const isLocal = /localhost|127\.0\.0\.1/.test(cfg.baseURL);
  if (!isLocal && !cfg.apiKey) return '还没填 API Key';
  return '';
}

export interface CloudOcrOptions {
  onProgress?: (msg: string) => void;
  /** 超时（毫秒），超过就抛错，避免界面永远转圈 */
  timeoutMs?: number;
}

export async function ocrViaCloud(
  blob: Blob,
  cfg: AIConfig,
  opts: CloudOcrOptions = {},
): Promise<{ text: string; model: string }> {
  const model = resolveVisionModel(cfg);
  const url = `${cfg.baseURL.replace(/\/$/, '')}/chat/completions`;

  opts.onProgress?.('正在压缩图片…');
  const prepared = await prepareImage(blob, MAX_EDGE);
  opts.onProgress?.(
    `正在用云端视觉模型识别（${fmtBytes(prepared.blob.size)}）…`,
  );
  const b64 = await blobToBase64(prepared.blob);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 45_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey || 'local'}`,
      },
      // 注意：这里**不用** response_format: json_object —— 部分视觉模型在带图片时
      // 不接受结构化输出，让它直接吐纯文本最稳。
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 4000,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: SYSTEM_PROMPT },
              {
                type: 'image_url',
                // mime 要跟着实际内容走：小图不会缩放，原样就是 PNG。
                // 服务端按文件头判断格式，写错了虽然也能认，但没必要留这种不一致。
                image_url: { url: `data:${prepared.blob.type || 'image/jpeg'};base64,${b64}` },
              },
            ],
          },
        ],
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error(`云端识别超时（${Math.round((opts.timeoutMs ?? 45_000) / 1000)} 秒）`);
    }
    throw new Error(`连不上识别服务：${e instanceof Error ? e.message : String(e)}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(cloudError(res.status, model, detail));
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  if (data.error?.message) throw new Error(`云端返回错误：${data.error.message}`);
  const text = (data.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error('云端没有返回任何文字（可能图片里确实没有文字）');
  return { text, model };
}

/** 把云端报错翻译成能动手修的话 */
function cloudError(status: number, model: string, detail: string): string {
  const tail = detail ? `「${detail}」` : '';
  if (status === 401 || status === 403) {
    return `云端鉴权失败（${status}）：API Key 不对或已失效${tail}`;
  }
  if (status === 404) {
    return `云端接口不存在（404）：地址可能少了 /v1，或模型 ${model} 不可用${tail}`;
  }
  if (status === 400) {
    return (
      `云端拒绝了请求（400）：多半是模型 ${model} 不支持图片${tail}。` +
      'DeepSeek 请填 deepseek-flash，其它服务商请确认用的是视觉模型。'
    );
  }
  if (status === 429) {
    return `云端限流或余额不足（429）${tail}`;
  }
  return `云端识别失败（${status}）${tail}`;
}
