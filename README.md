<div align="center">
  <img src="static/assets/lingxi-logo.svg" alt="灵犀工作坊" width="100">
  <h1>灵犀工作坊</h1>
  <p><em>把日常工作、AI 用量、提示词与本机技能放进一个个人工作台。</em></p>
  <a href="https://github.com/Ceeyu-iooi/Lingxi-Workspace/releases"><img src="https://img.shields.io/github/v/release/Ceeyu-iooi/Lingxi-Workspace?include_prereleases&amp;style=flat-square&amp;color=2962ed" alt="最新发布"></a>
  <img src="https://img.shields.io/badge/Windows-x64-2962ed?style=flat-square" alt="Windows x64">
  <img src="https://img.shields.io/badge/TypeScript-React%20%2B%20Node-2962ed?style=flat-square" alt="TypeScript">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-CC--BY--NC--4.0-64748b?style=flat-square" alt="许可证"></a>
</div>

<p align="center"><a href="#安装">安装</a> · <a href="#功能特性">功能特性</a> · <a href="#app-数据">App 数据</a> · <a href="#从源码构建">从源码构建</a> · <a href="#工作原理">工作原理</a> · <a href="#设置">设置</a></p>

## 灵犀工作坊是什么？

灵犀把项目、待办、账单、提示词与 AI 用量放在一个本地工作台。你可以查看工作安排、核对消费、整理常用提示词，也可以在 Windows 任务栏随时查看 Codex 剩余额度。

选择一个资料文件夹（Profile）即可开始，无需注册灵犀账户。Windows 桌面版开箱即用；公开源码可自行运行网页版。两者的资料独立保存，不会自动合并。

## 支持的工具与来源

| 来源 | 本机用量证据 | 余额、额度与账单 | 说明 |
|---|---|---|---|
| Codex | sessions / archived_sessions 的 token_count | 本机已授权账户的官方活动与额度 | 官方汇总与本机明细分开 |
| ZCode | CLI SQLite 与响应日志 | GLM 供应商接口能力 | 数据库证据优先，无法证明重叠时不相加 |
| DeepSeek Harness | JSONL / 多帧 Zstandard 会话日志 | DeepSeek 供应商接口能力 | 只保留最小用量证据 |
| API 供应商 | 真实 API 响应、授权历史接口或导入 | DeepSeek、GLM、OpenRouter、New API、Sub2API、硅基流动、Moonshot、MiniMax、LMU、自定义查询 | 各平台与 Key 的能力不同，不按余额反推 Token |

来源未返回、模型缺失、价格未知和查询失败不会被填成零。安装了某个 Agent，不代表获得它的全部历史。

## 界面展示

![总览界面](docs/images/overview.png)

截图使用独立 Profile 的合成示例资料，不展示个人数据。

浅色与深色主题、六套配色、字号和页面缩放可以按习惯调整。侧栏可收起，筛选和滚动位置在切换页面后保留。Windows 任务栏双环提供独立的用量详情。

[设计规范](design.md) · [浅色预览](frontend/app/preview.html) · [深色预览](frontend/app/preview-dark.html)

## 为什么用灵犀工作坊？

- 工作记录与 AI 使用证据放在同一个个人工作台，减少来回整理。
- 资料留在自己选择的位置，网页和桌面保持独立，不自动合并。
- Token、供应商实际账单与参考等价值分开，缺口有证据说明。
- 不同模块沿用统一主题、圆角、编辑与保存交互。

## 功能特性

| 模块 | 功能 |
|---|---|
| 总览与项目 | 自建项目与待办、甘特排期／列表、主题与时间地点识别、进度与月度总结 |
| 热点与记账 | 热点聚合；CSV／XLSX 账单导入、收支趋势、资金来源与去向、交易筛选 |
| 用量监测 | 日志证据、供应商余额与账单、多 Key、日期与任意多模型筛选 |
| 历史参考计价 | 为 Codex 用量提供 USD／CNY 参考金额，保留缺价和分项说明 |
| 任务栏插件（桌面版） | 五小时与周额度双环，点击查看用量、趋势及模型；位置、颜色、主题与材质可调 |
| 提示词 | 分类、编辑、版本、导入导出、模板市场、按需 AI 评估与优化 |
| 本机技能 | 登记目录、只读扫描、搜索、来源和原文查看，不执行技能脚本 |
| Profile 与资料 | 可改用户名及头像、加密完整备份、受控迁移、资料空间统计 |

仅 Codex 提供可选的历史参考计价，默认关闭。首次开启会准备已有记录的价格与汇率；之后只在显式刷新时更新。参考金额与真实账单分别显示，缺少价格或用量分项时保持未知。

## 安装

