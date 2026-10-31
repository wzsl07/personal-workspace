/**
 * 信息流（聚合服务）的本地镜像客户端。
 *
 * 为什么要有这一层：信息流的本体在聚合服务的 SQLite 里，前端每次现拉。
 * 但搜索必须能"离线也能搜"——服务没启动、或者你在别的地方打开了应用，
 * 至少应该能搜到上一次的快照。所以这里拉到的数据会写进 IndexedDB，
 * 搜索只认这份快照，并如实告诉用户"这是什么时候的快照"。
 *
 * 另一个现实约束：服务只监听 127.0.0.1，**只有桌面版访问得到**。
 * 网页版/手机版拉不到，所以那里的信息流搜索应当直接说明不可用，
 * 而不是让人等半天再报错。
 */

import { db } from '../repo/db';
import { getMeta, setMeta } from '../repo/db';
import { isTauri } from '../adapters/desktop';

const BASE_KEY = 'aggregator.base';
export const DEFAULT_BASE = 'http://127.0.0.1:8787';

/** 进搜索页自动拉取时的超时：服务没起就快点失败，别卡住界面 */
const QUICK_TIMEOUT = 1500;

export interface FeedDoc {
  /** 搜索索引里的 id，形如 `feed:123` */
  id: string;
  refId: string;
  sourceId: number;
  sourceName: string;
  section: string;
  title: string;
  url: string;
  summary: string;
  content: string;
  publishedAt: string | null;
}

export function aggBase(): string {
  try {
    return localStorage.getItem(BASE_KEY) || DEFAULT_BASE;
  } catch {
    return DEFAULT_BASE;
  }
}

/** 网页版 / 手机版访问不到本机的服务 —— 这种情况信息流搜索直接不可用 */
export function feedAvailable(): boolean {
  return isTauri();
}

interface AggItem {
  id: number;
  source_id: number;
  source_name: string;
  section: string;
  title: string;
  url: string;
  summary: string;
  content?: string;
  has_content?: boolean;
  published_at: string | null;
  discovered_at: string;
}

async function getJSON(url: string, timeout: number): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`接口返回 ${res.status}`);
    const ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('json')) throw new Error('返回的不是 JSON（地址可能填错了）');
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

export interface FeedPullResult {
  docs: FeedDoc[];
  /** true = 这次真的从服务拿到了数据；false = 用的是本地旧快照 */
  fresh: boolean;
  at: string;
  error?: string;
}

/**
 * 拉一次信息流并写进本地镜像。
 *
 * 拉不到时不抛异常：返回 fresh=false + 本地快照，让调用方自己决定怎么提示。
 * 这是刻意的设计 —— 服务没启动是常态之一（不是错误），不该用红色报错吓人。
 */
export async function pullFeed(opts?: {
  limit?: number;
  contentLimit?: number;
  timeout?: number;
}): Promise<FeedPullResult> {
  const limit = opts?.limit ?? 500;
  const climit = opts?.contentLimit ?? 1500;
  const timeout = opts?.timeout ?? QUICK_TIMEOUT;
  const url = `${aggBase().replace(/\/$/, '')}/api/items?limit=${limit}&with_content=1&content_limit=${climit}`;
  try {
    const data = (await getJSON(url, timeout)) as AggItem[];
    const now = new Date().toISOString();
    const docs: FeedDoc[] = (data ?? []).map((r) => ({
      id: `feed:${r.id}`,
      refId: String(r.id),
      sourceId: r.source_id,
      sourceName: r.source_name ?? '',
      section: r.section ?? '',
      title: r.title ?? '',
      url: r.url ?? '',
      summary: r.summary ?? '',
      content: r.content ?? '',
      publishedAt: r.published_at ?? null,
    }));
    await saveFeed(docs, now);
    return { docs, fresh: true, at: now };
  } catch (e) {
    const cached = await loadFeed();
    return {
      docs: cached.docs,
      fresh: false,
      at: cached.at,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 读取本地快照 */
export async function loadFeed(): Promise<{ docs: FeedDoc[]; at: string }> {
  try {
    const rows = await db.feedItems.toArray();
    const at = (await getMeta<string>('feed:cachedAt', '')) ?? '';
    return {
      docs: rows.map((r) => ({
        id: r.id,
        refId: r.refId,
        sourceId: r.sourceId,
        sourceName: r.sourceName,
        section: r.section,
        title: r.title,
        url: r.url,
        summary: r.summary,
        content: r.content,
        publishedAt: r.publishedAt,
      })),
      at,
    };
  } catch {
    return { docs: [], at: '' };
  }
}

async function saveFeed(docs: FeedDoc[], at: string): Promise<void> {
  const rows = docs.map((d) => ({
    ...d,
    cachedAt: at,
  }));
  await db.transaction('rw', db.feedItems, async () => {
    await db.feedItems.clear();
    await db.feedItems.bulkPut(rows);
  });
  await setMeta('feed:cachedAt', at);
}

/** 服务是否在跑（界面上给个状态灯 / 决定是否显示"刷新"按钮） */
export async function feedOnline(timeout = QUICK_TIMEOUT): Promise<boolean> {
  try {
    await getJSON(`${aggBase().replace(/\/$/, '')}/api/content/status`, timeout);
    return true;
  } catch {
    return false;
  }
}
