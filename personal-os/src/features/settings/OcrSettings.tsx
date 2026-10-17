import { useEffect, useState } from 'react';
import { loadOcrConfig, saveOcrConfig } from '../../core/adapters/extract';
import { langReady, type OcrConfig } from '../../core/adapters/ocr';
import { hasOPFS } from '../../core/adapters/storage/opfs';
import { Icon } from '../../ui/Icon';

export function OcrSettings() {
  const [cfg, setCfg] = useState<OcrConfig | null>(null);
  const [status, setStatus] = useState('');
  const [opfs, setOpfs] = useState<boolean | null>(null);

  useEffect(() => {
    void loadOcrConfig().then(setCfg);
    void hasOPFS().then(setOpfs);
  }, []);

  if (!cfg) return <div className="text-xs text-fg-dim">加载中…</div>;

  async function check() {
    setStatus('检查中…');
    const ok = await langReady(cfg!);
    setStatus(ok ? '语言包已就位，可以识别中文图片了' : '没找到语言包，见下方说明');
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
          <label className="label">语言包路径</label>
          <input
            className="field"
            value={cfg.langPath}
            onChange={(e) => setCfg({ ...cfg, langPath: e.target.value })}
            placeholder="./ocr/"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          className="btn btn-primary"
          onClick={() => {
            void saveOcrConfig(cfg).then(() => window.alert('已保存'));
          }}
        >
          <Icon name="Download" size={14} /> 保存
        </button>
        <button className="btn" onClick={() => void check()}>
          检查语言包
        </button>
        {status && <span className="text-[11px] text-fg-muted">{status}</span>}
      </div>

      <div className="text-[11px] text-fg-dim leading-5">
        <b>为什么默认关着：</b>中文识别包约 15~25MB，为了保持产物零外链、体积小，
        它不随应用分发。想用 OCR 就做两步：
        <br />
        1. 跑一次 <code>npm run ocr:setup</code>，把 worker 与 wasm 复制到 <code>public/ocr/</code>；
        <br />
        2. 下载 <code>chi_sim.traineddata</code>（Tesseract 官方 tessdata 仓库）放进 <code>public/ocr/</code>，
        或把「语言包路径」填成你自己的地址。
        <br />
        没放语言包时点识别会直接报错提示，<b>不会偷偷去网上下载</b>。
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
