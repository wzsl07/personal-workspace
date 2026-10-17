/**
 * 领域模型 —— 纯类型，零框架依赖。
 * 设计要点：
 * 1. 单表多态：Task/Event/Course/Assignment/ClassAffair/Activity/Exam/Meeting
 *    全部合并为 ScheduleItem，用 type 判别，类型专属字段放 extra。
 *    （理由：日历/今日/看板/搜索都要跨类型统一查询与排序。）
 * 2. BaseEntity 自带 deletedAt（软删除）与 rev（修订号），为阶段 4 的
 *    同步与冲突合并提前埋点，阶段 1 成本几乎为零。
 */

export type ID = string;
/** ISO 8601 字符串，统一用本地时间语义存储 */
export type ISO = string;

export interface BaseEntity {
  id: ID;
  createdAt: ISO;
  updatedAt: ISO;
  /** 软删除：非空即已删除，同步合并需要它 */
  deletedAt?: ISO | null;
  /** 本地修订号，每次写入 +1 */
  rev: number;
}

/* ------------------------------------------------------------------ */
/* 日程条目                                                            */
/* ------------------------------------------------------------------ */

export type ItemType =
  | 'task'
  | 'todo'
  | 'assignment'
  | 'course'
  | 'classAffair'
  | 'activity'
  | 'exam'
  | 'meeting'
  | 'custom';

export type ItemStatus =
  | 'notStarted'
  | 'inProgress'
  | 'done'
  | 'cancelled'
  | 'postponed';

/** 0 无 / 1 低 / 2 中 / 3 高 / 4 紧急 */
export type Priority = 0 | 1 | 2 | 3 | 4;

export interface Recurrence {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom';
  interval: number;
  /** 0 = 周日，1 = 周一 … */
  byWeekday?: number[];
  /** 教学周次，如 [1, 3, 5, 7, 9] */
  weeks?: number[];
  weekParity?: 'all' | 'odd' | 'even';
  until?: ISO;
  /** 兼容标准 RRULE（导出 ICS 用） */
  rrule?: string;
}

export interface ScheduleItem extends BaseEntity {
  type: ItemType;
  title: string;
  startAt?: ISO | null;
  dueAt?: ISO | null;
  allDay: boolean;
  priority: Priority;
  status: ItemStatus;
  completedAt?: ISO | null;

  tags: ID[];
  noteIds: ID[];
  attachmentIds: ID[];
  sourceId?: ID | null;
  /** 关联的 course 型条目 */
  courseId?: ID | null;
  /** 关联的班级（后期多人协作用） */
  classId?: ID | null;
  reminderIds: ID[];
  recurrence?: Recurrence | null;

  location?: string;
  remark?: string;
  /** 类型专属字段：学分、教师、教室、班费金额 … */
  extra?: Record<string, unknown>;

  origin: 'manual' | 'ai' | 'import';
  /** AI 抽取后仍需人工确认的字段名 */
  pendingConfirm?: string[];
  /** 字段级置信度 0~1 */
  confidence?: Record<string, number>;
}

/* ------------------------------------------------------------------ */
/* 笔记 / 附件 / 标签 / 双链                                            */
/* ------------------------------------------------------------------ */

export interface Note extends BaseEntity {
  title: string;
  /** 虚拟路径，如 /课程/高等数学/第3章.md */
  path: string;
  /** Markdown 原文 */
  content: string;
  tags: ID[];
  itemIds: ID[];
  attachmentIds: ID[];
  /** 冗余字段，由 links 表维护，用于反链展示 */
  backlinks: ID[];
  sourceId?: ID | null;
  pinned: boolean;
}

export type Ref =
  | { kind: 'item'; id: ID }
  | { kind: 'note'; id: ID }
  | { kind: 'attachment'; id: ID };

export interface Attachment extends BaseEntity {
  name: string;
  mime: string;
  size: number;
  /** OPFS / 文件系统中的存储键 */
  storageKey: string;
  /** 内容哈希，用于去重 */
  hash?: string;
  /** PDF/Word/OCR 抽取出的文本（敏感，可加密） */
  extractedText?: string;
  extractedAt?: ISO;
  ownerRefs: Ref[];
  /** 抽取方式与错误信息，如 { method: 'pdf' } / { extractError: '…' } */
  extra?: Record<string, unknown>;
}

