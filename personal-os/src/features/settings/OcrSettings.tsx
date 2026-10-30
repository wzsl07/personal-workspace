import { useEffect, useState } from 'react';
import { loadOcrConfig, saveOcrConfig } from '../../core/adapters/extract';
import { LANG_SIZE_HINT, langList, missingLangs, type OcrConfig } from '../../core/adapters/ocr';
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
    const missing = await missingLangs(cfg!);
    if (missing.length === 0) {
      setStatus(`✓ ${langList(cfg!).join('、')} 都已就位，可以识别图片文字了`);
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
        <b>为什么默认关着：</b>语言包 {LANG_SIZE_HINT}，为了保持产物零外链、体积小，
        它不随应用分发。要用 OCR 只需一步：
        <br />
        跑一次 <code>npm run ocr:setup</code>，它会把 worker、wasm 复制到 <code>public/ocr/</code>，
        并把 <code>chi_sim.traineddata</code>、<code>eng.traineddata</code> 下载到同目录。
        <br />
        也可以自己放语言包，或把「语言包路径」填成能访问到它们的地址（只影响语言包，不影响引擎）。
        <br />
        没放语言包时点识别会直接报错说明缺哪个文件，<b>不会偷偷去网上下载</b>。
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
