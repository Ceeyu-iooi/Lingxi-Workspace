// @ts-nocheck
// Compatibility controller: retain the validated interactions during the React migration.
/* 个人总控台前端。所有数据经由 store（异步适配器）与本地服务交互，
   模块间不直接读写彼此的 DOM/存储，仅通过 store 与事件刷新。 */
"use strict";
const layoutStorage = window.wbLayoutStorage;

/* ---------------- 异步存储适配器（module-contract） ---------------- */
const store = {
  async read(namespace) {
    const res = await api("GET", `/api/state`);
    return res ? res[namespace] : null;
  },
  async write(namespace, key, value) {
    if (namespace === "tasks") {
      return key
        ? api("POST", `/api/tasks/${encodeURIComponent(key)}`, value)
        : api("POST", "/api/tasks", value);
    }
    if (namespace === "projects") {
      return key
        ? api("POST", `/api/projects/${encodeURIComponent(key)}`, value)
        : api("POST", "/api/projects", value);
    }
    if (namespace === "summaries") {
      return api("POST", "/api/summary/save", value);
    }
    throw new Error("unsupported namespace: " + namespace);
  },
  async remove(namespace, key) {
    if (namespace === "tasks")
      return api("POST", `/api/tasks/${encodeURIComponent(key)}`, {
        _method: "DELETE",
      });
    if (namespace === "projects")
      return api("POST", `/api/projects/${encodeURIComponent(key)}`, {
        _method: "DELETE",
      });
    if (namespace === "summaries")
      return api("POST", `/api/summary/${encodeURIComponent(key)}`, {});
    throw new Error("unsupported namespace: " + namespace);
  },
  async list(namespace, query) {
    if (namespace === "news")
      return api("GET", "/api/news" + (query && query.force ? "?force=1" : ""));
    if (namespace === "backups") return api("GET", "/api/backups");
    if (namespace === "summaryDraft")
      return api(
        "GET",
        `/api/summary/draft${query && query.month ? "?month=" + query.month : ""}`,
      );
    const res = await api("GET", "/api/state");
    return res ? res[namespace] : null;
  },
  async export() {
    await layoutStorage.flush();
    return api("GET", "/api/export");
  },
  async import(envelope) {
    await layoutStorage.flush();
    const result = await api("POST", "/api/import", envelope);
    if (user)
      await layoutStorage.hydrate(user.username, {
        force: true,
        discardPending: true,
      });
    return result;
  },
};

async function api(method, url, body, { auth = false, signal } = {}) {
  const identity = user?.username,
    opt = { method, headers: {}, signal };
  if (body !== undefined) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(url, opt);
  const data = await res.json().catch(() => ({}));
  if (!auth && identity !== user?.username)
    throw new DOMException("账户已切换", "AbortError");
  if (!res.ok) {
    if (res.status === 401 && !auth) {
      showProfile();
    }
    const error = new Error(data.error || `请求失败（${res.status}）`);
    Object.assign(error, data, { status: res.status });
    throw error;
  }
  return data;
}

window.workbenchRequest = api;

