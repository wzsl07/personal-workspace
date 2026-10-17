/**
 * 本地加密（WebCrypto，无任何外部库）。
 *
 * 两种模式：
 * 1. 设备密钥（默认）：首次运行生成随机密钥材料存在本地库里。
 *    —— 只能防止"直接翻 IndexedDB / 备份文件看到明文 API Key"，
 *       不能防本机恶意程序。这点不做夸大宣传。
 * 2. 口令模式（可选）：用 PBKDF2 从用户口令派生密钥，口令只存内存，
 *    重启后需重新输入才能真正安全。
 */

import { getMeta, setMeta } from '../repo/db';

const KEY_MATERIAL = 'crypto:device-key-material';
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** 会话内缓存的口令（刷新即失效） */
let sessionPassphrase: string | null = null;
export function setPassphrase(p: string | null): void {
  sessionPassphrase = p && p.length > 0 ? p : null;
}
export function hasPassphrase(): boolean {
  return sessionPassphrase !== null;
}

async function getMaterial(): Promise<string> {
  let m = await getMeta<string>(KEY_MATERIAL, '');
  if (!m) {
    const rnd = crypto.getRandomValues(new Uint8Array(32));
    m = b64(rnd);
    await setMeta(KEY_MATERIAL, m);
  }
  return m;
}

async function deriveKey(salt: Uint8Array): Promise<CryptoKey> {
  const passphrase = sessionPassphrase ?? (await getMaterial());
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: 100_000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encrypt(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(salt);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    enc.encode(plain),
  );
  return `v1.${b64(salt)}.${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

export async function decrypt(payload: string): Promise<string> {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('密文格式不正确');
  const salt = unb64(parts[1]);
  const iv = unb64(parts[2]);
  const ct = unb64(parts[3]);
  const key = await deriveKey(salt);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      ct as unknown as BufferSource,
    );
    return dec.decode(pt);
  } catch {
    throw new Error('解密失败：可能是口令不对，或密文已损坏');
  }
}

/** 便捷：加密后写入 meta，读出时自动解密 */
export async function saveSecret(name: string, value: string): Promise<void> {
  await setMeta(`secret:${name}`, value ? await encrypt(value) : '');
}

export async function loadSecret(name: string): Promise<string> {
  const raw = await getMeta<string>(`secret:${name}`, '');
  if (!raw) return '';
  try {
    return await decrypt(raw);
  } catch {
    // 口令模式下解密失败不应崩溃，交给调用方提示
    throw new Error('API Key 解密失败，若启用了口令请在设置里重新输入');
  }
}