export interface Tag extends BaseEntity {
  name: string;
  color?: string;
  /** 支持 #班级/班费 这类层级 */
  parentId?: ID | null;
}

export interface Link extends BaseEntity {
  fromType: 'note' | 'item';
  fromId: ID;
  toType: 'note' | 'item';
  toId: ID;
  /** 链接所在上下文片段，图谱悬停预览用 */
  context?: string;
}

/* ------------------------------------------------------------------ */
/* 来源 / 提醒 / AI / 同步                                             */
/* ------------------------------------------------------------------ */

export type SourceKind =
  | 'text'
  | 'image'
  | 'pdf'
  | 'word'
  | 'markdown'
  | 'url'
  | 'manual';

export interface Source extends BaseEntity {
  kind: SourceKind;
  /** 原文快照（敏感，可加密，可清空） */
  rawText?: string;
  url?: string;
  attachmentId?: ID | null;
  capturedAt: ISO;
  /** 是否已整理出正式条目/笔记 */
  processed: boolean;
}

export interface Reminder extends BaseEntity {
  itemId: ID;
  triggerAt: ISO;
  /** 相对截止时间的提前量（分钟） */
  offsetMinutes: number;
  fired: boolean;
  channel: 'web' | 'system';
}

/**
 * AI 提供商标识（单一来源，adapters/ai 复用）。
 * DeepSeek / Ollama / 自定义都走 OpenAI 兼容协议；rule 是离线规则兜底；none = 关闭。
 */
export type AIProviderId = 'deepseek' | 'ollama' | 'custom' | 'rule' | 'none';

export interface AIParseJob extends BaseEntity {
  sourceId: ID;
  provider: AIProviderId;
  status: 'queued' | 'running' | 'success' | 'failed' | 'retrying';
  retries: number;
  inputKind: SourceKind;
  outputDraftIds: ID[];
  /** 只记错误，不记正文 */
  error?: string;
  startedAt?: ISO;
  finishedAt?: ISO;
}

/** AI 草稿：确认前绝不写入正式表 */
export interface Draft extends BaseEntity {
  jobId: ID;
  target: 'item' | 'note';
  payload: Partial<ScheduleItem> | Partial<Note>;
  /** AI 建议的标签名（确认时才转成 Tag 实体） */
  suggestedTags?: string[];
  pendingConfirm: string[];
  confidence: Record<string, number>;
  state: 'pending' | 'accepted' | 'edited' | 'rejected';
}

export interface SyncLog extends BaseEntity {
  adapter: string;
  startedAt: ISO;
  finishedAt?: ISO;
  pushed: number;
  pulled: number;
  status: 'success' | 'failed' | 'conflict';
  message?: string;
}

export interface Conflict extends BaseEntity {
  entityType: 'item' | 'note' | 'attachment' | 'tag';
  entityId: ID;
  localRev: number;
  remoteRev: number;
  localSnapshot: unknown;
  remoteSnapshot: unknown;
  resolution?: 'local' | 'remote' | 'both' | 'manual';
  resolvedAt?: ISO;
}

/** 离线变更队列：阶段 4 启用，阶段 1 先建表 */
export interface OutboxOp extends BaseEntity {
  seq: number;
  entityType: string;
  entityId: ID;
  op: 'create' | 'update' | 'delete';
  payload: unknown;
  status: 'pending' | 'synced' | 'failed';
}

/* ------------------------------------------------------------------ */
/* 查询与视图                                                          */
/* ------------------------------------------------------------------ */

export interface ItemQuery {
  types?: ItemType[];
  statuses?: ItemStatus[];
  tags?: ID[];
  /** 与 [from, to] 有交集的条目（按 startAt ?? dueAt 判断） */
  from?: ISO;
  to?: ISO;
  /** 仅未完成 */
  openOnly?: boolean;
  keyword?: string;
  priorityMin?: Priority;
  courseId?: ID;
  limit?: number;
}

export type SortKey = 'dueAt' | 'startAt' | 'priority' | 'createdAt' | 'updatedAt';
