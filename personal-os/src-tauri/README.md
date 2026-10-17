# 桌面壳（Tauri）

同一套前端 + 一个系统窗口，补上浏览器给不了的三件事：

1. **系统级全局悬浮球**——独立小窗，永远置顶，不在任务栏显示
2. **全局快捷键**——默认 `Alt+Space`，任何界面都能唤出悬浮球
3. **真文件系统**——附件可以直接写到你的磁盘目录，不再困在浏览器沙箱

另外：原生系统通知（关掉窗口也能弹）、托盘图标（右键打开/快速收录/退出）。

## 编译前提

| 依赖 | 说明 |
|---|---|
| Rust | `winget install Rustlang.Rustup` 或 https://rustup.rs ，装完重启终端 |
| Visual Studio Build Tools | 勾选「使用 C++ 的桌面开发」（约 2~6GB） |
| WebView2 | Windows 11 自带 |

**本机状态（2026-10-11 实测）**：Rust 1.99.0 ✓、VS BuildTools 18（MSVC 14.51）✓、
Windows SDK 10.0.26100 ✓、WebView2 154 ✓。`cargo check` 已通过。

### ⚠️ 必须关掉 Windows 智能应用控制（Smart App Control）

否则会报 `应用程序控制策略已阻止此文件。(os error 4551)`——
cargo 临时生成的未签名构建脚本 exe 会被拦，几百个 crate 编完但 build script 跑不起来。

关闭：Windows 安全中心 → 应用和浏览器控制 → 智能应用控制 → 关闭
（可一键打开该页：`Start-Process "windowsdefender://appbrowser"`）

**注意：关掉后无法重新开启，除非重装系统。** 开发 Rust 项目基本都得关。

## 跑起来

```bash
npm install
npm install -D @tauri-apps/cli@^2   # CLI 体积较大，装一次即可
npm run tauri:dev      # 开发：会先起 vite dev server，再开桌面窗
npm run tauri:build    # 打包：产出 msi / nsis 安装包
```

图标已生成在 `src-tauri/icons/`，需要重画用 `npm run icons`（需要 python）。

## 前端怎么区分环境

`src/core/adapters/desktop.ts` 用 `window.__TAURI_INTERNALS__` 判断：
有就用原生能力，没有就降级到 Web 实现（`Notification` API、OPFS）。
**所以同一份代码在浏览器和桌面壳里都能跑**，只是能力不同。

小窗模式：`index.html?quick=1`，桌面壳的悬浮球窗口加载的就是这个地址，
前端据此隐藏侧边栏、只显示快速收录面板。

## 已知要点

- CSP 里放行了 `api.deepseek.com` 与 `localhost:11434`，
  如果你换 AI 服务商，记得同步改 `tauri.conf.json` 的 `app.security.csp`。
- 首次编译 Tauri 很慢（几分钟，要编几百个 crate），之后是增量的。
- 全局快捷键如果和系统/其它软件冲突，改 `main.rs` 里的 `Alt+Space` 即可。
