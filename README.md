<div align="center">
  <img src="static/assets/lingxi-logo.svg" alt="灵犀工作坊" width="88">
  <h1>灵犀工作坊</h1>
  <p>管理项目与待办，查看 AI 用量，整理账单、提示词和本机技能。</p>
  <a href="https://github.com/Ceeyu-iooi/Lingxi-Workspace/releases"><img src="https://img.shields.io/github/v/release/Ceeyu-iooi/Lingxi-Workspace?include_prereleases&amp;style=flat-square&amp;color=2962ed" alt="下载最新版"></a>
  <img src="https://img.shields.io/badge/Windows-x64-2962ed?style=flat-square" alt="Windows x64">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-CC--BY--NC--4.0-64748b?style=flat-square" alt="许可证"></a>
</div>

![灵犀工作坊总览：项目进度、待办与完成情况](docs/images/overview.png)

灵犀工作坊是一个保存在本机的个人工作台。你可以在同一个窗口里安排工作、查看 AI 工具的用量、导入账单和整理常用提示词。截图使用示例资料，不包含个人数据。

[下载 Windows 版](https://github.com/Ceeyu-iooi/Lingxi-Workspace/releases) · [查看功能](#能做什么) · [在浏览器中运行](#在浏览器中运行)

## 开始使用

1. 在 [Releases](https://github.com/Ceeyu-iooi/Lingxi-Workspace/releases) 下载 Windows x64 安装包并安装。
2. 首次打开时，选择资料保存位置，填写用户名。
3. 按需连接 Codex、ZCode、DeepSeek Harness 或供应商账户。你也可以稍后在设置中完成。

桌面版自带运行环境，无需另外安装 Node.js 或 Python。资料保存在你选择的文件夹中，卸载程序会保留资料。当前安装包没有发布者代码签名，下载页面提供 SHA-256 摘要供核对。

有新版本时，左下角用户名旁会出现更新入口。你确认后才会下载和安装；也可以在“设置 → 关于”检查更新。

## 能做什么

| 功能 | 使用方式 |
|---|---|
| 项目与待办 | 创建项目，安排起止时间，用列表或甘特图查看进度，整理月度总结。 |
| AI 用量 | 查看本机日志中的 Token、请求与模型分布，按日期和模型筛选；查询供应商支持的余额与账单。 |
| 任务栏插件 | 在 Windows 任务栏查看 Codex 五小时与每周额度，悬停看提示，点击打开用量详情。 |
| 记账 | 导入 CSV、TSV 或 XLSX 账单，核对后保存，查看支出趋势、分类占比和可筛选的交易明细。 |
| 提示词 | 分类保存、编辑和导入导出，保留版本，按需使用 AI 评估与优化。 |
| 本机技能 | 登记技能目录，搜索名称与原文。只读查看，不执行技能脚本。 |
| 热点 | 查看聚合资讯，按自己的需要浏览与整理。 |

### AI 用量与费用

支持 Codex、ZCode、DeepSeek Harness，以及 DeepSeek、GLM、OpenRouter、New API、Sub2API 等供应商。连接哪种来源，就展示它实际支持的数据；未返回的额度、金额或 Token 会显示为未知。

Codex 可以开启 API 参考计价，按历史模型价格与汇率换算。它用于比较 API 等价值，不代表订阅实际扣费。供应商账单、账户余额与参考计价会分别标明。

DeepSeek 的历史记录授权需要在桌面版的官方登录窗口中完成。网页版可以读取余额，以及已有有效授权支持的数据。

### 任务栏插件

在“设置 → 任务栏插件”中开启。两个双环分别展示五小时与每周额度：外环表示剩余额度，内环表示距重置的时间。中间的时间文字支持调色、调字号和隐藏。

点击双环可打开概览、用量和图表，独立筛选不会改变工作台。详情支持浅深主题、标准或透明材质，以及高度调整。任务栏空间不足或系统不兼容时，入口会显示在任务栏附近。

插件开启时，关闭主窗口会保留任务栏入口与后台监测；从托盘可重新打开工作台。“退出”会完全结束应用。网页版不提供原生任务栏插件。

## 资料与备份

每个资料文件夹（Profile）都有独立的工作内容、连接与设置，无需注册账户。用户名和头像可以修改。

在“设置 → 数据与备份”中，可以用口令导出完整加密备份，也可以恢复或迁移资料。请妥善保存备份口令，丢失后无法解密。不要直接复制正在运行的数据库。

网页版和桌面版使用独立资料，彼此不会自动合并，也不提供自动多设备同步。账单、凭据和备份都属于私人资料，请勿上传到公开仓库。

## 在浏览器中运行

源码版需要 **Node.js 24 LTS**。下载源码后，在项目目录运行：

```shell
npm ci
npm run build:web
npm start
```

然后打开 [http://127.0.0.1:8765](http://127.0.0.1:8765)。Windows 也可双击 `start.bat`。默认资料目录为项目下的 `profile`。

如需让同一局域网的设备访问，可在本机“数据与备份 → 局域网访问”调整范围，然后正常退出并重新启动服务。默认只允许本机访问。

## 主题与快捷操作

设置中提供浅深模式、六套浅色配色、字号和页面缩放。任务栏插件可以保存独立外观。图表支持悬停提示与键盘查看，筛选和页面切换会保留可继续操作的状态。

[设计规范](design.md) · [浅色预览源码](frontend/app/preview.html) · [深色预览源码](frontend/app/preview-dark.html) · [许可证](LICENSE)

本项目按 CC BY-NC 4.0 提供；引用的组件与资源保留各自许可，详见 [第三方说明](THIRD_PARTY_NOTICES.md)。
