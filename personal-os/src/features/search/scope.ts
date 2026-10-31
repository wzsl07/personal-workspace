/**
 * 搜索范围：三个 tab（全文 / 语义 / 问答）共用这一套选择。
 *
 * 默认只勾「日程 + 笔记」，信息流要手动勾 —— 这是刻意的：
 * 问答里问"还有什么没做"，如果信息流默认参与，就会冒出一条校园新闻。
 * 想搜信息流时自己勾上，意图明确，答案也干净。
 */

import type { SearchKind } from '../../core/search/searchIndex';

export type Scope = SearchKind;

export const SCOPE_LABEL: Record<Scope, string> = {
  item: '日程',
  note: '笔记',
  attachment: '附件',
  feed: '信息流',
};

export const DEFAULT_SCOPES: Scope[] = ['item', 'note'];

const KEY = 'search.scopes';

export function loadScopes(): Scope[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [...DEFAULT_SCOPES];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [...DEFAULT_SCOPES];
    const out = arr.filter((x): x is Scope =>
      x === 'item' || x === 'note' || x === 'attachment' || x === 'feed',
    );
    return out.length ? out : [...DEFAULT_SCOPES];
  } catch {
    return [...DEFAULT_SCOPES];
  }
}

export function saveScopes(s: Scope[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 隐私模式下写不了，忽略即可 */
  }
}

const CONTENT_KEY = 'ask.feedContent';

/**
 * 问答时信息流的**正文**是否参与检索。
 * 默认开（本地检索不出网）；关掉后索引里只留标题+摘要。
 *
 * 这个开关同时被搜索页（建索引时决定要不要把正文喂进去）
 * 和问答面板（决定提示语）使用，所以放在这里共享，避免两边读不同的键。
 */
export function loadFeedContentFlag(): boolean {
  try {
    return localStorage.getItem(CONTENT_KEY) !== '0';
  } catch {
    return true;
  }
}

export function saveFeedContentFlag(v: boolean): void {
  try {
    localStorage.setItem(CONTENT_KEY, v ? '1' : '0');
  } catch {
    /* 忽略 */
  }
}
