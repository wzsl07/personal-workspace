import { useEffect, useState } from 'react';
import { lastSyncInfo, runSync, unresolvedConflicts } from '../../core/sync/engine';
import { loadSyncConfig } from '../../core/adapters/sync';
import { useUI } from '../../app/store';
import { Icon } from '../../ui/Icon';

const STYLE: Record<string, { color: string; label: string }> = {
  success: { color: '#3fb984', label: '已同步' },
  syncing: { color: '#5b8cff', label: '同步中' },
  conflict: { color: '#f0a13c', label: '有冲突' },
  failed: { color: '#e5484d', label: '同步失败' },
  never: { color: '#6b7590', label: '未同步' },
  off: { color: '#6b7590', label: '同步已关闭' },
};

/** 顶栏状态灯：点一下立即同步 */
export function SyncIndicator() {
  const revision = useUI((s) => s.revision);
  const toast = useUI((s) => s.toast);
  const bump = useUI((s) => s.bump);
  const setView = useUI((s) => s.setView);
  const [state, setState] = useState<string>('never');
  const [conflicts, setConflicts] = useState(0);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    void (async () => {
      const cfg = await loadSyncConfig();
      if (cfg.adapter === 'none') {
        setState('off');
        return;
      }
      const info = await lastSyncInfo();
      setState(info.status);
      setConflicts((await unresolvedConflicts()).length);
    })();
  }, [revision]);

  // 自动同步：页面打开时按间隔轮询（浏览器没有后台能力，关掉页面就不会跑）
  useEffect(() => {
    let timer: number | undefined;
    void loadSyncConfig().then((cfg) => {
      if (cfg.adapter === 'none' || cfg.autoMinutes <= 0) return;
      timer = window.setInterval(
        () => {
          void (async () => {
            setRunning(true);
            try {
              const r = await runSync();
              setState(r.status === 'success' ? 'success' : r.status);
              setConflicts(r.conflicts);
              bump();
            } finally {
              setRunning(false);
            }
          })();
        },
        cfg.autoMinutes * 60 * 1000,
      );
    });
    return () => {
      if (timer) window.clearInterval(timer);
    };
  }, [bump]);

  async function syncNow() {
    const cfg = await loadSyncConfig();
    if (cfg.adapter === 'none') {
      setView('settings');
      return;
    }
    setRunning(true);
    setState('syncing');
    try {
      const r = await runSync();
      setState(r.status === 'success' ? 'success' : r.status);
      setConflicts(r.conflicts);
      toast(r.message, r.status === 'success' ? 'ok' : 'warn');
      bump();
    } catch (e) {
      setState('failed');
      toast(`同步失败：${e instanceof Error ? e.message : e}`, 'err');
    } finally {
      setRunning(false);
    }
  }

  const s = STYLE[running ? 'syncing' : state] ?? STYLE.never;

  return (
    <button
      className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-bg-hover text-xs"
      onClick={() => void syncNow()}
      title="点击立即同步"
    >
      <span
        className="w-2 h-2 rounded-full"
        style={{ background: s.color, boxShadow: `0 0 6px ${s.color}66` }}
      />
      <span style={{ color: s.color }}>{s.label}</span>
      {conflicts > 0 && (
        <span className="text-[10px] px-1 rounded bg-[#f0a13c]/20 text-[#f0a13c]">{conflicts}</span>
      )}
      <Icon name="Settings" size={11} />
    </button>
  );
}
