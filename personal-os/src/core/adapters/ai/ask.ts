import type { ItemQuery, ItemStatus, ItemType, Priority } from '../../domain/types';
import { listItems } from '../../repo/itemRepo';
import { listNotes } from '../../repo/noteRepo';
import { search as fullTextSearch } from '../../search/searchIndex';
import { chatJSON } from './openaiCompat';
import { cloudBlockReason, cloudReady, loadConfig, providerLabel } from './index';
import type { AIConfig } from './types';

/**
 * 自然语言问答。
 *
 * 流程：问题 → 结构化查询条件 → **本地**执行 → 命中片段 → 交给模型总结 → 带引用返回。
 * 两条硬约束：
 * 1. 只把"命中片段"发给模型，绝不上传全库；
 * 2. 云端开关关掉时，改用本地规则解析查询条件，且不做总结（纯列表），一点不出网。
 */

export interface AskHit {
  kind: 'item' | 'note' | 'attachment';
  id: string;
  title: string;
  typeLabel: string;
  when: string;
  snippet: string;
  score?: number;
}

export interface AskResult {
  question: string;
  answer: string;
  hits: AskHit[];
  /** 实际用的查询条件，展示给用户，便于纠错 */
  query: ItemQuery;
  provider: string;
  /** 是否用了云端模型做总结 */
  usedCloud: boolean;
  notes: string[];
}

const PLAN_SYSTEM = `你是查询条件生成器。把用户的问题转成 JSON 过滤条件，不要回答问题本身。
字段（都可省略）：
- types: 数组，取值只能是 task/todo/assignment/course/classAffair/activity/exam/meeting/custom
  作业习题=assignment；考试测验=exam；班级事务班费=classAffair；活动=activity；会议=meeting；上课=course；普通待办=todo；其余=task
- statuses: 数组，取值 notStarted/inProgress/done/cancelled/postponed
- openOnly: 布尔，"没交/未完成/还没/待办" 时为 true
- keyword: 字符串，标题或备注里要包含的关键词（不要放时间词和类型词）
- from / to: 本地时间 ISO 字符串（YYYY-MM-DDTHH:mm），表示时间范围
- tags: 标签名数组
- priorityMin: 0~4
- limit: 数字，默认 20
只输出 JSON，不要解释。`;

const SUMMARY_SYSTEM = `你是个人助理。用户问了一个问题，下面是从他本地数据库里检索到的若干条记录。
要求：
1. 只根据这些记录回答，不要编造。记录里没有就说"没找到"。
2. 用简洁的中文回答，需要时在句末用 [1] [2] 标注依据的是第几条记录。
3. 不要重复罗列记录内容，要给出结论。
4. 如果问的是"还有什么没做"，按截止时间先后列出重点。
5. 只输出 JSON，不要解释，格式样例：{"answer":"你的回答"}。

（第 5 条不能省：接口开了 response_format=json_object，DeepSeek / OpenAI 都要求
提示词里出现 json 字样，否则直接 400 —— 查询条件生成那步能过就是因为它的提示词里有"JSON"。）`;

/** 本地规则兜底：从问题里抽出查询条件（不需要模型） */
export function planByRule(question: string, now: Date = new Date()): ItemQuery {
  const q: ItemQuery = {};
  const t = question.toLowerCase();

  const types: ItemType[] = [];
  if (/作业|习题|论文|报告|提交/.test(question)) types.push('assignment');
  if (/考试|测验|期中|期末/.test(question)) types.push('exam');
  if (/班级|班费|班会|班委/.test(question)) types.push('classAffair');
  if (/活动|晚会|聚餐|比赛|团建/.test(question)) types.push('activity');
  if (/会议|例会|开会/.test(question)) types.push('meeting');
  if (/课|上课/.test(question)) types.push('course');
  if (/待办|todo/.test(t)) types.push('todo');
  if (types.length) q.types = types;

  if (/没交|未完成|还没|未做|待办|剩下|还有什么/.test(question)) q.openOnly = true;
  if (/紧急|重要/.test(question)) q.priorityMin = 3 as Priority;

  // 时间范围
  const startOfWeek = new Date(now);
  startOfWeek.setHours(0, 0, 0, 0);
  startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7));
  const endOfWeek = new Date(startOfWeek.getTime() + 6 * 86400000);
  endOfWeek.setHours(23, 59, 59, 999);

  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  if (/本周|这周/.test(question)) {
    q.from = startOfWeek.toISOString();
    q.to = endOfWeek.toISOString();
  } else if (/下周/.test(question)) {
    q.from = new Date(startOfWeek.getTime() + 7 * 86400000).toISOString();
    q.to = new Date(endOfWeek.getTime() + 7 * 86400000).toISOString();
  } else if (/今天|今日/.test(question)) {
    const s = new Date(now);
    s.setHours(0, 0, 0, 0);
    q.from = s.toISOString();
    q.to = todayEnd.toISOString();
  } else if (/明天/.test(question)) {
    const s = new Date(now.getTime() + 86400000);
    s.setHours(0, 0, 0, 0);
    q.from = s.toISOString();
    q.to = new Date(s.getTime() + 86400000 - 1000).toISOString();
  } else if (/上个月|上月/.test(question)) {
    const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const e = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    q.from = s.toISOString();
    q.to = e.toISOString();
  } else if (/本月|这个月/.test(question)) {
    const s = new Date(now.getFullYear(), now.getMonth(), 1);
    const e = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    q.from = s.toISOString();
    q.to = e.toISOString();
  }

  // 关键词：去掉停用词后的剩余片段
  const kw = question
    .replace(/我|的|有|什么|哪些|还有|没|不|了|吗|这|那|个|一下|帮我|找|查|看|请|多少|几/g, '')
    .replace(/(本周|这周|下周|今天|今日|明天|上个月|上月|本月|这个月|作业|考试|班级|班费|活动|会议|待办|没交|未完成)/g, '')
    .replace(/[，。？?、\s]+/g, ' ')
    .trim();
  if (kw.length >= 2) q.keyword = kw;

  q.limit = 20;
  return q;
}

