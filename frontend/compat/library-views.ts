// @ts-nocheck
// Compatibility controller: retain the validated interactions during the React migration.
/* Prompt-Tools / Skills-Manager presentation adapted to the workbench UI contract.
 * Their MIT source licences are retained in static/vendor; all storage uses owned HTTP APIs. */
import { skillCategories } from "../../src/shared/skill-presentation";

(() => {
  const U = () => window.WorkbenchUI,
    e = (s) => U().e(s),
    q = (s, r = document) => r.querySelector(s),
    qa = (s, r = document) => [...r.querySelectorAll(s)];
  const current = (root, owner) =>
    root.isConnected && typeof user !== "undefined" && user?.username === owner;
  const fileData = async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let value = "";
    for (let i = 0; i < bytes.length; i += 8192)
      value += String.fromCharCode(...bytes.slice(i, i + 8192));
    return btoa(value);
  };
  function shell(root, title, desc, actions) {
    root.classList.add("wb-fixed-layout");
    root.innerHTML = `<header class="wb-page-head"><div><h1>${e(title)}</h1><p>${e(desc)}</p></div><div class="wb-page-actions">${actions}</div></header><div class="wb-library-tabs"></div><div class="wb-library-content"></div>`;
    return q(".wb-library-content", root);
  }
  function modal(title, body, { close } = {}) {
    return U().dialog(title, body, { beforeClose: close });
  }
  /* 技能管理中台：信息架构与视觉语言对照 skills-manager（MIT）。
     * 侧边导航改为模块内上部横向导航；扫描与预览只读，不执行 SKILL.md 或脚本。
     * 数据只来自 /api/skill-manager/*。 */
  async function skills(root) {
    const owner = user.username;
    const signal = root._wbAbort?.signal;
    const esc = (v) => e(String(v ?? ""));

    const iconPaths = {
      dashboard: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
      layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
      bot: '<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/>',
      globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
      settings: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
      search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
      plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
      chevronRight: '<polyline points="9 18 15 12 9 6"/>',
      chevronDown: '<polyline points="6 9 12 15 18 9"/>',
      folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
      folderOpen: '<path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
      fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/>',
      refresh: '<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
      x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
      check: '<polyline points="20 6 9 17 4 12"/>',
      alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
      link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
      copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
      trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
      edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
      grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
      list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
      scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7" y1="12" x2="17" y2="12"/>',
      lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
      arrowRight: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
      download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
      upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
      spark: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
      external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
      clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    };
    const icon = (name, size = 16, cls = "") =>
      `<svg class="skm-ico ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || ""}</svg>`;

    const state = {
      view: "library",
      overview: null,
      agents: [],
      workspaces: [],
      presets: [],
      tags: [],
      activity: [],
      scan: null,
      settings: null,
      library: {
        items: [], total: 0, q: "", tag: "", agent: "", status: "all", source: "", category: "", view: "grid",
        offset: 0, limit: 12, loading: false, loaded: false, error: "", preset: "",
      },
      agentCounts: {},
      agentSkills: {},
      entries: {},
      detail: null,
      error: "",
      busy: false,
    };

    const api = (method, path, body) =>
      U().request(method, "/api/skill-manager" + path, body, { signal });

    const nf = (n) => Number(n || 0).toLocaleString("zh-CN");
    const fmtBytes = (n) => {
      const v = Number(n || 0);
      if (!v) return "0 B";
      if (v < 1024) return `${v} B`;
      if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
      return `${(v / 1024 / 1024).toFixed(1)} MB`;
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
    const zhName = (item) => {
      const v = String(item?.displayName || "").trim();
      if (!v || v === item?.name || v === "自定义技能") return "";
      return v;
    };
    const zhDescription = (item) => {
      const v = String(item?.displayDescription || "").trim();
      if (!v || v === "暂无中文简介，可在详情中补充。") return "";
      return v;
    };
    const stripFrontmatter = (text) => String(text || "").replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    const sourceType = (type) => ({
      local: "本机目录", adopted: "已收录", git: "Git 仓库", archive: "压缩包",
      market: "技能市场", manual: "手动添加",
    }[type] || "本机目录");
    const sourceIcon = (type) => (type === "git" || type === "archive" || type === "market" ? "link" : "folder");
    const libraryStatusText = (s) => ({ ok: "可用", missing: "文件缺失", modified: "已修改" }[s] || "未知");
    const presentationText = (s) => ({
      custom: "当前 Profile 覆盖", catalog: "本地词目", source: "源文件提供", untranslated: "缺少中文资料",
    }[s] || "缺少中文资料");
    const deployText = (s) => ({
      absent: "未部署", linked: "已链接", copied: "已复制", different: "内容不同", external: "外部目录", unreadable: "不可读",
    }[s] || "未部署");
    const upstreamText = (s) => ({
      unknown: "未检查", current: "已是最新", behind: "落后上游", "local-changes": "本地已修改",
      diverged: "已分叉", unavailable: "上游不可用",
    }[s] || "未检查");
    const deployedAgents = (s) => (s?.agents || []).filter((a) => a.deployed);
    const agentName = (id) => (state.agents.find((a) => a.id === id) || {}).name || id || "Agent";
    const agentTone = { shared: "indigo", codex: "zinc", claude: "orange", cursor: "blue", gemini: "sky", dsh: "green" };
    const agentTile = (a, size = 36) => {
      const id=a?.id||a?.agentId;
      const tone = agentTone[id] || "violet";
      const brands={codex:"openai-blossom-black.svg",claude:"agent-claude.svg",cursor:"agent-cursor.svg",gemini:"agent-gemini.svg",dsh:"dsh-logo.svg",opencode:"agent-opencode.svg",copilot:"agent-copilot.svg",antigravity:"agent-antigravity.svg"};
      const asset=Object.hasOwn(brands,id)?brands[id]:null;
      const label=asset?`<img src="assets/${asset}" alt="">`:icon(a?.id==="shared"?"layers":"bot",16);
      return `<span class="skm-agent-tile skm-tone-${tone}${size <= 28 ? " is-sm" : ""}" aria-hidden="true">${label}</span>`;
    };

    function statusPills(skill) {
      const out = [];
      if (skill.libraryStatus && skill.libraryStatus !== "ok") {
        out.push(`<span class="skm-mini-pill is-${skill.libraryStatus === "missing" ? "danger" : "warn"}">${libraryStatusText(skill.libraryStatus)}</span>`);
      }
      if (skill.presentationSource === "untranslated") {
        out.push('<span class="skm-mini-pill">缺少中文资料</span>');
      }
      if (skill.warning) out.push('<span class="skm-mini-pill is-warn" title="' + esc(skill.warning) + '">需检查</span>');
      return out.join("");
    }

    function skillCard(skill) {
      const zh = zhName(skill);
      const desc = zhDescription(skill) || String(skill.description || "").trim();
      const agents = deployedAgents(skill);
      const tags = (skill.tags || []).slice(0, 5);
      const title = String(skill.name || skill.displayName || "未命名技能");
      return `<article class="skm-card" data-skill-category="${esc(skill.category||"其他")}" data-open-skill="${esc(skill.id)}" role="button" tabindex="0" aria-label="打开技能 ${esc(title)}">
        <div class="skm-card-head">
          <span class="skm-dot${agents.length ? " is-on" : ""}" title="${agents.length ? "已部署到 " + esc(agents.map((a) => a.name).join("、")) : "尚未部署到 Agent"}"></span>
          <div class="skm-card-titles">
            <h3 class="skm-card-title" title="${esc(title)}">${esc(title)}</h3>
            ${zh ? `<p class="skm-card-zh" title="${esc(zh)}">${esc(zh)}</p>` : ""}
          </div>
          <span class="skm-card-pills">${statusPills(skill)}</span>
        </div>
        <p class="skm-card-desc">${desc ? esc(desc) : "暂无简介"}</p>
        <div class="skm-card-tags">${skill.category?`<span class="skm-tag skm-function">${esc(skill.category)}</span>`:""}${tags.map((t) => `<span class="skm-tag">${esc(t)}</span>`).join("")}${(skill.tags || []).length > 5 ? `<span class="skm-tag is-more">+${skill.tags.length - 5}</span>` : ""}</div>
        <div class="skm-card-foot">
          <span class="skm-card-source">${icon(sourceIcon(skill.source?.type), 14)}<span>${esc(sourceType(skill.source?.type))}</span></span>
          <span class="skm-agent-dots">
            ${agents.slice(0, 6).map((a) => `<span class="skm-agent-dot" title="${esc(a.name)}">${agentTile(a, 20)}</span>`).join("")}
            ${agents.length > 6 ? `<span class="skm-agent-more">+${agents.length - 6}</span>` : ""}
            ${agents.length ? "" : '<span class="skm-agent-none">未部署</span>'}
          </span>
        </div>
      </article>`;
    }

    function skillRow(skill) {
      const zh = zhName(skill);
      const desc = zhDescription(skill) || String(skill.description || "").trim();
      const agents = deployedAgents(skill);
      return `<article class="skm-row" data-open-skill="${esc(skill.id)}" role="button" tabindex="0" aria-label="打开技能 ${esc(skill.name)}">
        <span class="skm-dot${agents.length ? " is-on" : ""}"></span>
        <div class="skm-row-main">
          <div class="skm-row-title">${esc(skill.name)}${zh ? `<span class="skm-row-zh">${esc(zh)}</span>` : ""}</div>
          <p class="skm-row-desc">${desc ? esc(desc) : "暂无简介"}</p>
        </div>
        <div class="skm-row-tags">${(skill.tags || []).slice(0, 3).map((t) => `<span class="skm-tag">${esc(t)}</span>`).join("")}</div>
        <div class="skm-row-source">${icon(sourceIcon(skill.source?.type), 14)}${esc(sourceType(skill.source?.type))}</div>
        <div class="skm-agent-dots">${agents.slice(0, 4).map((a) => `<span class="skm-agent-dot" title="${esc(a.name)}">${agentTile(a, 20)}</span>`).join("")}${agents.length ? "" : '<span class="skm-agent-none">未部署</span>'}</div>
      </article>`;
    }

    function emptyState({ title, hint, action = "", extra = "" } = {}) {
      return `<div class="skm-empty">
        <span class="skm-empty-icon">${icon("layers", 48)}</span>
        <h3>${esc(title)}</h3>
        <p>${esc(hint)}</p>
        ${extra ? `<div class="skm-empty-extra">${extra}</div>` : ""}
        ${action || ""}
      </div>`;
    }

    function pageHead(title, { badge = "", sub = "", actions = "" } = {}) {
      return `<header class="skm-page-head">
        <div class="skm-page-head-main">
          <h1 class="skm-page-title">${esc(title)}${badge ? `<span class="skm-badge">${badge}</span>` : ""}</h1>
          ${sub ? `<p class="skm-page-sub">${sub}</p>` : ""}
        </div>
        ${actions ? `<div class="skm-page-actions">${actions}</div>` : ""}
      </header>`;
    }

    function alertBox(message, retry = true) {
      return `<div class="skm-alert" role="alert">${icon("alert", 16)}<span>${esc(message)}</span>${retry ? '<button class="skm-link" data-act="retry">重试</button>' : ""}</div>`;
    }

    function coverCount() {
      const total = state.overview?.libraryTotal ?? state.library.total;
      const items = state.library.items || [];
      const synced = items.filter((s) => deployedAgents(s).length > 0).length;
      return { total, synced };
    }

    // 模块内上部横向导航：一级页签 + 二级横向分组，取代 skills-manager 的 220px 应用侧栏。
    function navItem(view, label, ico, count, cls = "") {
      const active = state.view === view || (view === "agents" && state.view.startsWith("agent:")) || (view === "workspaces" && state.view.startsWith("workspace:"));
      return `<button class="skm-nav${active ? " is-active" : ""}${cls ? " " + cls : ""}" data-act="nav" data-view="${view}"${active ? ' aria-current="page"' : ""}>
        ${icon(ico, 15, "skm-nav-ico")}<span class="skm-nav-label">${esc(label)}</span>${count != null ? `<span class="skm-nav-count">${nf(count)}</span>` : ""}</button>`;
    }

    function topbarHTML() {
      return `<div class="skm-brand">
          <span class="skm-brand-mark" aria-hidden="true">${icon("layers", 15)}</span>
          <span class="skm-brand-name">技能管理</span>
        </div>
        <nav class="skm-nav-primary" aria-label="技能管理导航">
          ${navItem("overview", "概览", "dashboard")}
          ${navItem("library", "技能库", "layers", state.overview?.libraryTotal ?? state.library.total)}
          ${navItem("agents", "Agents", "bot")}
          ${navItem("workspaces", "工作区", "folderOpen")}
        </nav>
        <div class="skm-topbar-actions">
          <button class="skm-icon-btn" data-act="refresh" aria-label="刷新数据" title="刷新数据">${icon("refresh", 16)}</button>
          ${navItem("settings", "设置", "settings", null, "skm-nav-settings")}
        </div>`;
    }

    function subnavHTML() {
      const groupHead = (label, open, key) =>
        `<button class="skm-subnav-label" data-act="group" data-group="${key}" aria-expanded="${open ? "true" : "false"}" title="${open ? "收起" : "展开"}${esc(label)}">${icon(open ? "chevronDown" : "chevronRight", 12, "skm-chev")}<span>${esc(label)}</span></button>`;
      const open = state.groups || (state.groups = { presets: true, agents: true, workspaces: true });
      const presets = state.presets || [];
      const linked = state.workspaces.filter((w) => w.kind === "linked");
      const project = state.workspaces.find((w) => w.kind === "project");
      const group = (key, label, body) => `<div class="skm-subnav-group${open[key] ? "" : " is-collapsed"}">
          ${groupHead(label, open[key], key)}
          ${open[key] ? `<div class="skm-subnav-track">${body}</div>` : ""}
        </div>`;
      return [
        group(
          "presets",
          "预设",
          presets
            .map(
              (p) => `<button class="skm-nav skm-nav-chip${state.library.preset === p.id ? " is-active" : ""}" data-act="preset" data-preset="${esc(p.id)}" title="${esc(p.description || p.name)}">
            <span class="skm-nav-ico skm-preset-mark" aria-hidden="true">${icon("spark", 12)}</span><span class="skm-nav-label">${esc(p.name)}</span><span class="skm-nav-count">${nf((p.skillIds || []).length)}</span></button>`,
            )
            .join("") +
            `<button class="skm-nav skm-nav-chip is-muted" data-act="new-preset">${icon("plus", 13, "skm-nav-ico")}<span class="skm-nav-label">新建预设</span></button>`,
        ),
        group(
          "agents",
          "Agents",

            state.agents
              .map(
                (a) => `<button class="skm-nav skm-nav-chip${state.view === "agent:" + a.id ? " is-active" : ""}" data-act="nav" data-view="agent:${esc(a.id)}" title="${esc(a.globalPath)}">
            ${agentTile(a, 18)}<span class="skm-nav-label">${esc(a.name)}</span>
            <span class="skm-nav-count">${state.agentCounts[a.id] == null ? "…" : nf(state.agentCounts[a.id])}</span>
            <span class="skm-dot sm${a.exists ? " is-on" : ""}" title="${a.exists ? "目录已创建" : "目录未创建"}"></span></button>`,
              )
              .join(""),
        ),
        group(
          "workspaces",
          "工作区",

            (project
              ? `<button class="skm-nav skm-nav-chip${state.view === "workspace:" + project.id ? " is-active" : ""}" data-act="nav" data-view="workspace:${esc(project.id)}" title="${esc(project.root)}">
            ${icon("folder", 13, "skm-nav-ico")}<span class="skm-nav-label">${esc(project.name)}</span><span class="skm-dot sm${project.exists ? " is-on" : ""}"></span></button>`
              : "") +
            linked
              .map(
                (w) => `<button class="skm-nav skm-nav-chip${state.view === "workspace:" + w.id ? " is-active" : ""}" data-act="nav" data-view="workspace:${esc(w.id)}" title="${esc(w.root)}">
            ${icon("link", 13, "skm-nav-ico")}<span class="skm-nav-label">${esc(w.name)}</span><span class="skm-dot sm${w.exists ? " is-on" : ""}"></span></button>`,
              )
              .join(""),
        ),
      ].join("");
    }

    function overviewHTML() {
      const o = state.overview;
      if (!o) {
        return `<div class="skm-page is-narrow">${pageHead("概览")}${alertBox(state.error || "正在读取技能管理数据…", false)}</div>`;
      }
      const agents = o.agents || [];
      const workspaces = o.workspaces || [];
      const missingAgents = agents.filter((a) => !a.exists);
      const connected = agents.filter((a) => a.exists && a.enabled);
      const { total, synced } = coverCount();
      const coverage = total ? `${synced}/${total}` : "0";
      const recent = (state.activity && state.activity.length ? state.activity : (o.activity || [])).slice(0, 6);
      const dirRows = [
        { name: "中央技能库", path: o.library?.root, ok: true, tag: "中央库" },
        ...agents.map((a) => ({ name: a.name, path: a.globalPath, ok: a.exists, tag: a.origin === "builtin" ? "内置 Agent" : "自定义 Agent", agent: a.id })),
        ...workspaces.filter((w) => w.kind !== "global").map((w) => ({ name: w.name, path: w.root, ok: w.exists, tag: w.kind === "project" ? "项目工作区" : "关联目录", ws: w.id })),
      ];
      const recentHTML = recent.length
        ? `<section class="skm-section">
            <h2 class="skm-section-title">近期活动</h2>
            <div class="skm-panel skm-activity">
              ${recent.map((ev) => `<div class="skm-activity-row">
                <span class="skm-activity-mark">${esc(String(ev.skillName || ev.action || "·").charAt(0).toUpperCase())}</span>
                <div class="skm-activity-main"><b>${esc(ev.skillName || ev.action || "操作")}</b><span>${esc(ev.detail || ev.action || "")}</span></div>
                <span class="skm-activity-time">${esc(fmtTime(ev.at))}${ev.ok === false ? " · 失败" : ""}</span>
              </div>`).join("")}
            </div>
          </section>`
        : "";
      return `<div class="skm-page is-narrow">
        ${pageHead("你好！", { sub: `技能库中 ${nf(total)} 个技能 · 已接入 ${nf(connected.length)} 个 Agent · ${nf(workspaces.length)} 个工作区` })}
        ${state.error ? alertBox(state.error) : ""}
        ${missingAgents.length ? `<div class="skm-setup-card">
          <span class="skm-setup-ico">${icon("alert", 18)}</span>
          <div class="skm-setup-main"><h2>${nf(missingAgents.length)} 个 Agent 目录尚未创建</h2><p>扫描只读取已登记的目录，不会自行创建或修改任何 Agent 目录。可先在「全部 Agents」中确认路径，再扫描本机。</p></div>
          <button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="nav" data-view="agents">查看 Agents</button>
        </div>` : ""}
        <div class="skm-stats">
          <div class="skm-stat"><div><p class="skm-section-title">技能库技能</p><strong>${nf(total)}</strong></div><span class="skm-stat-ico is-accent">${icon("layers", 16)}</span></div>
          <div class="skm-stat"><div><p class="skm-section-title">同步覆盖</p><strong>${coverage}</strong></div><span class="skm-stat-ico is-ok">${icon("check", 16)}</span></div>
          <div class="skm-stat"><div><p class="skm-section-title">连接 Agent</p><strong>${nf(connected.length)}<span class="skm-stat-total">/${nf(agents.length)}</span></strong></div><span class="skm-stat-ico is-sky">${icon("bot", 16)}</span></div>
        </div>
        <div class="skm-actions">
          <button class="skm-btn skm-btn-primary" data-act="scan">${icon("scan", 16)}扫描本机目录</button>
          <button class="skm-btn skm-btn-secondary" data-act="new-workspace">${icon("plus", 16)}关联工作区目录</button>
        </div>
        <section class="skm-section">
          <h2 class="skm-section-title">登记目录</h2>
          <div class="skm-panel skm-dir-list">
            ${dirRows.map((row) => `<div class="skm-dir-row">
              <span class="skm-dir-ico">${icon(row.agent ? "bot" : row.ws ? "folder" : "layers", 15)}</span>
              <div class="skm-dir-main"><div class="skm-dir-name">${esc(row.name)}<span class="skm-mini-pill">${esc(row.tag)}</span></div><code class="skm-path" title="${esc(row.path)}">${esc(row.path || "—")}</code></div>
              <span class="skm-status ${row.ok ? "is-ok" : "is-muted"}"><span class="skm-dot sm${row.ok ? " is-on" : ""}"></span>${row.ok ? "已创建" : "目录未创建"}</span>
              ${row.agent ? `<button class="skm-icon-btn" data-act="nav" data-view="agent:${esc(row.agent)}" title="查看 Agent">${icon("chevronRight", 15)}</button>` : row.ws ? `<button class="skm-icon-btn" data-act="nav" data-view="workspace:${esc(row.ws)}" title="查看工作区">${icon("chevronRight", 15)}</button>` : ""}
            </div>`).join("")}
          </div>
        </section>
        <section class="skm-section">
          <h2 class="skm-section-title">索引与只读边界</h2>
          <div class="skm-panel skm-readonly">
            <div class="skm-readonly-row">${icon("lock", 16)}<div><b>不会执行技能内容</b><span>预览只读取 SKILL.md 文本；不会运行其中的脚本、命令或任何安装步骤。</span></div></div>
            <div class="skm-readonly-row">${icon("folder", 16)}<div><b>只扫描已登记目录</b><span>中央库、Agent 目录与项目工作区；不会遍历整块磁盘。</span></div></div>
            <div class="skm-readonly-row">${icon("fileText", 16)}<div><b>索引状态</b><span>${o.scan ? `上次索引 ${esc(fmtTime(o.scan.at))} · 收录 ${nf(o.scan.count)} 项 · 新吸收 ${nf(o.scan.absorbed)} 项` : "尚未建立索引。首次扫描会生成只读快照。"}</span></div></div>
          </div>
        </section>
        ${recentHTML}
      </div>`;
    }

    function libraryFiltered() {
      const l = state.library;
      let items = (l.items || []).slice();
      if (l.status === "deployed") items = items.filter((s) => deployedAgents(s).length > 0);
      if (l.status === "available") items = items.filter((s) => deployedAgents(s).length === 0);
      if (l.source) items = items.filter((s) => (s.source?.type || "local") === l.source);
      if (l.preset) {
        const preset = state.presets.find((p) => p.id === l.preset);
        const ids = new Set((preset?.skillIds) || []);
        items = items.filter((s) => ids.has(s.id));
      }
      return items;
    }

    function libraryResultsHTML() {
      const l = state.library;
      if (l.loading && !l.loaded) {
        return `<div class="skm-skeleton">${Array.from({ length: 6 }).map(() => '<div class="skm-skeleton-card"></div>').join("")}</div>`;
      }
      if (l.error) return alertBox(l.error);
      const items = libraryFiltered();
      const start = l.offset;
      const page = items.slice(start, start + l.limit);
      if (!items.length) {
        const filtered = l.q || l.tag || l.agent || l.status !== "all" || l.source || l.preset || l.category;
        const totalZero = !filtered && l.total === 0;
        return emptyState({
          title: totalZero ? "技能库还没有技能" : "没有可显示的 Skills",
          hint: totalZero
            ? "中央技能库为空。可以扫描本机已登记的 Agent 目录，或先把已有技能目录登记为工作区。"
            : "当前筛选条件下没有匹配的技能。可以清除筛选，或换一个关键词。",
          action: filtered
            ? '<button class="skm-btn skm-btn-secondary" data-act="clear-filters">清除筛选</button>'
            : '<div class="skm-empty-actions"><button class="skm-btn skm-btn-primary" data-act="scan">扫描本机目录</button><button class="skm-btn skm-btn-secondary" data-act="new-workspace">关联工作区</button></div>',
        });
      }
      const body = l.view === "grid"
        ? `<div class="skm-card-grid">${page.map(skillCard).join("")}</div>`
        : `<div class="skm-rows">${page.map(skillRow).join("")}</div>`;
      const loadedNote = l.total > l.items.length ? `<span class="skm-meta-note">已载入前 ${nf(l.items.length)} / ${nf(l.total)} 项</span>` : "";
      const pages = Math.max(1, Math.ceil(items.length / l.limit));
      const pageNo = Math.floor(start / l.limit) + 1;
      const pager = `<div class="skm-pager">
        <span class="skm-pager-meta">第 ${nf(start + 1)}–${nf(Math.min(start + l.limit, items.length))} 项，共 ${nf(items.length)} 项 ${loadedNote}</span>
        <div class="skm-pager-actions">
          <button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="lib-page" data-dir="-1" ${pageNo <= 1 ? "disabled" : ""}>${icon("chevronRight", 14, "skm-flip")}上一页</button>
          <span class="skm-pager-no">第 ${pageNo} / ${pages} 页</span>
          <button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="lib-page" data-dir="1" ${pageNo >= pages ? "disabled" : ""}>下一页${icon("chevronRight", 14)}</button>
        </div>
      </div>`;
      return body + pager;
    }

    function libraryHTML() {
      const l = state.library;
      const sourceTypes = [...new Set((l.items || []).map((s) => s.source?.type || "local"))];
      const tags = (state.overview?.tags || state.tags || []).slice(0, 10);
      const seg = [["all", "全部"], ["deployed", "已部署"], ["available", "未部署"]]
        .map(([v, label]) => `<button class="skm-seg${l.status === v ? " is-active" : ""}" data-act="lib-status" data-status="${v}" aria-pressed="${l.status === v}">${label}</button>`).join("");
      const sources = [["", "全部来源"], ...sourceTypes.map((t) => [t, sourceType(t)])]
        .map(([v, label]) => `<button class="skm-chip${l.source === v ? " is-active" : ""}" data-act="lib-source" data-source="${esc(v)}" aria-pressed="${l.source === v}">${esc(label)}</button>`).join("");
      const tagChips = tags.map((t) => `<button class="skm-chip${l.tag === t.name ? " is-active" : ""}" data-act="tag" data-tag="${esc(t.name)}" aria-pressed="${l.tag === t.name}">${esc(t.name)}<span>${nf(t.count)}</span></button>`).join("");
      const preset = l.preset ? state.presets.find((p) => p.id === l.preset) : null;
      return `<div class="skm-page">
        ${pageHead("技能库", { badge: nf(l.total), actions: `<button class="skm-btn skm-btn-primary skm-btn-sm" data-act="scan">${icon("scan", 15)}扫描本机</button>` })}
        ${preset ? `<div class="skm-filter-banner">正在查看预设「${esc(preset.name)}」<button class="skm-link" data-act="clear-preset">退出预设</button></div>` : ""}
        <div class="skm-toolbar-wrap">
        <div class="skm-toolbar">
          <div class="skm-toolbar-main">
            <label class="skm-search">${icon("search", 16)}<input class="skm-input" type="search" data-lib-search placeholder="搜索技能名称或简介" value="${esc(l.q)}" aria-label="搜索技能" autocomplete="off" spellcheck="false"></label>
            <div class="skm-segmented" role="group" aria-label="按部署状态筛选">${seg}</div>
          </div>
          <div class="skm-toolbar-actions">
            <div class="skm-segmented is-icon" role="group" aria-label="视图">
              <button class="skm-seg skm-seg-icon${l.view === "grid" ? " is-active" : ""}" data-act="lib-view" data-view="grid" aria-pressed="${l.view === "grid"}" title="网格视图">${icon("grid", 15)}</button>
              <button class="skm-seg skm-seg-icon${l.view === "list" ? " is-active" : ""}" data-act="lib-view" data-view="list" aria-pressed="${l.view === "list"}" title="列表视图">${icon("list", 15)}</button>
            </div>
          </div>
        </div>
        <div class="skm-chip-row skm-function-filters" role="group" aria-label="技能功能分类">${["",...skillCategories].map(category=>`<button class="skm-chip${l.category===category?" is-active":""}" data-act="lib-category" data-category="${esc(category)}" aria-pressed="${l.category===category}">${esc(category||"全部功能")}</button>`).join("")}</div>
        <div class="skm-chip-row">${sources}${tags.length ? '<span class="skm-chip-sep" aria-hidden="true"></span>' : ""}${tagChips}</div>
        </div>
        <div data-lib-results>${libraryResultsHTML()}</div>
      </div>`;
    }

    function agentsHTML() {
      if (!state.overview) return `<div class="skm-page">${pageHead("Agents")}${alertBox(state.error || "正在读取…", false)}</div>`;
      const agents = state.agents || [];
      const detected = agents.filter((a) => a.exists).length;
      return `<div class="skm-page">
        ${pageHead("Agents", { badge: `${detected}/${agents.length}`, sub: "已登记的 Agent 技能目录。目录存在与否、启用状态与实际部署分别判断。", actions: `<button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="new-agent">${icon("plus", 15)}自定义 Agent</button>` })}
        ${state.error ? alertBox(state.error) : ""}
        <div class="skm-agent-grid">
          ${agents.map((a) => `<button class="skm-agent-card" data-act="nav" data-view="agent:${esc(a.id)}">
            ${agentTile(a, 36)}
            <div class="skm-agent-main">
              <div class="skm-agent-name">${esc(a.name)}<span class="skm-mini-pill">${a.origin === "builtin" ? "内置" : "自定义"}</span>${a.enabled ? "" : '<span class="skm-mini-pill is-warn">已停用</span>'}</div>
              <p class="skm-agent-sub">${state.agentCounts[a.id] == null ? "正在读取技能数…" : `${nf(state.agentCounts[a.id])} 个 Skills`} · ${a.exists ? "目录已创建" : "目录未创建"}</p>
            </div>
            ${icon("chevronRight", 16, "skm-agent-chev")}
          </button>`).join("")}
        </div>
        <section class="skm-section">
          <h2 class="skm-section-title">只读边界</h2>
          <div class="skm-panel skm-readonly">
            <div class="skm-readonly-row">${icon("lock", 16)}<div><b>目录未创建 ≠ 未启用</b><span>路径不存在时仅表示本机还没有这个目录；启用状态与文件存在性分别展示，不会自动创建目录。</span></div></div>
            <div class="skm-readonly-row">${icon("folderOpen", 16)}<div><b>只读扫描</b><span>扫描只读取各 Agent 目录中的 SKILL.md，不会写入 Agent 配置或执行技能脚本。</span></div></div>
          </div>
        </section>
      </div>`;
    }

    function agentDetailHTML(id) {
      const a = state.agents.find((x) => x.id === id);
      if (!a) return `<div class="skm-page">${pageHead("Agent 未找到")}${emptyState({ title: "没有这个 Agent", hint: "它可能已被移除，或链接已失效。", action: '<button class="skm-btn skm-btn-secondary" data-act="nav" data-view="agents">返回 Agents</button>' })}</div>`;
      const skills = state.agentSkills[id];
      const bindings = state.workspaces.filter((w) => (w.agentIds || []).includes(id));
      return `<div class="skm-page">
        <header class="skm-page-head">
          <div class="skm-page-head-main">
            <h1 class="skm-page-title skm-title-with-tile">${agentTile(a, 28)}${esc(a.name)}<span class="skm-badge">${skills ? nf(skills.total) : "…"}</span></h1>
            <p class="skm-page-sub skm-path-line">${icon("folder", 13)}<code class="skm-path" title="${esc(a.globalPath)}">${esc(a.globalPath || "未设置目录")}</code></p>
          </div>
          <div class="skm-page-actions">
            <button class="skm-switch${a.enabled ? " is-on" : ""}" role="switch" aria-checked="${a.enabled}" data-act="agent-toggle" data-id="${esc(a.id)}" title="${a.enabled ? "停用" : "启用"}" aria-label="${a.enabled ? "停用" : "启用"} ${esc(a.name)}"><span></span></button>
            <button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="edit-agent" data-id="${esc(a.id)}">${icon("edit", 14)}编辑目录</button>
            ${a.origin === "builtin" ? `<button class="skm-btn skm-btn-ghost skm-btn-sm" data-act="agent-restore" data-id="${esc(a.id)}">恢复默认</button>` : `<button class="skm-btn skm-btn-ghost skm-btn-sm is-danger" data-act="agent-delete" data-id="${esc(a.id)}">${icon("trash", 14)}删除</button>`}
          </div>
        </header>
        ${state.error ? alertBox(state.error) : ""}
        <div class="skm-meta-grid">
          <div class="skm-kv"><span>目录状态</span><b class="${a.exists ? "is-ok" : "is-muted"}">${a.exists ? "已创建" : "目录未创建"}</b></div>
          <div class="skm-kv"><span>启用状态</span><b>${a.enabled ? "已启用" : "已停用"}</b></div>
          <div class="skm-kv"><span>来源</span><b>${a.origin === "builtin" ? "内置" : "自定义"}</b></div>
          <div class="skm-kv"><span>项目相对目录</span><b class="skm-mono">${esc(a.projectRelative || "无")}</b></div>
        </div>
        <section class="skm-section">
          <h2 class="skm-section-title">工作区绑定</h2>
          <div class="skm-panel skm-bind-list">
            ${bindings.length ? bindings.map((w) => `<button class="skm-bind-row" data-act="nav" data-view="workspace:${esc(w.id)}"><span class="skm-dir-ico">${icon(w.kind === "linked" ? "link" : "globe", 15)}</span><span>${esc(w.name)}</span><span class="skm-mini-pill">${w.kind === "global" ? "全局" : w.kind === "project" ? "项目" : "关联"}</span>${icon("chevronRight", 14)}</button>`).join("") : '<p class="skm-inline-note">尚未绑定到任何工作区。</p>'}
          </div>
        </section>
        <section class="skm-section">
          <div class="skm-section-head"><h2 class="skm-section-title">此 Agent 的技能</h2><button class="skm-btn skm-btn-ghost skm-btn-sm" data-act="refresh-agent" data-id="${esc(a.id)}">${icon("refresh", 14)}刷新</button></div>
          ${skills
            ? (skills.items.length
              ? `<div class="skm-card-grid">${skills.items.map(skillCard).join("")}</div>`
              : emptyState({ title: "这个 Agent 目录还没有技能", hint: a.exists ? "目录存在，但其中没有检测到 SKILL.md。" : "目录尚未创建，因此没有任何技能可读取。", action: `<button class="skm-btn skm-btn-secondary" data-act="edit-agent" data-id="${esc(a.id)}">检查目录路径</button>` }))
            : `<div class="skm-skeleton">${Array.from({ length: 3 }).map(() => '<div class="skm-skeleton-card"></div>').join("")}</div>`}
        </section>
      </div>`;
    }

    function workspaceCard(w) {
      const kindLabel = w.kind === "global" ? "全局" : w.kind === "project" ? "项目" : "关联";
      const ico = w.kind === "global" ? "globe" : w.kind === "project" ? "folder" : "link";
      return `<button class="skm-ws-card" data-act="nav" data-view="workspace:${esc(w.id)}">
        <span class="skm-ws-ico">${icon(ico, 18)}</span>
        <div class="skm-ws-main">
          <div class="skm-ws-name">${esc(w.name)}<span class="skm-mini-pill">${kindLabel}</span><span class="skm-status ${w.exists ? "is-ok" : "is-muted"}"><span class="skm-dot sm${w.exists ? " is-on" : ""}"></span>${w.exists ? "目录已创建" : "目录未创建"}</span></div>
          <code class="skm-path" title="${esc(w.root || "由各 Agent 的全局目录组成")}">${esc(w.root || "由各 Agent 的全局目录组成")}</code>
          <p class="skm-ws-meta">${nf((w.agentIds || []).length)} 个 Agent${w.kind === "global" ? ` · 中央库 ${nf(state.overview?.libraryTotal ?? 0)} 个技能` : ""}</p>
        </div>
        ${icon("chevronRight", 16, "skm-ws-chev")}
      </button>`;
    }

    function workspacesHTML() {
      const linked = state.workspaces.filter((w) => w.kind === "linked");
      const project = state.workspaces.filter((w) => w.kind === "project");
      return `<div class="skm-page">
        ${pageHead("工作区", { badge: nf(state.workspaces.length), sub: "技能在中央库与各 Agent 目录之间的映射。关联目录只读取已存在的绝对路径。", actions: `<button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="refresh-workspaces">${icon("refresh", 15)}刷新</button><button class="skm-btn skm-btn-primary skm-btn-sm" data-act="new-workspace">${icon("plus", 15)}关联目录</button>` })}
        ${state.error ? alertBox(state.error) : ""}
        <section class="skm-section">
          <h2 class="skm-section-title">全局工作区</h2>
          <div class="skm-ws-grid">${state.workspaces.filter((w) => w.kind === "global").map(workspaceCard).join("")}</div>
        </section>
        <section class="skm-section">
          <h2 class="skm-section-title">项目工作区</h2>
          ${project.length ? `<div class="skm-ws-grid">${project.map(workspaceCard).join("")}</div>` : emptyState({ title: "没有项目工作区", hint: "项目工作区来自当前工作目录，目录不存在时也会如实显示。" })}
        </section>
        <section class="skm-section">
          <div class="skm-section-head"><h2 class="skm-section-title">关联目录（${nf(linked.length)}）</h2><button class="skm-btn skm-btn-ghost skm-btn-sm" data-act="new-workspace">${icon("plus", 14)}关联目录</button></div>
          ${linked.length ? `<div class="skm-ws-grid">${linked.map(workspaceCard).join("")}</div>` : `<div class="skm-panel skm-empty-inline"><span>${icon("link", 18)}</span><p>尚未关联任何目录。关联后可浏览其中的技能条目，并与中央库对照。</p><button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="new-workspace">关联目录</button></div>`}
        </section>
      </div>`;
    }

    function entryHTML(item) {
      const zh = zhName(item);
      const desc = zhDescription(item) || String(item.description || "").trim();
      const missing = item.missingLocalization;
      return `<div class="skm-entry">
        <span class="skm-entry-ico">${icon("fileText", 16)}</span>
        <div class="skm-entry-main">
          <div class="skm-entry-name">${esc(item.name)}${zh ? `<span class="skm-row-zh">${esc(zh)}</span>` : ""}${missing ? '<span class="skm-mini-pill is-warn">缺少中文资料</span>' : ""}</div>
          ${desc ? `<p class="skm-entry-desc">${esc(desc)}</p>` : ""}
          <code class="skm-path" title="${esc(item.path)}">${esc(item.path)}</code>
          <div class="skm-entry-pills">
            <span class="skm-mini-pill ${item.inLibrary ? "is-ok" : ""}">${item.inLibrary ? "已在技能库" : "未收录"}</span>
            <span class="skm-mini-pill">${deployText(item.deployStatus)}</span>
            ${(item.tags || []).map((t) => `<span class="skm-tag">${esc(t)}</span>`).join("")}
          </div>
        </div>
        <span class="skm-entry-agent" title="${esc(agentName(item.agentId))}">${agentTile({ id: item.agentId }, 24)}<span>${esc(agentName(item.agentId))}</span></span>
      </div>`;
    }

    function workspaceDetailHTML(id) {
      const w = state.workspaces.find((x) => x.id === id);
      if (!w) return `<div class="skm-page">${pageHead("工作区未找到")}${emptyState({ title: "没有这个工作区", hint: "它可能已被移除。", action: '<button class="skm-btn skm-btn-secondary" data-act="nav" data-view="workspaces">返回工作区</button>' })}</div>`;
      const cache = state.entries[id];
      const data = cache?.data;
      const items = data?.items || [];
      const rows = data?.rows || [];
      const actionLabel = { "add-to-workspace": "待加入工作区", "add-to-library": "待收录到库", "in-sync": "已同步", "differs": "内容不同", external: "外部目录" };
      return `<div class="skm-page">
        <header class="skm-page-head">
          <div class="skm-page-head-main">
            <h1 class="skm-page-title skm-title-with-tile">${icon(w.kind === "linked" ? "link" : w.kind === "global" ? "globe" : "folder", 20)}${esc(w.name)}<span class="skm-badge">${data ? nf(items.length) : "…"}</span><span class="skm-mini-pill">${w.kind === "global" ? "全局" : w.kind === "project" ? "项目" : "关联"}</span></h1>
            <p class="skm-page-sub skm-path-line">${icon("folder", 13)}<code class="skm-path" title="${esc(w.root || "由各 Agent 的全局目录组成")}">${esc(w.root || "由各 Agent 的全局目录组成")}</code><span class="skm-status ${w.exists ? "is-ok" : "is-muted"}"><span class="skm-dot sm${w.exists ? " is-on" : ""}"></span>${w.exists ? "目录已创建" : "目录未创建"}</span></p>
          </div>
          <div class="skm-page-actions">
            <button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="ws-refresh" data-id="${esc(w.id)}">${icon("refresh", 14)}重新读取</button>
            ${w.kind === "linked" ? `<button class="skm-btn skm-btn-ghost skm-btn-sm is-danger" data-act="ws-delete" data-id="${esc(w.id)}">${icon("trash", 14)}移除</button>` : ""}
          </div>
        </header>
        ${state.error ? alertBox(state.error) : ""}
        <div class="skm-agent-chips">${(w.agentIds || []).map((aid) => `<span class="skm-agent-chip">${agentTile({ id: aid }, 20)}${esc(agentName(aid))}</span>`).join("") || '<span class="skm-inline-note">没有绑定 Agent</span>'}</div>
        <section class="skm-section">
          <h2 class="skm-section-title">工作区目录条目</h2>
          ${!cache || cache.loading ? `<div class="skm-skeleton">${Array.from({ length: 3 }).map(() => '<div class="skm-skeleton-card"></div>').join("")}</div>`
            : cache.error ? alertBox(cache.error)
            : items.length ? `<div class="skm-panel skm-entry-list">${items.map(entryHTML).join("")}</div>`
            : emptyState({ title: w.exists ? "目录中没有技能" : "目录尚未创建", hint: w.exists ? "已读取该工作区，但没有在已登记的 Agent 目录中发现 SKILL.md。" : "工作区路径尚不存在。关联目录只读取本机已存在的绝对路径，不会创建目录。", action: w.kind === "linked" ? "" : `<button class="skm-btn skm-btn-secondary" data-act="nav" data-view="agents">检查 Agent 目录</button>` })}
        </section>
        ${data && rows.length ? `<section class="skm-section">
          <h2 class="skm-section-title">库与工作区对照</h2>
          <div class="skm-panel skm-table-wrap"><table class="skm-table"><thead><tr><th>技能</th><th>技能库</th><th>工作区</th><th>部署状态</th><th>建议动作</th></tr></thead><tbody>
            ${rows.map((r) => `<tr><td>${esc(r.name)}${zhName(r) ? `<span class="skm-row-zh">${esc(zhName(r))}</span>` : ""}</td><td>${r.library ? "已收录" : "未收录"}</td><td>${r.workspace ? "存在" : "缺失"}</td><td>${esc(deployText(r.deployStatus))}</td><td><span class="skm-mini-pill">${esc(actionLabel[r.action] || r.action)}</span></td></tr>`).join("")}
          </tbody></table></div>
        </section>` : ""}
      </div>`;
    }

    function agentSettingsRows() {
      return state.agents.map((a) => `<div class="skm-set-row">
        <div class="skm-set-label"><div class="skm-set-name">${agentTile(a, 24)}<b>${esc(a.name)}</b><span class="skm-mini-pill">${a.origin === "builtin" ? "内置" : "自定义"}</span><span class="skm-status ${a.exists ? "is-ok" : "is-muted"}"><span class="skm-dot sm${a.exists ? " is-on" : ""}"></span>${a.exists ? "已创建" : "未创建"}</span></div>
          <code class="skm-path" title="${esc(a.globalPath)}">${esc(a.globalPath || "未设置")}</code></div>
        <div class="skm-set-control"><button class="skm-switch${a.enabled ? " is-on" : ""}" role="switch" aria-checked="${a.enabled}" data-act="agent-toggle" data-id="${esc(a.id)}" aria-label="${a.enabled ? "停用" : "启用"} ${esc(a.name)}"><span></span></button><button class="skm-icon-btn" data-act="edit-agent" data-id="${esc(a.id)}" title="编辑目录">${icon("edit", 15)}</button></div>
      </div>`).join("");
    }

    function settingsHTML() {
      const s = state.settings;
      const o = state.overview;
      const scan = o?.scan;
      return `<div class="skm-page is-narrow">
        ${pageHead("设置", { sub: "中央技能库、同步方式与只读边界。所有修改只写入当前 Profile，不改动源技能文件。" })}
        ${state.error ? alertBox(state.error) : ""}
        <section class="skm-section">
          <div class="skm-section-head"><h2 class="skm-section-title">支持的 Agents（${nf(state.agents.filter((a) => a.exists).length)}/${nf(state.agents.length)}）</h2><button class="skm-btn skm-btn-ghost skm-btn-sm" data-act="new-agent">${icon("plus", 14)}自定义 Agent</button></div>
          <div class="skm-panel skm-set-list">${agentSettingsRows()}</div>
        </section>
        <section class="skm-section">
          <h2 class="skm-section-title">全局配置</h2>
          <div class="skm-panel skm-set-list">
            <div class="skm-set-row">
              <div class="skm-set-label"><b>中央技能库路径</b><p>所有技能的中央副本与索引快照都保存在这里。</p><code class="skm-path" title="${esc(s?.libraryRoot || o?.library?.root || "")}">${esc(s?.libraryRoot || o?.library?.root || "读取中…")}</code></div>
              <div class="skm-set-control"><button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="edit-library">${icon("folderOpen", 14)}更改目录</button></div>
            </div>
            <div class="skm-set-row">
              <div class="skm-set-label"><b>默认同步方式</b><p>符号链接占用空间更小，复制则在目标目录保留独立副本。</p></div>
              <div class="skm-set-control"><div class="skm-segmented" role="group" aria-label="默认同步方式">
                <button class="skm-seg${s?.defaultMode === "symlink" ? " is-active" : ""}" data-act="set-mode" data-mode="symlink">符号链接</button>
                <button class="skm-seg${s?.defaultMode === "copy" ? " is-active" : ""}" data-act="set-mode" data-mode="copy">复制</button>
              </div></div>
            </div>
            <div class="skm-set-row">
              <div class="skm-set-label"><b>项目工作区路径</b><p>项目工作区中的技能目录会按 Agent 的项目相对目录解析。</p><code class="skm-path" title="${esc(s?.workspacePath || "")}">${esc(s?.workspacePath || "读取中…")}</code></div>
            </div>
            <div class="skm-set-row">
              <div class="skm-set-label"><b>索引状态</b><p>${scan ? `上次索引 ${esc(fmtTime(scan.at))}，读取 ${nf(scan.visited)} 个目录，收录 ${nf(scan.count)} 项。` : "尚未建立索引。扫描只读取已登记目录，不会执行技能内容。"}</p>${scan ? `<span class="skm-mini-pill ${scan.limited ? "is-warn" : "is-ok"}">${scan.limited ? "达到扫描上限" : "只读索引完成"}</span>` : ""}</div>
              <div class="skm-set-control"><button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="scan">${icon("scan", 14)}重建索引</button></div>
            </div>
          </div>
        </section>
        <section class="skm-section">
          <h2 class="skm-section-title">只读与安全边界</h2>
          <div class="skm-panel skm-readonly">
            <div class="skm-readonly-row">${icon("lock", 16)}<div><b>不执行任何技能内容</b><span>SKILL.md 只作为文本预览；不会运行脚本、命令、安装器或 MCP 服务。</span></div></div>
            <div class="skm-readonly-row">${icon("folder", 16)}<div><b>只扫描已登记目录</b><span>中央技能库、已登记的 Agent 目录与项目工作区；不会遍历整盘。</span></div></div>
            <div class="skm-readonly-row">${icon("fileText", 16)}<div><b>中文展示不改源文件</b><span>中文名称与简介来自本地词目或当前 Profile 覆盖，不会上传或改写 SKILL.md。</span></div></div>
          </div>
        </section>
        <section class="skm-section">
          <h2 class="skm-section-title">维护</h2>
          <div class="skm-actions">
            <button class="skm-btn skm-btn-secondary" data-act="refresh">${icon("refresh", 15)}刷新全部数据</button>
            <button class="skm-btn skm-btn-ghost" data-act="nav" data-view="library">前往技能库</button>
          </div>
        </section>
      </div>`;
    }

    function pageHTML() {
      if (state.view === "overview") return overviewHTML();
      if (state.view === "library") return libraryHTML();
      if (state.view === "agents") return agentsHTML();
      if (state.view.startsWith("agent:")) return agentDetailHTML(state.view.slice(6));
      if (state.view === "workspaces") return workspacesHTML();
      if (state.view.startsWith("workspace:")) return workspaceDetailHTML(state.view.slice(10));
      if (state.view === "settings") return settingsHTML();
      return overviewHTML();
    }

    function sheetHTML() {
      return `<div class="skm-sheet-backdrop" data-act="close-sheet"></div>
        <section class="skm-sheet-panel" role="dialog" aria-modal="true" aria-label="技能详情">
          <button class="skm-sheet-close" data-act="close-sheet" aria-label="关闭详情">${icon("x", 18)}</button>
          <div class="skm-sheet-scroll"><div class="skm-sheet-body" data-sheet-body></div></div>
        </section>`;
    }

    function docSection(d) {
      const zh = zhName(d);
      const desc = zhDescription(d) || String(d.description || "").trim();
      const agents = state.agents || [];
      const badges = d.agents || [];
      const deployed = agents.filter((a) => badges.some((b) => b.agentId === a.id && b.deployed));
      const metadata = [
        ["路径", d.path],
        ["来源类型", sourceType(d.source?.type)],
        ["来源地址", d.source?.url],
        ["来源引用", d.source?.ref],
        ["来源修订", d.source?.revision],
        ["快照摘要", d.digest],
        ["文件数", d.files ? String(d.files) : ""],
        ["占用空间", d.bytes != null ? fmtBytes(d.bytes) : ""],
        ["更新时间", d.updatedAt ? new Date(d.updatedAt).toLocaleString("zh-CN") : ""],
        ["上游状态", d.upstream ? upstreamText(d.upstream.status) : ""],
        ["内容与快照", d.contentMatchesSnapshot == null ? "" : d.contentMatchesSnapshot ? "一致" : d.source?.revision ? "不一致" : "无修订记录"],
      ].filter(([, v]) => v);
      const entries = d.entries || [];
      const deployRows = agents.map((a) => {
        const badge = badges.find((b) => b.agentId === a.id && b.deployed);
        return `<div class="skm-deploy-row">
          ${agentTile(a, 28)}
          <div class="skm-deploy-main"><b>${esc(a.name)}</b><span class="skm-deploy-path">${badge ? esc(badge.path || "") : esc(a.globalPath || "")}</span></div>
          ${badge ? `<span class="skm-mini-pill is-ok">${esc(deployText(badge.status))}</span><button class="skm-btn skm-btn-ghost skm-btn-sm" data-act="undeploy" data-skill="${esc(d.id)}" data-agent="${esc(a.id)}">移除</button>` : `<button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="deploy" data-skill="${esc(d.id)}" data-agent="${esc(a.id)}" ${a.exists ? "" : "disabled title=" + JSON.stringify("Agent 目录未创建")}>部署</button>`}
        </div>`;
      }).join("");
      const content = stripFrontmatter(d.content || "");
      return `<div class="skm-doc">
        <header class="skm-doc-head">
          <div class="skm-doc-titles">
            <h2>${esc(d.name)}</h2>
            ${zh ? `<p class="skm-doc-zh">${esc(zh)}</p>` : ""}
            <p class="skm-doc-desc">${desc ? esc(desc) : "源文件未提供简介。"}</p>
          </div>
        </header>
        <div class="skm-doc-meta">
          <span class="skm-mini-pill ${d.libraryStatus === "ok" ? "is-ok" : d.libraryStatus === "missing" ? "is-danger" : "is-warn"}">${libraryStatusText(d.libraryStatus)}</span>
          <span class="skm-mini-pill">${presentationText(d.presentationSource)}</span>
          <span class="skm-mini-pill">${sourceType(d.source?.type)}</span>
          ${(d.tags || []).map((t) => `<span class="skm-tag">${esc(t)}</span>`).join("")}
          <span class="skm-doc-meta-time">${icon("clock", 13)}${esc(fmtTime(d.updatedAt))}</span>
        </div>
        <div class="skm-doc-path">${icon("folder", 14)}<code class="skm-path" title="${esc(d.path)}">${esc(d.path || "—")}</code><button class="skm-icon-btn" data-act="copy" data-copy="${esc(d.path || "")}" title="复制路径">${icon("copy", 14)}</button></div>
        <div class="skm-doc-actions">
          <button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="edit-zh" data-id="${esc(d.id)}">${icon("edit", 14)}编辑中文展示</button>
          <button class="skm-btn skm-btn-ghost skm-btn-sm" data-act="open-dir" data-path="${esc(d.path || "")}">${icon("folderOpen", 14)}复制目录路径</button>
        </div>
        <section class="skm-doc-section">
          <h3 class="skm-section-title">部署到 Agent</h3>
          <div class="skm-panel skm-deploy-list">${deployRows}</div>
          <p class="skm-inline-note">部署只复制或链接当前技能目录，不会执行其中脚本。</p>
        </section>
        ${metadata.length ? `<section class="skm-doc-section">
          <button class="skm-meta-toggle" data-act="toggle-meta" aria-expanded="false">${icon("chevronDown", 14, "skm-meta-chev")}<span>来源与索引元信息</span></button>
          <div class="skm-panel skm-meta-card" data-meta hidden><div class="skm-meta-grid">${metadata.map(([k, v]) => `<div class="skm-kv"><span>${esc(k)}</span><b class="skm-mono" title="${esc(v)}">${esc(v)}</b></div>`).join("")}</div></div>
        </section>` : ""}
        ${entries.length ? `<section class="skm-doc-section">
          <details class="skm-files"><summary>技能目录文件（${nf(entries.length)}）</summary><div class="skm-file-list">${entries.map((f) => `<code>${esc(f)}</code>`).join("")}</div></details>
        </section>` : ""}
        <section class="skm-doc-section">
          <h3 class="skm-section-title">SKILL.md</h3>
          ${content ? `<div class="skm-markdown" data-doc-md></div>` : `<p class="skm-inline-note">没有可用的 SKILL.md 正文。${d.fileExists === "no" ? "源文件当前不可读，也不会执行其中的内容。" : ""}</p>`}
        </section>
        <footer class="skm-doc-foot">${icon("lock", 13)}只读预览 · 不执行技能内容 · 中文展示只写入当前 Profile</footer>
      </div>`;
    }

    async function openSheet(id) {
      state.lastFocus = document.activeElement;
      const sheet = q("[data-skm-sheet]", root);
      sheet.hidden = false;
      requestAnimationFrame(() => sheet.classList.add("is-open"));
      const body = q("[data-sheet-body]", sheet);
      body.innerHTML = `<div class="skm-sheet-loading">${icon("refresh", 18, "skm-spin")}正在读取技能详情…</div>`;
      const ticket = (state.sheetTicket = (state.sheetTicket || 0) + 1);
      try {
        const d = await api("GET", "/skill?id=" + encodeURIComponent(id));
        if (ticket !== state.sheetTicket || !root.isConnected) return;
        state.detail = d;
        body.innerHTML = docSection(d);
        const md = q("[data-doc-md]", body);
        if (md) U().markdown(md, stripFrontmatter(d.content || ""));
        q(".skm-sheet-close", sheet)?.focus();
        syncUnsaved();
      } catch (err) {
        if (signal?.aborted) return;
        body.innerHTML = `<div class="skm-sheet-error">${alertBox(err.message || "读取技能详情失败")}</div>`;
      }
    }

    function closeSheet(force) {
      const sheet = q("[data-skm-sheet]", root);
      if (!sheet || sheet.hidden) return;
      sheet.classList.remove("is-open");
      state.sheetTicket = (state.sheetTicket || 0) + 1;
      const done = () => {
        if (!sheet.isConnected) return;
        sheet.hidden = true;
        q("[data-sheet-body]", sheet).innerHTML = "";
        state.detail = null;
        delete root._wbUnsaved;
        try { state.lastFocus?.focus?.(); } catch {}
      };
      if (force) done();
      else setTimeout(done, 160);
    }

    function syncUnsaved() {
      delete root._wbUnsaved;
    }

    function paintTop() {
      const top = q("[data-skm-topbar]", root);
      if (top) top.innerHTML = topbarHTML();
      const sub = q("[data-skm-subnav]", root);
      if (sub) {
        const html = subnavHTML();
        if (sub.innerHTML !== html) sub.innerHTML = html;
      }
    }

    function paintPage() {
      const host = q("[data-skm-page]", root);
      if (!host) return;
      host.innerHTML = pageHTML();
      const active = q("[data-skm-topbar] .skm-nav.is-active", root);
      if (active && !active.contains(document.activeElement)) {
        // 仅在导航后把焦点交给页面标题，避免打断正在输入的搜索框。
        if (state.focusPage) {
          state.focusPage = false;
          const title = q(".skm-page-title", host);
          if (title) { title.tabIndex = -1; title.focus({ preventScroll: true }); }
        }
      }
    }

    function paint() {
      paintTop();
      paintPage();
    }

    async function loadOverview(force) {
      try {
        const d = await api("GET", "/overview");
        if (signal?.aborted) return;
        state.overview = d;
        state.agents = d.agents || [];
        state.workspaces = d.workspaces || [];
        state.presets = d.presets || [];
        state.tags = d.tags || [];
        state.activity = d.activity || [];
        state.scan = d.scan || null;
        state.error = "";
      } catch (err) {
        if (signal?.aborted) return;
        state.error = err.message || "读取概览失败";
      }
    }

    async function loadSettings() {
      try {
        state.settings = await api("GET", "/settings");
      } catch (err) {
        if (!signal?.aborted) state.settings = null;
      }
    }

    async function loadAgentCounts() {
      await Promise.all(state.agents.map(async (a) => {
        try {
          const d = await api("GET", `/library?agent=${encodeURIComponent(a.id)}&limit=1`);
          state.agentCounts[a.id] = d.total || 0;
        } catch {
          state.agentCounts[a.id] = null;
        }
      }));
      if (root.isConnected && state.view !== "library") paintTop();
    }

    async function loadLibrary() {
      const l = state.library;
      l.loading = true;
      l.error = "";
      paintLibraryResults();
      try {
        const params = new URLSearchParams({ limit: "100" });
        if (l.q) params.set("q", l.q);
        if (l.tag) params.set("tag", l.tag);
        if (l.category) params.set("category", l.category);
        if (l.agent) params.set("agent", l.agent);
        const d = await api("GET", "/library?" + params.toString());
        if (signal?.aborted) return;
        l.items = d.items || [];
        l.total = d.total || 0;
        l.loaded = true;
        if (l.offset >= libraryFiltered().length) l.offset = 0;
      } catch (err) {
        if (signal?.aborted) return;
        l.error = err.message || "读取技能库失败";
        if (!l.loaded) { l.items = []; l.total = 0; }
      } finally {
        l.loading = false;
        paintLibraryResults();
        paintTop();
      }
    }

    function paintLibraryResults() {
      const host = q("[data-lib-results]", root);
      if (!host) return;
      host.innerHTML = libraryResultsHTML();
      const total = q("[data-lib-total]", root);
      if (total) total.textContent = nf(state.library.total);
      const badge = q(".skm-page-title .skm-badge", root);
      if (badge && state.view === "library") badge.textContent = nf(state.library.total);
    }

    async function loadAgentSkills(id, force) {
      if (!force && state.agentSkills[id]) return;
      state.agentSkills[id] = null;
      paintPage();
      try {
        const d = await api("GET", `/library?agent=${encodeURIComponent(id)}&limit=100`);
        if (signal?.aborted) return;
        state.agentSkills[id] = { items: d.items || [], total: d.total || 0 };
      } catch (err) {
        if (signal?.aborted) return;
        state.agentSkills[id] = { items: [], total: 0, error: err.message };
      }
      if (state.view === "agent:" + id) paintPage();
    }

    async function loadEntries(id, force) {
      if (!force && state.entries[id]?.data) return;
      state.entries[id] = { loading: true };
      paintPage();
      try {
        const d = await api("POST", "/workspace/entries", { id });
        if (signal?.aborted) return;
        state.entries[id] = { data: d };
      } catch (err) {
        if (signal?.aborted) return;
        state.entries[id] = { error: err.message || "读取工作区失败" };
      }
      if (state.view === "workspace:" + id) paintPage();
    }

    async function go(view) {
      if (state.view !== view) closeSheet(true);
      state.view = view;
      state.error = "";
      state.focusPage = true;
      paintTop();
      paintPage();
      if (view === "overview" || view === "settings" || view === "agents" || view === "workspaces") {
        if (!state.overview) { await loadOverview(); paint(); }
        if (view === "settings" && !state.settings) { await loadSettings(); paintPage(); }
        if (view === "overview" && !state.library.loaded && (state.overview?.libraryTotal || 0) > 0) {
          await loadLibrary();
          paintPage();
        }
      }
      if (view === "library" && !state.library.loaded) await loadLibrary();
      if (view.startsWith("agent:")) await loadAgentSkills(view.slice(6));
      if (view.startsWith("workspace:")) await loadEntries(view.slice(10));
      paintTop();
    }

    function notify(msg, kind) { U().notify(msg, { kind: kind || "success" }); }

    async function refreshAll() {
      await Promise.all([loadOverview(true), loadSettings()]);
      state.library.loaded = false;
      state.agentSkills = {};
      state.entries = {};
      paint();
      if (state.view === "library") await loadLibrary();
      if (state.view.startsWith("agent:")) await loadAgentSkills(state.view.slice(6), true);
      if (state.view.startsWith("workspace:")) await loadEntries(state.view.slice(10), true);
      notify("数据已刷新");
    }

    async function scanLibrary(button) {
      if (button) { button.disabled = true; }
      try {
        const task = await U().request("POST", "/api/skills/scan", {}, { signal });
        await U().job(task, { signal });
        await loadOverview(true);
        state.library.loaded = false;
        state.agentSkills = {};
        state.entries = {};
        state.library.offset = 0;
        paint();
        if (state.view === "library") await loadLibrary();
        notify("只读索引已更新", "success");
      } catch (err) {
        if (!signal?.aborted) notify(err.message || "扫描失败", "error");
      } finally {
        if (button?.isConnected) button.disabled = false;
      }
    }

    function dialogForm(fields) {
      return `<form class="skm-form" data-form>${fields.map((f) => f.type === "checkbox"
        ? `<label class="skm-check"><input type="checkbox" name="${esc(f.name)}" ${f.checked ? "checked" : ""}><span>${esc(f.label)}</span></label>`
        : `<label class="skm-field"><span>${esc(f.label)}</span>${f.multiline
          ? `<textarea class="skm-input" name="${esc(f.name)}" rows="3" maxlength="${f.max || 320}" placeholder="${esc(f.placeholder || "")}">${esc(f.value || "")}</textarea>`
          : `<input class="skm-input" type="text" name="${esc(f.name)}" value="${esc(f.value || "")}" maxlength="${f.max || 200}" placeholder="${esc(f.placeholder || "")}" autocomplete="off" spellcheck="false">`}</label>`).join("")}${fields.note ? `<p class="skm-inline-note">${esc(fields.note)}</p>` : ""}</form>`;
    }

    function openAgentEditor(agent) {
      const isNew = !agent;
      const a = agent || { id: "", name: "", globalPath: "", projectRelative: "", enabled: true, origin: "custom" };
      const body = `<div class="skm-dialog">
        ${dialogForm([
          { name: "id", label: "Agent 标识（字母、数字、_ . -）", value: a.id, max: 48 },
          { name: "name", label: "显示名称", value: a.name, max: 60 },
          { name: "path", label: "全局技能目录（本机绝对路径）", value: a.globalPath || "", max: 400 },
          { name: "projectRelative", label: "项目相对目录（可选）", value: a.projectRelative || "", max: 200 },
          { type: "checkbox", name: "enabled", label: "启用此 Agent", checked: a.enabled !== false },
        ])}
        <p class="skm-inline-note">只读取这个目录，不会创建、改写或执行目录中的任何内容。</p>
        <div class="skm-dialog-actions"><button class="skm-btn skm-btn-secondary" data-dlg-cancel>取消</button><button class="skm-btn skm-btn-primary" data-dlg-save>${isNew ? "添加 Agent" : "保存"}</button></div>
      </div>`;
      const dlg = U().dialog(isNew ? "添加自定义 Agent" : "编辑 Agent 目录", body);
      q("[data-dlg-cancel]", dlg.body).onclick = () => dlg.close(true);
      q("[data-dlg-save]", dlg.body).onclick = async () => {
        const form = q("[data-form]", dlg.body);
        const data = Object.fromEntries(new FormData(form).entries());
        const payload = { id: String(data.id || "").trim(), name: String(data.name || "").trim(), path: String(data.path || "").trim(), projectRelative: String(data.projectRelative || "").trim(), enabled: !!form.querySelector('[name="enabled"]').checked };
        if (!payload.id || !payload.name) return notify("请填写 Agent 标识与名称", "error");
        if (!/^[A-Za-z0-9_.-]{1,48}$/.test(payload.id)) return notify("Agent 标识只能包含字母、数字、_ . -", "error");
        if (payload.path && !/^[A-Za-z]:[\\/]|^\//.test(payload.path)) return notify("请填写本机绝对路径", "error");
        try {
          await api("POST", "/agents", payload);
          dlg.close(true);
          await loadOverview(true);
          paint();
          if (state.view.startsWith("agent:")) await loadAgentSkills(state.view.slice(6), true);
          notify(isNew ? "已添加 Agent" : "Agent 目录已保存");
        } catch (err) { notify(err.message || "保存失败", "error"); }
      };
    }

    function openWorkspaceDialog() {
      const agents = state.agents.filter((a) => a.projectRelative || a.id);
      const body = `<div class="skm-dialog">
        <p class="skm-inline-note">关联目录必须是本机已存在的绝对路径。登记后只读取其中的 SKILL.md，不会创建目录或执行技能。</p>
        ${dialogForm([
          { name: "name", label: "工作区名称（可选，最多 80 字）", value: "", max: 80 },
          { name: "root", label: "目录绝对路径", value: "", max: 400, placeholder: "D:\\path\\to\\workspace" },
        ])}
        <div class="skm-field"><span>绑定 Agent</span><div class="skm-checks">${agents.map((a) => `<label class="skm-check"><input type="checkbox" name="agent" value="${esc(a.id)}" ${a.projectRelative ? "checked" : ""}><span>${esc(a.name)}</span></label>`).join("")}</div></div>
        <div class="skm-dialog-actions"><button class="skm-btn skm-btn-secondary" data-dlg-cancel>取消</button><button class="skm-btn skm-btn-primary" data-dlg-save>关联目录</button></div>
      </div>`;
      const dlg = U().dialog("关联工作区目录", body);
      q("[data-dlg-cancel]", dlg.body).onclick = () => dlg.close(true);
      q("[data-dlg-save]", dlg.body).onclick = async () => {
        const form = q("[data-form]", dlg.body);
        const name = String(q('[name="name"]', form).value || "").trim();
        const dir = String(q('[name="root"]', form).value || "").trim();
        const agentIds = [...form.querySelectorAll('[name="agent"]:checked')].map((x) => x.value);
        if (!dir || !/^[A-Za-z]:[\\/]|^\//.test(dir)) return notify("请填写本机绝对路径", "error");
        try {
          await api("POST", "/workspaces", { name: name || undefined, root: dir, agentIds });
          dlg.close(true);
          await loadOverview(true);
          paint();
          notify("工作区已关联");
        } catch (err) { notify(err.message || "关联失败", "error"); }
      };
    }

    async function openPresetDialog() {
      if (!state.library.loaded) await loadLibrary();
      const items = (state.library.items || []).slice(0, 40);
      const body = `<div class="skm-dialog">
        ${dialogForm([
          { name: "name", label: "预设名称", value: "", max: 80 },
          { name: "description", label: "说明（可选）", value: "", max: 240, multiline: true },
        ])}
        <div class="skm-field"><span>选择技能（当前已载入 ${nf(items.length)} 项）</span><div class="skm-checks is-scroll">${items.map((s) => `<label class="skm-check"><input type="checkbox" name="skill" value="${esc(s.id)}"><span>${esc(s.name)}${zhName(s) ? ` <em>${esc(zhName(s))}</em>` : ""}</span></label>`).join("") || '<p class="skm-inline-note">技能库为空，尚不能创建预设。</p>'}</div></div>
        <div class="skm-dialog-actions"><button class="skm-btn skm-btn-secondary" data-dlg-cancel>取消</button><button class="skm-btn skm-btn-primary" data-dlg-save>创建预设</button></div>
      </div>`;
      const dlg = U().dialog("新建预设", body);
      q("[data-dlg-cancel]", dlg.body).onclick = () => dlg.close(true);
      q("[data-dlg-save]", dlg.body).onclick = async () => {
        const form = q("[data-form]", dlg.body);
        const name = String(q('[name="name"]', form).value || "").trim();
        const description = String(q('[name="description"]', form).value || "").trim();
        const skillIds = [...form.querySelectorAll('[name="skill"]:checked')].map((x) => x.value);
        if (!name) return notify("请填写预设名称", "error");
        try {
          await api("POST", "/preset", { name, description, skillIds });
          dlg.close(true);
          await loadOverview(true);
          paint();
          notify("预设已创建");
        } catch (err) { notify(err.message || "创建失败", "error"); }
      };
    }

    function confirmDialog(title, message, onConfirm, confirmLabel) {
      const body = `<div class="skm-dialog"><p class="skm-confirm-text">${esc(message)}</p><div class="skm-dialog-actions"><button class="skm-btn skm-btn-secondary" data-dlg-cancel>取消</button><button class="skm-btn skm-btn-danger" data-dlg-save>${esc(confirmLabel || "确认")}</button></div></div>`;
      const dlg = U().dialog(title, body);
      q("[data-dlg-cancel]", dlg.body).onclick = () => dlg.close(true);
      q("[data-dlg-save]", dlg.body).onclick = async () => {
        try { await onConfirm(); dlg.close(true); } catch (err) { notify(err.message || "操作失败", "error"); }
      };
    }

    function editPresentation(id) {
      const d = state.detail;
      if (!d) return;
      const body = `<div class="skm-dialog">
        <p class="skm-inline-note">中文展示来自本地词目或当前 Profile 覆盖，不会修改 SKILL.md，也不会上传正文。标题与简介都必须包含中文。</p>
        ${dialogForm([
          { name: "title", label: "中文名称（最多 80 字）", value: zhName(d), max: 80 },
          { name: "description", label: "中文简介（最多 320 字）", value: zhDescription(d), max: 320, multiline: true },
        ])}
        <div class="skm-dialog-actions"><button class="skm-btn skm-btn-ghost" data-dlg-clear>清除覆盖</button><button class="skm-btn skm-btn-secondary" data-dlg-cancel>取消</button><button class="skm-btn skm-btn-primary" data-dlg-save>保存到当前 Profile</button></div>
      </div>`;
      const dlg = U().dialog("编辑中文展示", body);
      q("[data-dlg-cancel]", dlg.body).onclick = () => dlg.close(true);
      q("[data-dlg-clear]", dlg.body).onclick = async () => {
        try {
          await api("POST", "/presentation", { id, title: "清除中文展示", description: "清除当前 Profile 中的中文覆盖", clear: true });
          dlg.close(true);
          await reloadDetail(id);
          notify("已清除中文覆盖");
        } catch (err) { notify(err.message || "清除失败", "error"); }
      };
      q("[data-dlg-save]", dlg.body).onclick = async () => {
        const form = q("[data-form]", dlg.body);
        const title = String(q('[name="title"]', form).value || "").trim();
        const description = String(q('[name="description"]', form).value || "").trim();
        if (!title || !/[\u3400-\u9fff]/.test(title)) return notify("中文名称必须包含中文", "error");
        if (!description || !/[\u3400-\u9fff]/.test(description)) return notify("中文简介必须包含中文", "error");
        try {
          const d2 = await api("POST", "/presentation", { id, title, description });
          dlg.close(true);
          state.detail = d2;
          const bodyHost = q("[data-sheet-body]", root);
          if (bodyHost) {
            bodyHost.innerHTML = docSection(d2);
            const md = q("[data-doc-md]", bodyHost);
            if (md) U().markdown(md, stripFrontmatter(d2.content || ""));
          }
          notify("中文展示已保存");
        } catch (err) { notify(err.message || "保存失败", "error"); }
      };
    }

    async function reloadDetail(id) {
      const d = await api("GET", "/skill?id=" + encodeURIComponent(id));
      state.detail = d;
      const host = q("[data-sheet-body]", root);
      if (host) {
        host.innerHTML = docSection(d);
        const md = q("[data-doc-md]", host);
        if (md) U().markdown(md, stripFrontmatter(d.content || ""));
      }
    }

    async function deployAction(skillId, agentId, deploy) {
      try {
        const payload = { skillId, agentId };
        if (deploy) payload.mode = state.settings?.defaultMode || "symlink";
        await api("POST", deploy ? "/deploy" : "/undeploy", payload);
        notify(deploy ? "已部署到 Agent" : "已从 Agent 移除");
        await reloadDetail(skillId);
        await loadOverview(true);
        paintTop();
      } catch (err) { notify(err.message || "操作失败", "error"); }
    }

    function bindEvents(app) {
      app.addEventListener("click", async (ev) => {
        const card = ev.target.closest("[data-open-skill]");
        if (card && app.contains(card)) { await openSheet(card.dataset.openSkill); return; }
        const target = ev.target.closest("[data-act]");
        if (!target || !app.contains(target)) return;
        const act = target.dataset.act;
        if (act === "nav") { closeSheet(true); await go(target.dataset.view); return; }
        if (act === "group") {
          const key = target.dataset.group;
          state.groups[key] = !state.groups[key];
          paintTop();
          return;
        }
        if (act === "preset") {
          state.library.preset = target.dataset.preset || "";
          state.library.offset = 0;
          if (state.view !== "library") await go("library");
          else { paintPage(); paintLibraryResults(); }
          return;
        }
        if (act === "lib-status") { state.library.status = target.dataset.status; state.library.offset = 0; paintPage(); return; }
        if (act === "lib-category") { state.library.category = target.dataset.category; state.library.offset = 0; await loadLibrary(); paintPage(); q(`[data-act=lib-category][data-category="${CSS.escape(state.library.category)}"]`,root)?.focus({preventScroll:true}); return; }
        if (act === "lib-source") { state.library.source = target.dataset.source; state.library.offset = 0; paintPage(); return; }
        if (act === "lib-view") { state.library.view = target.dataset.view === "list" ? "list" : "grid"; paintPage(); return; }
        if (act === "lib-page") {
          const dir = Number(target.dataset.dir || 0);
          const max = Math.max(1, Math.ceil(libraryFiltered().length / state.library.limit));
          const page = Math.min(max, Math.max(1, Math.floor(state.library.offset / state.library.limit) + 1 + dir));
          state.library.offset = (page - 1) * state.library.limit;
          paintLibraryResults();
          q("[data-lib-results]", root)?.scrollIntoView({ block: "nearest" });
          return;
        }
        if (act === "tag") { state.library.tag = state.library.tag === target.dataset.tag ? "" : target.dataset.tag; state.library.offset = 0; await loadLibrary(); paintPage(); return; }
        if (act === "clear-filters") {
          Object.assign(state.library, { q: "", tag: "", agent: "", status: "all", source: "", category: "", preset: "", offset: 0 });
          await loadLibrary();
          paintPage();
          return;
        }
        if (act === "clear-preset") { state.library.preset = ""; state.library.offset = 0; paintPage(); return; }
        if (act === "refresh") { await refreshAll(); return; }
        if (act === "scan") { await scanLibrary(target); return; }
        if (act === "new-workspace") { openWorkspaceDialog(); return; }
        if (act === "new-preset") { await openPresetDialog(); return; }
        if (act === "new-agent") { openAgentEditor(null); return; }
        if (act === "edit-agent") { openAgentEditor(state.agents.find((a) => a.id === target.dataset.id)); return; }
        if (act === "agent-toggle") {
          const a = state.agents.find((x) => x.id === target.dataset.id);
          if (!a) return;
          target.disabled = true;
          try {
            const d = await api("POST", "/agents", { id: a.id, enabled: !a.enabled });
            state.agents = d.items || state.agents;
            if (state.overview) state.overview.agents = state.agents;
            paint();
            notify(!a.enabled ? "Agent 已启用" : "Agent 已停用");
          } catch (err) { notify(err.message || "操作失败", "error"); target.disabled = false; }
          return;
        }
        if (act === "agent-restore") {
          const id = target.dataset.id;
          confirmDialog("恢复默认目录", `确定将「${agentName(id)}」的全局目录恢复为默认路径吗？`, async () => {
            await api("POST", "/agents", { id, restore: true });
            await loadOverview(true);
            paint();
            notify("已恢复默认目录");
          }, "恢复默认");
          return;
        }
        if (act === "agent-delete") {
          const id = target.dataset.id;
          confirmDialog("移除自定义 Agent", `确定移除「${agentName(id)}」吗？只会移除登记，不会删除本机目录。`, async () => {
            await api("POST", "/agents", { id, delete: true });
            await loadOverview(true);
            await go("agents");
            notify("已移除 Agent");
          }, "移除");
          return;
        }
        if (act === "refresh-agent") { await loadAgentSkills(target.dataset.id, true); notify("已刷新"); return; }
        if (act === "refresh-workspaces") { await loadOverview(true); paint(); notify("已刷新"); return; }
        if (act === "ws-refresh") { await loadEntries(target.dataset.id, true); return; }
        if (act === "ws-delete") {
          const w = state.workspaces.find((x) => x.id === target.dataset.id);
          confirmDialog("移除关联工作区", `确定移除「${w?.name || "该工作区"}」吗？只会移除登记，不会删除本机目录。`, async () => {
            await api("POST", "/workspaces/delete", { id: target.dataset.id });
            await loadOverview(true);
            await go("workspaces");
            notify("已移除工作区");
          }, "移除");
          return;
        }
        if (act === "edit-library") {
          const current = state.settings?.libraryRoot || state.overview?.library?.root || "";
          const body = `<div class="skm-dialog"><p class="skm-inline-note">中央技能库路径必须是本机绝对路径。修改后不会移动或删除已有文件。</p>${dialogForm([{ name: "root", label: "中央技能库绝对路径", value: current, max: 400 }])}<div class="skm-dialog-actions"><button class="skm-btn skm-btn-secondary" data-dlg-cancel>取消</button><button class="skm-btn skm-btn-primary" data-dlg-save>保存</button></div></div>`;
          const dlg = U().dialog("更改中央技能库目录", body);
          q("[data-dlg-cancel]", dlg.body).onclick = () => dlg.close(true);
          q("[data-dlg-save]", dlg.body).onclick = async () => {
            const dir = String(q('[name="root"]', dlg.body).value || "").trim();
            if (!dir || !/^[A-Za-z]:[\\/]|^\//.test(dir)) return notify("请填写本机绝对路径", "error");
            try {
              await api("POST", "/settings", { libraryRoot: dir });
              dlg.close(true);
              await Promise.all([loadOverview(true), loadSettings()]);
              paint();
              notify("中央技能库路径已保存");
            } catch (err) { notify(err.message || "保存失败", "error"); }
          };
          return;
        }
        if (act === "set-mode") {
          try {
            await api("POST", "/settings", { defaultMode: target.dataset.mode });
            await loadSettings();
            paintPage();
            notify("默认同步方式已更新");
          } catch (err) { notify(err.message || "保存失败", "error"); }
          return;
        }
        if (act === "open-skill") { await openSheet(target.dataset.openSkill); return; }
        if (act === "close-sheet") { closeSheet(); return; }
        if (act === "copy" || act === "open-dir") {
          const value = target.dataset.copy || target.dataset.path || "";
          if (!value) return;
          try { await navigator.clipboard.writeText(value); notify("路径已复制"); }
          catch { notify("无法访问剪贴板", "error"); }
          return;
        }
        if (act === "deploy") { await deployAction(target.dataset.skill, target.dataset.agent, true); return; }
        if (act === "undeploy") { await deployAction(target.dataset.skill, target.dataset.agent, false); return; }
        if (act === "toggle-meta") {
          const expanded = target.getAttribute("aria-expanded") === "true";
          target.setAttribute("aria-expanded", expanded ? "false" : "true");
          const card = q("[data-meta]", target.parentElement);
          if (card) card.hidden = expanded;
          return;
        }
        if (act === "edit-zh") { editPresentation(state.detail?.id); return; }
        if (act === "retry") { await refreshAll(); return; }
      });

      app.addEventListener("input", (ev) => {
        const input = ev.target.closest("[data-lib-search]");
        if (!input) return;
        state.library.q = input.value;
        state.library.offset = 0;
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(() => loadLibrary(), 220);
      });

      app.addEventListener("keydown", async (ev) => {
        const card = ev.target.closest?.("[data-open-skill]");
        if (card && (ev.key === "Enter" || ev.key === " ")) {
          ev.preventDefault();
          await openSheet(card.dataset.openSkill);
          return;
        }
        const sheet = q("[data-skm-sheet]", root);
        if (sheet && !sheet.hidden) {
          if (ev.key === "Escape") { ev.preventDefault(); closeSheet(); return; }
          if (ev.key === "Tab") {
            const focusables = [...sheet.querySelectorAll("button, [href], input, textarea, [tabindex]:not([tabindex='-1'])")].filter((el) => !el.disabled && el.offsetParent !== null);
            if (!focusables.length) return;
            const first = focusables[0], last = focusables[focusables.length - 1];
            if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
            else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
          }
        }
      });
    }

    function injectCss() {
      if (document.querySelector("link[data-skill-manager-css]")) return;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/skill-manager.css";
      link.dataset.skillManagerCss = "1";
      document.head.append(link);
    }

    injectCss();
    root.classList.add("wb-fixed-layout");
    root.innerHTML = `<div class="skm-app skm-catalog" data-skm>
      <header class="skm-topbar" data-skm-topbar aria-label="技能管理导航"></header>
      <div class="skm-subnav" data-skm-subnav aria-label="技能管理二级导航"></div>
      <main class="skm-main" data-skm-main><div class="skm-main-scroll"><div data-skm-page></div></div></main>
      <div class="skm-sheet" data-skm-sheet hidden></div>
      <div class="skm-live" aria-live="polite"></div>
    </div>`;
    const app = q("[data-skm]", root);
    const sheet = q("[data-skm-sheet]", root);
    sheet.innerHTML = sheetHTML();
    bindEvents(app);
    delete root._wbUnsaved;
    const priorDispose = root._wbDispose;
    root._wbDispose = () => {
      clearTimeout(state.searchTimer);
      try { priorDispose?.(); } catch {}
    };
    state.groups = { presets: true, agents: true, workspaces: true };
    paint();
    await Promise.all([loadOverview(), loadSettings()]);
    if (signal?.aborted || !root.isConnected) return;
    if ((state.overview?.libraryTotal || 0) > 0) await loadLibrary();
    paint();
    void loadAgentCounts();
    if (state.view === "library" && !state.library.loaded) await loadLibrary();
    if (state.view.startsWith("agent:")) await loadAgentSkills(state.view.slice(6));
    if (state.view.startsWith("workspace:")) await loadEntries(state.view.slice(10));
  }

  window.LibraryViews = { ...(window.LibraryViews || {}), skills };
})();
