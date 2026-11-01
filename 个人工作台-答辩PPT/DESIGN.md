# DESIGN.md · 个人工作台答辩 PPT

## ① 画布与安全区

- 画布 1280×720；padding 上下 60 / 左右 60；内容区 1160×600
- 页尾 y=670（14px，仅内容页）

## ② 配色（未来紫蓝 · 深底）

| 槽位 | Hex | 用途 |
|---|---|---|
| 底色 | `#0B1020` | 页面背景 |
| 主色 | `#4F46E5` | 标题栏、编号、主色块、强调线 |
| 辅色 | `#22D3EE` | 卡片描边、第二序列、关键标注 |
| 强调 | `#F0ABFC` | 巨型数字、唯一焦点（每页 ≤2 处） |
| 卡片底 | `#151B33` | 卡片/面板填充 |
| 正文 | `#E2E8F0` | 主文字 |
| muted | `#94A3B8` | 次级文字、脚注 |

## ③ 字体

- 中文：Microsoft YaHei；数字/英文：Consolas（仅巨型数字与代码）
- 字号：封面主标 72 / 页面主标 34 / 卡片小标 24 / 正文 18 / 脚注 14 / 巨型数字 96

## ④ 视觉母题

标题下 1px 贯通细线（`#22D3EE` 40% 透明），全篇复用；左下角 L3 徽标（24×24 圆点）。

## ⑤ 配图清单

| 文件 | 等级 | 来源 | 使用页 |
|---|---|---|---|
| `today.png` | L2 | 实机截图 | P2 / P8 |
| `calendar.png` | L2 | 实机截图 | P2 |
| `inbox.png` | L1 | 实机截图 | P8 |
| `search-fulltext.png` | L2 | 实机截图 | P9 |
| `semantic.png` | L1 | 实机截图 | P9 |
| `ask.png` | L1 | 实机截图 | P9 |
| `settings.png` | L2 | 实机截图 | P14 |
| `graph.png` | L2 | 实机截图 | P2 |
| 架构图 | L1 | SVG | P6 |
| Agent 链路图 | L1 | SVG | P5 |

## 页面规划（17 页）

| 页 | 类型 | 角色 | 版式 | 内容 |
|---|---|---|---|---|
| 1 | cover | hero | 大字报 + 几何 | 封面 |
| 2 | content | hero | 拼贴 + 大字 | 项目概述 |
| 3 | content | supporting | 左标题色块 + 右表 | 问题与目标 |
| 4 | content | supporting | 三栏非均分 | 整体方案与选型 |
| 5 | content | hero | 流程链 SVG | Agent 三条链路 |
| 6 | content | supporting | 架构图 SVG 满版 | 系统架构 |
| 7 | content | supporting | 对比式 | 本地优先 vs 云可选 |
| 8 | content | supporting | 左图右文 | 结果：收集箱解析 |
| 9 | content | supporting | 上图下文 + 表 | 结果：三种检索 |
| 10 | content | hero | 巨型数字 | 结果：信息流正文 60/75 |
| 11 | content | hero | 一句独白 | 端到端价值 |
| 12 | content | supporting | 左标题色块 + 右代码 | 工程化：复现 |
| 13 | content | supporting | 表格 + 结论条 | 工程化：异常处理 |
| 14 | content | supporting | 左图右文 | 工程化：可靠性与可观测性 |
| 15 | content | supporting | 数据展示 | 成本与性能取舍 |
| 16 | content | supporting | 两栏对比 | 总结与不足 / 下一步 |
| 17 | ending | hero | 收束金句 + 落款 | 结尾 |