async function planByModel(cfg: AIConfig, question: string, now: Date): Promise<ItemQuery> {
  const raw = (await chatJSON(
    cfg,
    PLAN_SYSTEM,
    `现在时间：${now.toLocaleString('zh-CN')}\n\n问题：${question}`,
  )) as Record<string, unknown>;

  const q: ItemQuery = {};
  const TYPES = new Set(['task', 'todo', 'assignment', 'course', 'classAffair', 'activity', 'exam', 'meeting', 'custom']);
  const STATUS = new Set(['notStarted', 'inProgress', 'done', 'cancelled', 'postponed']);

  if (Array.isArray(raw.types)) {
    const t = raw.types.filter((x): x is ItemType => typeof x === 'string' && TYPES.has(x));
    if (t.length) q.types = t;
  }
  if (Array.isArray(raw.statuses)) {
    const s = raw.statuses.filter((x): x is ItemStatus => typeof x === 'string' && STATUS.has(x));
    if (s.length) q.statuses = s;
  }
  if (typeof raw.openOnly === 'boolean') q.openOnly = raw.openOnly;
  if (typeof raw.keyword === 'string' && raw.keyword.trim()) q.keyword = raw.keyword.trim();
  if (typeof raw.from === 'string' && raw.from) q.from = new Date(raw.from).toISOString();
  if (typeof raw.to === 'string' && raw.to) q.to = new Date(raw.to).toISOString();
  if (typeof raw.priorityMin === 'number') q.priorityMin = Math.max(0, Math.min(4, Math.round(raw.priorityMin))) as Priority;
  if (Array.isArray(raw.tags) && raw.tags.length) q.tags = raw.tags.filter((x): x is string => typeof x === 'string');
  q.limit = typeof raw.limit === 'number' ? Math.min(50, Math.max(1, Math.round(raw.limit))) : 20;
  return q;
}

/** 执行查询并把结果压成"片段"，供总结与引用 */
export async function collectHits(query: ItemQuery): Promise<AskHit[]> {
  const [items, notes] = await Promise.all([listItems({ query }), listNotes()]);

  const hits: AskHit[] = items.slice(0, query.limit ?? 20).map((i) => ({
    kind: 'item' as const,
    id: i.id,
    title: i.title,
    typeLabel: TYPE_LABEL[i.type] ?? i.type,
    when: i.dueAt ?? i.startAt ?? '',
    snippet: [i.remark ?? '', i.location ?? ''].filter(Boolean).join(' · ').slice(0, 160),
  }));

  // 关键词同时搜笔记（问答常常要"笔记和附件"）
  const kw = query.keyword?.trim().toLowerCase();
  if (kw) {
    for (const n of notes) {
      if (!n.content.toLowerCase().includes(kw) && !n.title.toLowerCase().includes(kw)) continue;
      if (hits.length >= (query.limit ?? 20)) break;
      const pos = n.content.toLowerCase().indexOf(kw);
      hits.push({
        kind: 'note',
        id: n.id,
        title: n.title,
        typeLabel: '笔记',
        when: n.updatedAt,
        snippet: pos >= 0 ? n.content.slice(Math.max(0, pos - 40), pos + 120) : n.content.slice(0, 120),
      });
    }
  }
  return hits;
}

const TYPE_LABEL: Record<string, string> = {
  task: '任务',
  todo: '待办',
  assignment: '作业',
  course: '课程',
  classAffair: '班级事务',
  activity: '活动',
  exam: '考试',
  meeting: '会议',
  custom: '自定义',
};

function search(q: string, limit: number) {
  return fullTextSearch(q, limit);
}

