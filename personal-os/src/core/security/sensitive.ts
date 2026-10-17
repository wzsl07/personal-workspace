import { decrypt, encrypt } from '../adapters/crypto';
import { getMeta, setMeta } from '../repo/db';

/**
 * 敏感正文加密（可选）。
 *
 * 作用范围：收集箱原文（Source.rawText）与附件抽取出的文字（Attachment.extractedText）。
 *
 * 代价必须说清楚：加密后的内容**无法参与全文索引和语义索引**，
 * 也就是说开了这个开关，这些正文就搜不到了。默认关闭。
 *
 * 另外：这解决不了"本机有人直接翻 IndexedDB 文件"的问题——
 * 设备密钥本身也在本地。它防的是"备份文件被拷走后正文泄露"。
 * 真正有效的整库静态加密需要 Tauri 桌面壳（用加密数据库/文件权限），阶段 6 桌面版再做。
 */

const KEY = 'security:encryptText';
const PREFIX = 'enc:v1.';

let cached: boolean | null = null;

export async function encryptTextEnabled(): Promise<boolean> {
  if (cached === null) cached = await getMeta<boolean>(KEY, false);
  return cached;
}

export async function setEncryptTextEnabled(v: boolean): Promise<void> {
  cached = v;
  await setMeta(KEY, v);
}

/** 存库前包裹 */
export async function wrapText(text: string): Promise<string> {
  if (!text) return text;
  if (!(await encryptTextEnabled())) return text;
  return PREFIX + (await encrypt(text));
}

/** 读取时解包（已是明文则原样返回） */
export async function unwrapText(text: string | undefined): Promise<string> {
  if (!text) return '';
  if (!text.startsWith(PREFIX)) return text;
  try {
    return await decrypt(text.slice(PREFIX.length));
  } catch {
    return '（解密失败：可能启用了口令加密但口令不对）';
  }
}

export function isEncrypted(text: string | undefined): boolean {
  return Boolean(text && text.startsWith(PREFIX));
}

/** 判断某段正文能否进索引（加密内容不进） */
export function indexable(text: string | undefined): boolean {
  return Boolean(text) && !isEncrypted(text);
}
