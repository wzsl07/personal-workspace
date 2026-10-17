import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useUI, type ViewKey } from './app/store';
import { Icon } from './ui/Icon';
import { OnboardingWizard, hasOnboarded } from './features/onboarding/OnboardingWizard';
import { TodayView } from './features/today/TodayView';
import { InboxView } from './features/inbox/InboxView';
import { CalendarView } from './features/calendar/CalendarView';
import { NotesView } from './features/notes/NotesView';
import { SearchView } from './features/search/SearchView';
import { SettingsView } from './features/settings/SettingsView';
import { ItemEditor } from './features/items/ItemEditor';
import { DraftsView } from './features/drafts/DraftsView';
import { AttachmentsView } from './features/attachments/AttachmentsView';
import { QuickBall } from './features/quick/QuickBall';
import { SyncIndicator } from './features/sync/SyncIndicator';
import { GraphView } from './features/graph/GraphView';
import { startScheduler } from './core/notify/scheduler';
import * as sourceRepo from './core/repo/sourceRepo';
import * as draftRepo from './core/repo/draftRepo';

const NAV: { key: ViewKey; label: string; icon: string }[] = [
  { key: 'today', label: '今日', icon: 'Sun' },
  { key: 'inbox', label: '收集箱', icon: 'Inbox' },
  { key: 'drafts', label: '草稿箱', icon: 'Sparkles' },
  { key: 'calendar', label: '日历', icon: 'CalendarDays' },
  { key: 'notes', label: '知识库', icon: 'NotebookText' },
  { key: 'attachments', label: '附件', icon: 'FileText' },
  { key: 'search', label: '搜索', icon: 'Search' },
  { key: 'graph', label: '图谱', icon: 'Network' },
  { key: 'settings', label: '设置', icon: 'Settings' },
];

