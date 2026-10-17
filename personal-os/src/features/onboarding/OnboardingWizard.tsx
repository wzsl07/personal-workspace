/**
 * 首启向导。
 *
 * 设计原则（针对"发给朋友用"）：
 *   1. **全程可跳过** —— 任何一步都有「以后再说」。被强制的向导只会让人关掉软件。
 *   2. **默认档位 = 纯离线** —— 不填任何东西也能立刻用，这是这软件的价值主张。
 *   3. **不在这里做复杂配置** —— 只放最小可用输入，细节一律指向设置页。
 *      否则向导会变成第二个设置页，两头都难维护。
 *   4. 每一步都说清"代价"：接 AI 要自己出钱、同步要自己建仓库。
 */

import { useState } from 'react';
import { Icon } from '../../ui/Icon';
import { loadConfig, saveConfig, testConnection } from '../../core/adapters/ai';
import type { AIConfig } from '../../core/adapters/ai/types';
import { getMeta, setMeta } from '../../core/repo/db';
import { useUI } from '../../app/store';

export const ONBOARD_KEY = 'onboardedAt';

export function hasOnboarded(): Promise<boolean> {
  return getMeta<string>(ONBOARD_KEY, '').then((v) => Boolean(v));
}

export function markOnboarded(): Promise<void> {
  return setMeta(ONBOARD_KEY, new Date().toISOString());
}

type Mode = 'offline' | 'ai' | 'sync';

