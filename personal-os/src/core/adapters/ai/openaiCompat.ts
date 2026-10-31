import type { AIProviderId } from '../../domain/types';
import type { AIConfig, AIProvider, ParseResult, ParsedItem } from './types';

/**
 * OpenAI 兼容的聊天接口实现，DeepSeek / Ollama / 自托管代理都走这一份代码。
 * 注意：浏览器直连第三方 API 可能被 CORS 拦截，此时请在设置里改用
 * 「自定义 API」指向自己的代理，或用桌面壳（Tauri）绕开浏览器限制。
 */

const SYSTEM_PROMPT = `你是个人信息整理助手。把用户给的一段中文内容（班级通知、作业要求、活动消息等）
拆成结构化日程条目。要求：
1. 只输出 JSON，不要任何解释文字、不要 Markdown 代码块。
2. 时间用本地时间的 ISO 字符串（YYYY-MM-DDTHH:mm），无法确定的字段给 null。
3. type 只能是：task/todo/assignment/course/classAffair/activity/exam/meeting/custom。
   作业与提交=assignment；考试测验=exam；班级事务与班费=classAffair；活动聚餐比赛=activity；
   会议例会=meeting；上课=course；普通待办=todo；需要完成但不明确=task。
4. priority 取 0(无)/1(低)/2(中)/3(高)/4(紧急)。
5. status 一般取 notStarted。
6. confidence 给每个字段 0~1 的把握程度，猜的或推断的不要超过 0.7。
7. 一段内容可能包含多个事项，能拆就拆。
8. 如果原文更像参考资料而非待办，把 items 置空，改用 note 输出笔记标题与 Markdown 正文。

输出格式：
{"items":[{"title":"","type":"assignment","startAt":null,"dueAt":"2026-10-12T23:59","allDay":false,"priority":3,"status":"notStarted","tags":["高数"],"location":"","summary":"","recurrence":null,"confidence":{"title":0.95,"dueAt":0.6}}],"note":null}`;

