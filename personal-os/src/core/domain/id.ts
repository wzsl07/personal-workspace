import type { ID, ISO } from './types';

/** 优先用浏览器原生 crypto.randomUUID，退化为时间戳+随机串 */
export function newId(): ID {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function nowISO(): ISO {
  return new Date().toISOString();
}

let seq = 0;
/** 单调递增序号，用于 outbox 排序（同一毫秒内也保持先后） */
export function nextSeq(): number {
  seq += 1;
  return Date.now() * 1000 + (seq % 1000);
}
