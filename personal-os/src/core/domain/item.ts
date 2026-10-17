import { newId, nowISO } from './id';
import type {
  ISO,
  ItemStatus,
  ItemType,
  Priority,
  ScheduleItem,
  SortKey,
} from './types';

/* ------------------------------------------------------------------ */
/* 类型元数据（UI 与导出的唯一来源）                                    */
/* ------------------------------------------------------------------ */

export interface TypeMeta {
  label: string;
  /** 十六进制色值，日历/看板/时间轴共用 */
  color: string;
  /** lucide 图标名，由 UI 层映射为组件 */
  icon: string;
  /** 该类型默认是否占一段时间（课程/会议/考试/活动 = true） */
  timed: boolean;
  /** 默认是否带截止时间（作业/任务 = true） */
  due: boolean;
}

export const ITEM_TYPES: Record<ItemType, TypeMeta> = {
  task: { label: '任务', color: '#5b8cff', icon: 'CheckSquare', timed: false, due: true },
  todo: { label: '待办', color: '#7c8aa5', icon: 'Circle', timed: false, due: false },
  assignment: { label: '作业', color: '#f0a13c', icon: 'FileText', timed: false, due: true },
  course: { label: '课程', color: '#3fb984', icon: 'GraduationCap', timed: true, due: false },
  classAffair: { label: '班级事务', color: '#b06cf0', icon: 'Users', timed: false, due: true },
  activity: { label: '活动', color: '#e8577f', icon: 'PartyPopper', timed: true, due: false },
  exam: { label: '考试', color: '#e5484d', icon: 'PenLine', timed: true, due: false },
  meeting: { label: '会议', color: '#2fb8c6', icon: 'CalendarClock', timed: true, due: false },
  custom: { label: '自定义', color: '#8b93a7', icon: 'Sparkles', timed: false, due: false },
};

export const ITEM_TYPE_LIST = Object.keys(ITEM_TYPES) as ItemType[];

export const STATUS_META: Record<ItemStatus, { label: string; color: string }> = {
  notStarted: { label: '未开始', color: '#7c8aa5' },
  inProgress: { label: '进行中', color: '#5b8cff' },
  done: { label: '已完成', color: '#3fb984' },
  cancelled: { label: '已取消', color: '#6b7590' },
  postponed: { label: '已延期', color: '#f0a13c' },
};

export const STATUS_LIST = Object.keys(STATUS_META) as ItemStatus[];

export const PRIORITY_META: Record<Priority, { label: string; color: string }> = {
  0: { label: '无', color: '#6b7590' },
  1: { label: '低', color: '#6b7590' },
  2: { label: '中', color: '#5b8cff' },
  3: { label: '高', color: '#f0a13c' },
  4: { label: '紧急', color: '#e5484d' },
};

export const PRIORITY_LIST: Priority[] = [0, 1, 2, 3, 4];

/* ------------------------------------------------------------------ */
/* 工厂与状态机                                                        */
/* ------------------------------------------------------------------ */

export function createItem(
  input: Partial<ScheduleItem> & { title: string; type?: ItemType },
): ScheduleItem {
  const now = nowISO();
  const type = input.type ?? 'task';
  const meta = ITEM_TYPES[type];
  return {
    id: input.id ?? newId(),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    rev: 1,
    type,
    title: input.title.trim(),
    startAt: input.startAt ?? null,
    dueAt: input.dueAt ?? (meta.due ? null : null),
    allDay: input.allDay ?? !meta.timed,
    priority: input.priority ?? 0,
    status: input.status ?? 'notStarted',
    completedAt: input.completedAt ?? null,
    tags: input.tags ?? [],
    noteIds: input.noteIds ?? [],
    attachmentIds: input.attachmentIds ?? [],
    sourceId: input.sourceId ?? null,
    courseId: input.courseId ?? null,
    classId: input.classId ?? null,
    reminderIds: input.reminderIds ?? [],
    recurrence: input.recurrence ?? null,
    location: input.location ?? '',
    remark: input.remark ?? '',
    extra: input.extra ?? {},
    origin: input.origin ?? 'manual',
    pendingConfirm: input.pendingConfirm ?? [],
    confidence: input.confidence ?? {},
  };
}

/** 已完成 / 已取消 视为关闭；其余为未完成 */
export function isOpen(item: ScheduleItem): boolean {
  return item.status !== 'done' && item.status !== 'cancelled';
}

export function isOverdue(item: ScheduleItem, at: Date = new Date()): boolean {
  if (!isOpen(item)) return false;
  if (!item.dueAt) return false;
  return new Date(item.dueAt).getTime() < at.getTime();
}

/** 状态流转的合法目标 */
const TRANSITIONS: Record<ItemStatus, ItemStatus[]> = {
  notStarted: ['inProgress', 'done', 'cancelled', 'postponed'],
  inProgress: ['done', 'cancelled', 'postponed', 'notStarted'],
  done: ['notStarted', 'inProgress'],
  cancelled: ['notStarted', 'inProgress'],
  postponed: ['notStarted', 'inProgress', 'cancelled'],
};

export function canTransition(from: ItemStatus, to: ItemStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/** 应用状态变更，返回新对象（不修改入参） */
export function applyStatus(item: ScheduleItem, status: ItemStatus): ScheduleItem {
  if (!canTransition(item.status, status)) return item;
  const now = nowISO();
  return {
    ...item,
    status,
    completedAt: status === 'done' ? now : null,
    updatedAt: now,
    rev: item.rev + 1,
  };
}

/** 条目在日历/列表上的"主时间"：有开始用开始，否则用截止 */
export function anchorTime(item: ScheduleItem): ISO | null {
  return item.startAt ?? item.dueAt ?? null;
}

export function sortItems(items: ScheduleItem[], key: SortKey = 'dueAt'): ScheduleItem[] {
  const weight = (it: ScheduleItem): number => {
    if (key === 'priority') return -it.priority;
    const t = anchorTime(it);
    return t ? new Date(t).getTime() : Number.POSITIVE_INFINITY;
  };
  return [...items].sort((a, b) => {
    const d = weight(a) - weight(b);
    if (Number.isNaN(d) || d === 0) return a.createdAt.localeCompare(b.createdAt);
    return d;
  });
}