在 [Releases](https://github.com/Ceeyu-iooi/Lingxi-Workspace/releases) 下载 Windows x64 安装版。下载页面提供安装包与 SHA-256 摘要，可用于核对文件完整性。当前提供安装版，不提供便携版。

| 包 | 使用方式 |
|---|---|
| `Lingxi-Workbench-版本-x64-Setup.exe` | 安装与升级；默认 Profile 跟随安装目录，可选择其他可写位置 |

桌面附带 Node 运行时，无需另外安装 Node 或 Python。卸载保留 Profile。当前未配置发布者代码签名，摘要校验与签名验证是两件事。

### 首次启动

选择或创建 Profile 资料位置，填写用户名，然后按需连接 Codex、ZCode、Harness 和供应商用量 Key；监测与 Key 都可稍后设置。引导中断后可继续，也可从“数据与备份”重新打开。新 Profile 默认浅色，后续尊重已保存主题。

每次启动自动检查更新一次，与开屏并行且最多额外等待3秒；从其他应用返回主页面、关闭最后一层独立界面返回主页面时再次检查，同次事件合并；有更新时用户名右侧显示更新按钮。“关于”保留手动检查，不自动下载或安装。安装版按用户确认下载完整包并重启安装。已使用安装包在新后台和页面就绪后清理，尚待安装的新版本保留。0.0.28 及以前需先手动升级到支持检查更新的版本。

## 多设备与局域网访问

当前支持可选局域网访问同一个网页实例，不提供自动多设备 Profile 同步。默认仅监听本机。可在本机“数据与备份 → 局域网访问”保存范围并正常退出、重启后台，或设置 `WORKBENCH_HOST=0.0.0.0`。连接凭证要求由当前Profile的配置决定；取消凭证要求后，局域网设备直接进入工作坊。

也可在 Profile 的 `config/web-server.json` 写入 `{"host":"0.0.0.0"}`。环境变量优先，`WORKBENCH_PORT` 默认 8765。已有服务不会被启动入口擅自重启；如果无法连接，先核验实际监听与本机网络配置。

## App 数据

| 位置 | 内容 |
|---|---|
| `.profile.json` | 不可变 profileId、用户名与创建信息 |
| `data/storage/workbench.sqlite` | 业务、提示词、用量、价格证据及派生缓存 |
| `data/credentials/` | 服务端凭据，禁止公开分发 |
| `backups/` | 完整加密 `.lxprofile` 备份 |
| `config/`、`workspace/` | 设置、维护配置和工作区 |
| `browser/`、`logs/`、`runtime/`、`updates/` | 桌面浏览器资料、日志、生命周期状态与临时更新包 |

网页版默认使用源码目录的 `profile`；桌面默认使用程序目录的 `profile`，两者独立。桌面 Cookie、草稿及缓存在 Profile 的 `browser`，崩溃记录在 `runtime/crashes`，新安装不额外建立 AppData/Roaming 资料目录。旧账户结构不会自动迁成新版 Profile；在资料目录中发现旧结构时明确提示。

“数据与备份”包含业务、工作区、设置、用户名、头像与凭据的完整 Profile 口令加密备份；口令不保存在浏览器、日志或 URL 中，丢失后无法解密。恢复前生成加密预备份、核验并事务应用。备份排除更新包、浏览器临时缓存、日志及备份自身。不要直接复制正在写入的 SQLite；受控迁移会先停写、校验及原子切换，原副本保留至明确清理。任何系统恢复资料均不得作为公开附件上传。

## 从源码构建

需要 **Node.js 24 LTS** 与首次安装依赖时的网络。网页版无需 Electron、Python、私有仓库或 API Key。

```shell
npm ci
npm run build:web
npm start
```

打开 **http://127.0.0.1:8765/**。Windows 可运行 `start.bat`，它显示启动状态，后台身份与版本核验后打开浏览器。保留运行窗口，按 Ctrl+C 正常退出。即使从其他目录调用启动脚本，资料仍按该副本定位。

局域网监听可在资料设置中启用。当前 Profile 的 `config/web-server.json` 设置 `requireAccessToken: false` 时，局域网设备可直接访问；未设置时仍需要实例凭证。本机维护、更新安装与凭据配置接口继续仅允许本机使用。

```text
Lingxi-Workspace/
├── start.bat                       # Windows 快捷启动
├── src/server/                     # Node TypeScript 服务与业务
├── src/shared/                     # 共享接口和默认值
├── frontend/app/                   # React 页面入口
├── frontend/compat/                # 原有交互的兼容适配
├── frontend/application-assets.json# 第三方集成成品摘要
├── static/                         # 样式、字体、图表及组件成品
├── scripts/                        # 构建、启动与维护入口
├── docs/                           # 架构、资料边界与使用说明
├── profile/                        # 启动后产生的私有资料
└── .runtime/                       # 可重建构建与私有定位
```

Vite 构建到 `.runtime/web-ui`，Node 后端构建到 `.runtime/server`。开发前端热更新可运行 `npx vite --config vite.app.config.mts`，其 API 代理需要单独启动后端。正式网页与桌面均不启用开发 HMR；服务端修改需要重启，前端发布更新需要刷新或重启。

## 工作原理

![TypeScript 技术架构](docs/images/architecture.svg)

React 管理应用壳、路由与页面入口，现有编辑器和图表通过兼容适配保留交互；新入口、共享契约和后端采用严格 TypeScript，兼容控制器尚未全面严格类型化。Fastify 提供本机 HTTP，SQLite 保存资料，Decimal 处理金额，Sharp 处理头像，YAML 与 Node Zstandard 支持技能结构和日志解码。

用量采集核验原始证据、去重与归属；累计值、缓存子集和推理子集不会重复相加。价格按 UTC 消费日期、汇率按上海日期取历史证据，最多沿用此前七日，不使用未来汇率。更多见[架构与资料流](docs/ARCHITECTURE.md)、[用量来源及限制](docs/USAGE.md)及[TOKEN_ACCOUNTING](TOKEN_ACCOUNTING.md)。图的表达参考 [C4 容器图](https://c4model.com/diagrams/container)，采用本项目自绘 SVG。

## 会话数据保留期

仅保留核验所需的最小用量证据、元数据与读取进度，不保留 Agent 聊天正文或附件。SQLite 使用整数关联、无损证据块与精确金额表示保存用量，迁移保留原库恢复基线；明细按需解压，日常使用增量派生与局部空间回收。本机业务与历史证据不会按固定天数自动删除；清理派生计价缓存不会删除真实消费、价格与汇率证据。日志原文在用户登记的外部目录，不随 Profile 迁移或清理。

## 设置

- 个人资料：用户名、头像上传与移除。
- 外观：浅色、深色、系统主题，强调色、字号、亮度、减少动画、菜单语言与办公/编程模式；预览、保存和放弃各自明确。
- AI 服务：服务商、模型、API 地址与 Key；仅可选 AI 操作需要凭据。
- 用量与实验：登记日志位置、控制采集与可选 AI 功能。
- 任务栏插件（桌面版）：直接设置双环位置、颜色、重置时间及详情外观和内容。任务栏不支持内嵌或空间不足时，会提供靠近任务栏的独立入口。
- 数据与备份：加密完整 Profile、恢复、空间统计、受控迁移与可选局域网。
- 快捷键：搜索、侧边栏与设置，支持不重复的 Ctrl/Meta 组合。

## 隐私

凭据仅留在服务端 Profile，不进入前端、普通提示词导出、日志或公开 Git；只在用户口令加密的完整 Profile 备份中携带。AI 内容仅在用户点击评估、优化或识别时发送到已配置服务，供应商查询仅访问所配置的平台，默认不跟随重定向。技能扫描仅限登记目录，不执行 SKILL.md 或脚本。

公开源码不包含个人路径、账户、密钥、真实用量截图、Agent 日志原文、内部验收回执或私有桌面构建工具。

## 常见问题

| 情况 | 处理方式 |
|---|---|
| 8765 被占用 | 核验已有服务身份，或明确指定其他端口，不连接未知程序 |
| Node / 依赖缺失 | 安装 Node.js 24 LTS，在该副本运行 `npm ci` |
| 组件摘要失败 | 获取对应版本成品，不从失效下载地址猜测替代组件 |
| 没有 Agent 用量 | 核验实际日志目录与来源状态，不生成不存在的历史 |
| 金额未知 | 检查模型归属、原始分项、历史价格与汇率缺口 |
| 更新失败 | 保留当前版本，检查网络、磁盘和摘要后重试，不覆盖运行中的程序 |

## Star 历史

[查看项目关注与贡献情况](https://github.com/Ceeyu-iooi/Lingxi-Workspace/stargazers)。

## 参与贡献

欢迎通过公开仓库 Issue 提交可复现的问题与界面建议，请使用合成资料和脱敏截图。开发前可阅读 [架构说明](docs/ARCHITECTURE.md)、[设计规范](design.md)与[用量计算约定](TOKEN_ACCOUNTING.md)。提交改动时，请说明复现步骤、预期结果和实际验证范围。

## 致谢

感谢 React、Vite、Node.js、Fastify、SQLite 与相关开源依赖。安装器留白与设置布局参考 DeepSeek Harness；组件、字体、图标和来源见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。页面组织参考 [Token Monitor](https://github.com/Javis603/token-monitor)，具体功能以本项目为准。

## 许可证

项目采用 [CC BY-NC 4.0](LICENSE)。仓库携带应用内集成的组件 JS/CSS 成品及业务源码，付费第三方原文件不公开，默认构建不重新编译这些组件，也不依赖失效下载地址。成品摘要见 `frontend/application-assets.json`，对应许可见 `static/vendor/`；它们随应用提供，不是可独立销售或分发的组件库。
