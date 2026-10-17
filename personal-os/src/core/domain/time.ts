import {
  differenceInCalendarDays,
  endOfDay,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import { zhCN } from 'date-fns/locale';
import type { ISO } from './types';

/** 统一按本地时区解析 */
export function toDate(v: ISO | Date | null | undefined): Date | null {
  if (!v) return null;
  return v instanceof Date ? v : new Date(v);
}

export function fmtDate(v: ISO | Date | null | undefined): string {
  const d = toDate(v);
  if (!d) return '';
  const y = d.getFullYear();
  const nowY = new Date().getFullYear();
  return format(d, y === nowY ? 'M月d日' : 'yyyy年M月d日', { locale: zhCN });
}

export function fmtTime(v: ISO | Date | null | undefined): string {
  const d = toDate(v);
  return d ? format(d, 'HH:mm') : '';
}

export function fmtDateTime(v: ISO | Date | null | undefined): string {
  const d = toDate(v);
  if (!d) return '';
  return `${fmtDate(d)} ${fmtTime(d)}`;
}

export function fmtWeekday(v: ISO | Date | null | undefined): string {
  const d = toDate(v);
  return d ? format(d, 'EEE', { locale: zhCN }) : '';
}

/** 相对今天的自然语言描述：今天 / 明天 / 逾期 3 天 / 3 天后 */
export function dueLabel(v: ISO | null | undefined): string {
  const d = toDate(v);
  if (!d) return '无期限';
  const days = differenceInCalendarDays(startOfDay(d), startOfDay(new Date()));
  if (days === 0) return '今天';
  if (days === 1) return '明天';
  if (days === 2) return '后天';
  if (days === -1) return '昨天';
  if (days < 0) return `逾期 ${-days} 天`;
  if (days <= 7) return `${days} 天后`;
  return fmtDate(d);
}

export function isToday(v: ISO | null | undefined): boolean {
  const d = toDate(v);
  return d ? isSameDay(d, new Date()) : false;
}

export interface Range {
  from: ISO;
  to: ISO;
}

export function dayRange(d: Date): Range {
  return { from: startOfDay(d).toISOString(), to: endOfDay(d).toISOString() };
}

export function weekRange(d: Date): Range {
  return {
    from: startOfWeek(d, { weekStartsOn: 1 }).toISOString(),
    to: endOfWeek(d, { weekStartsOn: 1 }).toISOString(),
  };
}

export function monthRange(d: Date): Range {
  return {
    from: startOfMonth(d).toISOString(),
    to: endOfMonth(d).toISOString(),
  };
}

/** 生成月视图需要的 6×7 网格起点（周一为首列） */
export function monthGrid(d: Date): Date[] {
  const start = startOfWeek(startOfMonth(d), { weekStartsOn: 1 });
  const out: Date[] = [];
  for (let i = 0; i < 42; i += 1) {
    out.push(new Date(start.getTime() + i * 86400000));
  }
  return out;
}

/** 判断条目时间是否落在区间内（开始或截止任一落在区间即算） */
export function overlaps(
  startAt: ISO | null | undefined,
  dueAt: ISO | null | undefined,
  range: Range,
): boolean {
  const a = toDate(startAt)?.getTime();
  const b = toDate(dueAt)?.getTime();
  const from = new Date(range.from).getTime();
  const to = new Date(range.to).getTime();
  if (a === undefined && b === undefined) return false;
  if (a !== undefined && a >= from && a <= to) return true;
  if (b !== undefined && b >= from && b <= to) return true;
  // 跨越整个区间的长任务
  if (a !== undefined && b !== undefined && a <= from && b >= to) return true;
  return false;
}

/** datetime-local 输入框 <-> ISO 互转（本地时区） */
export function toLocalInput(v: ISO | null | undefined): string {
  const d = toDate(v);
  if (!d) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(s: string): ISO | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