export function OnboardingWizard({ onDone }: { onDone: () => void }) {
  const toast = useUI((s) => s.toast);
  const setView = useUI((s) => s.setView);

  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  const [mode, setMode] = useState<Mode>('offline');

  // AI 步骤
  const [baseURL, setBaseURL] = useState('https://api.deepseek.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState('');

  async function finish() {
    await markOnboarded();
    onDone();
  }

  async function saveAI() {
    const cfg: AIConfig = {
      ...(await loadConfig()),
      provider: 'deepseek',
      baseURL: baseURL.trim(),
      model: 'deepseek-chat',
      apiKey: apiKey.trim(),
      allowCloud: Boolean(apiKey.trim()),
      autoFallback: true,
    };
    await saveConfig(cfg);
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
      <div className="card w-full max-w-lg p-5 space-y-4">
        {/* 进度 */}
        <div className="flex items-center gap-2">
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className="h-1 flex-1 rounded-full"
              style={{ background: i <= step ? 'var(--accent, #6b8afd)' : 'var(--line, #2a3145)' }}
            />
          ))}
        </div>

        {/* ── 第 0 步：欢迎 ── */}
        {step === 0 && (
          <>
            <div>
              <h1 className="text-lg font-semibold">欢迎使用个人工作台</h1>
              <p className="text-xs text-fg-dim mt-1">
                一个把「随手写的东西」变成日程和知识的地方。
              </p>
            </div>
            <div className="space-y-2 text-xs">
              <div className="flex gap-2 p-3 rounded-md bg-bg-elev">
                <Icon name="ShieldCheck" size={16} />
                <div>
                  <b>数据只在你这台电脑上</b>
                  <div className="text-fg-dim mt-0.5">
                    没有账号、没有云端、作者看不到你的任何内容。
                  </div>
                </div>
              </div>
              <div className="flex gap-2 p-3 rounded-md bg-bg-elev">
                <Icon name="WifiOff" size={16} />
                <div>
                  <b>断网也能用</b>
                  <div className="text-fg-dim mt-0.5">
                    录入、日历、搜索、图谱全部离线运行。AI 和同步是可选插件。
                  </div>
                </div>
              </div>
              <div className="flex gap-2 p-3 rounded-md bg-bg-elev">
                <Icon name="Download" size={16} />
                <div>
                  <b>随时能把数据全部拿走</b>
                  <div className="text-fg-dim mt-0.5">
                    设置里一键导出 JSON，是你的文件，跟这个软件无关。
                  </div>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn" onClick={() => void finish()}>
                跳过，直接开始
              </button>
              <button className="btn btn-primary" onClick={() => setStep(1)}>
                下一步
              </button>
            </div>
          </>
        )}

        {/* ── 第 1 步：选档 ── */}
        {step === 1 && (
          <>
            <div>
              <h2 className="text-base font-semibold">你想怎么用？</h2>
              <p className="text-xs text-fg-dim mt-1">三个都可以随时改，选错了不用重来。</p>
            </div>
            <div className="space-y-2">
              <ModeCard
                active={mode === 'offline'}
                onClick={() => setMode('offline')}
                icon="WifiOff"
                title="纯离线（推荐）"
                desc="现在就能用。手动录入 + 本地规则解析 + 全文搜索，一分钱不花。"
                tag="0 元"
              />
              <ModeCard
                active={mode === 'ai'}
                onClick={() => setMode('ai')}
                icon="Sparkles"
                title="我还要 AI 帮我解析"
                desc="把「下周三下午三点开会」这种话自动变成日程。需要你自己的 API Key，费用走你的账号。"
                tag="自费"
              />
              <ModeCard
                active={mode === 'sync'}
                onClick={() => setMode('sync')}
                icon="RefreshCw"
                title="我要在手机和电脑之间同步"
                desc="需要一个你自己建的 GitHub 私有仓库。数据仍然只在你自己的仓库里。"
                tag="需配置"
              />
            </div>
            <div className="flex justify-between gap-2">
              <button className="btn" onClick={() => setStep(0)}>
                上一步
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  if (mode === 'offline') {
                    void finish();
                    toast('已设为纯离线模式。随时可以在设置里开启 AI 或同步。');
                  } else {
                    setStep(2);
                  }
                }}
              >
                {mode === 'offline' ? '就这样，开始用' : '下一步'}
              </button>
            </div>
          </>
        )}

        {/* ── 第 2 步：AI 或 同步 ── */}
        {step === 2 && mode === 'ai' && (
          <>
            <div>
              <h2 className="text-base font-semibold">接一个 AI</h2>
              <p className="text-xs text-fg-dim mt-1">
                默认 DeepSeek（便宜）。Key 会加密存在本机，<b>费用由你自己的账号承担</b>。
                不填也能用，只是解析改成本地规则。
              </p>
            </div>
            <div className="space-y-2">
              <label className="block">
                <span className="text-xs text-fg-muted">接口地址</span>
                <input
                  className="field mt-1"
                  value={baseURL}
                  onChange={(e) => setBaseURL(e.target.value)}
                  placeholder="https://api.deepseek.com/v1"
                />
              </label>
              <label className="block">
                <span className="text-xs text-fg-muted">API Key</span>
                <input
                  className="field mt-1"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-…"
                  autoComplete="off"
                />
              </label>
              {testMsg && <div className="text-xs text-fg-muted">{testMsg}</div>}
            </div>
            <div className="flex justify-between gap-2">
              <button className="btn" onClick={() => setStep(1)}>
                上一步
              </button>
              <div className="flex gap-2">
                <button
                  className="btn"
                  disabled={testing}
                  onClick={() => {
                    void (async () => {
                      setTesting(true);
                      setTestMsg('测试中…');
                      try {
                        const cfg: AIConfig = {
                          ...(await loadConfig()),
                          provider: 'deepseek',
                          baseURL: baseURL.trim(),
                          model: 'deepseek-chat',
                          apiKey: apiKey.trim(),
                          allowCloud: true,
                          autoFallback: true,
                        };
                        setTestMsg(await testConnection(cfg));
                      } catch (e) {
                        setTestMsg(`测试失败：${e instanceof Error ? e.message : e}`);
                      } finally {
                        setTesting(false);
                      }
                    })();
                  }}
                >
                  测试连接
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    void (async () => {
                      await saveAI();
                      await finish();
                      toast(apiKey.trim() ? 'AI 已配置好，去收集箱试试。' : '已保持离线模式。');
                      setView('inbox');
                    })();
                  }}
                >
                  完成
                </button>
              </div>
            </div>
          </>
        )}

        {step === 2 && mode === 'sync' && (
          <>
            <div>
              <h2 className="text-base font-semibold">设置同步</h2>
              <p className="text-xs text-fg-dim mt-1">
                同步需要建一个你自己的 GitHub 私有仓库、生成一枚 Token，步骤不复杂但要点几下。
                这里给你准备好入口，去设置页跟着做就行。
              </p>
            </div>
            <ol className="text-xs text-fg-muted space-y-1.5 list-decimal pl-4">
              <li>在 GitHub 新建一个<b>私有</b>仓库（公开仓库等于把日记发网上）</li>
              <li>生成一枚 Fine-grained Token，权限给 Contents 的 <b>Read and write</b></li>
              <li>回到设置 → 同步，填仓库和 Token，点「测试连接」</li>
            </ol>
            <p className="text-xs text-fg-dim">
              ⚠️ 一个仓库只服务一个人 —— 两个人共用一个仓库会互相覆盖对方的数据。
            </p>
            <div className="flex justify-between gap-2">
              <button className="btn" onClick={() => setStep(1)}>
                上一步
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  void (async () => {
                    await finish();
                    setView('settings');
                  })();
                }}
              >
                去设置页配置
              </button>
            </div>
          </>
        )}

        {/* ── 第 3 步：结束 ── */}
        {step === 3 && (
          <>
            <div>
              <h2 className="text-base font-semibold">好了</h2>
              <p className="text-xs text-fg-dim mt-1">
                记一句提醒：数据只有这一份，<b>偶尔花 3 秒导一次备份</b>。
              </p>
            </div>
            <div className="flex justify-end">
              <button className="btn btn-primary" onClick={() => void finish()}>
                开始使用
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  icon,
  title,
  desc,
  tag,
}: {
  active: boolean;
  onClick: () => void;
  icon: string;
  title: string;
  desc: string;
  tag: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left flex gap-3 p-3 rounded-md border transition-colors ${
        active ? 'border-accent bg-bg-elev' : 'border-line hover:bg-bg-hover'
      }`}
    >
      <Icon name={icon} size={18} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{title}</span>
          <span className="text-[10px] px-1.5 rounded-full bg-bg-hover text-fg-dim">{tag}</span>
        </div>
        <div className="text-xs text-fg-dim mt-0.5 leading-5">{desc}</div>
      </div>
      <span
        className="w-3.5 h-3.5 mt-1 rounded-full border shrink-0"
        style={{
          borderColor: active ? 'var(--accent, #6b8afd)' : 'var(--line, #2a3145)',
          background: active ? 'var(--accent, #6b8afd)' : 'transparent',
        }}
      />
    </button>
  );
}
