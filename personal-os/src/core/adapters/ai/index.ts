import { getMeta, setMeta } from '../../repo/db';
import { loadSecret, saveSecret } from '../crypto';
import { createOpenAICompat } from './openaiCompat';
import { ruleProvider } from './rule';
import {
  DEFAULT_CONFIG,
  type AIConfig,
  type AIProvider,
  type AIProviderId,
  type ParseResult,
} from './types';

export * from './types';

const deepseek = createOpenAICompat('deepseek', 'DeepSeek', true);
const ollama = createOpenAICompat('ollama', 'Ollama（本地）', false);
const custom = createOpenAICompat('custom', '自定义 API', false);

const REGISTRY: Record<AIProviderId, AIProvider> = {
  deepseek,
  ollama,
  custom,
  rule: ruleProvider,
  none: ruleProvider,
};

export function providerLabel(id: AIProviderId): string {
  return REGISTRY[id]?.label ?? id;
}

/* ------------------------------------------------------------------ */
/* 配置：Key 加密存本地，其余明文存 meta                                */
/* ------------------------------------------------------------------ */

const CFG_KEY = 'ai:config';

export async function loadConfig(): Promise<AIConfig> {
  const stored = await getMeta<Partial<AIConfig>>(CFG_KEY, {});
  let apiKey = '';
  try {
    apiKey = await loadSecret('ai.apiKey');
  } catch {
    apiKey = '';
  }
  return { ...DEFAULT_CONFIG, ...stored, apiKey };
}

export async function saveConfig(cfg: AIConfig): Promise<void> {
  const { apiKey, ...rest } = cfg;
  await setMeta(CFG_KEY, rest);
  await saveSecret('ai.apiKey', apiKey);
}

/* ------------------------------------------------------------------ */
/* 降级链                                                              */
/* ------------------------------------------------------------------ */

/**
 * 云端能力是否真的可用（接口地址 + Key 都齐）。
 * 问答/查询改写这些直接调 chatJSON 的地方必须先问这个，
 * 否则空地址会请求到自身域名、拿回一张 HTML 页面，报出莫名其妙的 JSON 解析错。
 */
export function cloudReady(cfg: AIConfig): boolean {
  if (!cfg.allowCloud || cfg.provider === 'rule' || cfg.provider === 'none') return false;
  const p = REGISTRY[cfg.provider];
  return Boolean(p && p.ready(cfg));
}

/** 为什么不可用（给 UI 显示原因） */
export function cloudBlockReason(cfg: AIConfig): string {
  if (!cfg.allowCloud) return '设置里关闭了「允许调用云端 AI」';
  if (cfg.provider === 'rule' || cfg.provider === 'none') return '当前用的是本地规则解析';
  if (!cfg.baseURL) return '还没填接口地址（设置 → AI 解析）';
  if (cfg.provider === 'deepseek' && !cfg.apiKey) return '还没填 DeepSeek API Key（设置 → AI 解析）';
  if (cfg.provider === 'custom' && !cfg.apiKey) return '自定义接口没填 Key（如果服务端不校验可以随便填）';
  return '云端 AI 不可用';
}

/** 按配置给出尝试顺序：主 provider →（可选）Ollama → 本地规则 */
export function resolveChain(cfg: AIConfig): AIProvider[] {
  if (!cfg.allowCloud || cfg.provider === 'rule' || cfg.provider === 'none') return [ruleProvider];
  const chain: AIProvider[] = [];
  const primary = REGISTRY[cfg.provider];
  if (primary && primary.ready(cfg)) chain.push(primary);
  if (cfg.autoFallback && cfg.provider !== 'ollama') {
    const ollamaCfg: AIConfig = {
      ...cfg,
      provider: 'ollama',
      baseURL: 'http://localhost:11434/v1',
      model: cfg.model.includes(':') ? cfg.model : 'qwen2.5:7b',
    };
    if (ollama.ready(ollamaCfg)) chain.push({ ...ollama, parse: (t, n) => ollama.parse(t, n, ollamaCfg) });
  }
  if (cfg.autoFallback || chain.length === 0) chain.push(ruleProvider);
  return chain.length ? chain : [ruleProvider];
}

export async function runParse(
  text: string,
  now: Date = new Date(),
  cfg?: AIConfig,
): Promise<ParseResult> {
  const conf = cfg ?? (await loadConfig());
  const chain = resolveChain(conf);
  const notes: string[] = [];

  for (const p of chain) {
    try {
      const r = await p.parse(text, now, conf);
      return { ...r, notes: [...notes, ...r.notes, `由 ${p.label} 解析`] };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notes.push(`${p.label} 失败：${msg.slice(0, 120)}`);
    }
  }
  // 理论上到不了这里：ruleProvider 永不抛错
  const fallback = await ruleProvider.parse(text, now, conf);
  return { ...fallback, notes: [...notes, '已降级到本地规则解析'] };
}

/** 设置页的"测试连接"：只打一次最小请求，不落库 */
export async function testConnection(cfg: AIConfig): Promise<string> {
  if (!cfg.allowCloud || cfg.provider === 'rule') return '当前使用本地规则解析，无需联网';
  const p = REGISTRY[cfg.provider];
  if (!p) return '未知的提供商';
  if (!p.ready(cfg)) return '缺少 API Key 或接口地址';
  try {
    const r = await p.parse('测试：明天下午3点开会', new Date(), cfg);
    return `连接正常（${p.label}），返回 ${r.items.length} 条`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `连接失败：${msg.slice(0, 200)}`;
  }
}