export default function App() {
  const view = useUI((s) => s.view);
  const setView = useUI((s) => s.setView);
  const openNew = useUI((s) => s.openNew);
  const sidebarOpen = useUI((s) => s.sidebarOpen);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const toasts = useUI((s) => s.toasts);

  const revision = useUI((s) => s.revision);
  const inboxN = useLiveQuery(async () => (await sourceRepo.listInbox()).length, [revision]);
  const draftN = useLiveQuery(async () => (await draftRepo.listPendingDrafts()).length, [revision]);
  const bump = useUI((s) => s.bump);
  const toast = useUI((s) => s.toast);

  // 首启向导：只有"从来没走过"的人才弹。走过一次就永久记在 meta 里。
  // null = 还没读到（不渲染，避免闪一下）
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  useEffect(() => {
    void hasOnboarded().then(setOnboarded);
  }, []);

  // 启动提醒调度器（应用打开期间每 30 秒扫一次到期提醒）
  useEffect(() => startScheduler(30_000), []);

  // PWA 分享目标：从别的应用分享文本/链接进来，直接落收集箱
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const text = params.get('text') ?? '';
    const title = params.get('title') ?? '';
    const url = params.get('url') ?? '';
    const content = [title, text, url].filter(Boolean).join('\n').trim();
    if (!content) return;
    void (async () => {
      await sourceRepo.createSource({ kind: sourceRepo.guessKind(content), rawText: content });
      bump();
      toast('已从分享收入收集箱');
      window.history.replaceState({}, '', window.location.pathname);
    })();
  }, [bump, toast]);

  // 全局快捷键：Ctrl/Cmd+K 搜索，Alt+N 新建
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setView('search');
      }
      if (e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        openNew();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setView, openNew]);

  // 桌面壳的小窗模式（?quick=1）：只显示快速收录面板
  const quickMode =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('quick') === '1';

  if (quickMode) {
    return (
      <div className="h-full">
        <QuickBall />
        <ItemEditor />
      </div>
    );
  }

  return (
    // 手机上避开刘海和底部横条（桌面端 env() 为 0，无副作用）
    <div className="h-full flex pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)]">
      {/* 侧边栏 */}
      <aside
        className={`${
          sidebarOpen ? 'flex' : 'hidden'
        } md:flex w-52 shrink-0 flex-col border-r border-line bg-bg-panel`}
      >
        <div className="h-12 flex items-center gap-2 px-4 border-b border-line">
          <span className="w-2 h-2 rounded-full bg-accent" />
          <span className="text-sm font-medium">个人工作台</span>
        </div>
        <nav className="flex-1 p-2 space-y-0.5">
          {NAV.map((n) => (
            <button
              key={n.key}
              onClick={() => setView(n.key)}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-sm transition-colors ${
                view === n.key
                  ? 'bg-bg-elev text-fg'
                  : 'text-fg-muted hover:bg-bg-hover hover:text-fg'
              }`}
            >
              <Icon name={n.icon} size={15} />
              <span className="flex-1 text-left">{n.label}</span>
              {n.key === 'inbox' && inboxN ? (
                <span className="text-[10px] px-1.5 rounded-full bg-accent/20 text-accent">
                  {inboxN}
                </span>
              ) : null}
              {n.key === 'drafts' && draftN ? (
                <span className="text-[10px] px-1.5 rounded-full bg-[#f0a13c]/20 text-[#f0a13c]">
                  {draftN}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="p-2 border-t border-line">
          <button className="btn btn-primary w-full justify-center" onClick={() => openNew()}>
            <Icon name="Plus" size={14} /> 新建条目
          </button>
          <div className="text-[10px] text-fg-dim mt-2 px-1">
            离线可用 · 数据存本机
            <br />
            Ctrl+K 搜索 · Alt+N 新建
          </div>
        </div>
      </aside>

      {/* 主区 */}
      <main className="flex-1 min-w-0 flex flex-col">
        {/* 顶栏：同步状态灯 */}
        <div className="hidden md:flex h-10 items-center justify-end gap-2 px-4 border-b border-line shrink-0">
          <SyncIndicator />
        </div>
        {/* 窄屏顶栏 */}
        <div className="md:hidden h-11 flex items-center px-3 border-b border-line shrink-0">
          <button className="btn btn-ghost px-1.5" onClick={toggleSidebar}>
            <Icon name="LayoutGrid" size={16} />
          </button>
          <span className="ml-2 text-sm">{NAV.find((n) => n.key === view)?.label}</span>
          <div className="flex-1" />
          <SyncIndicator />
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          {view === 'today' && (
            <div className="h-full overflow-y-auto">
              <TodayView />
            </div>
          )}
          {view === 'inbox' && (
            <div className="h-full overflow-y-auto">
              <InboxView />
            </div>
          )}
          {view === 'drafts' && (
            <div className="h-full overflow-y-auto">
              <DraftsView />
            </div>
          )}
          {view === 'attachments' && (
            <div className="h-full overflow-y-auto">
              <AttachmentsView />
            </div>
          )}
          {view === 'calendar' && <CalendarView />}
          {view === 'notes' && <NotesView />}
          {view === 'search' && (
            <div className="h-full overflow-y-auto">
              <SearchView />
            </div>
          )}
          {view === 'graph' && <GraphView />}
          {view === 'settings' && (
            <div className="h-full overflow-y-auto">
              <SettingsView />
            </div>
          )}
        </div>
      </main>

      <ItemEditor />
      <QuickBall />

      {/* 首启向导（只在 quickMode 之外弹，小窗里不该出现向导） */}
      {onboarded === false && <OnboardingWizard onDone={() => setOnboarded(true)} />}

      {/* Toast */}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 space-y-1.5">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="px-3 py-1.5 rounded-md text-xs border shadow-lg"
            style={{
              background: '#1b2030',
              borderColor: t.kind === 'err' ? '#e5484d' : t.kind === 'warn' ? '#f0a13c' : '#2a3145',
              color: t.kind === 'err' ? '#e5484d' : t.kind === 'warn' ? '#f0a13c' : '#e6e9f0',
            }}
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
