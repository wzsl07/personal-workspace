import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db, setMeta } from '../../core/repo/db';
import { useUI } from '../../app/store';
import { Icon } from '../../ui/Icon';
import { AISettings } from './AISettings';
import { OcrSettings } from './OcrSettings';
import { SyncSettings } from '../sync/SyncSettings';
import { NotifySettings } from './NotifySettings';
import { SecuritySettings } from './SecuritySettings';
import { DupeCleaner } from './DupeCleaner';
import { DataSettings } from './DataSettings';
import { AboutPanel } from './AboutPanel';
import { HealthCheck } from './HealthCheck';
import { ShortcutSettings } from './ShortcutSettings';
import { OnboardingWizard } from '../onboarding/OnboardingWizard';

/**
 * 设置页四段式：
 *   ① 新手区（体检 / 重看向导）  ← 出问题先来这
 *   ② 数据区（在哪 / 备份 / 恢复）← 最重要，放最上面
 *   ③ 能力区（AI / OCR / 同步 / 通知）← 全部可选
 *   ④ 关于（版本 / 诊断）
 *
 * 每段带 id，体检卡片里的「去修复」按钮靠锚点滚过来。
 */
export function SettingsView() {
  const revision = useUI((s) => s.revision);
  const toast = useUI((s) => s.toast);
  const [wizard, setWizard] = useState(false);

  const stats = useLiveQuery(
    async () => ({
      items: await db.items.count(),
      notes: await db.notes.count(),
      tags: await db.tags.count(),
      sources: await db.sources.count(),
    }),
    [revision],
  );

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-5 pb-10">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">设置</h1>
        <div className="flex flex-wrap gap-2 text-xs text-fg-muted">
          <span>日程 {stats?.items ?? 0}</span>
          <span>笔记 {stats?.notes ?? 0}</span>
          <span>标签 {stats?.tags ?? 0}</span>
          <span>收集箱 {stats?.sources ?? 0}</span>
        </div>
      </div>

      {/* ① 新手区 */}
      <section id="health" className="card p-4">
        <h2 className="text-sm font-medium mb-1">一键体检</h2>
        <p className="text-xs text-fg-dim mb-3">
          列出每个功能现在能不能用、不能用的缺什么。除了备份，其余都是可选的。
        </p>
        <HealthCheck />
        <div className="mt-3 pt-3 border-t border-line">
          <button className="btn text-xs" onClick={() => setWizard(true)}>
            <Icon name="Sparkles" size={13} /> 重看首次启动向导
          </button>
        </div>
      </section>

      {/* ② 数据区 */}
      <section id="data" className="card p-4">
        <h2 className="text-sm font-medium mb-1">数据</h2>
        <p className="text-xs text-fg-dim mb-3">
          全部数据保存在本机数据库里，不上传任何服务器。
        </p>
        <DataSettings />
      </section>

      {/* ③ 界面 */}
      <section id="ui" className="card p-4">
        <h2 className="text-sm font-medium mb-1">界面与快捷键</h2>
        <p className="text-xs text-fg-dim mb-3">
          右侧悬浮球：<b className="text-fg-muted">Alt+Q</b> 随时唤出，可上下拖动，位置会自动记住。
        </p>
        <div className="flex flex-wrap gap-2 mb-3">
          <button
            className="btn text-xs"
            onClick={async () => {
              await setMeta('quickball:hidden', false);
              toast('悬浮球已恢复，刷新页面生效');
            }}
          >
            恢复悬浮球
          </button>
          <button
            className="btn text-xs"
            onClick={async () => {
              await setMeta('quickball:top', Math.round(window.innerHeight * 0.42));
              toast('悬浮球位置已重置，刷新页面生效');
            }}
          >
            重置位置
          </button>
        </div>
        <div className="pt-3 border-t border-line">
          <div className="text-xs font-medium mb-2">全局快捷键</div>
          <ShortcutSettings />
        </div>
      </section>

      {/* ③ 提醒 */}
      <section id="notify" className="card p-4">
        <h2 className="text-sm font-medium mb-1">提醒与通知</h2>
        <p className="text-xs text-fg-dim mb-3">
          条目编辑里可单独设置提前量（准点 / 10 分钟 / 30 分钟 / 1 天），重复条目会按周期续下一次。
        </p>
        <NotifySettings />
      </section>

      {/* ③ AI */}
      <section id="ai" className="card p-4">
        <h2 className="text-sm font-medium mb-1">AI 解析</h2>
        <p className="text-xs text-fg-dim mb-3">
          收集箱里的内容可以一键解析成日程草稿。默认 DeepSeek，失败自动降级到 Ollama，
          再不行用本地规则兜底。
          <b className="text-fg-muted"> AI 只生成草稿，必须你在草稿箱确认后才写入。</b>
        </p>
        <AISettings />
      </section>

      {/* ③ 隐私与加密 */}
      <section id="security" className="card p-4">
        <h2 className="text-sm font-medium mb-1">隐私与加密</h2>
        <p className="text-xs text-fg-dim mb-3">
          正文加密是可选的，开启后加密的正文不进全文/语义索引（会搜不到）。
        </p>
        <SecuritySettings />
      </section>

      {/* ③ OCR */}
      <section id="ocr" className="card p-4">
        <h2 className="text-sm font-medium mb-1">附件与 OCR</h2>
        <p className="text-xs text-fg-dim mb-3">
          PDF / Word / 纯文本在本机抽取文字；图片需要 OCR，默认关闭。
          抽取出的文字会进入全文搜索，也能直接交给 AI 生成日程草稿。
        </p>
        <OcrSettings />
      </section>

      {/* ③ 同步 */}
      <section id="sync" className="card p-4">
        <h2 className="text-sm font-medium mb-1">同步</h2>
        <p className="text-xs text-fg-dim mb-3">
          适配器可切换，默认关闭。同步的是一份全量快照，冲突用「本地 / 远端 / 上次同步基线」
          三路比对判定，<b className="text-fg-muted">绝不自动覆盖</b>。
          <b className="text-fg-muted"> 一个仓库只服务一个人</b>，两人共用会互相覆盖。
        </p>
        <SyncSettings />
      </section>

      {/* ③ 重复清理 */}
      <section id="dedupe" className="card p-4">
        <h2 className="text-sm font-medium mb-1">重复数据清理</h2>
        <p className="text-xs text-fg-dim mb-3">
          两台设备各自录入（或各有一份示例数据）时，同步会把两边合并，可能出现内容一样的两条。
          这里一键去掉多余的。
        </p>
        <DupeCleaner />
      </section>

      {/* ④ 关于 */}
      <section id="about" className="card p-4">
        <h2 className="text-sm font-medium mb-1">关于</h2>
        <div className="mt-2">
          <AboutPanel />
        </div>
      </section>

      {wizard && <OnboardingWizard onDone={() => setWizard(false)} />}
    </div>
  );
}
