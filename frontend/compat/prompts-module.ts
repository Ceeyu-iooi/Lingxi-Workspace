// @ts-nocheck
// Compatibility controller: retain the validated interactions during the React migration.
/* 提示词管理中台：沿用技能管理的模块内上部横向导航与卡片语言（信息架构对照 skills-manager，MIT）。
 * 正文只做文本渲染与变量预览；扫描、预览与模板同步均不执行脚本，数据只来自 /api/prompts*。 */
(() => {
  const U = () => window.WorkbenchUI,
    e = (s) => U().e(s),
    q = (s, r = document) => r.querySelector(s),
    qa = (s, r = document) => [...r.querySelectorAll(s)],
    esc = (v) => e(String(v ?? ""));
  const modal = (title, body, { close } = {}) =>
    U().dialog(title, body, { beforeClose: close });
  const current = (root, owner) =>
    root.isConnected && typeof user !== "undefined" && user?.username === owner;
  const fileData = async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let value = "";
    for (let i = 0; i < bytes.length; i += 8192)
      value += String.fromCharCode(...bytes.slice(i, i + 8192));
    return btoa(value);
  };
  const iconPaths = {
    layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    dashboard: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    refresh: '<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    folderOpen: '<path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
    tag: '<path d="M20.59 13.41 12 22 2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    pin: '<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-1.5-5.5A5 5 0 0 0 12.7 7h-1.4a5 5 0 0 0-4.8 4.5z"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
    list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    spark: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
    chevronDown: '<polyline points="6 9 12 15 18 9"/>',
  };
  const icon = (name, size = 15, cls = "") =>
    `<svg class="skm-ico ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || ""}</svg>`;
  const FORMATS = {
    text: "纯文本",
    markdown: "Markdown",
    rich: "富文本",
    json: "JSON",
    custom: "自定义文本",
  };
  const fmtTime = (iso) => {
    if (!iso) return "未知";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const diff = Date.now() - d.getTime();
    if (diff >= 0 && diff < 60e3) return "刚刚";
    if (diff >= 0 && diff < 36e5) return `${Math.floor(diff / 60e3)} 分钟前`;
    if (diff >= 0 && diff < 864e5) return `${Math.floor(diff / 36e5)} 小时前`;
    return d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  };
  const MODES = [
    ["library", "我的提示词", "fileText"],
    ["market", "模板市场", "globe"],
    ["stats", "使用分析", "dashboard"],
  ];

  function injectCss() {
    if (document.querySelector("link[data-skill-manager-css]")) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/skill-manager.css";
    link.dataset.skillManagerCss = "1";
    document.head.append(link);
  }
  async function prompts(root) {
    const owner = user.username,
      signal = root._wbAbort?.signal;
    const modeParams = {};
    let mode = "library",
      result,
      params = { q: "", sort: "updated", offset: 0, limit: 40, tags: [] },
      selected = new Set(),
      editor = null,
      ticket = 0,
      timer,
      features = { promptAutosave: true, promptAIEnabled: true },
      cache = new Map();
    try {
      features = await U().request("GET", "/api/features", undefined, {
        signal,
      });
    } catch (error) {
      if (current(root, owner)) U().notify(error.message, { kind: "error" });
    }
    if (!current(root, owner)) return;
    root.classList.add("wb-fixed-layout");
    injectCss();
    root.innerHTML = `<div class="skm-app skm-catalog skm-app-prompts" data-skm>
      <header class="skm-topbar" data-skm-topbar aria-label="提示词管理导航"></header>
      <div class="skm-subnav" data-skm-subnav aria-label="提示词筛选"></div>
      <main class="skm-main" data-skm-main><div class="skm-main-scroll"><div data-skm-page></div></div></main>
      <div class="skm-sheet" data-skm-sheet hidden></div>
      <div class="skm-live" aria-live="polite"></div>
    </div>`;
    const app = q("[data-skm]", root),
      top = q("[data-skm-topbar]", root),
      sub = q("[data-skm-subnav]", root),
      page = q("[data-skm-page]", root),
      sheet = q("[data-skm-sheet]", root),
      content = page;
    root._wbUnsaved = () => editor?.dirty || false;
    root._wbDispose = () => {
      clearTimeout(timer);
      editor?.forceClose();
      cache.clear();
    };
    const changedFeatures = (event) => {
      features = { ...features, ...event.detail };
      editor?.syncFeatures?.();
    };
    window.addEventListener("workbench:features", changedFeatures);
    const disposeFeatures = root._wbDispose;
    root._wbDispose = () => {
      disposeFeatures();
      window.removeEventListener("workbench:features", changedFeatures);
    };

    function navItem(view, label, ico, count, extra = "") {
      const active =
        mode === view || (view === "market" && mode === "market");
      return `<button class="skm-nav${active ? " is-active" : ""}${extra}" data-act="mode" data-mode="${view}"${active ? ' aria-current="page"' : ""}>${icon(ico, 15, "skm-nav-ico")}<span class="skm-nav-label">${esc(label)}</span>${count == null ? "" : `<span class="skm-nav-count">${count}</span>`}</button>`;
    }
    function topbarHTML() {
      const total = result?.total ?? 0;
      return `<span class="skm-brand"><span class="skm-brand-mark">${icon("fileText", 15)}</span><span class="skm-brand-name">提示词管理</span></span>
        <nav class="skm-nav-primary" aria-label="提示词管理导航">${MODES.map(([id, label, ico]) => navItem(id, label, ico, id === "library" ? nf(total) : null)).join("")}</nav>
        <div class="skm-topbar-actions">
          <button class="skm-icon-btn" data-act="refresh" title="刷新" aria-label="刷新">${icon("refresh", 15)}</button>
          <button class="skm-btn skm-btn-ghost skm-btn-sm" data-act="import">${icon("upload", 14)}导入</button>
          <button class="skm-btn skm-btn-ghost skm-btn-sm" data-act="export">${icon("download", 14)}导出</button>
          <button class="skm-btn skm-btn-primary skm-btn-sm" data-act="create">${icon("plus", 14)}新建提示词</button>
        </div>`;
    }
    function subnavHTML() {
      if (mode === "stats") return "";
      if (mode === "market") {
        const sources = result?.sources || [];
        if (!sources.length) return "";
        return `<div class="skm-subnav-group"><span class="skm-subnav-label">模板来源</span><div class="skm-subnav-track">
          <button class="skm-nav skm-nav-chip${!params.source ? " is-active" : ""}" data-act="source" data-source="">全部来源</button>
          ${sources.map((s) => `<button class="skm-nav skm-nav-chip${params.source === s.id ? " is-active" : ""}" data-act="source" data-source="${esc(s.id)}">${icon("globe", 13, "skm-nav-ico")}${esc(s.name)}</button>`).join("")}
          <button class="skm-nav skm-nav-chip" data-act="source-add">${icon("plus", 13, "skm-nav-ico")}添加来源</button>
        </div></div>`;
      }
      const folders = result?.folders || [],
        tags = result?.tags || [];
      const chip = (act, value, label, active, count) =>
        `<button class="skm-nav skm-nav-chip${active ? " is-active" : ""}" data-act="${act}" data-value="${esc(value)}">${esc(label)}${count == null ? "" : `<span class="skm-nav-count">${count}</span>`}</button>`;
      return `<div class="skm-subnav-group"><span class="skm-subnav-label">分类</span><div class="skm-subnav-track">
          ${chip("folder", "", "全部", !params.folder)}
          ${folders.map((f) => chip("folder", f.id, f.name, params.folder === f.id)).join("")}
          <button class="skm-icon-btn" data-act="folder-add" title="新建分类" aria-label="新建分类">${icon("plus", 13)}</button>
        </div></div>
        <div class="skm-subnav-group"><span class="skm-subnav-label">标签</span><div class="skm-subnav-track">
          ${tags.length ? tags.slice(0, 12).map((t) => chip("tag", t, t, params.tags.includes(t))).join("") : '<span class="skm-subnav-empty">暂无标签</span>'}
        </div></div>
        <div class="skm-subnav-group"><span class="skm-subnav-label">状态</span><div class="skm-subnav-track">
          ${chip("flag", "favorite", "仅收藏", params.favorite)}
          ${chip("flag", "trash", "回收站", params.trash)}
        </div></div>`;
    }
    function paintTop() {
      const html = topbarHTML();
      if (top.innerHTML !== html) top.innerHTML = html;
      const subHTML = subnavHTML();
      if (sub.innerHTML !== subHTML) sub.innerHTML = subHTML;
    }
    const FORMAT_LABEL = (f) => FORMATS[f] || f;
    function promptCard(item) {
      const checked = selected.has(item.id);
      return `<article class="skm-card" data-prompt-id="${esc(item.id)}" role="button" tabindex="0" aria-label="${esc(item.title)}">
        <div class="skm-card-head">
          <label class="skm-check" title="选择"><input type="checkbox" data-select${checked ? " checked" : ""} aria-label="选择 ${esc(item.title)}"></label>
          <div class="skm-card-titles">
            <div class="skm-card-title">${esc(item.title)}</div>
            <div class="skm-card-zh">${esc(item.folder ? folderName(item.folder) : "未分类")} · ${esc(FORMAT_LABEL(item.format))}</div>
          </div>
          <div class="skm-card-pills">
            ${item.pinned ? '<span class="skm-mini-pill is-ok">置顶</span>' : ""}
            ${item.favorite ? '<span class="skm-mini-pill is-warn">收藏</span>' : ""}
          </div>
        </div>
        <p class="skm-card-desc">${esc(item.excerpt || "")}</p>
        ${item.tags?.length ? `<div class="skm-card-tags">${item.tags.slice(0, 6).map((t) => `<span class="skm-tag">${esc(t)}</span>`).join("")}</div>` : ""}
        <div class="skm-card-foot">
          <span class="skm-card-source">${icon("clock", 13, "skm-ico")}更新于 ${esc(fmtTime(item.updated))}</span>
          <span class="skm-card-actions">
            <button class="skm-icon-btn" data-act="copy" title="复制渲染后的提示词" aria-label="复制">${icon("copy", 14)}</button>
            <button class="skm-icon-btn" data-act="pin" title="置顶" aria-label="置顶">${icon("pin", 14)}</button>
            <button class="skm-icon-btn" data-act="fav" title="收藏" aria-label="收藏">${icon("star", 14)}</button>
          </span>
        </div>
      </article>`;
    }
    function marketCard(item) {
      return `<article class="skm-card" data-market-id="${esc(item.id)}" data-source-id="${esc(item.source)}" role="button" tabindex="0" aria-label="${esc(item.title)}">
        <div class="skm-card-head"><div class="skm-card-titles"><div class="skm-card-title">${esc(item.title)}</div><div class="skm-card-zh">${esc(item.origin?.repo || item.source)}</div></div></div>
        <p class="skm-card-desc">${esc(item.excerpt || "")}</p>
        <div class="skm-card-foot"><span class="skm-card-source">${icon("globe", 13, "skm-ico")}公开模板</span>
          <span class="skm-card-actions"><button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="market-apply">创建副本</button></span>
        </div>
      </article>`;
    }
    function folderName(id) {
      return result?.folders?.find((f) => f.id === id)?.name || "未分类";
    }
    function emptyState(title, hint, extra = "") {
      return `<div class="skm-empty"><span class="skm-empty-icon">${icon("fileText", 40)}</span><strong class="skm-empty-title">${esc(title)}</strong><span>${esc(hint)}</span>${extra}</div>`;
    }
    function pageHTML() {
      if (mode === "stats") {
        return `<div class="skm-page is-narrow"><header class="skm-page-head"><div class="skm-page-head-main"><h1 class="skm-page-title">使用分析</h1><p class="skm-page-sub">复制、模板应用与 AI 操作分开统计；打开预览不计入使用。</p></div>
          <div class="skm-page-actions"><label class="skm-field is-inline">开始<input class="skm-input" type="date" data-stat-start value="${esc(params.start || "")}"></label><label class="skm-field is-inline">截止<input class="skm-input" type="date" data-stat-end value="${esc(params.end || "")}"></label><button class="skm-btn skm-btn-secondary" data-act="stats-load">查看</button></div></header>
          <div data-stats-output><div class="skm-skeleton"><div class="skm-skeleton-card"></div><div class="skm-skeleton-card"></div></div></div></div>`;
      }
      const isMarket = mode === "market";
      return `<div class="skm-page">
        <header class="skm-page-head">
          <div class="skm-page-head-main">
            <h1 class="skm-page-title">${isMarket ? "模板市场" : "我的提示词"}<span class="skm-badge" data-count>${nf(result?.total ?? 0)}</span></h1>
            ${isMarket ? '<p class="skm-page-sub">预览模板后创建副本。</p>' : ""}
          </div>
          <div class="skm-page-actions">
            ${isMarket ? `<button class="skm-btn skm-btn-secondary" data-act="market-sync">${icon("refresh", 14)}同步模板</button>` : ""}
            <select class="skm-input skm-select" data-sort aria-label="排序方式">
              <option value="updated"${params.sort === "updated" ? " selected" : ""}>最近更新</option>
              <option value="created"${params.sort === "created" ? " selected" : ""}>创建时间</option>
              <option value="name"${params.sort === "name" ? " selected" : ""}>标题</option>
              <option value="usage"${params.sort === "usage" ? " selected" : ""}>使用次数</option>
            </select>
          </div>
        </header>
        <div class="skm-toolbar-wrap"><div class="skm-toolbar"><div class="skm-toolbar-main">
          <label class="skm-search">${icon("search", 15)}<input class="skm-input" type="search" data-search maxlength="300" value="${esc(params.q)}" placeholder="搜索标题、正文或标签" aria-label="搜索提示词"></label>
          ${isMarket ? "" : `<label class="skm-field is-inline">格式<select class="skm-input" data-format aria-label="格式筛选"><option value="">全部格式</option>${Object.entries(FORMATS).map(([k, v]) => `<option value="${k}"${params.format === k ? " selected" : ""}>${v}</option>`).join("")}</select></label>`}
        </div></div></div>
        <div class="skm-bulk-bar" data-bulk-bar hidden><span data-selected-count></span>
          <button class="skm-btn skm-btn-ghost skm-btn-sm" data-bulk="favorite">收藏</button>
          <button class="skm-btn skm-btn-ghost skm-btn-sm" data-bulk="move">移动分类</button>
          <button class="skm-btn skm-btn-ghost skm-btn-sm" data-bulk="tag">加标签</button>
          <button class="skm-btn skm-btn-ghost skm-btn-sm" data-bulk="trash">移入回收站</button>
          <button class="skm-btn skm-btn-ghost skm-btn-sm" data-bulk="restore">恢复</button>
          <button class="skm-btn skm-btn-ghost skm-btn-sm" data-bulk="export">导出</button>
        </div>
        <div data-list-results>${emptyState("正在读取提示词…", "本地索引与全文搜索会在首次加载后可用。")}</div>
        <div class="skm-pager"><span class="skm-pager-meta" data-page-meta></span><span class="skm-pager-actions">
          <button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="page" data-dir="-1">上一页</button>
          <span class="skm-pager-no" data-page>1 / 1</span>
          <button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="page" data-dir="1">下一页</button>
        </span></div>
        <p class="skm-inline-error" data-list-error role="alert"></p>
      </div>`;
    }
    function draw() {
      page.innerHTML = pageHTML();
      if (mode === "stats") {
        q("[data-act=stats-load]", page).onclick = () => {
          params.start = q("[data-stat-start]", page).value;
          params.end = q("[data-stat-end]", page).value;
          load();
        };
      }
      paintTop();
    }

    const nf = (n) => Number(n || 0).toLocaleString("zh-CN");
    function paintList(data) {
      const seat = q("[data-list-results]", page);
      if (!seat) return;
      const focus = document.activeElement,
        focusId = focus?.closest("[data-prompt-id]")?.dataset.promptId;
      if (!data.items.length) {
        seat.innerHTML = emptyState(
          mode === "market" ? "模板市场还没有条目" : "没有匹配的提示词",
          mode === "market"
            ? "添加公开模板源后同步，或稍后重试。"
            : "调整筛选，或新建／导入一条提示词。",
        );
      } else {
        seat.innerHTML = `<div class="skm-card-grid">${data.items
          .map((item) => (mode === "market" ? marketCard(item) : promptCard(item)))
          .join("")}</div>`;
      }
      const count = q("[data-count]", page);
      if (count) count.textContent = nf(data.total);
      const pager = q("[data-page]", page),
        meta = q("[data-page-meta]", page);
      const from = data.total ? params.offset + 1 : 0,
        to = params.offset + data.items.length;
      if (pager) pager.textContent = `${from}-${to} / ${nf(data.total)}`;
      if (meta) meta.textContent = `共 ${nf(data.total)} 条，每页 40 条`;
      const prev = q('[data-act="page"][data-dir="-1"]', page),
        next = q('[data-act="page"][data-dir="1"]', page);
      if (prev) prev.disabled = params.offset === 0;
      if (next) next.disabled = params.offset + data.items.length >= data.total;
      qa("[data-prompt-id],[data-market-id]", seat).forEach((card) => {
        const key = card.dataset.promptId || card.dataset.marketId;
        const item = data.items.find((x) => x.id === key);
        if (!item) return;
        const box = q("[data-select]", card);
        if (box)
          box.onchange = (ev) => {
            ev.stopPropagation();
            ev.target.checked ? selected.add(item.id) : selected.delete(item.id);
            card.setAttribute("aria-selected", String(ev.target.checked));
            paintBulk();
          };
        const activate = () =>
          mode === "market" ? marketPreview(item) : editPrompt(item.id);
        card.onclick = (ev) => {
          if (ev.target.closest("[data-act],[data-select]")) return;
          activate();
        };
        card.onkeydown = (ev) => {
          if (
            (ev.key === "Enter" || ev.key === " ") &&
            ev.target === card
          ) {
            ev.preventDefault();
            activate();
          }
        };
        const act = (name, run) => {
          const b = q(`[data-act="${name}"]`, card);
          if (b)
            b.onclick = (ev) => {
              ev.stopPropagation();
              run(ev);
            };
        };
        act("copy", () => copy(item.id));
        act("pin", async () => {
          await U().request("POST", "/api/prompts/bulk", {
            ids: [item.id],
            action: "pin",
            value: !item.pinned,
          });
          cache.clear();
          load();
        });
        act("fav", async () => {
          await U().request("POST", "/api/prompts/bulk", {
            ids: [item.id],
            action: "favorite",
            value: !item.favorite,
          });
          cache.clear();
          load();
        });
        act("market-open", () => marketPreview(item));
        act("market-apply", () => applyMarket(item));
        card.addEventListener("contextmenu", () => {
          const actions = [{ label: "打开提示词", action: activate }];
          if (mode === "library")
            actions.push(
              { label: "复制内容", action: () => copy(item.id) },
              { label: "移入回收站", action: () => bulk("trash", [item.id]) },
            );
          card._wbContextActions = actions;
        });
      });
      paintBulk();
      if (focusId)
        q(`[data-prompt-id="${CSS.escape(focusId)}"]`, seat)?.focus({
          preventScroll: true,
        });
    }
    function paintBulk() {
      const bar = q("[data-bulk-bar]", page);
      if (!bar) return;
      bar.hidden = mode !== "library" || !selected.size;
      const label = q("[data-selected-count]", bar);
      if (label) label.textContent = "已选 " + selected.size + " 条";
      const trash = q('[data-bulk="trash"]', bar),
        restore = q('[data-bulk="restore"]', bar);
      if (trash) trash.hidden = !!params.trash;
      if (restore) restore.hidden = !params.trash;
    }
    async function load() {
      const id = ++ticket,
        modeAt = mode;
      const query = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) =>
        Array.isArray(v)
          ? v.forEach((x) => query.append(k, x))
          : v !== "" && query.set(k, String(v)),
      );
      const url =
        mode === "stats"
          ? "/api/prompts/stats?" + query
          : (mode === "market" ? "/api/prompts/market" : "/api/prompts") +
            "?" +
            query;
      const stop = U().busy(page, "正在查询…");
      try {
        const cached = cache.get(url);
        if (cached) paint(cached);
        const data = await U().request("GET", url, undefined, { signal });
        if (!current(root, owner) || id !== ticket || mode !== modeAt) return;
        result = data;
        cache.set(url, data);
        paint(data);
      } catch (error) {
        if (
          error.name !== "AbortError" &&
          current(root, owner) &&
          id === ticket
        ) {
          const seat = q("[data-list-error]", page);
          if (seat) seat.textContent = error.message;
          if (!result) {
            const list = q("[data-list-results]", page);
            if (list) list.innerHTML = emptyState("读取失败", error.message);
          }
        }
      } finally {
        stop();
      }
    }
    function paint(data) {
      if (mode === "stats") return paintStats(data);
      paintList(data);
      paintTop();
    }
    async function bulk(action, ids = [...selected]) {
      if (!ids.length) return;
      if (action === "export") {
        U().download(
          await U().request(
            "GET",
            "/api/prompts/export?ids=" + ids.join(",") + "&format=json",
          ),
        );
        return;
      }
      const body = { ids, action };
      if (action === "trash" && !confirm("将所选提示词移入回收站？")) return;
      if (action === "move") {
        const m = modal(
          "移动分类",
          `<label class="skm-field">分类<select class="skm-input">${(result?.folders || []).map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("")}<option value="">未分类</option></select></label>`,
        );
        q("footer", m.d).hidden = false;
        q("footer", m.d).innerHTML =
          '<button class="skm-btn skm-btn-primary" data-confirm>移动</button>';
        q("[data-confirm]", m.d).onclick = async () => {
          await U().request("POST", "/api/prompts/bulk", {
            ...body,
            folder: q("select", m.d).value,
          });
          m.close(true);
          cache.clear();
          load();
        };
        return;
      }
      if (action === "tag") {
        const tag = prompt("输入标签名称");
        if (!tag?.trim()) return;
        body.tag = tag.trim();
      }
      try {
        await U().request("POST", "/api/prompts/bulk", body);
        selected.clear();
        cache.clear();
        load();
      } catch (error) {
        U().notify(error.message, { kind: "error" });
      }
    }
    function folderDialog(folder = {}) {
      const m = modal(
        folder.id ? "编辑分类" : "新建分类",
        `<form><label class="skm-field">名称<input class="skm-input" name="name" required maxlength="100" value="${esc(folder.name || "")}"></label><label class="skm-field">上级分类<select class="skm-input" name="parent"><option value="">顶层</option>${(result?.folders || [])
          .filter((f) => f.id !== folder.id)
          .map(
            (f) =>
              `<option value="${esc(f.id)}" ${f.id === folder.parent ? "selected" : ""}>${esc(f.name)}</option>`,
          )
          .join("")}</select></label><p class="skm-inline-error" role="alert"></p></form>`,
      );
      q("footer", m.d).hidden = false;
      q("footer", m.d).innerHTML =
        (folder.id
          ? '<button class="skm-btn skm-btn-danger" data-delete>删除分类</button>'
          : "") +
        '<button class="skm-btn skm-btn-primary" data-save>保存</button>';
      q("[data-save]", m.d).onclick = async () => {
        try {
          const body = Object.fromEntries(new FormData(q("form", m.d)));
          await U().request("POST", "/api/prompts/folder", {
            ...body,
            id: folder.id,
          });
          m.close(true);
          cache.clear();
          load();
        } catch (error) {
          q("[role=alert]", m.d).textContent = error.message;
        }
      };
      const del = q("[data-delete]", m.d);
      if (del)
        del.onclick = async () => {
          if (!confirm("删除分类，提示词将移到未分类？")) return;
          await U().request("POST", "/api/prompts/folder", {
            id: folder.id,
            delete: true,
          });
          m.close(true);
          params.folder = "";
          cache.clear();
          load();
        };
    }
    async function copy(pid) {
      try {
        const r = await U().request("POST", "/api/prompts/render", { id: pid });
        await navigator.clipboard.writeText(r.content);
        await U().request("POST", "/api/prompts/event", {
          id: pid,
          action: "copy",
        });
        U().notify("提示词已复制", { kind: "success" });
        cache.clear();
      } catch (error) {
        U().notify(error.message, { kind: "error" });
      }
    }
    async function editPrompt(pid, draft) {
      if (editor) {
        if (editor.dirty && !confirm("放弃当前草稿？")) return;
        editor.forceClose();
      }
      let item = pid
        ? await U().request("GET", "/api/prompts/item?id=" + pid)
        : draft || {
            title: "未命名提示词",
            content: "",
            format: "markdown",
            folder: params.folder || "",
            tags: [],
            variables: {},
            favorite: false,
            pinned: false,
            origin: {},
          };
      const draftKey = "wb-prompt-draft:" + owner + ":" + (pid || "new");
      let recovered;
      try {
        recovered = JSON.parse(localStorage.getItem(draftKey));
      } catch {}
      if (recovered && confirm("发现未完成的本地草稿，恢复吗？"))
        item = { ...item, ...recovered };
      const m = modal(
        pid ? "编辑提示词" : "新建提示词",
        `<div class="wb-conflict" hidden role="alert"></div><div class="wb-editor-fields"><label>标题<input name="title" maxlength="160" value="${e(item.title)}"></label><label>格式<select name="format">${[
          ["markdown", "Markdown"],
          ["text", "纯文本"],
          ["rich", "富文本"],
          ["json", "JSON"],
          ["custom", "自定义文本"],
        ]
          .map(
            ([v, t]) =>
              `<option value="${v}" ${item.format === v ? "selected" : ""}>${t}</option>`,
          )
          .join(
            "",
          )}</select></label><label>分类<select name="folder"><option value="">未分类</option>${(result?.folders || []).map((f) => `<option value="${e(f.id)}" ${item.folder === f.id ? "selected" : ""}>${e(f.name)}</option>`).join("")}</select></label><label>标签<input name="tags" value="${e((item.tags || []).join(", "))}" placeholder="多个标签用逗号分隔"></label></div><div class="wb-editor-columns"><section><div class="wb-rich-toolbar" hidden><button class="btn ghost" data-rich="bold">粗体</button><button class="btn ghost" data-rich="italic">斜体</button><button class="btn ghost" data-rich="underline">下划线</button><button class="btn ghost" data-rich="insertUnorderedList">列表</button></div><textarea class="wb-editor-source" aria-label="提示词内容" spellcheck="false"></textarea><div class="wb-rich-editor" contenteditable="true" role="textbox" aria-label="富文本提示词内容" hidden></div></section><section><h3 class="wb-muted">实时预览</h3><div class="wb-editor-preview"></div></section></div><details class="wb-prompt-variables"><summary>模板变量与来源</summary><label class="control-field">变量默认值（JSON）<textarea name="variables" rows="3">${e(JSON.stringify(item.variables || {}, null, 2))}</textarea></label><p class="wb-muted">使用 {{变量}} 与 {{#if 变量}}…{{else}}…{{/if}}；不执行代码。</p>${item.origin?.url ? '<p class="wb-muted">来源：' + e(item.origin.repo || "") + " · " + e(item.origin.license || "") + "</p>" : ""}</details><div class="wb-ai-actions"><select name="provider" aria-label="AI 服务"><option value="">默认 AI 服务</option></select><button class="btn ghost" data-ai="evaluate">AI 评估</button><button class="btn ghost" data-ai="optimize">AI 优化</button><button class="btn ghost" data-versions>版本历史</button><button class="btn ghost" data-feedback>记录反馈</button><button class="btn ghost" data-copy-editor>应用变量并复制</button></div><p class="wb-inline-error" data-editor-error role="alert"></p><section class="wb-ai-output"></section>`,
        {
          close: () =>
            !editor?.dirty || confirm("提示词尚未保存，关闭后保留本地草稿？"),
        },
      );
      let saveTimer,
        saving = false,
        pending = false,
        dirty = !!recovered,
        sequence = 0,
        base = item.revision || 0,
        live = true,
        modeAt = item.format,
        editorAbort = new AbortController();
      editor = {
        get dirty() {
          return dirty;
        },
        forceClose() {
          live = false;
          clearTimeout(saveTimer);
          editorAbort.abort();
          m.close(true);
          if (editor?.node === m.d) editor = null;
          cache.clear();
          if (current(root, owner)) load();
        },
        node: m.d,
      };
      m.d.addEventListener("close", () => {
        live = false;
        clearTimeout(saveTimer);
        editorAbort.abort();
        if (editor?.node === m.d) editor = null;
        cache.clear();
        if (current(root, owner)) load();
      });
      const source = q(".wb-editor-source", m.d),
        rich = q(".wb-rich-editor", m.d),
        preview = q(".wb-editor-preview", m.d),
        error = q("[data-editor-error]", m.d);
      source.value = item.content;
      if (item.templateUpdate)
        q(".wb-editor-fields", m.d).before(
          U().el("p", {
            class: "wb-template-update",
            text: item.templateUpdate.message,
          }),
        );
      const alive = () => live && m.d.isConnected && current(root, owner);
      editor.syncFeatures = () => {
        clearTimeout(saveTimer);
        if (features.promptAutosave && dirty)
          saveTimer = setTimeout(() => save(), 800);
        qa("[data-ai]", m.d).forEach(
          (b) =>
            (b.disabled =
              !features.promptAIEnabled ||
              !editor.canAI ||
              b.dataset.pending === "true"),
        );
      };
      if (item.variablesRaw !== undefined)
        q("[name=variables]", m.d).value = item.variablesRaw;
      const rawDraft = () => ({
        id: item.id,
        title: q("[name=title]", m.d).value,
        content:
          modeAt === "rich" ? JSON.stringify(U().richDoc(rich)) : source.value,
        format: q("[name=format]", m.d).value,
        folder: q("[name=folder]", m.d).value,
        tags: q("[name=tags]", m.d)
          .value.split(/[，,]/)
          .map((x) => x.trim())
          .filter(Boolean),
        variablesRaw: q("[name=variables]", m.d).value,
        variables: item.variables || {},
        favorite: item.favorite,
        pinned: item.pinned,
        origin: item.origin || {},
        expectedRevision: base,
      });
      const payload = () => {
        const { variablesRaw, ...value } = rawDraft();
        return { ...value, variables: JSON.parse(variablesRaw || "{}") };
      };
      const paintPreview = () => {
        try {
          const body =
            modeAt === "rich"
              ? JSON.stringify(U().richDoc(rich))
              : source.value;
          U().preview(preview, body, modeAt);
        } catch (error) {
          preview.textContent = error.message;
        }
      };
      const status = () => {
        q("[data-save-status]", m.d).textContent = saving
          ? "正在保存…"
          : dirty
            ? "有未保存的修改"
            : "已保存";
        q("[data-save-prompt]", m.d).disabled = saving;
      };
      async function save(checkpoint = false) {
        if (!alive()) return;
        if (saving) {
          pending = true;
          return;
        }
        let data;
        try {
          data = payload();
        } catch {
          error.textContent = "变量 JSON 暂不完整；草稿保留";
          return;
        }
        const submitted = sequence;
        saving = true;
        status();
        error.textContent = "";
        try {
          const saved = await U().request(
            "POST",
            "/api/prompts",
            { ...data, checkpoint },
            { signal: editorAbort.signal },
          );
          if (!alive()) return;
          item = { ...item, ...saved };
          base = saved.revision;
          dirty = submitted !== sequence;
          if (!dirty) localStorage.removeItem(draftKey);
          q(".wb-conflict", m.d).hidden = true;
        } catch (ex) {
          if (alive()) {
            error.textContent = ex.message;
            if (ex.status === 409 && ex.current) {
              const seat = q(".wb-conflict", m.d);
              seat.hidden = false;
              seat.replaceChildren(
                U().el("p", {
                  text: "其他窗口已保存新版本。当前草稿保留，请选择处理方式。",
                }),
              );
              const copy = U().el("button", {
                class: "btn ghost",
                text: "另存为新提示词",
              });
              copy.onclick = () => {
                item.id = undefined;
                base = 0;
                seat.hidden = true;
                save(true);
              };
              const load = U().el("button", {
                class: "btn ghost",
                text: "载入最新版本",
              });
              load.onclick = () => {
                if (confirm("保留本地草稿并载入最新版本？")) {
                  localStorage.setItem(
                    draftKey + ":conflict",
                    localStorage.getItem(draftKey) || "{}",
                  );
                  localStorage.removeItem(draftKey);
                  editor.forceClose();
                  editPrompt(ex.current.id);
                }
              };
              seat.append(copy, load);
              pending = false;
            }
          }
        } finally {
          saving = false;
          if (alive()) {
            status();
            if (pending) {
              pending = false;
              clearTimeout(saveTimer);
              saveTimer = setTimeout(() => save(), 800);
            }
          }
        }
        return item;
      }
      const change = () => {
        dirty = true;
        sequence++;
        try {
          localStorage.setItem(draftKey, JSON.stringify(rawDraft()));
        } catch {
          error.textContent = "浏览器草稿存储不可用，请手动保存或导出文本";
        }
        paintPreview();
        status();
        clearTimeout(saveTimer);
        if (features.promptAutosave) saveTimer = setTimeout(() => save(), 800);
      };
      function setFormat() {
        source.hidden = modeAt === "rich";
        rich.hidden = modeAt !== "rich";
        q(".wb-rich-toolbar", m.d).hidden = modeAt !== "rich";
        if (modeAt === "rich") {
          try {
            rich.innerHTML = U().richHTML(JSON.parse(source.value));
          } catch {
            rich.replaceChildren(U().el("p", { text: source.value }));
          }
        }
        paintPreview();
      }
      q("[name=format]", m.d).onchange = () => {
        const next = q("[name=format]", m.d).value;
        if (modeAt === "rich") source.value = U().richText(U().richDoc(rich));
        else if (next === "rich") {
          rich.replaceChildren(U().el("p", { text: source.value }));
          source.value = JSON.stringify(U().richDoc(rich));
        }
        modeAt = next;
        setFormat();
        change();
      };
      source.oninput = change;
      rich.oninput = change;
      rich.onpaste = (ev) => {
        ev.preventDefault();
        const value = ev.clipboardData.getData("text/plain");
        const range = getSelection()?.rangeCount
          ? getSelection().getRangeAt(0)
          : null;
        if (range) {
          range.deleteContents();
          range.insertNode(document.createTextNode(value));
        } else rich.append(document.createTextNode(value));
        change();
      };
      qa(
        "[name=title],[name=tags],[name=folder],[name=variables]",
        m.d,
      ).forEach((input) => {
        input.addEventListener("input", change);
        input.addEventListener("change", change);
      });
      qa("[data-rich]", m.d).forEach((b) => {
        b.onmousedown = (ev) => ev.preventDefault();
        b.onclick = () => {
          rich.focus();
          document.execCommand(b.dataset.rich, false, null);
          change();
        };
      });
      q("footer", m.d).hidden = false;
      q("footer", m.d).innerHTML =
        '<span data-save-status></span><div class="control-actions"><button class="btn ghost" data-close-editor>关闭</button><button class="btn" data-save-prompt>保存</button></div>';
      q("[data-save-prompt]", m.d).onclick = () => save(true);
      q("[data-close-editor]", m.d).onclick = () => m.close(false);
      m.d.onkeydown = (ev) => {
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
          ev.preventDefault();
          save(true);
        }
      };
      q("[data-copy-editor]", m.d).onclick = async () => {
        const saved = dirty || !item.id ? await save(true) : item;
        if (!saved?.id || dirty) return;
        const value = await U().request("POST", "/api/prompts/render", {
          id: saved.id,
          variables: JSON.parse(q("[name=variables]", m.d).value || "{}"),
        });
        await navigator.clipboard.writeText(value.content);
        await U().request("POST", "/api/prompts/event", {
          id: saved.id,
          action: "apply",
        });
        U().notify("已应用变量并复制", {kind:"success"});
      };
      q("[data-feedback]", m.d).onclick = async () => {
        const saved = dirty || !item.id ? await save(true) : item;
        if (!saved?.id || dirty) return;
        const rating = Number(prompt("你的使用评分（1–5）", "4"));
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) return;
        const note = prompt("使用反馈（可留空）", "");
        if (note === null) return;
        await U().request("POST", "/api/prompts/event", {
          id: item.id,
          action: "feedback",
          details: { rating, note },
        });
        U().notify("反馈已记录", {kind:"success"});
      };
      q("[data-versions]", m.d).onclick = async () => {
        if (!item.id) return;
        const data = await U().request(
          "GET",
          "/api/prompts/versions?id=" + item.id,
        );
        const v = modal("版本历史", '<div class="wb-version-list"></div>');
        const list = q(".wb-version-list", v.d);
        if (!data.items.length) list.textContent = "暂无历史版本";
        for (const version of data.items) {
          const node = U().el("section", { class: "wb-panel" });
          node.append(
            U().el("h3", {
              text:
                "版本 " +
                version.revision +
                " · " +
                new Date(version.at).toLocaleString(),
            }),
            U().el("pre", {
              class: "wb-text-preview",
              text: version.value.content,
            }),
          );
          const compare = U().el("details");
          compare.append(U().el("summary", { text: "对比当前草稿" }));
          const diff = U().el("div");
          U().diff(diff, source.value, version.value.content);
          compare.append(diff);
          node.append(compare);
          const b = U().el("button", {
            class: "btn ghost",
            text: "载入为当前草稿",
          });
          b.onclick = () => {
            source.value = version.value.content;
            for (const key of ["title", "folder"])
              q("[name=" + key + "]", m.d).value = version.value[key] || "";
            q("[name=tags]", m.d).value = (version.value.tags || []).join(", ");
            q("[name=variables]", m.d).value = JSON.stringify(
              version.value.variables || {},
              null,
              2,
            );
            item.favorite = version.value.favorite;
            item.pinned = version.value.pinned;
            item.origin = version.value.origin || {};
            modeAt = version.value.format;
            q("[name=format]", m.d).value = modeAt;
            setFormat();
            change();
            v.close(true);
          };
          node.append(b);
          list.append(node);
        }
      };
      async function runAI(kind, button) {
        if (!features.promptAIEnabled) {
          U().notify("设置中已关闭 AI 评估与优化");
          return;
        }
        const saved = dirty || !item.id ? await save(true) : item;
        if (!saved?.id || dirty) return;
        button.disabled = true;
        button.dataset.pending = "true";
        const stop = U().busy(q(".wb-ai-output", m.d), "正在请求 AI…", 0);
        try {
          const task = await U().request(
            "POST",
            "/api/prompts/ai",
            {
              id: item.id,
              kind,
              provider: q("[name=provider]", m.d).value || undefined,
              variables: JSON.parse(q("[name=variables]", m.d).value || "{}"),
            },
            { signal: editorAbort.signal },
          );
          const value = await U().job(task, { signal: editorAbort.signal });
          if (!alive()) return;
          const result = value.result,
            output = q(".wb-ai-output", m.d);
          output.replaceChildren();
          const section = U().el("article", { class: "wb-ai-result" });
          section.append(
            U().el("h3", {
              text: kind === "evaluate" ? "AI 评估建议" : "优化建议",
            }),
            U().el("p", {
              class: "wb-muted",
              text:
                (result.model || "") +
                " · 基于版本 " +
                value.revision +
                "；建议不代表客观效果",
            }),
          );
          if (kind === "evaluate") {
            section.append(
              U().el("strong", {
                class: "wb-ai-score",
                text: result.score + " / 100",
              }),
            );
            for (const [key, score] of Object.entries(result.scores))
              section.append(
                U().el("p", { text: key + "：" + score + " / 5" }),
              );
            section.append(U().el("p", { text: result.explanation || "" }));
          } else {
            section.append(U().el("p", { text: result.reason || "" }));
            const diff = U().el("div");
            U().diff(
              diff,
              saved.format === "rich"
                ? U().richText(JSON.parse(saved.content))
                : saved.content,
              result.content,
            );
            section.append(diff);
            const apply = U().el("button", {
              class: "btn",
              text: "载入优化结果为新草稿",
            });
            apply.onclick = () => {
              if (
                (base !== value.revision || dirty) &&
                !confirm("评估期间原文有变化，仍载入此版本的建议？")
              )
                return;
              source.value = result.content;
              modeAt = "markdown";
              q("[name=format]", m.d).value = "markdown";
              setFormat();
              change();
            };
            section.append(apply);
          }
          const usage = U().el("details"),
            usageTitle = U().el("summary", {
              text: result.usage
                ? "本次响应 usage（API 用量证据）"
                : "本次响应未返回 usage，用量未知",
            });
          usage.append(usageTitle);
          if (result.usage)
            usage.append(
              U().el("pre", {
                class: "wb-text-preview",
                text: JSON.stringify(result.usage, null, 2),
              }),
            );
          section.append(usage);
          output.append(section);
        } catch (ex) {
          if (alive() && ex.name !== "AbortError")
            error.textContent = ex.message;
        } finally {
          stop();
          if (alive()) {
            delete button.dataset.pending;
            button.disabled = !features.promptAIEnabled || !editor.canAI;
          }
        }
      }
      qa("[data-ai]", m.d).forEach(
        (b) => (b.onclick = () => runAI(b.dataset.ai, b)),
      );
      U()
        .request("GET", "/api/control", undefined, {
          signal: editorAbort.signal,
        })
        .then((control) => {
          if (!alive()) return;
          const select = q("[name=provider]", m.d);
          for (const provider of control.providers.filter(
            (p) => p.configured && p.enabled,
          ))
            select.append(
              U().el("option", {
                value: provider.id,
                text: provider.name + " · " + provider.model,
              }),
            );
          editor.canAI = control.providers.some(
            (p) => p.configured && p.enabled,
          );
          editor.syncFeatures();
        })
        .catch(() => {});
      setFormat();
      status();
      q("[name=title]", m.d).focus();
    }

    async function marketPreview(item) {
      try {
        const value = await U().request(
          "GET",
          "/api/prompts/market/item?source=" +
            encodeURIComponent(item.source) +
            "&id=" +
            item.id,
          undefined,
          { signal },
        );
        const m = modal(
          value.title,
          '<div class="skm-doc-meta" data-market-meta></div><div class="skm-preview" data-market-body></div>',
        );
        q("[data-market-meta]", m.d).innerHTML =
          `<span class="skm-mini-pill">${esc(value.origin?.license || "许可未知")}</span><span class="skm-mini-pill">${esc(value.origin?.repo || item.source)}</span>`;
        U().preview(q("[data-market-body]", m.d), value.content, value.format);
        q("footer", m.d).hidden = false;
        q("footer", m.d).innerHTML =
          '<button class="skm-btn skm-btn-ghost" data-modal-close>关闭</button><button class="skm-btn skm-btn-primary" data-apply>创建个人副本</button>';
        q("[data-apply]", m.d).onclick = () => {
          m.close(true);
          editPrompt(null, value);
        };
      } catch (error) {
        U().notify(error.message, { kind: "error" });
      }
    }
    async function applyMarket(item) {
      try {
        const p = await U().request("POST", "/api/prompts/market/apply", {
          source: item.source,
          id: item.id,
        });
        U().notify("已保存到我的提示词库", { kind: "success" });
        cache.clear();
        await load();
        return p;
      } catch (error) {
        U().notify(error.message, { kind: "error" });
      }
    }
    async function syncMarket() {
      const sources = result?.sources || [];
      const source = params.source || sources[0]?.id;
      if (!source) {
        U().notify("先添加一个公开模板源", { kind: "error" });
        return;
      }
      const stop = U().busy(page, "正在同步公开模板…", 0);
      try {
        const task = await U().request("POST", "/api/prompts/market/sync", {
          source,
        });
        await U().job(task, { signal });
        cache.clear();
        await load();
      } catch (error) {
        U().notify(error.message, { kind: "error" });
      } finally {
        stop();
      }
    }
    function sourceDialog() {
      const m = modal(
        "添加公开模板源",
        `<form class="skm-form"><label class="skm-field"><span>名称</span><input class="skm-input" name="name"></label><label class="skm-field"><span>GitHub 仓库</span><input class="skm-input" name="repo" placeholder="owner/repository" required></label><label class="skm-field"><span>文件路径</span><input class="skm-input" name="path" placeholder="prompts.json" required></label><label class="skm-field"><span>分支</span><input class="skm-input" name="ref" value="main"></label><label class="skm-field"><span>格式</span><select class="skm-input" name="format"><option value="json">JSON</option><option value="csv">CSV</option><option value="markdown">Markdown</option></select></label><label class="skm-field"><span>模板数据许可</span><input class="skm-input" name="license" placeholder="核验来源许可后填写" required></label><label class="skm-field"><span>字段映射（JSON，可选）</span><textarea class="skm-input" name="mapping" rows="2">{}</textarea></label><div data-source-preview></div><p class="skm-inline-error" role="alert"></p></form>`,
      );
      let previewed, previewCommit;
      const form = q("form", m.d),
        error = q("[role=alert]", m.d),
        read = () => {
          const data = Object.fromEntries(new FormData(form));
          data.mapping = JSON.parse(data.mapping || "{}");
          return data;
        };
      q("footer", m.d).hidden = false;
      q("footer", m.d).innerHTML =
        '<button class="skm-btn skm-btn-ghost" data-preview>预览来源</button><button class="skm-btn skm-btn-primary" data-save disabled>确认并同步到本地</button>';
      form.oninput = () => {
        previewed = null;
        q("[data-save]", m.d).disabled = true;
      };
      q("[data-preview]", m.d).onclick = async (ev) => {
        if (!form.reportValidity()) return;
        const stop = U().busy(
          q("[data-source-preview]", m.d),
          "正在读取公开模板…",
        );
        ev.target.disabled = true;
        try {
          const data = read(),
            task = await U().request(
              "POST",
              "/api/prompts/market/preview",
              data,
            ),
            preview = await U().job(task, { signal });
          if (
            !m.d.isConnected ||
            JSON.stringify(read()) !== JSON.stringify(data)
          )
            return;
          previewed = data;
          previewCommit = preview.commit;
          error.textContent = "";
          const seat = q("[data-source-preview]", m.d);
          seat.replaceChildren(
            U().el("p", {
              text:
                "识别 " +
                preview.count +
                " 条 · " +
                preview.license +
                " · " +
                preview.commit.slice(0, 8),
            }),
          );
          preview.items.forEach((item) =>
            seat.append(
              U().el("p", { text: item.title + " · " + item.excerpt }),
            ),
          );
          q("[data-save]", m.d).disabled = !preview.count;
        } catch (ex) {
          error.textContent = ex.message;
        } finally {
          stop();
          if (ev.target.isConnected) ev.target.disabled = false;
        }
      };
      q("[data-save]", m.d).onclick = async (ev) => {
        if (!previewed) return;
        ev.target.disabled = true;
        try {
          const source = await U().request(
              "POST",
              "/api/prompts/market/source",
              previewed,
            ),
            task = await U().request("POST", "/api/prompts/market/sync", {
              source: source.id,
              expectedCommit: previewCommit,
            });
          await U().job(task, { signal });
          m.close(true);
          cache.clear();
          await load();
        } catch (ex) {
          error.textContent = ex.message;
          ev.target.disabled = false;
        }
      };
    }
    function paintStats(data) {
      const output = q("[data-stats-output]", page);
      if (!output) return;
      const label = {
        copy: "复制",
        apply: "模板应用",
        evaluate: "AI 评估",
        optimize: "AI 优化",
        feedback: "反馈",
      };
      output.innerHTML = `<section class="skm-panel"><div class="skm-section-head"><h2 class="skm-section-title">使用记录</h2><div class="skm-section-actions"><button class="skm-btn skm-btn-ghost skm-btn-sm" data-report-json>JSON</button><button class="skm-btn skm-btn-ghost skm-btn-sm" data-report-csv>CSV</button><button class="skm-btn skm-btn-ghost skm-btn-sm" data-report-html>HTML</button></div></div><p class="skm-inline-note">复制、模板应用与 AI 操作分开统计；打开预览不计入使用。</p>
        <div class="skm-stats">${data.actions
          .map(
            (a) => `<div class="skm-stat"><span class="skm-section-title">${esc(label[a.action] || a.action)}</span><strong>${nf(a.count)}</strong></div>`,
          )
          .join("")}</div>
        <h3 class="skm-section-title">使用趋势</h3><div data-stat-trend></div>
        <h3 class="skm-section-title">每日记录</h3>
        <div class="skm-table-wrap"><table class="skm-table"><thead><tr><th>日期</th><th>操作</th><th>次数</th></tr></thead><tbody>${data.daily
          .map(
            (r) => `<tr><td>${esc(r.date)}</td><td>${esc(label[r.action] || r.action)}</td><td>${nf(r.count)}</td></tr>`,
          )
          .join("")}</tbody></table></div>
        <h3 class="skm-section-title">分类与标签</h3>
        <div class="skm-stats">${Object.entries(data.categories)
          .sort((a, b) => b[1] - a[1])
          .map(
            ([id, count]) =>
              `<div class="skm-stat"><span class="skm-section-title">${esc(data.folders.find((f) => f.id === id)?.name || "未分类")}</span><strong>${nf(count)}</strong></div>`,
          )
          .join("")}${Object.entries(data.tagCounts)
          .sort((a, b) => b[1] - a[1])
          .map(
            ([tag, count]) =>
              `<div class="skm-stat"><span class="skm-section-title">${esc(tag)}</span><strong>${nf(count)}</strong></div>`,
          )
          .join("")}</div>
        <h3 class="skm-section-title">提示词使用频率</h3>
        <ul class="skm-stat-list">${data.prompts.map((p) => `<li>${esc(p.title)} · ${nf(p.count)} 次</li>`).join("") || "<li>暂无记录</li>"}</ul>
        <h3 class="skm-section-title">你的反馈</h3>
        <ul class="skm-stat-list">${data.feedback.map((f) => `<li>${esc(new Date(f.at).toLocaleString("zh-CN"))} · ${f.details.rating || "—"} / 5 · ${esc(f.details.note || "")}</li>`).join("") || "<li>暂无反馈</li>"}</ul></section>`;
      const counts = new Map();
      data.daily
        .filter((r) => ["copy", "apply"].includes(r.action))
        .forEach((r) => counts.set(r.date, (counts.get(r.date) || 0) + r.count));
      const trend = q("[data-stat-trend]", output);
      if (trend && window.usageCharts) {
        trend.innerHTML = window.usageCharts.trend(
          [...counts].map(([date, total]) => ({ date, total })),
          "复制与模板应用次数",
        );
        const plot = q(".usage-plot", trend);
        if (plot) {
          plot.dataset.unit = " 次";
          plot.dataset.axisLabel = "次数";
        }
        window.usageCharts.mount(trend);
      }
      q("[data-report-json]", output).onclick = () =>
        U().download({
          filename: "prompt-report.json",
          mime: "application/json",
          content: JSON.stringify(data, null, 2),
        });
      q("[data-report-csv]", output).onclick = () =>
        U().download({
          filename: "prompt-report.csv",
          mime: "text/csv",
          content:
            "date,action,count\n" +
            data.daily.map((r) => [r.date, r.action, r.count].join(",")).join("\n"),
        });
      q("[data-report-html]", output).onclick = () =>
        U().download({
          filename: "prompt-report.html",
          mime: "text/html",
          content:
            '<!doctype html><meta charset="utf-8"><title>提示词使用报告</title><style>body{font:14px system-ui;max-width:1000px;margin:40px auto}table{border-collapse:collapse}td,th{padding:8px;border:1px solid #ddd}</style>' +
            output.innerHTML,
        });
    }
    async function importDialog() {
      const m = modal(
        "导入提示词",
        '<p class="skm-inline-note">支持 TXT、Markdown、JSON、CSV、HTML、ZIP；先预览再保存，内容不会被执行。</p><input class="skm-input" type="file" data-file accept=".txt,.md,.markdown,.json,.csv,.html,.htm,.zip"><button class="skm-btn skm-btn-ghost skm-btn-sm" data-clipboard>从剪贴板导入</button><textarea class="skm-input" data-paste placeholder="也可粘贴纯文本或 JSON" rows="4"></textarea><button class="skm-btn skm-btn-secondary skm-btn-sm" data-preview>预览文本</button><div data-import-preview></div><p class="skm-inline-error" role="alert"></p>',
      );
      let data;
      const preview = async (filename, bytes) => {
        try {
          data = await U().request("POST", "/api/prompts/import/preview", {
            filename,
            data: bytes,
          });
          const seat = q("[data-import-preview]", m.d);
          seat.replaceChildren(
            U().el("p", {
              text: "识别 " + data.total + " 条；重复内容默认跳过。",
            }),
          );
          for (const item of data.items.slice(0, 30))
            seat.append(U().el("p", { text: item.title + " · " + item.format }));
          q("[data-import-confirm]", m.d).disabled = !data.items.length;
        } catch (error) {
          q("[role=alert]", m.d).textContent = error.message;
        }
      };
      q("[data-file]", m.d).onchange = async (ev) => {
        const file = ev.target.files[0];
        if (file) preview(file.name, await fileData(file));
      };
      q("[data-preview]", m.d).onclick = () => {
        const value = q("[data-paste]", m.d).value;
        preview(
          value.trim().startsWith("{") || value.trim().startsWith("[")
            ? "clipboard.json"
            : "clipboard.txt",
          btoa(unescape(encodeURIComponent(value))),
        );
      };
      q("[data-clipboard]", m.d).onclick = async () => {
        try {
          q("[data-paste]", m.d).value = await navigator.clipboard.readText();
          q("[data-preview]", m.d).click();
        } catch {
          q("[role=alert]", m.d).textContent =
            "浏览器未允许读取剪贴板，请粘贴到文本框。";
        }
      };
      q("footer", m.d).hidden = false;
      q("footer", m.d).innerHTML =
        '<button class="skm-btn skm-btn-ghost" data-modal-close>取消</button><span class="skm-inline-note">内容不会被执行</span><button class="skm-btn skm-btn-primary" data-import-confirm disabled>确认导入</button>';
      q("[data-import-confirm]", m.d).onclick = async () => {
        const button = q("[data-import-confirm]", m.d);
        button.disabled = true;
        let done = 0;
        try {
          for (let i = 0; i < data.items.length; i += 1000) {
            await U().request("POST", "/api/prompts/import", {
              items: data.items.slice(i, i + 1000),
            });
            done = i + Math.min(1000, data.items.length - i);
          }
          m.close(true);
          cache.clear();
          await load();
          U().notify("导入完成", { kind: "success" });
        } catch (error) {
          data.items = data.items.slice(done);
          q("[role=alert]", m.d).textContent =
            "已处理 " + done + " 条；剩余内容保留。" + error.message;
          button.disabled = false;
        }
      };
    }
    function exportDialog() {
      const m = modal(
        "导出提示词",
        '<label class="skm-field"><span>格式</span><select class="skm-input"><option value="json">JSON（含变量与来源）</option><option value="md">Markdown</option><option value="txt">纯文本</option><option value="csv">CSV</option><option value="html">HTML</option><option value="zip">ZIP 批量文件</option></select></label><p class="skm-inline-note">只导出当前账号；不包含模型服务凭据。</p>',
      );
      q("footer", m.d).hidden = false;
      q("footer", m.d).innerHTML =
        '<button class="skm-btn skm-btn-ghost" data-modal-close>取消</button><button class="skm-btn skm-btn-primary" data-export-confirm>导出</button>';
      q("[data-export-confirm]", m.d).onclick = async () => {
        const value = await U().request(
          "GET",
          "/api/prompts/export?format=" + q("select", m.d).value,
        );
        U().download(value);
        m.close(true);
      };
    }
    function setMode(value) {
      if (mode === value) return;
      if (editor?.dirty && !confirm("提示词修改尚未保存，切换页面？")) return;
      editor?.forceClose();
      modeParams[mode] = { ...params, tags: [...params.tags] };
      mode = value;
      params = {
        q: "",
        sort: "updated",
        offset: 0,
        limit: 40,
        tags: [],
        ...(modeParams[mode] || {}),
      };
      selected.clear();
      draw();
      load();
    }
    app.addEventListener("click", (ev) => {
      const modeButton = ev.target.closest("[data-act='mode']");
      if (modeButton) {
        setMode(modeButton.dataset.mode);
        return;
      }
      const bulkButton = ev.target.closest("[data-bulk]");
      if (bulkButton) {
        bulk(bulkButton.dataset.bulk);
        return;
      }
      const button = ev.target.closest("[data-act]");
      if (!button) return;
      const act = button.dataset.act;
      if (act === "refresh") {
        cache.clear();
        U().notify("正在刷新", { kind: "info" });
        load();
        return;
      }
      if (act === "import") return importDialog();
      if (act === "export") return exportDialog();
      if (act === "create") return editPrompt();
      if (act === "folder") {
        params.folder = button.dataset.value;
        params.offset = 0;
        draw();
        return load();
      }
      if (act === "tag") {
        const tag = button.dataset.value;
        params.tags = params.tags.includes(tag)
          ? params.tags.filter((t) => t !== tag)
          : [...params.tags, tag];
        params.offset = 0;
        draw();
        return load();
      }
      if (act === "flag") {
        const key = button.dataset.value;
        params[key] = params[key] ? "" : "1";
        params.offset = 0;
        draw();
        return load();
      }
      if (act === "source") {
        params.source = button.dataset.source;
        params.offset = 0;
        draw();
        return load();
      }
      if (act === "source-add") return sourceDialog();
      if (act === "folder-add") return folderDialog();
      if (act === "market-sync") return syncMarket();
      if (act === "stats-load") {
        params.start = q("[data-stat-start]", page).value;
        params.end = q("[data-stat-end]", page).value;
        return load();
      }
      if (act === "page") {
        params.offset = Math.max(
          0,
          params.offset + Number(button.dataset.dir) * 40,
        );
        return load();
      }
    });
    app.addEventListener("change", (ev) => {
      if (ev.target.matches("[data-sort]")) {
        params.sort = ev.target.value;
        params.offset = 0;
        return load();
      }
      if (ev.target.matches("[data-format]")) {
        params.format = ev.target.value;
        params.offset = 0;
        return load();
      }
    });
    app.addEventListener("input", (ev) => {
      if (!ev.target.matches("[data-search]")) return;
      params.q = ev.target.value;
      params.offset = 0;
      clearTimeout(timer);
      timer = setTimeout(() => load(), 220);
    });
    app.addEventListener("keydown", (ev) => {
      if (
        (ev.key === "Enter" || ev.key === " ") &&
        ev.target.matches("[data-prompt-id],[data-market-id]")
      ) {
        ev.preventDefault();
        ev.target.click();
      }
    });
    const offMenu = window.workbenchContextMenu?.register?.(({ target }) => {
      const card = target?.closest?.("[data-prompt-id]");
      return card && root.contains(card) ? card._wbContextActions || [] : [];
    });
    const disposeBase = root._wbDispose;
    root._wbDispose = () => {
      disposeBase();
      offMenu?.();
    };
    draw();
    await load();
  }

  window.LibraryViews = { ...(window.LibraryViews || {}), prompts };
})();