/* ---------------- 工具 ---------------- */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
let toastTimer;
function toast(msg, options = {}) {
  const host=$("#toast");if(window.WorkbenchReact?.toast){window.WorkbenchReact.toast(host,msg,options);return;}
  host.textContent=msg;host.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>host.classList.remove('show'),2600);
}
window.workbenchNotify = toast;
function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(typeof iso === "number" ? iso * 1000 : iso);
  if (isNaN(d.getTime())) return "时间未知";
  const now = new Date();
  const diff = (now - d) / 60000;
  if (diff < 1) return "刚刚";
  if (diff < 60) return `${Math.floor(diff)} 分钟前`;
  if (diff < 60 * 24) return `${Math.floor(diff / 60)} 小时前`;
  if (diff < 60 * 24 * 7) return `${Math.floor(diff / 60 / 24)} 天前`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 星期${"日一二三四五六"[d.getDay()]}`;
}
function fmtDue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `明天 ${hm}`;
  return sameYear ? `${md} ${hm}` : `${d.getFullYear()}年${md} ${hm}`;
}
function monthStr(offset = 0) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/* ---------------- 全局状态 ---------------- */
let state = {
  projects: [],
  tasks: [],
  activities: [],
  summaries: [],
  transactions: [],
  settings: {},
};
let user = null;
let summaryDraft = null;
let refreshSequence = 0;

async function refresh() {
  const identity = user?.username,
    sequence = ++refreshSequence;
  const res = await api("GET", "/api/state");
  if (!user || user.username !== identity || sequence !== refreshSequence)
    return res;
  state = res;
  if (user) await layoutStorage.hydrate(user.username);
  return res;
}
const projName = (id) =>
  (state.projects.find((p) => p.id === id) || {}).name || "";
const projectStats = (pid) => {
  const ts = state.tasks.filter((t) => t.projectId === pid);
  const done = ts.filter((t) => t.done).length;
  return {
    done,
    total: ts.length,
    pct: ts.length ? Math.round((done / ts.length) * 100) : 0,
  };
};
const tagClass = (name) => {
  if (/考研|课程|学习|复习|作业/.test(name)) return "study";
  if (/保研|竞赛|申请|导师/.test(name)) return "plan";
  return "life";
};

/* ---------------- 视图 ---------------- */
const views = {
  overview: renderOverview,
  projects: renderProjects,
  summary: renderSummary,
  news: renderNews,
  finance: renderFinance,
  settings: renderSettings,
  usage: (root) => renderControl("usage", root),
  prompts: (root) => window.LibraryViews.prompts(root),
  skills: (root) => window.LibraryViews.skills(root),
};

function renderControl(view, root) {
  let host = root.querySelector(".control-host");
  if (!host) {
    host = document.createElement("div");
    host.className = "control-host";
    root.replaceChildren(host);
    host.innerHTML =
      '<div class="control-loading" role="status">正在读取…</div>';
  }
  if (view === "usage")
    host.innerHTML =
      '<div class="control-loading" role="status">正在读取…</div>';
  return window.controlCenter[view](host);
}

let renderSequence = 0,
  renderedHash = "";
function render() {
  if(window.WorkbenchSurfaces?.isOpen())return;
  const restoreUnderlying=()=>{const surface=$("#main").querySelector(".module-surface");if(surface)window.workbenchDesign?.reveal(surface,true);if(location.hash.startsWith("#/usage"))window.dispatchEvent(new CustomEvent("workbench:usage-enter"));};
  if(window.settingsCenter?.consumeRestore?.()&&renderedHash===location.hash&&$("#main").querySelector(".module-surface")){restoreUnderlying();return;}
  if(!location.hash.startsWith("#/settings"))try{sessionStorage.setItem("lingxi-last-work-route",location.hash||"#/overview");}catch{}
  if (!user) {
    showProfile();
    return;
  }
  delete document.documentElement.dataset.profileRequired;
  if (location.hash.startsWith("#/settings") && window.settingsCenter) {
    if (!$("#main").querySelector(".module-surface")) {
      const requested = location.hash;
      history.replaceState(null, "", "#/overview");
      render();
      history.replaceState(null, "", requested);
    }
    return window.settingsCenter
      .open(renderSettings, renderedHash)
      .catch((e) => toast(e.message, {kind:"error"}));
  }
  if (window.settingsCenter?.isOpen()) {
    const restoring=window.settingsCenter.baseHash()===location.hash&&renderedHash===location.hash;
    if(!window.settingsCenter.close(false)){history.replaceState(null,"","#/settings");return;}
    if(restoring&&$("#main").querySelector(".module-surface")){restoreUnderlying();return;}
  }
  if (
    renderedHash &&
    renderedHash !== location.hash &&
    window.workbenchDesign?.unsaved() &&
    !confirm("当前修改尚未保存，离开此页？")
  ) {
    history.replaceState(null, "", renderedHash);
    return;
  }
  renderedHash = location.hash;
  $("#main").classList.remove("wb-redesign");
  if (/^#\/(workspace|agent|automations)(?:\/|$)/.test(location.hash)) {
    history.replaceState(null, "", "#/overview");
  }
  const requestedHash = location.hash,
    identity = user.username,
    sequence = ++renderSequence;
  const view = location.hash.replace(/^#\//, "").split("/")[0] || "overview";
  const fn = views[view] || views.overview;
  $("#main")._columnResizeObserver?.disconnect();
  $("#main")._columnResizeAbort?.abort();
  window.roundedSelects?.close();
  if(view!=="finance"||!$("#main").querySelector(".finance-workspace"))window.usageCharts?.dispose($("#main"));
  window.controlCenter?.dispose?.();
  $("#main")._workspaceDispose?.();
  $("#main")._workspaceDispose = null;
  $$("[data-view]").forEach((a) => {
    const cur = a.dataset.view === view;
    a.classList.toggle("on", cur);
    a.classList.toggle("active", cur);
  });
  $("#side-hello").textContent =
    `${state.settings.display_name || user.username} · 专注今天`;
  const viewName = views[view] ? view : "overview";
  $("#shell-page").textContent = {
    overview: "总览",
    projects: "项目",
    summary: "月度总结",
    news: "热点",
    finance: "记账",
    workspace: "AI 工作区",
    settings: "设置",
    agent: "AI Agent",
    usage: "用量监测",
    automations: "自动化",
    prompts: "提示词管理",
    skills: "技能管理",
  }[viewName];
  const target =
    window.workbenchDesign?.activate($("#main"), viewName, identity) ||
    $("#main");
  const result = fn(target);
  const finish = () => {
    if (
      !user ||
      user.username !== identity ||
      location.hash !== requestedHash ||
      sequence !== renderSequence
    )
      return;
    window.workbenchDesign?.finish(target);
    target.classList.add("wb-fixed-layout");
    // Route changes must never rehydrate a stale durable preference over live zoom.
    setPageZoom(window.WorkbenchPageZoom?.get() || Number(layoutStorage.getItem(layoutPrefs.zoomKey)) || 100);

    window.dispatchEvent(
      new CustomEvent("workbench:state", {
        detail: { user, projects: state.projects, tasks: state.tasks },
      }),
    );
  };
  if (result?.then)
    result.then(finish).catch((error) => {
      if (
        error.name !== "AbortError" &&
        sequence === renderSequence &&
        user?.username === identity &&
        location.hash === requestedHash
      )
        toast(error.message, {kind:"error"});
    });
  else finish();
}

/* ---------- 页面缩放；旧自由布局偏好不再恢复 ---------- */
const layoutPrefs = {
  colsKey: (v) => "wb-cols-" + v,
  hKey: (v) => "wb-cardh-" + v,
  orderKey: (v) => "wb-card-order-" + v,
  zoomKey: "wb-page-zoom",
  editKey: "wb-layout-editing",
  clearAll() {
    layoutStorage
      .keys()
      .filter(
        (k) =>
          k.startsWith("wb-cols-") ||
          k.startsWith("wb-cardh-") ||
          k.startsWith("wb-card-order-") ||
          k === this.zoomKey ||
          k === this.editKey ||
          k === "wb-ws-width",
      )
      .forEach((k) => layoutStorage.removeItem(k));
    setPageZoom(100);
  },
};

function setPageZoom(value) {
  const zoom = Math.min(160, Math.max(60, Number(value) || 100));
  document.documentElement.style.removeProperty("zoom");
  window.WorkbenchPageZoom?.set(zoom);
  document.documentElement.style.setProperty("--ui-scale", "1");
  document.documentElement.dataset.uiScale = String(zoom);
  layoutStorage.setItem(layoutPrefs.zoomKey, String(zoom));
  const output = $("#page-zoom-value");
  if (output) output.textContent = `${zoom}%`;
  const input = $("#page-zoom");
  if (input) input.value = String(zoom);
}

/* ---------- 登录 ---------- */
// Compatibility view; public Profile contracts are shared with the Node service.
function showProfile() {
  window.settingsCenter?.close(false, true);
  window.workbenchContextMenu?.close();
  user = null;
  state = { projects: [], tasks: [], activities: [], summaries: [], transactions: [], settings: {} };
  document.documentElement.style.removeProperty("zoom");
  document.documentElement.style.setProperty("--ui-scale", "1");
  document.documentElement.dataset.profileRequired="true";
  $("#main").innerHTML = '<div class="login-wrap profile-start"><section class="login-card"><div class="onboarding-brand"><img src="assets/lingxi-logo.svg" alt="灵犀"><span>灵犀工作坊</span></div><h1 class="onboarding-heading">建立你的个人资料</h1><p class="onboarding-subtitle">资料保存在所选 Profile，用户名与头像可随时修改。</p><div data-profile-editor></div></section></div>';
  window.LingxiDesign.identity($("[data-profile-editor]"), { create: true, save: async (name, avatar) => {
    if (!user) {
      const result = await api("POST", "/api/profile/create", { username: name }, { auth: true }); user = result.user;
    } else await api("POST", "/api/profile", { displayName: name });
    if (avatar) await api("POST", "/api/profile/avatar", { data: avatar });
    window.lingxiFreshProfile = true;
    await api("POST", "/api/control/config", { onboardingStep: "agents" });
    delete document.documentElement.dataset.profileRequired;
    await refresh(); render();
  }});
  $("#profile-username")?.focus();
}
function showInstanceConnection() {
  $("#main").innerHTML =
    '<div class="login-wrap profile-start"><section class="card login-card"><div class="brand workbench-brand login-brand"><span class="brand-knot"><img src="assets/lingxi-logo.svg" alt=""></span><span class="brand-name">灵犀工作坊</span></div><p class="login-sub">连接这台电脑上的工作坊。</p><form><label class="login-field">实例访问凭证<input name="token" type="password" required autocomplete="off"></label><p class="login-note">在运行工作坊的电脑上，从资料设置获取访问凭证。</p><div class="login-error" role="alert"></div><button class="onboarding-action" type="submit">连接工作坊</button></form></section></div>';
  const form = $("form", $("#main"));
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = $("[type=submit]", form);
    if (button.disabled) return;
    button.disabled = true;
    try {
      await api(
        "POST",
        "/api/instance/connect",
        { token: form.elements.token.value },
        { auth: true },
      );
      const session = await api("GET", "/api/profile/session", undefined, {
        auth: true,
      });
      user = session.user;
      if (!user) {
        showProfile();
        return;
      }
      await refresh();
      render();
    } catch (error) {
      $("[role=alert]", form).textContent = error.message;
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  };
}

/* ---------- 总览 ---------- */
function renderOverview(root) {
  return window.overviewBoard.mount(root, {
    state,
    toast,
    complete: async (id) => {
      await store.write("tasks", id, { done: true });
      await refresh();
      return state;
    },
    add: async (title) => {
      await store.write("tasks", null, { title });
      await refresh();
      if (root.isConnected && root.querySelector(".overview-board"))
        renderOverview(root);
    },
  });
}

async function loadNewsPreview(el) {
  try {
    const news = await store.list("news");
    const ranked = (news.baidu?.items || []).slice(0, 2);
    const articles = Object.entries(news)
      .filter(([id]) => id !== "baidu")
      .flatMap(([, group]) => group.items || [])
      .sort(
        (a, b) =>
          new Date(b.publishedAt || b.date) - new Date(a.publishedAt || a.date),
      );
    const items = [...ranked, ...articles].slice(0, 4);
    el.className = "";
    el.innerHTML = items.length
      ? items
          .map(
            (n) =>
              `<div class="news-item"><span class="time">${esc(n.capturedAt ? `热搜 #${n.rank}` : fmtTime(n.publishedAt || n.date))}</span>
       <div><a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a><small>${esc(n.source || "国内资讯")}</small></div></div>`,
          )
          .join("")
      : `<div class="empty">暂时没有可验证时间的近期热点，<a href="#/news">查看平台入口</a></div>`;
  } catch (e) {
    el.className = "empty";
    el.textContent = "热点加载失败：" + e.message;
  }
}
/* ---------- 项目与待办 ---------- */
function renderProjects(root) {
  window.projectsBoard.mount(root, {
    state,
    api,
    write: store.write.bind(store),
    remove: store.remove.bind(store),
    refresh: async () => {
      await refresh();
      return state;
    },
    toast,
  });
}
function statusText(s) {
  return { active: "进行中", waiting: "等待中", done: "已完成" }[s] || s;
}

/* ---------- 总结 ---------- */
function renderSummary(root) {
  window.summaryBoard.mount(root, {
    state,
    month: monthStr,
    list: store.list.bind(store),
    write: store.write.bind(store),
    remove: store.remove.bind(store),
    refresh: async () => {
      await refresh();
      return state;
    },
    storage: layoutStorage,
    toast,
  });
}

/* ---------- 热点 ---------- */
function renderNews(root) {
  if (root.querySelector(".hot-board")) return;
  return window.newsBoard.render(root, {
    load: (force) =>
      api("GET", "/api/news" + (force ? "?force=1" : ""), undefined, {
        signal: root._wbAbort?.signal,
      }),
    esc,
    fmtTime,
  });
}

/* ---------- 设置 ---------- */
function renderSettings(root) {
  let host = root.querySelector(".control-host");
  if (!host) {
    host = document.createElement("div");
    host.className = "control-host";
    root.replaceChildren(host);
  }
  return window.controlCenter.settings(host);
}

const financeColors = { 餐饮: "var(--color-usage-chart-1)", 交通: "var(--color-usage-chart-2)", 购物: "var(--color-usage-chart-3)", 学习: "var(--color-usage-chart-6)", 居住: "var(--color-usage-chart-5)", 娱乐: "var(--color-usage-chart-4)", 医疗: "var(--color-finance-medical)", 其他: "var(--color-foreground-subtle)", 收入: "var(--color-success)" };
const categoryColor = name => Object.hasOwn(financeColors, name) ? financeColors[name] : financeColors.其他;
let billPreview=null,financeMonth=monthStr(),financeReveal=0;
function setFinanceMonth(month){financeReveal++;financeMonth=/^\d{4}-(0[1-9]|1[0-2])$/.test(month)?month:monthStr();layoutStorage.setItem('wb-finance-month',financeMonth)}
const money=n=>Number(n||0).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
function renderFinance(root){
 const saved=layoutStorage.getItem('wb-finance-month');financeMonth=/^\d{4}-(0[1-9]|1[0-2])$/.test(saved||'')?saved:monthStr();
 window.financeWorkspace.render(root,{rows:state.transactions||[],month:financeMonth,reveal:financeReveal,colors:financeColors,storage:layoutStorage,onDispose:()=>{billPreview=null}});
  const billDialog = $("#bill-dialog");
  $("#bill-file").onchange = async (e) => {
    const identity = user?.username,
      input = e.target;
    if (input.disabled) return;
    const file = input.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast("账单文件不能超过 5 MB", {kind:"warning"});
      return;
    }
    input.disabled = true;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const parsed = await api("POST", "/api/bills/preview", {
        filename: file.name,
        data: btoa(binary),
      });
      if (!billDialog.isConnected || user?.username !== identity) return;
      billPreview = parsed;
      $("#bill-count").textContent =
        `识别 ${billPreview.rows.length} 笔，跳过 ${billPreview.skipped} 行。${Object.keys(billPreview.warnings||{}).join("；")} 可修改下方收支和分类。`;
      let offset = 0;
      const drawPreview = () => {
        $("#bill-rows").innerHTML = billPreview.rows
          .slice(offset, offset + 30)
          .map((r, pageIndex) => {
            const i = offset + pageIndex;
            return `<div><time>${esc(r.date)}</time><span>${esc(r.title)}</span><b>¥${money(r.amount)}</b><select class="bill-kind" data-i="${i}" aria-label="${esc(r.title)} 的收支方向"><option value="expense" ${r.kind === "expense" ? "selected" : ""}>支出</option><option value="income" ${r.kind === "income" ? "selected" : ""}>收入</option></select><select class="bill-category" data-i="${i}" aria-label="${esc(r.title)} 的分类">${Object.keys(
              financeColors,
            )
              .map(
                (c) =>
                  `<option ${r.category === c ? "selected" : ""}>${c}</option>`,
              )
              .join("")}</select></div>`;
          })
          .join("");
        $("#bill-rows").scrollTop = 0;
        $("#bill-pagination").innerHTML = "";
        if (billPreview.rows.length > 30) {
          const controls = document.createElement("div");
          controls.className = "bill-page-controls";
          controls.innerHTML = `<button type="button" class="btn ghost" id="bill-prev" ${offset === 0 ? "disabled" : ""}>上一页</button><span>第 ${Math.floor(offset / 30) + 1} / ${Math.ceil(billPreview.rows.length / 30)} 页 · 所有页的修改都会保存</span><button type="button" class="btn ghost" id="bill-next" ${offset + 30 >= billPreview.rows.length ? "disabled" : ""}>下一页</button>`;
          $("#bill-pagination").append(controls);
          $("#bill-prev").onclick = () => {
            offset -= 30;
            drawPreview();
          };
          $("#bill-next").onclick = () => {
            offset += 30;
            drawPreview();
          };
        }

        $$(".bill-kind").forEach(
          (sel) =>
            (sel.onchange = () => {
              const row = billPreview.rows[Number(sel.dataset.i)];
              row.kind = sel.value;
              if (sel.value === "income") row.category = "收入";
              else if (row.category === "收入") row.category = "其他";
              $(".bill-category[data-i='" + sel.dataset.i + "']").value =
                row.category;
            }),
        );
        $$(".bill-category").forEach(
          (sel) =>
            (sel.onchange = () => {
              const row = billPreview.rows[Number(sel.dataset.i)];
              row.category = sel.value;
              row.kind = sel.value === "收入" ? "income" : "expense";
              $(".bill-kind[data-i='" + sel.dataset.i + "']").value = row.kind;
            }),
        );
      };
      drawPreview();
      $("#bill-dialog").showModal();
    } catch (err) {
      if (billDialog.isConnected) toast("识别失败：" + err.message,{kind:"error"});
    } finally {
      input.value = "";
      input.disabled = false;
    }
  };
  $("#bill-cancel").onclick = () => {
    billPreview = null;
    $("#bill-dialog").close();
  };
  $("#bill-confirm").onclick = async () => {
    if (!billPreview) return;
    const identity = user?.username,
      btn = $("#bill-confirm");
    if (btn.disabled) return;
    const preview = billPreview;
    btn.disabled = true;
    const cancel = $("#bill-cancel", root);
    cancel.disabled = true;
    billDialog.oncancel = event => event.preventDefault();
    $("#bill-status", root).textContent = "正在导入…";
    try {
      const result = await api("POST", "/api/transactions", {
        rows: preview.rows,
      });
      if (user?.username !== identity) return;
      if (billPreview === preview) billPreview = null;
      setFinanceMonth(
        preview.rows
          .reduce((latest, row) => (row.date > latest ? row.date : latest), "")
          .slice(0, 7) || financeMonth,
      );

      await refresh();
      if (user?.username !== identity || !root.isConnected) return;
      renderFinance(root);
      if (billDialog.isConnected) billDialog.close();
      toast(
        `已导入 ${result.added} 笔，去重 ${result.duplicates} 笔 · ${financeMonth}`,
        {kind:"success"},
      );
    } catch (err) {
      if (user?.username === identity) toast("导入失败：" + err.message,{kind:"error"});
    } finally {
      if (btn.isConnected) btn.disabled = false;
      if (cancel.isConnected) cancel.disabled = false;
      billDialog.oncancel = null;
      const status = $("#bill-status", root);
      if (status) status.textContent = "";
    }
  };
}

/* ---------------- 启动 ---------------- */
window.addEventListener("beforeunload", (event) => {
  if (window.workbenchDesign?.unsaved()) {
    event.preventDefault();
    event.returnValue = "";
  }
});

const appReady = (async function init() {
  try {
    const runtime = await api("GET", "/api/runtime");
    window.workbenchRuntime = runtime;
    if (runtime.version !== window.WorkbenchUI.version || runtime.preview) {
      const note = document.createElement("p");
      note.className = "wb-runtime-note";
      note.setAttribute("role", "status");
      note.textContent = runtime.preview
        ? `${runtime.version} 隔离测试 · 不写入正式 Profile；不代表正式8765验收`
        : `前端 ${window.WorkbenchUI.version} · 后端仍为 ${runtime.version}，新功能需重启后端服务。`;
      document.querySelector(".shell-heading").append(note);
    }
    const me = await api("GET", "/api/profile/session", undefined, {
      auth: true,
    });
    if (!me.user) {
      showProfile();
      return;
    }
    user = me.user;
    await refresh();
  } catch (e) {
    $("#main").innerHTML =
      `<div class="card" style="margin-top:40px"><h3>无法连接本地服务</h3>
      <p class="empty">请确认 后台服务正在运行（双击 start.bat）。<br>错误信息：${esc(e.message)}</p></div>`;
    return;
  }
  render();
  setInterval(async () => {
    try {
      await refresh();
      const editing = document.querySelector(
        "#main input:focus,#main textarea:focus,#main select:focus,.card-dragging,.resize-corner.active,.sidebar-resize.active,.ws-divider.active",
      );
      if (
        user &&
        !editing &&
        ["overview"].includes(
          (location.hash || "#/overview").replace(/^#\//, ""),
        )
      )
        render();
    } catch (_) {}
  }, 60000);
})();
