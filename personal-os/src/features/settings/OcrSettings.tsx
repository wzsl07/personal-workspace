import { useEffect, useState } from 'react';
import { loadOcrConfig, ocrRoute, saveOcrConfig } from '../../core/adapters/extract';
import { hasOPFS } from '../../core/adapters/storage/opfs';
import { cloudVisionStatus, resolveVisionModel } from '../../core/adapters/ai/vision';
import { loadConfig } from '../../core/adapters/ai';
import { LANG_SIZE_HINT, langList, missingLangs, type OcrConfig, type OcrMode } from '../../core/adapters/ocr';
import { Icon } from '../../ui/Icon';

const MODE_OPTIONS: { value: OcrMode; label: string; hint: string }[] = [
  { value: 'auto', label: '自动（云端优先，失败退回本机）', hint: '快，断网或报错时自动用本地兜底' },
  { value: 'cloud', label: '只用云端', hint: '最准最快，但必须联网' },
  { value: 'local', label: '只用本机（不联网）', hint: '离线可用，手机上较慢' },
];

export function OcrSettings() {
  const [cfg, setCfg] = useState<OcrConfig | null>(null);
  const [status, setStatus] = useState('');
  const [route, setRoute] = useState('');
  const [cloudWhy, setCloudWhy] = useState('');
  const [opfs, setOpfs] = useState<boolean | null>(null);

  useEffect(() => {
    void loadOcrConfig().then(setCfg);
    void hasOPFS().then(setOpfs);
  }, []);

  async function refresh() {
    const r = await ocrRoute();
    setRoute(r.detail);
  }

  useEffect(() => {
    if (cfg) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg?.enabled, cfg?.mode]);

  useEffect(() => {
    void loadConfig().then((ai) => {
      setCloudWhy(cloudVisionStatus(ai));
      return resolveVisionModel(ai);
    });
  }, []);

  if (!cfg) return <div className="text-xs text-fg-dim">加载中…</div>;

  async function check() {
    setStatus('检查中…');
    const missing = await missingLangs(cfg!);
    if (missing.length === 0) {
      setStatus(`✓ ${langList(cfg!).join('、')} 都已就位，本机识别可用`);
    } else {
      const tried = missing.map((m) => `${cfg!.langPath.replace(/\/$/, '')}/${m}.traineddata`).join('、');
      setStatus(`✗ 找不到 ${tried}`);
    }
  }

  return (
    <div className="space-y-3">
      <label className="text-xs text-fg-muted flex items-center gap-2">
        <input
          type="checkbox"
          checked={cfg.enabled}
          onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })}
        />
        启用图片 OCR（截图、扫描件也能变成可搜索文字）
      </label>

      <div>
        <label className="label">识别方式</label>
        <select
          className="field"
          value={cfg.mode ?? 'auto'}
          onChange={(e) => setCfg({ ...cfg, mode: e.target.value as OcrMode })}
        >
          {MODE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <div className="text-[11px] text-fg-dim mt-1">
          {MODE_OPTIONS.find((o) => o.value === (cfg.mode ?? 'auto'))?.hint}
        </div>
      </div>

      {(cfg.mode ?? 'auto') !== 'local' && (
        <div className="rounded border border-line bg-panel px-2.5 py-2 text-[11px] leading-5 text-fg-muted">
          <b>注意：这条路的图片会离开本机。</b>
          图片会先压缩到长边 1600 像素，再发给你在「AI 解析」里填的服务商
          {cloudWhy ? (
            <>
              ，但当前<b>云端不可用</b>：{cloudWhy}
            </>
          ) : (
            '，识别完只保留文字。介意的话把「识别方式」改成「只用本机」'
          )}
          。
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-3">
        <div>
          <label className="label">语言</label>
          <input
            className="field"
            value={cfg.lang}
            onChange={(e) => setCfg({ ...cfg, lang: e.target.value })}
            placeholder="chi_sim+eng"
          />
        </div>
        <div>
          <label className="label">语言包路径（仅本机识别用）</label>
          <input
            className="field"
            value={cfg.langPath}
            onChange={(e) => setCfg({ ...cfg, langPath: e.target.value })}
            placeholder="./ocr/"
          />
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          className="btn btn-primary"
          onClick={() => {
            void saveOcrConfig(cfg).then(() => {
              window.alert('已保存');
              void refresh();
            });
          }}
        >
          <Icon name="Download" size={14} /> 保存
        </button>
        <button className="btn" onClick={() => void check()}>
          检查语言包
        </button>
        <button className="btn" onClick={() => void refresh()}>
          当前走哪条路
        </button>
        {status && <span className="text-[11px] text-fg-muted">{status}</span>}
      </div>
      {route && (
        <div className="text-[11px] text-fg-muted">
          当前：<b>{route}</b>
        </div>
      )}

      <div className="text-[11px] text-fg-dim leading-5">
        <b>两条路的差别：</b>
        <br />
        · <b>云端</b>：3~10 秒，中文截图、课件照片、手写都更准；要联网、要 API Key，
        一张图几分钱，<b>图片会发给服务商</b>。
        <br />
        · <b>本机</b>：离线、隐私、零成本；语言包 {LANG_SIZE_HINT}，
        正常字号很准，小于 12px 的小字容易串行，手机上可能要几十秒。
        <br />
        本机识别缺语言包时会直接说明缺哪个文件，<b>不会偷偷去网上下载</b>；
        跑一次 <code>npm run ocr:setup</code> 即可补齐。
        {opfs === false && (
          <>
            <br />
            <b>注意：</b>当前浏览器不支持 OPFS，附件二进制会退回到 IndexedDB（能用，但大文件占内存更多）。
          </>
        )}
      </div>
    </div>
  );
}
