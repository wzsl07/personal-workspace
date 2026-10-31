import type { FeatureExtractionPipeline } from '@huggingface/transformers';

/**
 * 本地向量（embedding）。
 *
 * 零外链约束：模型文件必须放在 public/models/bge-small-zh/ 下，
 * 并且 env.allowRemoteModels = false —— 缺文件时直接报错，
 * 绝不会偷偷去 HuggingFace 下载。
 *
 * 模型：Xenova/bge-small-zh-v1.5（中文，512 维，量化 ONNX 约 25MB）
 * 用 `npm run model:setup` 下载。
 */

/**
 * 路径必须是**绝对 URL**，不能是 './xxx'。
 *
 * 原因：动态 import 的相对路径是相对"当前源文件"（src/core/adapters/）解析的，
 * 用 './libs/…' 会去找 src/core/adapters/libs/… 而 404；
 * 而 transformers 内部用 fetch 取模型时又要相对文档根。
 * 统一用 document.baseURI 拼绝对地址，两种场景都对。
 */
const PAGE_BASE = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/';

function absURL(path: string): string {
  return new URL(path, PAGE_BASE).href;
}

/** 模型目录（结尾保留 /，transformers 会直接拼接 modelId） */
const MODEL_DIR = absURL('models/');
const MODEL_ID = 'bge-small-zh';
/** transformers.js 浏览器 bundle 的位置（由 npm run model:setup 复制到 public/libs） */
const LIB_DIR = absURL('libs/');

let pipe: FeatureExtractionPipeline | null = null;
let loading: Promise<FeatureExtractionPipeline> | null = null;

export function modelReady(): boolean {
  return pipe !== null;
}

/**
 * 探测本地模型文件是否存在（不发网络请求到外部）。
 *
 * 两个坑：
 * 1. 不能只看 res.ok —— Vite / Tauri 对不存在的路径会走 SPA 兜底，
 *    返回 200 + 一张 index.html，光看状态码会误判成"文件在"，
 *    然后在解析模型时抛出 "Unexpected token '<' ... is not valid JSON"。
 * 2. **不能看 content-type** —— Tauri 的内嵌资源服务（tauri:// / http://tauri.localhost）
 *    对认不出的扩展名一律把 Content-Type 回退成 text/html（tauri-utils 的 MimeType::parse：
 *    infer 认不出就按扩展名猜，猜不到就 fallback 到 Html）。.onnx 正好是"认不出"的那一类，
 *    于是 24MB 的模型被标成 text/html，按 content-type 判断会误判成"模型没装"。
 *    .js / .json / .wasm 都认得出，所以以前只有模型这一个文件被冤枉。
 *
 * 结论：**只看魔术字节**。SPA 兜底页开头一定是 '<'（0x3C），
 * 真正的 onnx 是二进制 protobuf（首字节 0x08），js/json 也不会以 '<' 开头。
 */
async function probeFile(url: string): Promise<boolean> {
  try {
    // 只取前 64 字节：既能判断真伪，又不用把 22MB 拖下来。
    // 不能用 HEAD —— Tauri 的资源协议（以及部分服务器）对 HEAD 不返回 content-length，
    // 那样会误判成"文件不存在"（桌面版就踩过这个坑）。
    const res = await fetch(url, { headers: { Range: 'bytes=0-63' } });
    if (!res.ok && res.status !== 206) return false;

    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0) return false;

    // 跳过 UTF-8 BOM（EF BB BF）
    const i = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
    // HTML 兜底页以 '<'（0x3C）开头；真正的模型文件不会
    if (buf[i] === 0x3c) return false;
    return true;
  } catch {
    return false;
  }
}

/** 模型是否已就位（带原因，方便 UI 说清楚） */
export async function checkModelDetailed(): Promise<{ ok: boolean; reason: string }> {
  // 运行时库先看：没有它连解析都做不了
  if (!(await probeFile(`${LIB_DIR}transformers.min.js`))) {
    return {
      ok: false,
      reason: `缺少运行时库 ${LIB_DIR}transformers.min.js（跑一次 npm run model:setup）`,
    };
  }
  const base = `${MODEL_DIR}${MODEL_ID}/onnx/`;
  if (await probeFile(`${base}model_quantized.onnx`)) return { ok: true, reason: '量化版' };
  if (await probeFile(`${base}model.onnx`)) return { ok: true, reason: '完整版' };
  return {
    ok: false,
    reason: `在 ${MODEL_DIR}${MODEL_ID}/onnx/ 下没找到模型文件（model_quantized.onnx）`,
  };
}

export async function checkModel(): Promise<boolean> {
  return (await checkModelDetailed()).ok;
}

export async function loadModel(
  onProgress?: (msg: string) => void,
): Promise<FeatureExtractionPipeline> {
  if (pipe) return pipe;
  if (loading) return loading;

  loading = (async () => {
    onProgress?.('检查本地模型…');
    if (!(await checkModel())) {
      throw new Error(
        `缺少本地模型：请把 bge-small-zh 放到 public/models/ 下（npm run model:setup）`,
      );
    }
    onProgress?.('加载模型中（首次约十几秒）…');

    // 关键：不走 Vite 的模块系统，直接把 public/libs 下的浏览器 bundle 当原生 ESM 加载。
    // transformers.js 是 webpack 打包产物，它按"自己所在目录"去找同级的
    // ort-wasm-*.mjs / .wasm；交给 Vite 处理会把路径改写成 /node_modules/... 而加载失败。
    // 这两个文件由 `npm run model:setup` 一起复制到 public/libs/。
    const url = `${LIB_DIR}transformers.min.js`;
    const mod = (await import(/* @vite-ignore */ url)) as {
      pipeline: typeof import('@huggingface/transformers').pipeline;
      env: typeof import('@huggingface/transformers').env;
    };
    const { pipeline, env } = mod;

    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = MODEL_DIR;

    // 单线程：多线程 wasm 需要 COOP/COEP 跨源隔离，普通页面没有，会直接失败
    const wasm = env.backends.onnx.wasm as unknown as Record<string, unknown>;
    wasm.numThreads = 1;
    wasm.proxy = false;
    const p = (await pipeline('feature-extraction', MODEL_ID, {
      // 进度回调在 v3 的类型里没有声明，运行时是支持的
      progress_callback: (x: { status?: string }) => onProgress?.(x.status ?? '加载中'),
    } as Parameters<typeof pipeline>[2])) as unknown as FeatureExtractionPipeline;
    pipe = p;
    return p;
  })();

  try {
    return await loading;
  } finally {
    loading = null;
  }
}

/** 把一段文本变成向量（已归一化，可直接点积算余弦相似度） */
export async function embed(text: string): Promise<Float32Array> {
  const p = await loadModel();
  const out = await p(text.slice(0, 1000), { pooling: 'mean', normalize: true });
  const arr = out.data as Float32Array | number[];
  const v = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i += 1) v[i] = arr[i];
  return v;
}

export async function embedMany(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 1) {
    out.push(await embed(texts[i]));
    onProgress?.(i + 1, texts.length);
  }
  return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

export const EMBED_DIM = 512;
