import { useEffect, useState } from 'react';
import { dedupe, findDuplicateItems, findDuplicateNotes } from '../../core/repo/cleanup';
import { useUI } from '../../app/store';

/**
 * 重复数据清理。
 * 同步后两台设备的示例数据会叠在一起，用这个一键去掉多余的
 * （保留最早创建的那条，其余软删除 —— 软删除会同步到另一台，所以只在一台清理即可）。
 */
export function DupeCleaner() {
  const revision = useUI((s) => s.revision);
  const toast = useUI((s) => s.toast);
  const bump = useUI((s) => s.bump);
  const [counts, setCounts] = useState<{ items: number; notes: number } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const [gi, gn] = await Promise.all([findDuplicateItems(), findDuplicateNotes()]);
      setCounts({
        items: gi.reduce((s, g) => s + g.drop.length, 0),
        notes: gn.reduce((s, g) => s + g.drop.length, 0),
      });
    })();
  }, [revision]);

  if (!counts || counts.items + counts.notes === 0) {
    return (
      <div className="text-[11px] text-fg-dim">
        没有发现重复内容（重复的判定：类型、标题、时间、正文都一样的日程；路径相同的笔记）
      </div>
    );
  }

  return (
    <div className="border border-[#f0a13c]/40 rounded-md p-2.5">
      <div className="text-xs text-fg-muted mb-1.5">
        发现 {counts.items} 条重复日程、{counts.notes} 篇重复笔记
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          className="btn text-xs"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await dedupe();
              toast(`已清理 ${r.items} 条日程、${r.notes} 篇笔记（保留最早的一条）`);
              bump();
              // 清理完再同步一次，另一台设备也会跟着清掉
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? '清理中…' : '清理重复（保留最早的一条）'}
        </button>
        <span className="text-[10px] text-fg-dim">
          清理后点一次「立即同步」，另一台设备也会跟着清掉
        </span>
      </div>
    </div>
  );
}
