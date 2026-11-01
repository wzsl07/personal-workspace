# 个人工作台

> **Personal Workspace** · AI 驱动的个人日程与知识库 —— **让 AI 帮你整理，帮你找到**
>
> 🏆 AI Application 比赛 · **赛道 B（AI Application）** 参赛作品
> 代码仓库：https://github.com/wzsl07/personal-workspace ｜ 许可：MIT ｜ 版本：v0.2.0
> 比赛材料：[专项材料（场景 / 架构 / Agent 流程 / 异常 / Demo / 成本 / 可观测性）](docs/比赛专项材料-赛道B-AI-Application.md)

把随手写的东西，变成日程和知识。和普通日程 / 笔记工具最大的不同在三件事：

1. **AI 真的在帮你干活** —— 粘贴一段班级通知，它拆成带时间和优先级的日程草稿；
   问"学校关于选课的通知说了什么"，它去你的数据里查完再回答，答案带 `[1][2]` 引用。
2. **搜索能按意思找** —— 全文 / 语义 / 问答三种检索并存，**连订阅抓来的信息流正文都能搜**。
3. **信息流自动聚合** —— 几个常看的网站定时抓取、按栏目归类、**自动补正文**，不用再挨个打开。

数据存在你自己的设备上（没有账号、没有服务器），AI 与同步是你要不要开、连哪家的开关 ——
想完全离线也能用，但那不是它的重点。

---

## 目录

| 路径 | 内容 |
|---|---|
| [`personal-os/`](personal-os/) | **项目源码**（前端 + Tauri 桌面壳） |
| [`aggregator/`](aggregator/) | **信息聚合**：订阅 RSS / JSON / 网页公告，定时抓取、按栏目分类浏览 |
| [`docs/`](docs/) | 文档：安装指南、故障排查、同步配置、隐私说明、更新日志、**比赛专项材料** |
| [`docs/shots/`](personal-os/docs/shots/) | 实机截图（今日 / 日历 / 收集箱 / 三种检索 / 设置 / 图谱） |

**搜索与信息流是它最实用的两块**，详细说明（含实测数据）在
[`personal-os/README.md`](personal-os/README.md) 的「检索」与「信息流」两节。

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

## 信息聚合（信息流）

`aggregator/` 是一个独立的 Python 小服务：订阅 RSS / JSON 接口 / 普通网页，
定时抓取、**自动把正文存进本地库**，并按网页自身的栏目分类。桌面版的「信息流」页会读取它，
而**这些正文会一并进入搜索索引** —— 所以你可以按意思搜到三个月前那条通知里写了什么。

实测：5 个源 75 条，60 条拿到正文（8.3 万字）；其中 RSS 源直接从 feed 自带全文字段取，
**不额外发一次请求**，只有网页源才按域名限速抓详情页。

**双击 `aggregator\启动工作台.bat` 即可** —— 它会自动检查 Python 与依赖、
启动服务并打开浏览器，不用记端口和命令。（停止：在那个窗口按 Ctrl + C）

```bash
cd aggregator
python -m pip install -r requirements.txt
python main.py          # 自动打开 http://127.0.0.1:8787
```

它只监听本机，不对外暴露；手机访问不到，所以「信息流」只在桌面版出现。

合规与安全是默认开启的：遵守 robots.txt、明示 User-Agent、抓取间隔不低于 15 分钟、
**拒绝内网地址（含重定向每一跳）**、抓来的富文本经白名单清洗后才渲染、
只存标题+摘要+原文链接、来源里的 token 加密存储。详见 [`aggregator/README.md`](aggregator/README.md)。

## 技术栈

React 18 · TypeScript · Vite · Tailwind · Dexie(IndexedDB) · MiniSearch
· transformers.js + bge-small-zh（本地语义检索）· pdf.js · tesseract.js · Tauri 2

约束：**零外链**，构建产物不引用任何 CDN、远程字体或远程脚本。

## 许可

[MIT](LICENSE)。第三方依赖许可见
[`docs/THIRD-PARTY-NOTICES.md`](docs/THIRD-PARTY-NOTICES.md)，隐私说明见
[`docs/PRIVACY.md`](docs/PRIVACY.md)。