function extractJSON(raw: string): unknown {
  const cleaned = raw
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('模型没有返回 JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

const TYPES = new Set(['task', 'todo', 'assignment', 'course', 'classAffair', 'activity', 'exam', 'meeting', 'custom']);

function normalizeItem(raw: Record<string, unknown>): ParsedItem {
  const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
  const num = (v: unknown, d = 0): number => (typeof v === 'number' && !Number.isNaN(v) ? v : d);
  const type = TYPES.has(str(raw.type)) ? (str(raw.type) as ParsedItem['type']) : 'task';
  const conf = (raw.confidence ?? {}) as Record<string, unknown>;
  const confNum = (k: string): number | undefined => {
    const v = conf[k];
    return typeof v === 'number' ? Math.max(0, Math.min(1, v)) : undefined;
  };
  return {
    title: str(raw.title).slice(0, 120) || '未命名条目',
    type,
    startAt: str(raw.startAt) || null,
    dueAt: str(raw.dueAt) || null,
    allDay: Boolean(raw.allDay ?? false),
    priority: Math.max(0, Math.min(4, Math.round(num(raw.priority, 0)))) as ParsedItem['priority'],
    status: 'notStarted',
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string').slice(0, 8) : [],
    location: str(raw.location),
    summary: str(raw.summary),
    recurrence: (raw.recurrence ?? null) as ParsedItem['recurrence'],
    confidence: {
      title: confNum('title'),
      type: confNum('type'),
      startAt: confNum('startAt'),
      dueAt: confNum('dueAt'),
      priority: confNum('priority'),
      tags: confNum('tags'),
    },
  };
}

/** 模型返回的 ISO 是"本地时间无时区"，补成本地时间再转 ISO */
function localToISO(s: string | null): string | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  if (!m) return null;
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    m[4] ? Number(m[4]) : 0,
    m[5] ? Number(m[5]) : 0,
  );
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * 把失败响应翻译成人话 —— **必须把服务端给的 error.message 带出来**。
 *
 * 只报状态码是没法排查的：400 可能是模型名不对，可能是开了 json_object 但提示词里
 * 没有 json 字样，也可能是某个参数这个模型不支持 —— 三种修法完全不同。
 * DeepSeek 的错误体是 {"error":{"message":"..."}}，这里优先取它。
 */
async function httpError(res: Response): Promise<string> {
  let detail = '';
  try {
    const text = (await res.text()).slice(0, 300);
    try {
      const j = JSON.parse(text) as {
        error?: { message?: string } | string;
        message?: string;
      };
      detail = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? text;
    } catch {
      detail = text;
    }
  } catch {
    detail = '';
  }
  detail = detail.replace(/\s+/g, ' ').trim();

  const head =
    res.status === 401 || res.status === 403
      ? `接口鉴权失败（${res.status}），检查 API Key 是否正确`
      : res.status === 404
        ? '接口地址不对（404），检查是否少了 /v1 或写错了域名'
        : `接口返回 ${res.status}`;
  return detail ? `${head}：${detail}` : head;
}

/**
 * 通用 JSON 对话：给一段 system + user，拿回解析好的 JSON。
 * 问答、查询改写都走这里，复用同一套 provider 与降级逻辑。
 */
export async function chatJSON(cfg: AIConfig, system: string, user: string): Promise<unknown> {
  if (!cfg.baseURL) {
    throw new Error('接口地址是空的，请到「设置 → AI 解析」里填写');
  }
  const res = await fetch(`${cfg.baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey || 'local'}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    }),
  });
  const ctype = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    throw new Error(await httpError(res));
  }
  if (!ctype.includes('json')) {
    // 返回 HTML 说明请求根本没打到 API（多半是地址空/错，被本地页面兜底了）
    const snippet = (await res.text()).slice(0, 80).replace(/\s+/g, ' ');
    throw new Error(
      `接口返回的不是 JSON（${ctype || '未知类型'}），八成是接口地址填错了：${snippet}`,
    );
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content ?? '';
  return extractJSON(content);
}

/**
 * 通用纯文本对话：给一段 system + user，拿回一段文字。
 *
 * 与 chatJSON 的区别是**不传 response_format**：
 * 有些模型开了结构化输出后会拒绝某些内容，或者把话缩得很短；
 * 摘要、润色这类"给我一段话"的场景用这个更稳。
 */
export async function chatText(
  cfg: AIConfig,
  system: string,
  user: string,
  maxTokens = 800,
): Promise<string> {
  if (!cfg.baseURL) {
    throw new Error('接口地址是空的，请到「设置 → AI 解析」里填写');
  }
  const res = await fetch(`${cfg.baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey || 'local'}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.2,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(await httpError(res));
  }
  const ctype = res.headers.get('content-type') ?? '';
  if (!ctype.includes('json')) {
    const snippet = (await res.text()).slice(0, 80).replace(/\s+/g, ' ');
    throw new Error(`接口返回的不是 JSON（${ctype || '未知类型'}），八成是接口地址填错了：${snippet}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return (data.choices?.[0]?.message?.content ?? '').trim();
}

export function createOpenAICompat(
  id: AIProviderId,
  label: string,
  requireKey = true,
): AIProvider {
  return {
    id,
    label,
    ready(cfg) {
      if (!cfg.baseURL) return false;
      return requireKey ? Boolean(cfg.apiKey) : true;
    },
    async parse(text, now, cfg): Promise<ParseResult> {
      const userPrompt = `现在时间：${now.toLocaleString('zh-CN')}（本地时区）。\n\n待整理内容：\n"""\n${text}\n"""`;
      const res = await fetch(`${cfg.baseURL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey || 'local'}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          response_format: { type: 'json_object' },
        }),
      });

      if (!res.ok) {
        throw new Error(`${label} · ${await httpError(res)}`);
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content ?? '';
      const parsed = extractJSON(content) as {
        items?: unknown[];
        note?: { title?: string; content?: string } | null;
      };

      const items = (Array.isArray(parsed.items) ? parsed.items : [])
        .map((i) => normalizeItem((i ?? {}) as Record<string, unknown>))
        .map((i) => ({ ...i, startAt: localToISO(i.startAt), dueAt: localToISO(i.dueAt) }));

      return {
        items,
        note:
          parsed.note && parsed.note.title
            ? { title: String(parsed.note.title), content: String(parsed.note.content ?? '') }
            : null,
        provider: id,
        notes: [],
      };
    },
  };
}
