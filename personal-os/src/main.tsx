import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { openDB } from './core/repo/db';
import { seedIfEmpty } from './core/repo/seed';

/** 仅在构建产物中注册 Service Worker，避免开发时被缓存干扰 */
function registerSW(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* 注册失败不影响离线使用（数据本来就在 IndexedDB） */
    });
  });
}

async function boot(): Promise<void> {
  await openDB();
  await seedIfEmpty();
  registerSW();
  const el = document.getElementById('root');
  if (!el) throw new Error('#root 不存在');
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot().catch((e: unknown) => {
  const el = document.getElementById('root');
  const msg = e instanceof Error ? e.message : String(e);
  if (el) {
    el.innerHTML = `<div style="padding:24px;font:14px system-ui;color:#e5484d">启动失败：${msg}</div>`;
  }
  console.error(e);
});
