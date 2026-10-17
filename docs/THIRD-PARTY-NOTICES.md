# 第三方组件许可声明

「个人工作台」使用了以下开源项目。本文件随分发物一起提供，用于履行各自的许可义务。

> 本清单依据 `package.json` 的直接依赖整理。间接依赖（npm 传递依赖）数量庞大，未逐条列出；
> 如需完整清单，在项目根目录执行 `npm ls --all --json` 或 `npx license-checker --json`。

## 运行时依赖（会随安装包一起分发）

| 项目 | 许可 | 用途 |
|---|---|---|
| [React](https://github.com/facebook/react) | MIT | 界面框架 |
| [React DOM](https://github.com/facebook/react) | MIT | 界面渲染 |
| [Dexie](https://github.com/dexie/Dexie) | Apache-2.0 | IndexedDB 封装（本地数据库） |
| [dexie-react-hooks](https://github.com/dexie/Dexie) | Apache-2.0 | 响应式数据绑定 |
| [zustand](https://github.com/pmndrs/zustand) | MIT | 轻量状态管理 |
| [MiniSearch](https://github.com/lucaong/minisearch) | MIT | 本地全文检索 |
| [date-fns](https://github.com/date-fns/date-fns) | MIT | 日期处理 |
| [nanoid](https://github.com/ai/nanoid) | MIT | ID 生成 |
| [lucide-react](https://github.com/lucide-icons/lucide) | ISC | 图标 |
| [markdown-it](https://github.com/markdown-it/markdown-it) | MIT | Markdown 渲染 |
| [mammoth](https://github.com/mwilliamson/mammoth.js) | BSD-2-Clause | .docx 正文抽取 |
| [pdf.js](https://github.com/mozilla/pdf.js) | Apache-2.0 | PDF 正文抽取 |
| [tesseract.js](https://github.com/naptha/tesseract.js) | Apache-2.0 | 本地 OCR |
| [transformers.js](https://github.com/huggingface/transformers.js) | Apache-2.0 | 本地向量模型推理 |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) | MIT | 本地推理运行时（WASM） |
| [@tauri-apps/api](https://github.com/tauri-apps/tauri) | MIT / Apache-2.0 | 桌面壳 JS 接口 |

## 模型与数据

| 项目 | 许可 | 说明 |
|---|---|---|
| [bge-small-zh](https://huggingface.co/BAAI/bge-small-zh) | MIT | 中文句向量模型，随安装包内置，离线运行 |

## 构建期依赖（不随安装包分发）

TypeScript、Vite、Tailwind CSS、PostCSS、Autoprefixer、esbuild、@tauri-apps/cli —— 均为 MIT / Apache-2.0 / ISC 许可。

## Tauri 桌面壳

| 项目 | 许可 |
|---|---|
| [Tauri](https://github.com/tauri-apps/tauri) | MIT / Apache-2.0 |
| tauri-plugin-notification | MIT / Apache-2.0 |
| tauri-plugin-dialog | MIT / Apache-2.0 |
| tauri-plugin-global-shortcut | MIT / Apache-2.0 |

## 许可全文

MIT、Apache-2.0、BSD-2-Clause、ISC 的许可全文可在 <https://spdx.org/licenses/> 查阅。
