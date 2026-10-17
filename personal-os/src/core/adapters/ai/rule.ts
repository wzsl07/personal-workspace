import { parseChineseTime } from '../../domain/nltime';
import type { ItemType, Priority } from '../../domain/types';
import type { AIConfig, AIProvider, ParseResult, ParsedItem } from './types';

/**
 * 离线规则解析器：没有网络、没有 Key、模型不可用时都能工作。
 * 定位是"能用但不完美"——所有推断字段的置信度都不超过 0.75，
 * 界面会把低置信度字段标成"待确认"，由用户拍板。
 */

const TYPE_RULES: [RegExp, ItemType][] = [
  [/考试|测验|期中|期末|补考|摸底/, 'exam'],
  [/作业|习题|提交|上交|论文|报告|实验报告|预习|复习提纲/, 'assignment'],
  [/班费|班级|班会|班委|团支部|团日|统计.*名单/, 'classAffair'],
  [/活动|晚会|聚餐|比赛|运动会|破冰|团建|讲座|招新/, 'activity'],
  [/会议|例会|开会|研讨|答辩/, 'meeting'],
  [/上课|课程|第\s*\d+\s*节|调课|停课/, 'course'],
];

const COURSE_TAGS: [RegExp, string][] = [
  [/高等数学|高数/, '高等数学'],
  [/大学物理|大物/, '大学物理'],
  [/英语/, '英语'],
  [/C语言|程序设计/, 'C语言'],
  [/电路|电子/, '电路电子'],
  [/工程图学|制图/, '工程图学'],
];

function guessType(text: string): { type: ItemType; hit: boolean } {
  for (const [re, t] of TYPE_RULES) {
    if (re.test(text)) return { type: t, hit: true };
  }
  return { type: 'task', hit: false };
}

function guessPriority(text: string, dueAt: string | null): Priority {
  if (/紧急|尽快|务必|必须|马上|立刻|asap|ddl/i.test(text)) return 4;
  if (/重要|优先|关键/.test(text)) return 3;
  if (dueAt) {
    const days = (new Date(dueAt).getTime() - Date.now()) / 86400000;
    if (days <= 1) return 3;
    if (days <= 3) return 2;
  }
  return 0;
}

function guessTags(text: string): string[] {
  const out = new Set<string>();
  for (const [re, tag] of COURSE_TAGS) if (re.test(text)) out.add(tag);
  for (const m of text.matchAll(/#([^\s#]+)/g)) out.add(m[1]);
  return [...out].slice(0, 6);
}

/** 地点：教学楼B201 / A301 / 图书馆三楼 / 体育馆 */
function guessLocation(text: string): string {
  // 前面紧跟"点/数字"的要排除，避免把"晚上7点体育馆"里的"点体育馆"当地点
  const m =
    /(?<![点\d])([\u4e00-\u9fa5]{2,6}(?:教学楼|楼|馆|厅|场|中心|教室|操场|报告厅)[A-Za-z0-9\-]{0,6})|(?<![点\d])([A-Z]\s?\d{3})/.exec(
      text,
    );
  if (!m) return '';
  const hit = (m[1] ?? m[2] ?? '').trim();
  return /^[点\d]/.test(hit) ? '' : hit;
}

const CLOCK_RE =
  /((上午|中午|下午|晚上|凌晨|早上|傍晚)?\s*\d{1,2}\s*[:：]\s*\d{2})|((上午|中午|下午|晚上|凌晨|早上|傍晚)?\s*\d{1,2}\s*点\s*(半|一刻|\d{1,2}\s*分?)?)/g;

/** 标题：去掉已识别的时间片段和尾部标点，避免把整句话当标题 */
function cleanTitle(line: string, timeRaws: string[] = []): string {
  let s = line
    .replace(/^\s*[-*•·]\s*/, '')
    .replace(/^\s*\d+[.、)]\s*/, '')
    .replace(/^【[^】]*】\s*/, '')
    .replace(/^\[[^\]]*\]\s*/, '');
  for (const raw of timeRaws) s = s.replace(raw, ' ');
  s = s
    .replace(CLOCK_RE, ' ')
    .replace(/\s*(截止|ddl|deadline)\s*/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[前之前最迟于在\s]+/, '')
    .replace(/[，,。；;、\s]+$/, '')
    .trim();
  return s.slice(0, 60) || line.slice(0, 60);
}

/** 按行/句号拆成候选事项；过滤掉太短或明显不是事项的行 */
function splitBlocks(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 4 && !/^[【\[]?(通知|提醒|各位|大家好)/.test(l));
  if (lines.length >= 2) return lines.slice(0, 6);
  const bySentence = text
    .split(/[。！；\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6);
  return (bySentence.length ? bySentence : [text]).slice(0, 4);
}

export const ruleProvider: AIProvider = {
  id: 'rule',
  label: '本地规则解析（离线）',
  ready: () => true,
  async parse(text, now): Promise<ParseResult> {
    const blocks = splitBlocks(text);
    const items: ParsedItem[] = blocks.map((block) => {
      const { type, hit } = guessType(block);
      const times = parseChineseTime(block, now);
      const due = times.find((h) => h.hint === 'due');
      const start = times.find((h) => h.hint === 'start');
      const dueAt = due?.iso ?? null;
      const startAt = start?.iso ?? (!due ? (times[0]?.iso ?? null) : null);
      const hasClock = Boolean(due?.hasTime || start?.hasTime || times[0]?.hasTime);

      return {
        title: cleanTitle(block, times.map((h) => h.raw)) || '未命名条目',
        type,
        startAt,
        dueAt,
        allDay: !hasClock,
        priority: guessPriority(block, dueAt),
        status: 'notStarted',
        tags: guessTags(block),
        location: guessLocation(block),
        summary: block.slice(0, 80),
        recurrence: null,
        confidence: {
          title: 0.7,
          type: hit ? 0.65 : 0.35,
          startAt: startAt ? (start?.hasTime ? 0.6 : 0.45) : 0.2,
          dueAt: dueAt ? (due?.hasTime ? 0.7 : 0.5) : 0.2,
          priority: 0.4,
          tags: 0.5,
        },
      };
    });

    return {
      items,
      note: null,
      provider: 'rule',
      notes: ['由本地规则解析生成，时间/类型可能不准，请逐项确认'],
    };
  },
};

export function ruleAvailable(): boolean {
  return true;
}

export type { AIConfig };
