/**
 * 桌面能力适配层：有 Tauri 就用原生能力，没有就优雅降级到 Web 实现。
 *
 * 判断方式不依赖任何 import：Tauri 会在 window 上注入 __TAURI_INTERNALS__。
 * 因此在纯浏览器里这段代码零副作用、零额外下载。
 */

type TauriInternals = {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  transformCallback?: (cb: unknown) => number;
};

function tauri(): TauriInternals | null {
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriInternals };
  return w.__TAURI_INTERNALS__ ?? null;
}

export function isTauri(): boolean {
  return tauri() !== null;
}

/** 桌面环境信息（用于设置页展示） */
export async function desktopInfo(): Promise<string> {
  if (!isTauri()) return '当前运行在浏览器中（未启用桌面壳）';
  try {
    const info = await invoke<{ arch?: string; os?: string }>('desktop_info');
    return `Tauri 桌面壳 · ${info.os ?? 'unknown'} ${info.arch ?? ''}`.trim();
  } catch {
    return 'Tauri 桌面壳（信息获取失败）';
  }
}

export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const t = tauri();
  if (!t?.invoke) throw new Error('当前不是 Tauri 环境');
  return (await t.invoke(cmd, args)) as T;
}

/* ------------------------------------------------------------------ */
/* 通知                                                                */
/* ------------------------------------------------------------------ */

export type NotifyPermission = 'granted' | 'denied' | 'default' | 'unsupported';

export function notifyPermission(): NotifyPermission {
  if (isTauri()) return 'granted'; // Tauri 用原生通知，不需要浏览器授权
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission as NotifyPermission;
}

export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (isTauri()) return 'granted';
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission as NotifyPermission;
  return (await Notification.requestPermission()) as NotifyPermission;
}

/** 发一条通知：桌面壳走原生，浏览器走 Notification API */
export async function notify(title: string, body: string): Promise<boolean> {
  if (isTauri()) {
    try {
      await invoke('desktop_notify', { title, body });
      return true;
    } catch {
      return false;
    }
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  try {
    new Notification(title, { body, icon: './icon.svg' });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 窗口（全局浮球用）                                                   */
/* ------------------------------------------------------------------ */

/** 打开独立的置顶小窗（真正的系统级浮球） */
export async function openQuickWindow(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await invoke('open_quick_window');
    return true;
  } catch {
    return false;
  }
}

/** 关闭（隐藏）置顶小窗。小窗无边框，必须靠这个或快捷键退出 */
export async function hideQuickWindow(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await invoke('hide_quick_window_cmd');
    return true;
  } catch {
    return false;
  }
}

/** 把小窗的动作交回主窗口 */
export async function showMainWindow(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await invoke('show_main_window_cmd');
    return true;
  } catch {
    return false;
  }
}

/** 注册全局热键（桌面端才有效） */
export async function registerHotkey(accelerator: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await invoke('register_hotkey', { accelerator });
    return true;
  } catch {
    return false;
  }
}

/** 注销全部全局热键（用户关掉开关时调用） */
export async function unregisterAllHotkeys(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await invoke('unregister_all_hotkeys');
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 分发版：让用户看得见自己的数据、报得出自己的版本                        */
/* ------------------------------------------------------------------ */

/** 本机数据目录绝对路径（桌面端）；浏览器环境返回 null */
export async function dataDir(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string>('data_dir');
  } catch {
    return null;
  }
}

/** 用系统文件管理器打开某个目录。返回 false 表示当前环境做不到（浏览器里做不到） */
export async function openPath(path: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await invoke('open_path', { path });
    return true;
  } catch {
    return false;
  }
}

/** 桌面壳里固化的版本号（来自 tauri.conf.json） */
export async function shellVersion(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string>('app_version');
  } catch {
    return null;
  }
}

/**
 * 桌面端保存文件：弹系统「另存为」对话框。
 *
 * 返回值语义：
 *   string  → 已保存到这个路径
 *   null    → 用户取消了（**不是错误**，不要报错）
 *   false   → 不是桌面环境，或调用失败（调用方应回退到浏览器下载）
 *
 * 为什么桌面端不能走 Blob 下载：
 *   WebView2 的下载事件需要宿主接管，Tauri 默认不管，
 *   于是 `Blob + <a download>` 在桌面壳里点了毫无反应。
 */
export async function saveTextFile(
  defaultName: string,
  content: string,
): Promise<string | null | false> {
  if (!isTauri()) return false;
  try {
    return await invoke<string | null>('save_text_file', { defaultName, content });
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 文件系统（真目录）                                                   */
/* ------------------------------------------------------------------ */

/** 桌面端：把附件写到真实目录；Web 端返回 null（走 OPFS） */
export async function pickDataDir(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string | null>('pick_data_dir');
  } catch {
    return null;
  }
}

export async function writeFileAbs(path: string, content: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await invoke('write_text_file', { path, content });
    return true;
  } catch {
    return false;
  }
}
