import MiniSearch from 'minisearch';
import { ITEM_TYPES } from '../domain/item';
import { indexable } from '../security/sensitive';
import type { Attachment, ID, Note, ScheduleItem } from '../domain/types';

/**
 * 全文索引（MiniSearch，纯 JS，无 wasm、无外链）。
 * 中文处理：不做词典分词，改用 CJK 二字组合（2-gram）+ 英文单词。
 * 数据量在几千条以内时，全量重建耗时可忽略。
 */

export type SearchKind = 'item' | 'note' | 'attachment' | 'feed';

export interface SearchDoc {
  id: string;
  kind: SearchKind;
  refId: ID;
  title: string;
  body: string;
  typeLabel: string;
}

/** 喂给索引的信息流条目（只取用得到的字段，避免搜索层依赖聚合客户端的类型） */
export interface FeedIndexInput {
  id: string;          // feed:<id>
  refId: string;
  title: string;
  summary: string;
  content: string;
  sourceName: string;
  section: string;
}

function tokenize(text: string): string[] {
  const out: string[] = [];
  const en = text.toLowerCase().match(/[a-z0-9_]+/g);
  if (en) out.push(...en);
  const cjkRuns = text.replace(/[^\u4e00-\u9fa5]/g, ' ').split(/\s+/).filter(Boolean);
  for (const run of cjkRuns) {
    if (run.length === 1) {
      out.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) out.push(run.slice(i, i + 2));
  }
  return out;
}

let index: MiniSearch<SearchDoc> | null = null;

export function buildIndex(
  items: ScheduleItem[],
  notes: Note[],
  attachments: Attachment[] = [],
  feed: FeedIndexInput[] = [],
): void {
  const docs: SearchDoc[] = [
    ...items
      .filter((i) => !i.deletedAt)
      .map((i) => ({
        id: `item:${i.id}`,
        kind: 'item' as const,
        refId: i.id,
        title: i.title,
        body: [i.remark ?? '', i.location ?? '', ITEM_TYPES[i.type].label].join(' '),
        typeLabel: ITEM_TYPES[i.type].label,
      })),
    ...notes
      .filter((n) => !n.deletedAt)
      .map((n) => ({
        id: `note:${n.id}`,
        kind: 'note' as const,
        refId: n.id,
        title: n.title,
        body: n.content,
        typeLabel: '笔记',
      })),
    ...attachments
      .filter((a) => !a.deletedAt && indexable(a.extractedText))
      .map((a) => ({
        id: `att:${a.id}`,
        kind: 'attachment' as const,
        refId: a.id,
        title: a.name,
        body: a.extractedText ?? '',
        typeLabel: '附件',
      })),
    // 信息流：标题 + 摘要 + 正文都进索引（正文入库后，这才是能搜到东西的关键）。
    // typeLabel 用来源名，界面上一眼能看出这条来自哪个站。
    ...feed.map((f) => ({
      id: f.id,
      kind: 'feed' as const,
      refId: f.refId,
      title: f.title,
      body: [f.summary ?? '', f.content ?? ''].filter(Boolean).join('\n'),
      typeLabel: f.sourceName || f.section || '信息流',
    })),
  ];

  index = new MiniSearch<SearchDoc>({
    fields: ['title', 'body'],
    storeFields: ['kind', 'refId', 'title', 'typeLabel', 'body'],
    tokenize,
    processTerm: (term) => tokenize(term),
    searchOptions: {
      boost: { title: 3 },
      prefix: true,
      fuzzy: 0.2,
      combineWith: 'AND',
    },
  });
  index.addAll(docs);
}

export interface SearchHit {
  kind: SearchKind;
  refId: ID;
  title: string;
  typeLabel: string;
  snippet: string;
  score: number;
}

/**
 * 检索。
 *
 * kinds 在**检索阶段**就过滤，不能先取 Top N 再筛 ——
 * 那样一旦前面的结果都被筛掉，返回条数会莫名其妙变少，
 * 而且分数阈值（"相关的才给"）也会被破坏。
 */
export function search(q: string, limit = 40, kinds?: SearchKind[]): SearchHit[] {
  if (!index || !q.trim()) return [];
  const filter =
    kinds && kinds.length ? (r: unknown) => kinds.includes((r as SearchDoc).kind) : undefined;
  const raw = index.search(q, { prefix: true, fuzzy: 0.2, filter });

  /**
   * 全中（AND）太少时放宽成"任一命中"（OR）。
   *
   * 为什么需要：中文按 2-gram 切词后，一句长问句（"学校关于选课的通知说了什么"）
   * 会切出十几个词，AND 要求全中，一个词不在就整条落空 —— 表现为"明明有却搜不到"。
   * 放宽后按分数过滤噪声：只保留不低于最高分 25% 的结果，避免"沾边就算"。
   */
  let list = raw;
  if (raw.length < 3) {
    const loose = index.search(q, { prefix: true, fuzzy: 0.2, filter, combineWith: 'OR' });
    if (loose.length) {
      const top = loose[0].score || 1;
      const seen = new Set(raw.map((r) => r.id));
      const extra = loose.filter((r) => !seen.has(r.id) && r.score >= top * 0.25);
      list = [...raw, ...extra];
    }
  }

  return list.slice(0, limit).map((r) => {
    const body = String((r as unknown as { body: string }).body ?? '');
    const pos = body.toLowerCase().indexOf(q.slice(0, 2).toLowerCase());
    const snippet = pos >= 0 ? body.slice(Math.max(0, pos - 30), pos + 90) : body.slice(0, 90);
    return {
      kind: r.kind as SearchKind,
      refId: r.refId as ID,
      title: r.title as string,
      typeLabel: r.typeLabel as string,
      snippet,
      score: r.score,
    };
  });
}

export function invalidate(): void {
  index = null;
}
