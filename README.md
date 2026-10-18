# 个人工作台

> **Personal Workspace** · 本地优先、离线可用的个人日程与知识库

把随手写的东西，变成日程和知识。数据只存在你自己的设备上 —— **没有账号、没有服务器、默认不联网**。

- 断网能用：录入、日历、搜索、图谱全部离线运行
- 不上传：没有统计上报，作者看不到你的任何内容
- 能带走：一键导出 JSON，是你的文件，跟这个软件无关

AI 解析和跨设备同步是**可选插件**：不开就完全离线，开了才联网，而且连的是**你自己**填的服务和你**自己**的仓库。

---

## 目录

| 路径 | 内容 |
|---|---|
| [`personal-os/`](personal-os/) | **项目源码**（前端 + Tauri 桌面壳） |
| [`docs/`](docs/) | 文档：安装指南、故障排查、同步配置、隐私说明、更新日志 |

**完整的使用说明、安装步骤、输入输出示例在 [`personal-os/README.md`](personal-os/README.md)。**

## 快速开始

需要 Node.js 18+：

```bash
cd personal-os
npm install
npm run dev          # http://127.0.0.1:5173
```

想用语义搜索（本地向量模型，无需联网）再跑一次：

```bash
npm run model:setup  # 下载中文向量模型，国内镜像优先
```

打包桌面应用（需 Rust 工具链）：

```bash
npm run tauri:build
```

## 技术栈

React 18 · TypeScript · Vite · Tailwind · Dexie(IndexedDB) · MiniSearch
· transformers.js + bge-small-zh（本地语义检索）· pdf.js · tesseract.js · Tauri 2

约束：**零外链**，构建产物不引用任何 CDN、远程字体或远程脚本。

## 许可

[MIT](LICENSE)。第三方依赖许可见
[`docs/THIRD-PARTY-NOTICES.md`](docs/THIRD-PARTY-NOTICES.md)，隐私说明见
[`docs/PRIVACY.md`](docs/PRIVACY.md)。
