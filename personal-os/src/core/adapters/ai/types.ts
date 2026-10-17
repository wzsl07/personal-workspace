import type {
  AIProviderId,
  ItemStatus,
  ItemType,
  Priority,
  Recurrence,
} from '../../domain/types';

export type { AIProviderId };

/** AI 抽出的结构化条目（尚未写入正式表） */
export interface ParsedItem {
  title: string;
  type: ItemType;
  startAt: string | null;
  dueAt: string | null;
  allDay: boolean;
  priority: Priority;
  status: ItemStatus;
  tags: string[];
  location: string;
  summary: string;
  recurrence: Recurrence | null;
  /** 字段级置信度 0~1 */
  confidence: Partial<Record<'title' | 'type' | 'startAt' | 'dueAt' | 'priority' | 'tags', number>>;
}

export interface ParsedNote {
  title: string;
  content: string;
}

export interface ParseResult {
  items: ParsedItem[];
  note: ParsedNote | null;
  /** 实际生效的 provider（可能已降级） */
  provider: AIProviderId;
  /** 降级链上的说明，展示给用户 */
  notes: string[];
}

export interface AIConfig {
  provider: AIProviderId;
  baseURL: string;
  model: string;
  /** 明文 Key，只存在内存；落盘时加密 */
  apiKey: string;
  /** 总开关：关闭后一律走本地规则解析 */
  allowCloud: boolean;
  /** 云端失败/断网时自动降级到 Ollama → 规则 */
  autoFallback: boolean;
}

export interface AIProvider {
  id: AIProviderId;
  label: string;
  /** 是否已具备可用条件（有 Key / 有地址） */
  ready(cfg: AIConfig): boolean;
  parse(text: string, now: Date, cfg: AIConfig): Promise<ParseResult>;
}

export const DEFAULT_CONFIG: AIConfig = {
  provider: 'deepseek',
  baseURL: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: '',
  allowCloud: true,
  autoFallback: true,
};

export const PROVIDER_PRESETS: Record<
  Exclude<AIProviderId, 'rule' | 'none'>,
  { label: string; baseURL: string; model: string }
> = {
  deepseek: { label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  ollama: { label: 'Ollama（本地）', baseURL: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
  custom: { label: '自定义 API', baseURL: 'http://localhost:8080/v1', model: 'gpt-4o-mini' },
};
