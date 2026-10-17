/**
 * 一键体检：把「哪些功能现在能用、不能用的缺什么」摊开给用户看。
 *
 * 存在的理由：分发版里最糟的体验是按钮灰着、点了没反应、也没说为什么。
 * 宁可多写几行说明，也不要让人觉得"这软件坏了"。
 */

import { useEffect, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { checkCapabilities, countProblems, type CapState } from '../../core/capabilities';
import { useUI } from '../../app/store';

export function HealthCheck() {
  const setView = useUI((s) => s.setView);
  const toast = useUI((s) => s.toast);
  const [caps, setCaps] = useState<CapState[] | null>(null);
  const [loading, setLoading] = useState(true);

  function run() {
    setLoading(true);
    void checkCapabilities()
      .then(setCaps)
      .catch(() => setCaps([]))
      .finally(() => setLoading(false));
  }

  useEffect(run, []);

  const problems = caps ? countProblems(caps) : 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`text-[10px] px-2 py-0.5 rounded-full ${
            problems === 0
              ? 'bg-accent/20 text-accent'
              : problems > 2
                ? 'bg-[#f0a13c]/20 text-[#f0a13c]'
                : 'bg-bg-hover text-fg-muted'
          }`}
        >
          {loading ? '检查中…' : problems === 0 ? '全部可用' : `${problems} 项未启用`}
        </span>
        <button className="btn text-xs" onClick={run} disabled={loading}>
          <Icon name="RefreshCw" size={13} /> 重新检查
        </button>
        <span className="text-[11px] text-fg-dim">
          除了备份，下面几项都是可选的 —— 不配也能正常用。
        </span>
      </div>

      {caps && (
        <div className="space-y-1.5">
          {caps.map((c) => (
            <div
              key={c.id}
              className="flex gap-2.5 p-2.5 rounded-md bg-bg-elev items-start"
            >
              <span className="mt-0.5 shrink-0">
                {c.ok ? (
                  <Icon name="CheckCircle2" size={14} />
                ) : c.optional ? (
                  <Icon name="MinusCircle" size={14} />
                ) : (
                  <Icon name="AlertTriangle" size={14} />
                )}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium">{c.label}</span>
                  {!c.ok && !c.optional && (
                    <span className="text-[10px] px-1.5 rounded-full bg-[#f0a13c]/20 text-[#f0a13c]">
                      建议处理
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-fg-dim mt-0.5 leading-5">{c.detail}</div>
              </div>
              {!c.ok && c.fixTo && (
                <button
                  className="btn text-[11px] shrink-0"
                  onClick={() => {
                    setView('settings');
                    // 等一帧再滚，否则设置页还没渲染出目标节点
                    requestAnimationFrame(() => {
                      const el = document.querySelector(c.fixTo as string);
                      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      else toast('已切到设置页，往下找对应的卡片');
                    });
                  }}
                >
                  {c.fixLabel ?? '去设置'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
