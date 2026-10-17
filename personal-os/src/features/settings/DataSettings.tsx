/**
 * 数据区：让普通用户知道「我的东西到底存在哪、怎么拿走、怎么恢复」。
 *
 * 这一块是分发版里最重要的设置项 —— 自用版时作者知道自己数据在 AppData 里，
 * 朋友不知道。看不见数据 = 不敢往里放真东西 = 这软件对他没价值。
 */

import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { Segmented } from '../../ui/primitives';
import { useUI } from '../../app/store';
import {
  backupToSyncTarget,
  downloadMessage,
  exportICS,
  exportJSON,
  exportMarkdown,
  importSnapshot,
  lastBackupAt,
  wipeAll,
} from '../../core/io/backup';
import { dataDir, isTauri, openPath } from '../../core/adapters/desktop';

type RestoreMode = 'merge' | 'replace';

export function DataSettings() {
  const toast = useUI((s) => s.toast);
  const bump = useUI((s) => s.bump);
  const fileRef = useRef<HTMLInputElement>(null);

  const [dir, setDir] = useState<string>('');
  const [lastAt, setLastAt] = useState<string>('');
  const [mode, setMode] = useState<RestoreMode>('merge');
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      setDir((await dataDir()) ?? '');
      setLastAt(await lastBackupAt());
    })();
  }, []);

  const days = lastAt
    ? Math.floor((Date.now() - new Date(lastAt).getTime()) / 86_400_000)
    : -1;

  async function onImport(file: File) {
    setBusy(true);
    try {
      const text = await file.text();
      if (mode === 'replace') {
        await wipeAll();
      }
      const r = await importSnapshot(text);
      bump();
      setLastAt(await lastBackupAt());
      toast(
        mode === 'replace'
          ? `已覆盖恢复：${r.items} 条日程、${r.notes} 篇笔记`
          : `已合并恢复：${r.items} 条日程、${r.notes} 篇笔记（重名标签会自动合并）`,
      );
    } catch (e) {
      toast(`导入失败：${e instanceof Error ? e.message : e}`, 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* 数据在哪 */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Icon name="FolderOpen" size={14} />
          <span className="text-xs font-medium">我的数据存在哪</span>
        </div>
        {isTauri() ? (
          <>
            <div className="text-[11px] text-fg-dim break-all font-mono bg-bg-elev rounded p-2">
              {dir || '（读取中…）'}
            </div>
            <button
              className="btn text-xs mt-2"
              disabled={!dir}
              onClick={() => {
                void (async () => {
                  const ok = await openPath(dir);
                  toast(ok ? '已打开数据目录' : '打开失败，请手动复制上面的路径', ok ? 'ok' : 'warn');
                })();
              }}
            >
              <Icon name="ExternalLink" size={13} /> 打开这个文件夹
            </button>
            <p className="text-[11px] text-fg-dim mt-2 leading-5">
              卸载软件<b>不会</b>删掉这个文件夹。想彻底清除，手动删它，或用下面的「清空全部数据」。
            </p>
          </>
        ) : (
          <p className="text-[11px] text-fg-dim leading-5">
            网页版的数据在你<b>当前浏览器的这个用户</b>里（IndexedDB）。
            换浏览器、换浏览器用户、或用隐私窗口打开，看到的是另一份空数据。
            公用电脑建议用独立的浏览器用户，避免别人看到你的内容。
          </p>
        )}
      </div>

      {/* 备份 */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Icon name="Download" size={14} />
          <span className="text-xs font-medium">备份</span>
          {days < 0 ? (
            <span className="text-[10px] px-1.5 rounded-full bg-[#e5484d]/20 text-[#e5484d]">
              从未备份
            </span>
          ) : days > 14 ? (
            <span className="text-[10px] px-1.5 rounded-full bg-[#f0a13c]/20 text-[#f0a13c]">
              {days} 天前
            </span>
          ) : (
            <span className="text-[10px] px-1.5 rounded-full bg-accent/20 text-accent">
              {days === 0 ? '今天已备份' : `${days} 天前`}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="btn text-xs"
            disabled={busy}
            onClick={() => {
              void (async () => {
                const r = await exportJSON();
                // 桌面端会弹「另存为」对话框，保存完明确告诉用户存到哪了 ——
                // 否则点了没反馈，用户会以为软件坏了
                toast(
                  downloadMessage(r, '备份已导出，请查看浏览器的下载'),
                  r.status === 'cancelled' ? 'warn' : 'ok',
                );
                if (r.status !== 'cancelled') setLastAt(await lastBackupAt());
              })();
            }}
          >
            <Icon name="Download" size={13} /> 一键备份（JSON）
          </button>
          <button
            className="btn text-xs"
            onClick={() => {
              void (async () => {
                try {
                  toast(await backupToSyncTarget());
                  setLastAt(await lastBackupAt());
                } catch (e) {
                  toast(e instanceof Error ? e.message : String(e), 'err');
                }
              })();
            }}
          >
            <Icon name="Upload" size={13} /> 备份到同步目标
          </button>
          <button
            className="btn text-xs"
            disabled={busy}
            onClick={() => {
              void (async () => {
                const r = await exportMarkdown();
                toast(
                  downloadMessage(r, 'Markdown 已导出'),
                  r.status === 'cancelled' ? 'warn' : 'ok',
                );
              })();
            }}
          >
            <Icon name="Download" size={13} /> 导出 Markdown
          </button>
          <button
            className="btn text-xs"
            disabled={busy}
            onClick={() => {
              void (async () => {
                const r = await exportICS();
                toast(
                  downloadMessage(r, '日历 ICS 已导出'),
                  r.status === 'cancelled' ? 'warn' : 'ok',
                );
              })();
            }}
          >
            <Icon name="Download" size={13} /> 导出日历 ICS
          </button>
        </div>
        <p className="text-[11px] text-fg-dim mt-2 leading-5">
          JSON 是唯一能完整还原的备份（含标签、附件正文、收集箱）。
          <b>API Key 不会写进备份</b>——换电脑后需要重新填一次，这是刻意的。
        </p>
      </div>

      {/* 恢复 */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Icon name="Upload" size={14} />
          <span className="text-xs font-medium">从备份恢复</span>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <Segmented<RestoreMode>
            value={mode}
            onChange={setMode}
            options={[
              { value: 'merge', label: '合并' },
              { value: 'replace', label: '覆盖' },
            ]}
          />
          <span className="text-[11px] text-fg-dim">
            {mode === 'merge'
              ? '把备份里的内容并进现有数据，同名的标签会自动合并。'
              : '先清空现有数据，再导入备份。换电脑 / 重装时用这个。'}
          </span>
        </div>
        <button
          className="btn text-xs mt-2"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          <Icon name="FileUp" size={13} /> {busy ? '导入中…' : '选择备份文件'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onImport(f);
            e.target.value = '';
          }}
        />
        {mode === 'replace' && (
          <p className="text-[11px] text-[#e5484d] mt-2">
            覆盖模式会先清空现有数据，不可撤销。建议先导出一份当前数据。
          </p>
        )}
      </div>

      {/* 清空 */}
      <div className="pt-2 border-t border-line">
        {!confirmWipe ? (
          <button className="btn text-xs text-[#e5484d]" onClick={() => setConfirmWipe(true)}>
            <Icon name="Trash2" size={13} /> 清空全部本地数据
          </button>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-[#e5484d]">确定清空？此操作不可撤销。</span>
            <button
              className="btn text-xs border-[#e5484d] text-[#e5484d]"
              onClick={() => {
                void (async () => {
                  await wipeAll();
                  setConfirmWipe(false);
                  bump();
                  toast('已清空全部本地数据', 'warn');
                })();
              }}
            >
              确认清空
            </button>
            <button className="btn text-xs" onClick={() => setConfirmWipe(false)}>
              取消
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
