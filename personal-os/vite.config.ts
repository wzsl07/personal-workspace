import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 零外链约束：
// 1. base 用相对路径，产物可直接放任意目录/子路径下打开；
// 2. 所有依赖必须打进 bundle，禁止任何 CDN、远程字体、远程图标；
// 3. build.assetsInlineLimit 提高，减少零碎文件，便于整个 dist 目录拷走。
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    // transformers.js 自身就是打包好的大 bundle，交给 Vite 预打包会失败
    // （表现为 dev 下 "Failed to fetch dynamically imported module"）
    exclude: ['@huggingface/transformers'],
  },
  build: {
    target: 'es2020',
    assetsInlineLimit: 512 * 1024,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // 后续 pdf.js / tesseract.js 会很大，单独切 chunk 便于按需懒加载
        manualChunks: {
          vendor: ['react', 'react-dom'],
          db: ['dexie', 'dexie-react-hooks'],
        },
      },
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
});
