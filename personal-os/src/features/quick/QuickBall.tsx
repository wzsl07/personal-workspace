import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import * as sourceRepo from '../../core/repo/sourceRepo';
import * as attachmentRepo from '../../core/repo/attachmentRepo';
import * as draftRepo from '../../core/repo/draftRepo';
import * as itemRepo from '../../core/repo/itemRepo';
import { anchorTime } from '../../core/domain/item';
import { monthGrid, monthRange } from '../../core/domain/time';
import { getMeta, setMeta } from '../../core/repo/db';
import {
  hideQuickWindow,
  isTauri,
  openQuickWindow,
  registerHotkey,
  showMainWindow,
} from '../../core/adapters/desktop';
import { useUI } from '../../app/store';
import { Icon } from '../../ui/Icon';

const WEEK_HEAD = ['一', '二', '三', '四', '五', '六', '日'];
const TOP_KEY = 'quickball:top';
const HIDDEN_KEY = 'quickball:hidden';

/**
 * 应用内悬浮球。
 * 说明：浏览器不允许页面渲染到窗口之外，所以这是"应用内"浮球——
 * 切到工作台就一直在右侧。真正的系统级全局浮球要等阶段 6 的 Tauri 桌面壳，
 * 到时候复用这里的面板即可。
 */
export function QuickBall() {
  const bump = useUI((s) => s.bump);
  const toast = useUI((s) => s.toast);
  const setView = useUI((s) => s.setView);
  const openNew = useUI((s) => s.openNew);
  const quickOpen = useUI((s) => s.quickOpen);
  const setQuickOpen = useUI((s) => s.setQuickOpen);
  const toggleQuick = useUI((s) => s.toggleQuick);
  const focusCalendar = useUI((s) => s.focusCalendar);

  const [top, setTop] = useState<number | null>(null);
  const [hidden, setHiddenState] = useState(false);
  const [text, setText] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState('');
  const [monthOffset, setMonthOffset] = useState(0);
  const [desktop, setDesktop] = useState(false);
  const [hotkey, setHotkey] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const ballRef = useRef<HTMLButtonElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  /** 桌面壳的小窗模式：URL 带 ?quick=1 时自动展开并铺满窗口 */
  const quickWindow =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('quick') === '1';

  useEffect(() => {
    void getMeta<number>(TOP_KEY, -1).then((v) =>
      setTop(v < 0 ? Math.round(window.innerHeight * 0.42) : v),
    );
    void getMeta<boolean>(HIDDEN_KEY, false).then(setHiddenState);
    if (quickWindow) setQuickOpen(true);
    setDesktop(isTauri());
    void registerHotkey('Alt+Space').then((ok) => setHotkey(ok));
  }, [quickWindow]);

  // Alt+Q 唤出 / 收起；Esc 关闭（独立小窗里 Esc 直接关窗）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key.toLowerCase() === 'q') {
        e.preventDefault();
        toggleQuick();
      }
      if (e.key === 'Escape') {
        if (quickWindow) void hideQuickWindow();
        else if (useUI.getState().quickOpen) setQuickOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleQuick, setQuickOpen, quickWindow]);

  // 展开时自动聚焦输入框
  useEffect(() => {
    if (quickOpen) setTimeout(() => areaRef.current?.focus(), 30);
  }, [quickOpen]);

  /** 拖拽：只允许上下移动，吸附右侧 */
  function startDrag(e: React.PointerEvent) {
    const ball = ballRef.current;
    if (!ball) return;
    const rect = ball.getBoundingClientRect();
    const offsetY = e.clientY - rect.top;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      moved = true;
      const next = Math.min(
        Math.max(56, ev.clientY - offsetY),
        window.innerHeight - 72,
      );
      setTop(next);
    };
    const onUp = async () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (moved) await setMeta(TOP_KEY, top ?? 0);
      else toggleQuick();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  async function capture() {
    const t = text.trim();
    if (!t) return;
    await sourceRepo.createSource({ kind: sourceRepo.guessKind(t), rawText: t });
    setText('');
    bump();
    toast('已收入收集箱');
  }

  async function captureAndParse() {
    const t = text.trim();
    if (!t) return;
    const s = await sourceRepo.createSource({ kind: sourceRepo.guessKind(t), rawText: t });
    setText('');
    setBusy('解析中…');
    try {
      const out = await draftRepo.parseSource(s);
      bump();
      toast(`生成 ${out.drafts.length} 条草稿`);
      setView('drafts');
      setQuickOpen(false);
    } catch (e) {
      toast(`解析失败：${e instanceof Error ? e.message : e}`, 'err');
    } finally {
      setBusy('');
    }
  }

  async function ingest(files: FileList) {
    for (const f of Array.from(files)) {
      setBusy(`处理 ${f.name}…`);
      const { attachment } = await attachmentRepo.addAttachment(f, f.name, {
        onProgress: (m) => setBusy(`${f.name}：${m}`),
      });
      await sourceRepo.createSource({
        kind: attachment.mime.startsWith('image/') ? 'image' : 'pdf',
        rawText: attachment.extractedText ?? '',
        attachmentId: attachment.id,
      });
    }
    setBusy('');
    bump();
    toast('已收录');
  }

  async function toggleHidden() {
    const next = !hidden;
    setHiddenState(next);
    await setMeta(HIDDEN_KEY, next);
  }

  if (hidden) {
    return (
      <button
        className="fixed right-2 z-40 w-6 h-6 rounded-full bg-bg-panel border border-line text-fg-dim hover:text-fg text-xs"
        style={{ top: top ?? 300 }}
        onClick={() => void toggleHidden()}
        title="显示悬浮球"
      >
        ·
      </button>
    );
  }

  return (
    <div
      // 独立小窗里用流式布局撑满窗口；浏览器里才是固定定位的浮球
      className={
        quickWindow ? 'h-full w-full flex flex-col' : 'fixed right-3 z-40 flex items-start gap-2'
      }
      style={quickWindow ? undefined : { top: top ?? 300 }}
    >
      {/* 展开面板 */}
      {quickOpen && (
        <div
          className={`${quickWindow ? 'flex-1 min-h-0 w-full' : 'w-[300px] max-w-[86vw]'} card overflow-hidden flex flex-col`}
          style={quickWindow ? undefined : { maxHeight: '72vh' }}
        >
          {/* 无边框小窗：标题栏就是拖动把手（Tauri 内置 data-tauri-drag-region，
              会自动跳过按钮和输入框，所以 × 不会误触拖动） */}
          <div
            className={`flex items-center justify-between px-3 h-9 border-b border-line shrink-0 ${
              quickWindow ? 'cursor-move select-none' : ''
            }`}
            data-tauri-drag-region={quickWindow ? 'deep' : undefined}
          >
            <span className="text-xs font-medium flex items-center gap-1.5">
              {quickWindow && <Icon name="Move" size={11} />}
              快速收录
            </span>
            <div className="flex items-center gap-1">
              <button
                className="btn btn-ghost px-1"
                onClick={() => {
                  if (quickWindow) void hideQuickWindow();
                  else void toggleHidden();
                }}
                title={quickWindow ? '关闭（Esc）' : '隐藏悬浮球（设置里可恢复）'}
              >
                <Icon name="X" size={13} />
              </button>
            </div>
          </div>

          <div className="p-2.5 overflow-y-auto">
            <textarea
              ref={areaRef}
              className="field min-h-[64px] resize-none text-xs"
              placeholder="想到什么写下来…（Ctrl+Enter 收录）"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void capture();
              }}
            />
            <div className="flex gap-1.5 mt-2">
              <button className="btn btn-primary text-xs flex-1" onClick={() => void capture()} disabled={!text.trim()}>
                收录
              </button>
              <button className="btn text-xs flex-1" onClick={() => void captureAndParse()} disabled={!text.trim()}>
                AI 解析
              </button>
              <button className="btn text-xs px-2" onClick={() => fileRef.current?.click()} title="添加文件">
                <Icon name="Upload" size={13} />
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept="image/*,.pdf,.doc,.docx,.md,.txt"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) void ingest(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>

            <div
              className={`mt-2 border border-dashed rounded-md p-1.5 text-center text-[11px] ${
                dragOver ? 'border-accent text-accent' : 'border-line text-fg-dim'
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                if (e.dataTransfer.files?.length) void ingest(e.dataTransfer.files);
              }}
            >
              把文件拖到这里
            </div>

            {busy && <div className="mt-2 text-[11px] text-fg-muted">{busy}</div>}

            <div className="flex gap-1.5 mt-2">
              <button
                className="btn text-xs flex-1 whitespace-nowrap"
                onClick={() => {
                  if (quickWindow) {
                    void showMainWindow();
                    void hideQuickWindow();
                  }
                  openNew();
                }}
              >
                <Icon name="Plus" size={12} /> 新建日程
              </button>
              <button
                className="btn text-xs flex-1 whitespace-nowrap"
                onClick={() => {
                  setView('inbox');
                  if (quickWindow) {
                    void showMainWindow();
                    void hideQuickWindow();
                  } else {
                    setQuickOpen(false);
                  }
                }}
              >
                打开收集箱
              </button>
            </div>

            <MiniMonth
              offset={monthOffset}
              onShift={(n) => setMonthOffset((o) => o + n)}
              onPick={(d) => {
                focusCalendar(d.toISOString());
                setQuickOpen(false);
              }}
            />

            {desktop ? (
              <div className="mt-2 border-t border-line pt-2">
                <button
                  className="btn text-xs w-full justify-center"
                  onClick={() => {
                    void openQuickWindow().then((ok) =>
                      toast(ok ? '已打开系统浮窗' : '打开失败', ok ? 'ok' : 'err'),
                    );
                  }}
                >
                  <Icon name="Sparkles" size={12} /> 钉为系统浮窗
                </button>
                <div className="text-[10px] text-fg-dim mt-1 text-center">
                  全局热键 Alt+Space {hotkey ? '已注册' : '未注册'}
                </div>
              </div>
            ) : (
              <div className="mt-2 border-t border-line pt-2 text-[10px] text-fg-dim leading-4">
                这是浏览器内浮球，只在应用窗口里可见。编译桌面壳后可获得
                <b className="text-fg-muted">系统级置顶浮窗 + 全局热键</b>。
              </div>
            )}

            {quickWindow && (
              <div className="mt-2 text-[10px] text-fg-dim text-center">
                拖动顶部标题栏可移动 · Esc 或再按一次 Alt+Space 关闭
              </div>
            )}
          </div>
        </div>
      )}

      {/* 球体：可上下拖，点击展开/收起（小窗模式下不需要） */}
      {!quickWindow && (
      <button
        ref={ballRef}
        onPointerDown={startDrag}
        className="w-11 h-11 rounded-full shadow-lg border flex items-center justify-center select-none touch-none"
        style={{
          background: quickOpen ? '#5b8cff' : '#1b2030',
          borderColor: quickOpen ? '#5b8cff' : '#2a3145',
          color: quickOpen ? '#fff' : '#e6e9f0',
          cursor: 'grab',
        }}
        title="快速收录（Alt+Q）· 可上下拖动"
      >
        <Icon name={quickOpen ? 'X' : 'Plus'} size={18} />
      </button>
      )}
    </div>
  );
}

/** 迷你月历：一眼看到哪天有安排，点一下跳到日历并弹出当日详情 */
function MiniMonth({
  offset,
  onShift,
  onPick,
}: {
  offset: number;
  onShift: (n: number) => void;
  onPick: (d: Date) => void;
}) {
  const revision = useUI((s) => s.revision);
  const base = useMemo(() => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() + offset);
    return d;
  }, [offset]);

  const range = useMemo(() => monthRange(base), [base]);
  const items = useLiveQuery(
    () => itemRepo.listItems({ query: { from: range.from, to: range.to } }),
    [range.from, range.to, revision],
  );

  const countByDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items ?? []) {
      const t = anchorTime(it);
      if (!t) continue;
      const d = new Date(t);
      const k = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [items]);

  const grid = useMemo(() => monthGrid(base), [base]);
  const todayKey = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  })();

  return (
    <div className="mt-3 border-t border-line pt-2">
      <div className="flex items-center justify-between mb-1">
        <button className="btn btn-ghost px-1" onClick={() => onShift(-1)}>
          <Icon name="ChevronLeft" size={12} />
        </button>
        <span className="text-[11px] text-fg-muted">
          {base.getFullYear()} 年 {base.getMonth() + 1} 月
        </span>
        <button className="btn btn-ghost px-1" onClick={() => onShift(1)}>
          <Icon name="ChevronRight" size={12} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-y-0.5">
        {WEEK_HEAD.map((w) => (
          <div key={w} className="text-center text-[9px] text-fg-dim">
            {w}
          </div>
        ))}
        {grid.map((d) => {
          const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
          const n = countByDay.get(key) ?? 0;
          const inMonth = d.getMonth() === base.getMonth();
          const isToday = key === todayKey;
          return (
            <button
              key={key}
              onClick={() => onPick(d)}
              className={`h-6 rounded text-[10px] relative ${
                isToday ? 'bg-accent text-white' : inMonth ? 'text-fg hover:bg-bg-hover' : 'text-fg-dim/50'
              }`}
              title={n ? `${n} 项安排` : '无安排'}
            >
              {d.getDate()}
              {n > 0 && !isToday && (
                <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-accent" />
              )}
            </button>
          );
        })}
      </div>
      <div className="text-[10px] text-fg-dim mt-1 text-center">点日期跳到日历并展开当天</div>
    </div>
  );
}