function fmtWhen(iso: string): string {
  if (!iso) return '无时间';
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 主入口：问一句，拿答案 + 引用 */
export async function ask(question: string, now: Date = new Date()): Promise<AskResult> {
  const cfg = await loadConfig();
  const notes: string[] = [];

  // 1) 查询条件：优先模型，失败/关闭则规则兜底
  let query: ItemQuery;
  let providerName = '本地规则';
  const cloudOk = cloudReady(cfg);
  if (cloudOk) {
    try {
      query = await planByModel(cfg, question, now);
      providerName = providerLabel(cfg.provider);
      notes.push('查询条件由模型生成');
    } catch (e) {
      query = planByRule(question, now);
      notes.push(`模型生成查询失败，已用本地规则：${e instanceof Error ? e.message.slice(0, 160) : e}`);
    }
  } else {
    query = planByRule(question, now);
    notes.push(`本地规则生成查询条件（${cloudBlockReason(cfg)}）`);
  }

  // 2) 本地执行
  const hits = await collectHits(query);

  // 3) 总结：只在允许出网且有命中时做
  let answer = '';
  let usedCloud = false;
  if (hits.length === 0) {
    answer = '本地库里没有符合条件的记录。';
  } else if (cloudOk) {
    const numbered = hits
      .map((h, i) => `[${i + 1}] ${h.typeLabel}｜${h.title}｜${fmtWhen(h.when)}｜${h.snippet}`)
      .join('\n');
    try {
      const raw = (await chatJSON(cfg, SUMMARY_SYSTEM, `问题：${question}\n\n记录：\n${numbered}`)) as {
        answer?: string;
      };
      answer = typeof raw.answer === 'string' ? raw.answer : JSON.stringify(raw).slice(0, 400);
      usedCloud = true;
    } catch (e) {
      answer = `（模型总结失败，下面是原始结果）${e instanceof Error ? e.message.slice(0, 200) : ''}`;
      usedCloud = false;
    }
  } else {
    answer = `只做本地检索（${cloudBlockReason(cfg)}），共 ${hits.length} 条符合条件。`;
  }

  return { question, answer, hits, query, provider: providerName, usedCloud, notes };
}

const EXPAND_SYSTEM = `你是检索助手。用户给一句自然语言查询，请输出 6~10 个中文关键词或短语，
覆盖同义表达、常见简称、相关说法（例如"班费"→"班级经费""班费收缴""班费收支"）。
不要输出解释，只输出 JSON：{"keywords":["关键词1","关键词2"]}`;

/**
 * 查询改写：本地向量模型不可用时，用这个兜底。
 * 让模型把一句自然语言扩成多个同义关键词，再走全文检索合并结果。
 * 效果不如向量检索，但零下载、零体积代价。
 */
export async function expandAndSearch(
  question: string,
): Promise<{ keywords: string[]; hits: AskHit[]; reason?: string }> {
  const cfg = await loadConfig();
  let keywords: string[] = [];
  let reason: string | undefined;

  if (cloudReady(cfg)) {
    try {
      const raw = (await chatJSON(cfg, EXPAND_SYSTEM, question)) as { keywords?: unknown };
      if (Array.isArray(raw.keywords)) {
        keywords = raw.keywords
          .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
          .slice(0, 10);
      }
      if (keywords.length === 0) reason = '模型没给出可用的关键词';
    } catch (e) {
      reason = e instanceof Error ? e.message.slice(0, 120) : String(e);
    }
  } else {
    reason = cloudBlockReason(cfg);
  }
  if (keywords.length === 0) keywords = [question];

  const merged = new Map<string, AskHit>();
  for (const k of keywords) {
    for (const h of search(k, 8)) {
      const key = `${h.kind}:${h.refId}`;
      if (!merged.has(key)) {
        merged.set(key, {
          kind: h.kind,
          id: h.refId,
          title: h.title,
          typeLabel: h.typeLabel,
          when: '',
          snippet: h.snippet,
          score: h.score,
        });
      }
    }
  }
  return { keywords, hits: [...merged.values()], reason };
}

/** 供 UI 显示：把查询条件翻译成中文 */
export function describeQuery(q: ItemQuery): string {
  const parts: string[] = [];
  if (q.types?.length) parts.push(q.types.map((t) => TYPE_LABEL[t] ?? t).join('/'));
  if (q.openOnly) parts.push('未完成');
  if (q.statuses?.length) parts.push(q.statuses.join('/'));
  if (q.keyword) parts.push(`含「${q.keyword}」`);
  if (q.from || q.to) {
    const f = q.from ? fmtWhen(q.from) : '不限';
    const t = q.to ? fmtWhen(q.to) : '不限';
    parts.push(`${f} — ${t}`);
  }
  if (q.priorityMin) parts.push(`优先级≥${q.priorityMin}`);
  if (q.tags?.length) parts.push(`标签 ${q.tags.join('、')}`);
  return parts.length ? parts.join(' · ') : '无限制条件';
}
