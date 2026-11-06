# Bootstrap 设计语言接入说明

本文件说明 Bootstrap 5.3.8 在本仓库中的角色：**它是被引用的设计语言基线，不是被全局加载的样式表**。实际渲染只发生在 `static/bootstrap-scope.css` 定义的 `.bs-scope` 作用域内。

## 1. 为什么引入

本项目已有 `design.md` 作为唯一设计依据，但任务栏插件与独立设置窗口此前缺少稳定的**布局刻度**。Bootstrap 5 提供的是成熟、可验证的刻度语义，而不是视觉风格：

- **间距刻度**：以 4px 为基准的 0/4/8/16/24/48 六档（`$spacer: 1rem`），与项目 8 点栅格重合，能直接消除各处 `margin:13px` 之类的随手值。
- **栅格**：12 栏、12 的因数多（2/3/4/6），适合 420 DIP 插件宽度下做 2 栏、主窗做 3–4 栏。
- **表单与表格密度**：`.table` 的 `8px 12px` 单元格内边距、表头降级色、末行去线，是可直接复用的紧凑密度。
- **进度条**：轨道 + 百分比条的两层结构，适合把额度/加载进度统一成同一套 DOM。
- **断点语义**：576/768/992/1200/1400 的命名稳定，便于跨窗口沟通，不必每处重新约定。

## 2. 版本与来源与许可

| 项 | 值 |
|---|---|
| 名称 / 版本 | Bootstrap 5.3.8（5.3.x 最新） |
| 获取方式 | `npm pack bootstrap@5.3.8` 到 `%TEMP%`，解包后取 `package/dist/css/bootstrap.min.css` |
| 上游来源 | `https://registry.npmjs.org/bootstrap/-/bootstrap-5.3.8.tgz` |
| 上游完整性 | `sha512-HP1SZDqaLDPwsNiqRqi5NcP0SSXciX2s9E+RyqJIIqGo+vJeN5AJVM98CXmW/Wux0nQ5L7jeWUdplCEf0Ee+tg==`（npm `dist.integrity`） |
| 文件 | `static/vendor/bootstrap/bootstrap.min.css`（232112 字节，上游 232111 字节 + 1 个尾随换行） |
| SHA-256 | `3adcc6d93321c336da2db20002b8a2361dbbcc5d58af418147616b8b376b9ef2` |
| 许可证 | MIT，Copyright (c) 2011-2025 The Bootstrap Authors |

`bootstrap.min.css` 为**逐字节上游副本**，仅追加一个换行，未做任何改写、压缩或裁剪。**未**引入 `bootstrap.bundle.js`、CSS 变量变体、RTL 变体或 SCSS 源码。

## 3. 许可与摘要位置

- 许可证原文：`static/vendor/bootstrap/LICENSE`（上游 `LICENSE`，逐字副本）。
- 来源与摘要：`static/vendor/bootstrap/SOURCE.json`（`name`/`version`/`source`/`file`/`sha256`/`license`/`vendoredAt`/`notes`）。
- 项目级第三方清单 `THIRD_PARTY_NOTICES.md` 由 Lead 统一登记，本目录不重复维护该清单。

## 4. 引入方式（仅 `.bs-scope` 生效）

规则只有一条：**`bootstrap.min.css` 不得被任何现有页面全局链接**。它之所以必须存在于仓库，是为了：

1. 作为设计对照与审计基线（核对某个刻度究竟来自上游哪个变量）；
2. 在将来确需完整上游工具类的**独立文档**里，作为一次性参考加载。

实际接入分两层：

| 层 | 文件 | 作用 |
|---|---|---|
| 参考层 | `static/vendor/bootstrap/bootstrap.min.css` | 只读基线，不参与构建、不进入任何现有页面 `<link>` |
| 作用层 | `static/bootstrap-scope.css` | 项目自有的小体量适配样式，**只对 `.bs-scope` 容器及其后代生效** |

接入方式：给需要 Bootstrap 语义的容器加 `class="bs-scope"`，再在容器内使用 `.bs-card` / `.bs-table` / `.bs-grid` / `.bs-col-*` / `.bs-gap-*` / `.bs-stack` / `.bs-inline` / `.bs-muted` / `.bs-badge` / `.bs-progress` + `.bs-progress__bar`。这些类**不会**影响作用域外的任何节点。

