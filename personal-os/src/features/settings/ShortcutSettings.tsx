/**
 * 全局快捷键开关。
 *
 * 分发版默认**关闭**。自用版时它随软件启动就注册 Alt+Space，
 * 但那个键会和中文输入法、截图工具、IDE 抢，对第一次用的人是纯粹的干扰。
 * 改成"想要的人自己开"，并且开了以后能关掉。
 */

import { useEffect, useState } from 'react';
import { useUI } from '../../app/store';
import { getMeta, setMeta } from '../../core/repo/db';
import { isTauri, registerHotkey, unregisterAllHotkeys } from '../../core/adapters/desktop';

const KEY_ENABLED = 'hotkey:enabled';
const KEY_ACC = 'hotkey:accelerator';
export const DEFAULT_ACC = 'Alt+Space';

export function ShortcutSettings() {
  const toast = useUI((s) => s.toast);
  const [enabled, setEnabled] = useState(false);
  const [acc, setAcc] = useState(DEFAULT_ACC);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      setEnabled(await getMeta<boolean>(KEY_ENABLED, false));
      setAcc(await getMeta<string>(KEY_ACC, DEFAULT_ACC));
    })();
  }, []);

  async function apply(next: boolean, accelerator: string) {
    if (!isTauri()) {
      toast('网页版没有全局快捷键（浏览器不允许）', 'warn');
      return;
    }
    setBusy(true);
    try {
      if (next) {
        const ok = await registerHotkey(accelerator);
        if (!ok) {
          toast(`注册失败：${accelerator} 可能已被其它软件占用`, 'err');
          setBusy(false);
          return;
        }
      } else {
        await unregisterAllHotkeys();
      }
      await setMeta(KEY_ENABLED, next);
      await setMeta(KEY_ACC, accelerator);
      setEnabled(next);
      toast(next ? `已开启：${accelerator} 唤出快速收录` : '已关闭全局快捷键');
    } finally {
      setBusy(false);
    }
  }

  if (!isTauri()) {
    return (
      <p className="text-[11px] text-fg-dim leading-5">
        全局快捷键只有桌面版有。网页版可以用应用内快捷键：
        <b> Ctrl/⌘+K</b> 搜索、<b>Alt+N</b> 新建。
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(e) => void apply(e.target.checked, acc)}
        />
        <span className="text-xs">开启全局快捷键（任何界面都能唤出快速收录）</span>
      </label>
      {enabled && (
        <div className="flex items-center gap-2 flex-wrap">
          <input
            className="field text-xs w-40"
            value={acc}
            disabled={busy}
            onChange={(e) => setAcc(e.target.value)}
            placeholder={DEFAULT_ACC}
          />
          <button className="btn text-xs" disabled={busy} onClick={() => void apply(true, acc)}>
            应用
          </button>
          <span className="text-[11px] text-fg-dim">
            写法如 <code>Alt+Space</code>、<code>CmdOrCtrl+Shift+K</code>
          </span>
        </div>
      )}
      <p className="text-[11px] text-fg-dim leading-5">
        默认关闭是有意的：这个键会和中文输入法、截图工具抢。
        注册失败说明被别的软件占了，换一个组合就行。
      </p>
    </div>
  );
}
