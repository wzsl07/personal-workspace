import MiniSearch from 'minisearch';
import { ITEM_TYPES } from '../domain/item';
import { indexable } from '../security/sensitive';
import type { Attachment, ID, Note, ScheduleItem } from '../domain/types';

/**
 * 全文索引（MiniSearch，纯 JS，无 wasm、无外链）。
 * 中文处理：不做词典分词，改用 CJK 二字组合（2-gram）+ 英文单词。
 * 数据量在几千条以内时，全量重建耗时可忽略。
 */

export interface SearchDoc {
  id: string;
  kind: 'item' | 'note' | 'attachment';
  refId: ID;
  title: string;
  body: string;
  typeLabel: string;
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
  kind: 'item' | 'note' | 'attachment';
  refId: ID;
  title: string;
  typeLabel: string;
  snippet: string;
  score: number;
}

export function search(q: string, limit = 40): SearchHit[] {
  if (!index || !q.trim()) return [];
  const raw = index.search(q, { prefix: true, fuzzy: 0.2 });
  return raw.slice(0, limit).map((r) => {
    const body = String((r as unknown as { body: string }).body ?? '');
    const pos = body.toLowerCase().indexOf(q.slice(0, 2).toLowerCase());
    const snippet = pos >= 0 ? body.slice(Math.max(0, pos - 30), pos + 90) : body.slice(0, 90);
    return {
      kind: r.kind as 'item' | 'note' | 'attachment',
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