`static/bootstrap-scope.css` 本身也需要被引用（与 `theme.css` 同一挂载点、同一顺序：主题令牌在前，作用层在后），但**不得**改写为全局选择器。若某个独立窗口无法引用外部 CSS，只能把该文件内容整体内联，仍保留 `.bs-scope` 前缀。

## 5. 与 design.md 令牌的对应关系

作用层不新增任何品牌色，所有值都指向项目令牌；括号内为令牌缺失时的回退值。

| Bootstrap 5.3 变量 | 上游默认值 | 本项目令牌 |
|---|---|---|
| `--bs-body-font-size` | `1rem` (16px) | `var(--text-ui-base, 14px)` |
| `--bs-body-font-family` | `var(--bs-font-sans-serif)` | `var(--font-ui, "Segoe UI Variable", "Microsoft YaHei UI", system-ui, sans-serif)` |
| `--bs-body-color` | `#212529` | `var(--ink, currentColor)` |
| `--bs-body-bg` | `#fff` | `var(--surface, transparent)` |
| `--bs-emphasis-color` | `#000` | `var(--ink, currentColor)` |
| `--bs-secondary-color` | `rgba(33,37,41,.75)` | `var(--ink-2, currentColor)` |
| `--bs-tertiary-bg` | `#f8f9fa` | `var(--surface-soft, transparent)` |
| `--bs-border-color` | `#dee2e6` | `var(--line, currentColor)` |
| `--bs-border-width` | `1px` | `1px`（不缩放） |
| `--bs-border-radius` | `.375rem` (6px) | `var(--radius-sm, 4px)`（当前令牌解析为 8px） |
| `--bs-border-radius-sm` | `.25rem` (4px) | `var(--radius-sm, 4px)`（当前令牌解析为 8px） |
| `--bs-border-radius-lg` | `.5rem` (8px) | `var(--radius, 8px)`（当前令牌解析为 14px） |
| `--bs-border-radius-pill` | `50rem` | 不映射：胶囊由组件自身负责 |
| `--bs-link-color` / `--bs-link-hover-color` | `#0d6efd` | `var(--accent, currentColor)` |
| `--bs-primary` | `#0d6efd` | `var(--accent, currentColor)` |
| `--bs-card-bg` | `var(--bs-body-bg)` | `var(--color-card, var(--surface, transparent))` |
| `--bs-card-border-color` | `rgba(0,0,0,.175)` | `var(--line, currentColor)` |
| `--bs-card-spacer-x/y` | `1rem` | `16px` |
| `--bs-table-cell-padding-*` | `.5rem` | `8px 12px` |
| `--bs-table-color` | `var(--bs-emphasis-color)` | `var(--ink, currentColor)` |
| `--bs-table-border-color` | `var(--bs-border-color)` | `var(--line, currentColor)` |
| `--bs-badge-*` | `.65em/.35em`、`.75em` 字号、`#fff` 文字 | `2px 8px`、`var(--text-ui-xs, 11px)`、`var(--ink-2)` |
| `--bs-progress-height` | `1rem` (16px) | `8px` |
| `--bs-progress-bg` | `var(--bs-secondary-bg)` | `var(--surface-soft, transparent)` |
| `--bs-progress-bar-bg` | `#0d6efd` | `var(--accent, currentColor)` |
| `--bs-progress-bar-transition` | `width .6s ease` | `width 140ms cubic-bezier(.22,1,.36,1)`（项目 micro） |
| `--bs-gutter-x` / `--bs-gutter-y` | `1.5rem` / `0` | `16px`（`.bs-grid` 的 `gap`） |

补充约定：

- **阴影**：不映射 Bootstrap 的 `--bs-box-shadow*`。项目 `--shadow` 刻意极轻，卡面靠 1px `--line` 分层。
- **颜色**：深色模式不由 `prefers-color-scheme` 分支处理。`theme.css` / `zcode-tokens.css` 已在 `html[data-theme="dark"]` 上换掉同一批令牌，作用层只需引用令牌即可自动跟随。
- **间距刻度**：Bootstrap 的 0/1/2/3/4/5 对应 `0/4/8/16/24/48`，作用层的 `.bs-gap-*` 与之逐档一致；不使用 `.m-*` / `.p-*` 全套（会与项目既有间距规则冲突）。
- **字体令牌**：项目当前把字体栈写在 `body`（`theme.css`）而非自定义属性，作用层以 `--font-ui` 作为未来令牌位，暂以同一字体栈回退，不擅自新增全局令牌。

