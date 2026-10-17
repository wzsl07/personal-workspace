/**
 * 中文自然语言时间解析（纯本地，不依赖任何模型）。
 * 支持：今天/明天/后天、下周三、10月9日、10/9、月底、周末、上午9点、下午3点半、23:59 …
 * 教学周次（第 8 周）需要学期起始日，见 termStart 参数。
 */

export interface TimeHit {
  iso: string;
  raw: string;
  /** 是否解析出了具体的时分 */
  hasTime: boolean;
  /** 原文暗示这个时间更像开始还是截止 */
  hint: 'start' | 'due' | null;
  index: number;
}

const WEEK_DAY: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0,
};

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function mkDate(y: number, m: number, d: number, h: number, min: number): Date {
  return new Date(y, m, d, h, min, 0, 0);
}

/** 从"下午3点半""23:59""上午9点"里抽出时分；没有则返回 null */
function parseClock(s: string): { h: number; m: number } | null {
  const colon = /(上午|中午|下午|晚上|凌晨|早上|傍晚)?\s*(\d{1,2})\s*[:：]\s*(\d{2})/.exec(s);
  if (colon) {
    let h = Number(colon[2]);
    const ap = colon[1];
    if ((ap === '下午' || ap === '晚上' || ap === '傍晚') && h < 12) h += 12;
    return { h, m: Number(colon[3]) };
  }
  const zh = /(上午|中午|下午|晚上|凌晨|早上|傍晚)?\s*(\d{1,2})\s*点\s*(半|一刻|\d{1,2}\s*分?)?/.exec(s);
  if (zh) {
    let h = Number(zh[2]);
    const ap = zh[1];
    if (ap === '中午' && h < 12) h = 12;
    if ((ap === '下午' || ap === '晚上' || ap === '傍晚') && h < 12) h += 12;
    const tail = (zh[3] ?? '').trim();
    let m = 0;
    if (tail === '半') m = 30;
    else if (tail === '一刻') m = 15;
    else {
      const mm = /(\d{1,2})/.exec(tail);
      if (mm) m = Number(mm[1]);
    }
    return { h, m };
  }
  return null;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function parseChineseTime(text: string, now: Date = new Date()): TimeHit[] {
  const t = text
    .replace(/号/g, '日')
    .replace(/礼拜/g, '周')
    .replace(/星期/g, '周')
    .replace(/明晚/g, '明天')
    .replace(/今晚|今夜/g, '今天');

  const hits: TimeHit[] = [];
  const push = (index: number, raw: string, date: Date, hasTime: boolean) => {
    hits.push({
      iso: date.toISOString(),
      raw,
      hasTime,
      hint: guessHint(t, index, raw),
      index,
    });
  };

  // 1) 相对日：今天 / 明天 / 后天 / 大后天 / 昨天
  const rel: [RegExp, number][] = [
    [/(今天|今日)/g, 0],
    [/(明天|明日)/g, 1],
    [/后天/g, 2],
    [/大后天/g, 3],
    [/(昨天|昨日)/g, -1],
  ];
  for (const [re, delta] of rel) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      const base = startOfDay(now);
      base.setDate(base.getDate() + delta);
      const clock = parseClock(t.slice(m.index, m.index + 14));
      if (clock) {
        push(m.index, m[0], mkDate(base.getFullYear(), base.getMonth(), base.getDate(), clock.h, clock.m), true);
      } else {
        push(m.index, m[0], mkDate(base.getFullYear(), base.getMonth(), base.getDate(), 23, 59), false);
      }
    }
  }

  // 2) 本周三 / 下周一 / 周五
  const weekRe = /(上|本|这|下)?周\s*([一二三四五六日天])/g;
  let wm: RegExpExecArray | null;
  while ((wm = weekRe.exec(t)) !== null) {
    const target = WEEK_DAY[wm[2]];
    const base = startOfDay(now);
    const cur = base.getDay();
    let diff = (target - cur + 7) % 7;
    const prefix = wm[1];
    if (prefix === '下') diff += 7;
    else if (prefix === '上') diff -= 7;
    else if (prefix === '本' || prefix === '这') diff = (target - cur + 7) % 7;
    base.setDate(base.getDate() + diff);
    const clock = parseClock(t.slice(wm.index, wm.index + 16));
    push(
      wm.index,
      wm[0],
      clock
        ? mkDate(base.getFullYear(), base.getMonth(), base.getDate(), clock.h, clock.m)
        : mkDate(base.getFullYear(), base.getMonth(), base.getDate(), 9, 0),
      Boolean(clock),
    );
  }

  // 3) 10月9日 / 10-9 / 10/9
  const mdRe = /(\d{1,2})月(\d{1,2})日|(\d{1,2})[-/](\d{1,2})(?!\d)/g;
  let mm: RegExpExecArray | null;
  while ((mm = mdRe.exec(t)) !== null) {
    const month = Number(mm[1] ?? mm[3]);
    const day = Number(mm[2] ?? mm[4]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    let year = now.getFullYear();
    if (month < now.getMonth() + 1) year += 1;
    const clock = parseClock(t.slice(mm.index, mm.index + 18));
    push(
      mm.index,
      mm[0],
      clock
        ? mkDate(year, month - 1, day, clock.h, clock.m)
        : mkDate(year, month - 1, day, 23, 59),
      Boolean(clock),
    );
  }

  // 4) 月底 / 月末 / 周末
  const endRe = /(月底|月末)/g;
  let em: RegExpExecArray | null;
  while ((em = endRe.exec(t)) !== null) {
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    push(em.index, em[0], mkDate(last.getFullYear(), last.getMonth(), last.getDate(), 23, 59), false);
  }
  const weekendRe = /周末/g;
  let km: RegExpExecArray | null;
  while ((km = weekendRe.exec(t)) !== null) {
    const base = startOfDay(now);
    base.setDate(base.getDate() + ((6 - base.getDay() + 7) % 7));
    push(km.index, km[0], mkDate(base.getFullYear(), base.getMonth(), base.getDate(), 10, 0), false);
  }

  // 5) 只有时钟没有日期，如"23:59 前交"
  const onlyClock = /(?:^|[^\d])(\d{1,2}[:：]\d{2})/.exec(t);
  if (onlyClock && hits.length === 0) {
    const c = parseClock(onlyClock[1]);
    if (c) {
      const base = startOfDay(now);
      push(
        onlyClock.index,
        onlyClock[1],
        mkDate(base.getFullYear(), base.getMonth(), base.getDate(), c.h, c.m),
        true,
      );
    }
  }

  return hits.sort((a, b) => a.index - b.index);
}

