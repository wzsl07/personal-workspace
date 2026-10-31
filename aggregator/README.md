# 信息聚合模块（aggregator）

个人工作台的可选模块：订阅 RSS / 公开 JSON 接口 / 网页公告，定时抓取、按来源与栏目分类浏览。

**数据全部存在本机**（SQLite 单文件），不上云、不需要账号。来源由你自己添加，没有内置列表。

---

## 怎么跑起来

**最简单：双击 `启动工作台.bat`**

它会自动检查 Python 和依赖（缺了就装）、启动服务、打开浏览器。
地址固定 `http://127.0.0.1:8787/`，不用记端口。

停止服务：在那个黑窗口里按 `Ctrl + C`。

<details>
<summary>手动启动 / 换端口 / 命令行用法</summary>

```bash
cd aggregator
python -m pip install -r requirements.txt      # 一条命令装依赖
python main.py                                  # 起服务 + 自动开浏览器
```

换端口：`set AGG_PORT=8899`（Windows）后再启动。
只起服务不弹浏览器：`set AGG_NO_BROWSER=1`。

命令行（不启动界面也能用）：

```bash
python cli.py detect <网址>        # 自动探测来源类型与解析规则
python cli.py add --name X --url <网址> --type rss
python cli.py fetch --all          # 抓一次
python cli.py items --source 4 --section 通知公告
python cli.py sections             # 看各来源识别出的栏目
python cli.py runs                 # 看抓取日志
```

</details>

---

## 三种来源类型

| 类型 | 适用 | 规则怎么定 |
|---|---|---|
| `rss` | RSS / Atom 订阅源 | 不用规则 |
| `json` | 公开 JSON 接口 | 路径表达式取数组 + 字段映射 |
| `html` | 普通网页 | CSS 选择器（列表容器 / 标题 / 链接 / 时间 / 摘要） |

**添加来源时只需要粘贴一个网址**，系统会依次尝试：
网址本身是 feed → RSS 自动发现 → 常见 feed 路径 → JSON Feed → 自动分析网页结构。
最后一步会自动生成一份建议规则让你确认，并支持**多栏目**（按网页自身分类拆成
通知公告 / 新闻动态 / 政策文件 等），每个栏目单独限条数。

规则猜不准是正常的 —— 界面上改完点「测试」能立刻看到抽出什么，不入库。

---

## 合规与安全（默认行为）

| 项 | 默认 | 说明 |
|---|---|---|
| robots.txt | **遵守** | 抓取前解析；来源的 `fetch_policy.ignore_robots` 可关（风险自负） |
| User-Agent | 明示工具名与仓库地址 | 可用 `fetch_policy.user_agent` 覆盖 |
| 抓取间隔 | ≥15 分钟，硬下限 5 分钟 | 另加每域名最小间隔 3 秒 |
| SSRF 防护 | **强制开启，不可关** | 只放行 http/https；拒绝内网、环回、链路本地（含云元数据）、保留段；**重定向每一跳都重新校验** |
| HTML 清洗 | 白名单过滤 | 移除脚本、样式、`on*` 事件、`javascript:`/`data:` 协议；外链加 `rel="noopener noreferrer"` |
| 版权 | 只存标题 + 摘要 + 原文链接 | 不抓全文，界面保留「查看原文」入口 |
| 凭据 | 加密存储 | token 用 AES-256-GCM 加密；日志与导出脱敏 |

**SSRF 为什么不可关**：来源网址是你自己填的，但"不小心填错"和"别人给你的配置"
都可能指向 `192.168.x.x` 或 `169.254.169.254`。这类请求是从你的电脑发出的，
目标会把你当内网可信方。

---

## 稳定性策略

- **失败退避**：1m → 5m → 15m → 1h → 4h，带 ±10% 抖动；成功即清零
- **自动隔离**：连续失败 5 次自动暂停（界面红点 + 说明），点「重试」清零恢复
- **自适应降频**：连续 3 次没新条目 → 间隔 ×1.5（上限 24h）；有新条目立刻回到设定值
- **省流量**：保存并使用 ETag / Last-Modified，304 直接跳过解析
- **调度**：到期扫描循环（30 秒一轮）+ 并发上限 8 + 每域名串行限速；重启自动恢复
- **保留**：默认每个栏目各留 500 条（来源级 5000 条上限）；时间清理默认关闭

---

## 目录结构

```
aggregator/
├─ main.py              本地服务（API + 后台调度器）
├─ cli.py               命令行入口
├─ run.py               只跑调度循环（不起界面）
├─ 启动工作台.bat        双击启动
├─ core/
│  ├─ models.py         各层共用的数据结构
│  ├─ pipeline.py       主流程：取→解析→归一化→去重→存储
│  ├─ scheduler.py      到期扫描 + 并发池 + 每域名限速
│  ├─ health.py         退避 / 降频 / 隔离策略（纯函数）
│  ├─ detect.py         自动探测降级链
│  ├─ security.py       SSRF 校验 + 凭据加密
│  └─ robots.py         robots.txt 解析与缓存
├─ adapters/http_fetch.py   统一发请求（超时/体积/重定向/SSRF/robots/ETag）
├─ parsers/             rss / json / html_css / auto_extract（可插拔点②）
├─ normalizers/         url / time / text / encoding / sanitize
├─ storage/             db / sources / items / dedup / runs / opml
├─ web/index.html       单页界面（CSS/JS 全内联，零外链）
└─ tests/               自检脚本
```

新增来源类型时**只改 `parsers/` 与 `adapters/`**，主流程零改动。

---

## 自检

```bash
python tests/test_step5.py        # 66 项：稳定性 + 合规 + 安全
python tests/test_time.py         # 时间解析
python tests/test_domain_limit.py # 每域名限速
```

---

## 已知限制

- 复杂首页（多屏、JS 渲染布局）自动提取效果差，需要手工指定选择器
- 需要登录 / 验证码 / Cookie 的页面不支持
- 全文抓取与存储不做（默认只存标题 + 摘要 + 链接）
- 手机端看不到（服务只监听 `127.0.0.1`）
- DNS rebinding 无法完全防御（校验时与连接时的 IP 可能不同）