## 6. 断点表

| Bootstrap | 语义 | 项目现状 | 处理 |
|---|---|---|---|
| `<576` (xs) | 手机 | 项目用 `max-width: 480/600/700/719/720` 等 | 不提供 xs 前缀，默认单列 |
| `≥576` (sm) | 平板竖屏 | 项目无 576 断点 | 不采用 |
| `≥768` (md) | 平板横屏 | 项目已有 8 处 `768`（含 `dialogs.css`）与 2 处 `760` | **唯一保留**：`.bs-col-md-3/4/6/8/12` |
| `≥992` (lg) | 桌面 | 项目主断点为 `900`（14 处），另有 `1000`/`1023` | 不采用，用 900 |
| `≥1200` (xl) | 宽桌面 | 项目用 `1100`(7 处) / `1150`(4 处) | 不采用 |
| `≥1400` (xxl) | 超宽 | 项目无 | 不采用 |

关系说明：

- **方向相反**：Bootstrap 全部是 `min-width` 移动优先，项目现有 CSS 以 `max-width` 桌面优先。两者不能写在同一个选择器组里，因此作用层只保留 `md` 一档 `min-width`，其余由项目既有断点接管。
- **960 不是断点**：960 是资源管理器窗口 `960×640`、供应商管理窗口 `960×680` 的**固定外框宽度**（见 `AGENTS.md` §6），与栅格无关；真正的布局断点是 900 与 720。
- **720 是容器查询**：`app.css` 用 `@container (max-width:720px)`，插件设置页 `taskbar-settings.css` 也用 `container-type: inline-size`。作用层的栅格默认 `span 12`，在窄容器里天然堆叠，不依赖 `md`。
- **插件宽度**：任务栏详情默认 `420×640` DIP，恒小于 768，`.bs-col-md-*` 在插件内**永远不会生效**。插件页面请只用 `.bs-col-*` 与 `.bs-gap-*`，或按容器查询自行分栏。

## 7. 禁止事项

1. **不得**在 `index.html`、`preview.html`、独立插件页或任何现有页面用 `<link>` 全局引入 `bootstrap.min.css`。它是全局 CSS（`:root`、`*`、`h1–h6`、`.btn` 等），一旦引入会污染主应用。
2. **不得**覆盖主应用既有的圆角规则：正文/主体 10px、共享窗口 4px、输入 10px、弹窗 20px。Bootstrap 的 `.25rem/.375rem` 默认值不得反向替换这些值。
3. **不得**用 Bootstrap 的 JS 组件（`dropdown`/`modal`/`tooltip`/`collapse`/`offcanvas`）替换 `JellyRadio`、`SquishSwitch`、`SwipeToast`、共享下拉与浮层等既有原生实现。本仓库未 vendored 任何 Bootstrap JS。
4. **不得**把 `.btn`、`.form-control`、`.form-select`、`.card` 等上游类直接套到既有控件上——继续复用项目的 `.btn` 与共享输入样式，只用作用层的 `.bs-*` 类。
5. **不得**在 `.bs-scope` 之外书写任何 Bootstrap 相关覆盖，也不得用更高优先级去补 `.bs-scope` 内实例。
6. **不得**为迁就 Bootstrap 默认值修改 `design.md` 令牌。令牌是唯一依据，Bootstrap 只提供刻度与结构。
7. **不得**在作用层里硬编码品牌色（`#0d6efd`、`#212529` 等一律禁止），也不得新增 `prefers-color-scheme` 分支。

## 8. 采纳 / 拒绝清单

**采纳**