function guessHint(text: string, index: number, raw: string): 'start' | 'due' | null {
  const before = text.slice(Math.max(0, index - 10), index);
  const after = text.slice(index + raw.length, index + raw.length + 10);
  const ctx = `${before} ${after}`;
  // "10月15日前交""月底前发给他""23:59 截止" 都算截止
  if (/截止|ddl|deadline|之前|以前|最迟|上交|交齐|提交|交|到期|前/i.test(ctx)) return 'due';
  if (/开始|上课|举行|开展|举办|会议|活动|集合|出发|考试|开考|报到/.test(ctx)) return 'start';
  return null;
}

/** 教学周次：第 8 周 → 该周周一（需要学期第一周周一的日期） */
export function weekToDate(week: number, termStart: Date, weekday = 1): Date | null {
  if (!termStart || week < 1) return null;
  const d = startOfDay(termStart);
  d.setDate(d.getDate() + (week - 1) * 7 + (weekday - 1));
  return d;
}

/** 给规则解析器用：挑一个最像截止时间和一个最像开始时间 */
export function pickTimes(text: string, now: Date = new Date()): {
  dueAt: string | null;
  startAt: string | null;
  dueRaw: string | null;
  startRaw: string | null;
  hasTime: boolean;
} {
  const hits = parseChineseTime(text, now);
  const due = hits.find((h) => h.hint === 'due') ?? null;
  const start = hits.find((h) => h.hint === 'start') ?? null;
  const rest = hits.filter((h) => h !== due && h !== start);
  return {
    dueAt: due?.iso ?? null,
    startAt: start?.iso ?? (due ? null : (rest[0]?.iso ?? null)),
    dueRaw: due?.raw ?? null,
    startRaw: start?.raw ?? null,
    hasTime: Boolean(due?.hasTime || start?.hasTime || rest[0]?.hasTime),
  };
}

export function formatLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
