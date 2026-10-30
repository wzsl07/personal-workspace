import { useEffect, useState } from 'react';
import {
  PROVIDER_PRESETS,
  loadConfig,
  saveConfig,
  testConnection,
  type AIConfig,
  type AIProviderId,
} from '../../core/adapters/ai';
import { hasPassphrase, setPassphrase } from '../../core/adapters/crypto';
import { Icon } from '../../ui/Icon';

const OPTIONS: { value: AIProviderId; label: string }[] = [
  { value: 'deepseek', label: 'DeepSeek（云端）' },
  { value: 'ollama', label: 'Ollama（本机）' },
  { value: 'custom', label: '自定义 API' },
  { value: 'rule', label: '仅本地规则（不联网）' },
];

export function AISettings() {
  const [cfg, setCfg] = useState<AIConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState<string>('');
  const [usePass, setUsePass] = useState(false);

  useEffect(() => {
    void loadConfig().then((c) => {
      setCfg(c);
      setSaved(Boolean(c.apiKey));
    });
    setUsePass(hasPassphrase());
  }, []);

  if (!cfg) return <div className="text-xs text-fg-dim">加载中…</div>;

  const patch = (p: Partial<AIConfig>) => setCfg({ ...cfg, ...p });

  async function persist(): Promise<string> {
    const c = cfg;
    if (!c) return '配置尚未加载完成';
    await saveConfig(c);
    setSaved(Boolean(c.apiKey));
    return '已保存。API Key 用 AES-GCM 加密存在本机，不会出现在任何导出文件里。';
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-xs text-fg-muted flex items-center gap-2">
          <input
            type="checkbox"
            checked={cfg.allowCloud}
            onChange={(e) => patch({ allowCloud: e.target.checked })}
          />
          允许调用云端 AI（关闭后只用本地规则解析，完全离线）
        </label>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <div>
          <label className="label">提供商</label>
          <select
            className="field"
            value={cfg.provider}
            onChange={(e) => {
              const id = e.target.value as AIProviderId;
              const preset = id in PROVIDER_PRESETS ? PROVIDER_PRESETS[id as keyof typeof PROVIDER_PRESETS] : null;
              patch({
                provider: id,
                baseURL: preset?.baseURL ?? cfg.baseURL,
                model: preset?.model ?? cfg.model,
              });
            }}
          >
            {OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">模型</label>
          <input
            className="field"
            value={cfg.model}
            onChange={(e) => patch({ model: e.target.value })}
            placeholder="deepseek-flash / qwen2.5:7b"
          />
        </div>
        <div>
          <label className="label">识图模型（选填）</label>
          <input
            className="field"
            value={cfg.visionModel ?? ''}
            onChange={(e) => patch({ visionModel: e.target.value })}
            placeholder="deepseek-flash"
          />
        </div>
      </div>
      <div className="text-[11px] text-fg-dim leading-5">
        「识图模型」只用于图片 OCR。文本模型常常不支持图片 —— 比如 DeepSeek 的
        <code>deepseek-chat</code> 只吃文本，识图必须填 <code>deepseek-flash</code>。
        留空则自动推断（DeepSeek 用 deepseek-flash，其余沿用上面的模型）。
      </div>

      <div>
        <label className="label">接口地址（Base URL）</label>
        <input
          className="field"
          value={cfg.baseURL}
          onChange={(e) => patch({ baseURL: e.target.value })}
          placeholder="https://api.deepseek.com/v1"
        />
      </div>

      <div>
        <label className="label">API Key（加密保存在本机{saved ? ' · 已保存' : ''}）</label>
        <input
          type="password"
          className="field"
          value={cfg.apiKey}
          onChange={(e) => patch({ apiKey: e.target.value })}
          placeholder={saved ? '已保存，留空表示不修改' : 'sk-…'}
        />
      </div>

      <label className="text-xs text-fg-muted flex items-center gap-2">
        <input
          type="checkbox"
          checked={cfg.autoFallback}
          onChange={(e) => patch({ autoFallback: e.target.checked })}
        />
        云端失败或断网时，自动降级到 Ollama → 本地规则解析
      </label>

      <div className="border-t border-line pt-3">
        <label className="text-xs text-fg-muted flex items-center gap-2">
          <input
            type="checkbox"
            checked={usePass}
            onChange={(e) => {
              setUsePass(e.target.checked);
              if (!e.target.checked) {
                setPassphrase(null);
              } else {
                const p = window.prompt('设置一个加密口令（重启后需重新输入，务必记住）：');
                if (p) setPassphrase(p);
                else setUsePass(false);
              }
            }}
          />
          用口令加密 API Key（更安全，但每次重启要重新输入口令）
        </label>
        <p className="text-[11px] text-fg-dim mt-1">
          默认用本机随机设备密钥加密，只能防止别人直接翻数据库看到明文，
          <b className="text-fg-muted">防不住本机恶意程序</b>。
        </p>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          className="btn btn-primary"
          onClick={() => {
            void persist().then((m) => window.alert(m));
          }}
        >
          <Icon name="Download" size={14} /> 保存配置
        </button>
        <button
          className="btn"
          disabled={!cfg.allowCloud}
          onClick={() => {
            setTesting('测试中…');
            void testConnection(cfg).then((r) => setTesting(r));
          }}
        >
          测试连接
        </button>
        {testing && <span className="text-[11px] text-fg-muted max-w-md">{testing}</span>}
      </div>

      <div className="text-[11px] text-fg-dim leading-5">
        <b>已知限制：</b>浏览器直连第三方 API 可能被 CORS 拦截。若 DeepSeek 连不上，
        请改用「自定义 API」指向你自己的代理，或用桌面壳（Tauri）绕开浏览器限制。
        Ollama 需先设置环境变量 <code>OLLAMA_ORIGINS=*</code> 才能跨域访问。
        <br />
        <b>硬约束：</b>AI 只生成草稿，必须你在草稿箱确认后才写入日历。
      </div>
    </div>
  );
}