- 4px 基准的间距刻度（0/4/8/16/24/48）→ `.bs-gap-*`。
- 12 栏栅格概念 → 用 CSS Grid 重写为 `.bs-grid` + `.bs-col-*`（不用 `.row` 的负 margin + 浮动）。
- 表格密度与分隔线语义 → `.bs-table`（`8px 12px`、表头 `--ink-2`、末行去线、行悬停 `--surface-soft`）。
- 进度条的 track + bar 结构与宽度百分比驱动 → `.bs-progress` + `.bs-progress__bar`。
- 卡片的表面 + 1px 边框 + 固定内边距结构 → `.bs-card`。
- 徽标与次要文字层级 → `.bs-badge`、`.bs-muted`。
- 断点命名语义（仅取 `md = 768`）。

**拒绝**

- Reboot 全局重置（`*` 盒模型、标题、`hr`、`body` 背景）：会与 `app.css` 主外壳冲突。
- Bootstrap 调色板：`#0d6efd` 蓝、`#212529` 正文、`#dee2e6` 边框、`#f8f9fa` 浅底。
- 圆角默认值 `.25/.375/.5rem`（项目为 4/8/10/14/20px 分档）。
- 16px 正文基准（项目为 14px 且随字号设置缩放）。
- `.container` / `.container-fluid` 固定宽度体系（项目用 flex 布局 + 240/64px 侧栏）。
- `offset-*` / `order-*` / `align-*` / `justify-*` / 全部 `.m-*` `.p-*` 工具类：与项目既有间距规则重复且易冲突。
- 阴影体系 `--bs-box-shadow*`（项目 `--shadow` 刻意极轻）。
- 576/992/1200/1400 断点前缀与 RTL 变体。
- Bootstrap JS 全部组件（`bootstrap.bundle.js`）。
- 主题变量块 `[data-bs-theme]`：项目用 `html[data-theme]`，两套主题开关不得并存。

## 9. 校验

实际执行过的命令与输出（`node` v24.16.0，`pwsh`）：

```powershell
# 1) 摘要核对：把磁盘文件的 SHA-256 与 SOURCE.json 记录比对
node -e "const fs=require('fs'),c=require('crypto');const p='static/vendor/bootstrap/bootstrap.min.css';const h=c.createHash('sha256').update(fs.readFileSync(p)).digest('hex');const rec=JSON.parse(fs.readFileSync('static/vendor/bootstrap/SOURCE.json','utf8')).sha256;console.log('file   :',h);console.log('record :',rec);console.log('MATCH  :',h===rec);"
# file   : 3adcc6d93321c336da2db20002b8a2361dbbcc5d58af418147616b8b376b9ef2
# record : 3adcc6d93321c336da2db20002b8a2361dbbcc5d58af418147616b8b376b9ef2
# MATCH  : true

# 2) 作用层结构核对：括号配平 + var() 闭合 + 行数
node -e "const s=require('fs').readFileSync('static/bootstrap-scope.css','utf8');let d=0;for(const c of s){if(c==='{')d++;else if(c==='}')d--;if(d<0)throw new Error('unbalanced');}if(d!==0)throw new Error('depth '+d);let n=0;for(let i=0;i<s.length;i++)if(s.startsWith('var(',i)){n++;let j=i+4,g=1;while(j<s.length&&g>0){if(s[j]==='(')g++;else if(s[j]===')')g--;j++;}if(g)throw new Error('var() open');}console.log('ok', s.split(/\r?\n/).length, 'lines,', n, 'var() calls');"
# ok 152 lines, 50 var() calls
```

浏览器侧另做过一次计算值抽查（Playwright + Chromium，页面来自 `%TEMP%`，只在 `<style>` 中内联 `theme.css` 与 `bootstrap-scope.css`）：

| 检项 | 浅色 | 深色（`data-theme="dark"`） |
|---|---|---|
| `.bs-card` 背景 | `rgb(255,255,255)` = `--surface` | `rgb(25,35,48)` = `--surface` |
| `.bs-card` 文字 | `rgb(24,43,67)` = `--ink` | `rgb(228,237,248)` = `--ink` |
| `.bs-progress__bar` | `rgb(37,99,235)` = `--accent` | `rgb(121,168,255)` = `--accent` |
| 字号 | `14px` = `--text-ui-base` | 同 |

即：深色切换完全由令牌驱动，作用层内没有任何 `prefers-color-scheme` 分支。
