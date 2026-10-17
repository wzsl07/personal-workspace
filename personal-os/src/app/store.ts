import { create } from 'zustand';
import type { ID, ItemType, ScheduleItem } from '../core/domain/types';

export type ViewKey =
  | 'today'
  | 'inbox'
  | 'drafts'
  | 'calendar'
  | 'notes'
  | 'attachments'
  | 'search'
  | 'graph'
  | 'settings';

export interface Toast {
  id: number;
  text: string;
  kind: 'ok' | 'warn' | 'err';
}

interface UIState {
  view: ViewKey;
  setView: (v: ViewKey) => void;

  /** 正在编辑的条目；'new' 表示新建，草稿放在 draft 里 */
  editing: { id: ID | 'new'; preset?: Partial<ScheduleItem> } | null;
  openNew: (preset?: Partial<ScheduleItem>) => void;
  openEdit: (id: ID) => void;
  closeEditor: () => void;

  /** 打开笔记编辑 */
  editingNoteId: ID | 'new' | null;
  openNote: (id: ID | 'new') => void;
  closeNote: () => void;

  /** 供各视图订阅的"数据已变更"信号，用于重建搜索索引 */
  revision: number;
  bump: () => void;

  toasts: Toast[];
  toast: (text: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;

  /** 日历当前锚点月份/周 */
  cursor: string;
  setCursor: (iso: string) => void;

  /** 侧边栏折叠（窄屏） */
  sidebarOpen: boolean;
  toggleSidebar: () => void;

  /** 快捷预设：从收集箱/日历点空白新建时带的类型 */
  quickType: ItemType;
  setQuickType: (t: ItemType) => void;

  /** 悬浮球面板是否展开 */
  quickOpen: boolean;
  setQuickOpen: (v: boolean) => void;
  toggleQuick: () => void;

  /** 外部（悬浮球迷你日历）要求日历页聚焦到某天 */
  calendarFocus: string | null;
  focusCalendar: (iso: string) => void;
  clearCalendarFocus: () => void;
}

let toastSeq = 0;

export const useUI = create<UIState>((set) => ({
  view: 'today',
  setView: (v) => set({ view: v, sidebarOpen: false }),

  editing: null,
  openNew: (preset) => set({ editing: { id: 'new', preset } }),
  openEdit: (id) => set({ editing: { id } }),
  closeEditor: () => set({ editing: null }),

  editingNoteId: null,
  openNote: (id) => set({ editingNoteId: id }),
  closeNote: () => set({ editingNoteId: null }),

  revision: 0,
  bump: () => set((s) => ({ revision: s.revision + 1 })),

  toasts: [],
  toast: (text, kind = 'ok') =>
    set((s) => {
      toastSeq += 1;
      const t = { id: toastSeq, text, kind };
      setTimeout(() => {
        set((st) => ({ toasts: st.toasts.filter((x) => x.id !== t.id) }));
      }, 2600);
      return { toasts: [...s.toasts, t] };
    }),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  cursor: new Date().toISOString(),
  setCursor: (iso) => set({ cursor: iso }),

  sidebarOpen: false,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  quickType: 'task',
  setQuickType: (t) => set({ quickType: t }),

  quickOpen: false,
  setQuickOpen: (v) => set({ quickOpen: v }),
  toggleQuick: () => set((s) => ({ quickOpen: !s.quickOpen })),

  calendarFocus: null,
  focusCalendar: (iso) => set({ calendarFocus: iso, view: 'calendar' }),
  clearCalendarFocus: () => set({ calendarFocus: null }),
}));
