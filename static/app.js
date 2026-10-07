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
      return key ? api("POST", `/api/tasks/${encodeURIComponent(key)}`, value)
                 : api("POST", "/api/tasks", value);
    }
    if (namespace === "projects") {
      return key ? api("POST", `/api/projects/${encodeURIComponent(key)}`, value)
                 : api("POST", "/api/projects", value);
    }
    if (namespace === "summaries") {
      return api("POST", "/api/summary/save", value);
    }
    throw new Error("unsupported namespace: " + namespace);
  },
  async remove(namespace, key) {
    if (namespace === "tasks") return api("POST", `/api/tasks/${encodeURIComponent(key)}`, { _method: "DELETE" });
    if (namespace === "projects") return api("POST", `/api/projects/${encodeURIComponent(key)}`, { _method: "DELETE" });
    if (namespace === "summaries") return api("POST", `/api/summary/${encodeURIComponent(key)}`, {});
    throw new Error("unsupported namespace: " + namespace);
  },
  async list(namespace, query) {
    if (namespace === "news") return api("GET", "/api/news" + (query && query.force ? "?force=1" : ""));
    if (namespace === "backups") return api("GET", "/api/backups");
    if (namespace === "summaryDraft") return api("GET", `/api/summary/draft${query && query.month ? "?month=" + query.month : ""}`);
    const res = await api("GET", "/api/state");
    return res ? res[namespace] : null;
  },
  async export() { await layoutStorage.flush(); return api("GET", "/api/export"); },
  async import(envelope) { await layoutStorage.flush(); const result = await api("POST", "/api/import", envelope); if (user) await layoutStorage.hydrate(user.username,{force:true,discardPending:true}); return result; },
};

async function api(method, url, body, { auth = false, signal } = {}) {
  const identity=user?.username,opt = { method, headers: {}, signal };
  if (body !== undefined) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(url, opt);
  const data = await res.json().catch(() => ({}));
  if(!auth&&identity!==user?.username)throw new DOMException('账户已切换','AbortError');
  if (!res.ok) {
    if (res.status === 401 && !auth) { showLogin(); }
    const error=new Error(data.error || `请求失败（${res.status}）`);Object.assign(error,data,{status:res.status});throw error;
  }
  return data;
}

window.workbenchRequest=api;

/* ---------------- 工具 ---------------- */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}
window.workbenchNotify=toast;
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
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
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
let state = { projects: [], tasks: [], activities: [], summaries: [], transactions: [], settings: {} };
let user = null;
let summaryDraft = null;
let refreshSequence = 0;

async function refresh() {
  const identity = user?.username, sequence = ++refreshSequence;
  const res = await api("GET", "/api/state");
  if (!user || user.username !== identity || sequence !== refreshSequence) return res;
  state = res;
  if (user) await layoutStorage.hydrate(user.username);
  return res;
}
const projName = id => (state.projects.find(p => p.id === id) || {}).name || "";
const projectStats = pid => {
  const ts = state.tasks.filter(t => t.projectId === pid);
  const done = ts.filter(t => t.done).length;
  return { done, total: ts.length, pct: ts.length ? Math.round(done / ts.length * 100) : 0 };
};
const tagClass = name => {
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
  usage: root => renderControl('usage',root),
  prompts: root=>window.LibraryViews.prompts(root),
  skills: root=>window.LibraryViews.skills(root),
};

function renderControl(view,root) {
  let host=root.querySelector('.control-host');if(!host){host=document.createElement('div');host.className='control-host';root.replaceChildren(host);host.innerHTML='<div class="control-loading" role="status">正在读取…</div>';}
  if(view==='usage')host.innerHTML='<div class="control-loading" role="status">正在读取…</div>';
  return window.controlCenter[view](host);
}

let renderSequence = 0,renderedHash='';
function render() {
  if (!user) { showLogin(); return; }
  if(location.hash.startsWith('#/settings')&&window.settingsCenter){
    if(!$('#main').querySelector('.module-surface')){const requested=location.hash;history.replaceState(null,'','#/overview');render();history.replaceState(null,'',requested);}
    return window.settingsCenter.open(renderSettings,renderedHash).catch(e=>toast(e.message));
  }
  if(window.settingsCenter?.isOpen()&&!window.settingsCenter.close(false)){history.replaceState(null,'','#/settings');return;}
  if(renderedHash&&renderedHash!==location.hash&&window.workbenchDesign?.unsaved()&&!confirm('当前修改尚未保存，离开此页？')){history.replaceState(null,'',renderedHash);return;}
  renderedHash=location.hash;
  $("#main").classList.remove("wb-redesign");
  if(/^#\/(workspace|agent|automations)(?:\/|$)/.test(location.hash)){history.replaceState(null,'','#/overview');}
  const requestedHash=location.hash, identity=user.username, sequence=++renderSequence;
  const view = (location.hash.replace(/^#\//, "").split('/')[0] || "overview");
  const fn = views[view] || views.overview;
  $('#main')._columnResizeObserver?.disconnect();$('#main')._columnResizeAbort?.abort();
  window.roundedSelects?.close();window.usageCharts?.dispose($("#main"));window.controlCenter?.dispose?.();
  $("#main")._workspaceDispose?.();$("#main")._workspaceDispose=null;
  $$("[data-view]").forEach(a => {
    const cur = a.dataset.view === view;
    a.classList.toggle("on", cur);
    a.classList.toggle("active", cur);
  });
  $("#side-hello").textContent = `${state.settings.display_name || user.username} · 专注今天`;
  const viewName = views[view] ? view : "overview";
  $("#shell-page").textContent = ({ overview: "总览", projects: "项目", summary: "月度总结", news: "热点", finance: "记账", workspace: "AI 工作区", settings: "设置", agent:'AI Agent', usage:'用量监测', automations:'自动化',prompts:'提示词管理',skills:'技能管理' })[viewName];
  const target=window.workbenchDesign?.activate($("#main"),viewName,identity)||$("#main");
  const result=fn(target);
  const finish=()=>{
  if (!user || user.username!==identity || location.hash!==requestedHash || sequence!==renderSequence) return;
  window.workbenchDesign?.finish(target);target.classList.add("wb-fixed-layout");
  setPageZoom(Number(layoutStorage.getItem(layoutPrefs.zoomKey))||100);





  window.dispatchEvent(new CustomEvent('workbench:state', {detail:{user, projects:state.projects, tasks:state.tasks}}));
  };
  if (result?.then) result.then(finish).catch(error=>{if(error.name!=='AbortError'&&sequence===renderSequence&&user?.username===identity&&location.hash===requestedHash)toast(error.message);}); else finish();
}

/* ---------- 页面缩放；旧自由布局偏好不再恢复 ---------- */
const layoutPrefs = {
  colsKey: v => "wb-cols-" + v,
  hKey: v => "wb-cardh-" + v,
  orderKey: v => "wb-card-order-" + v,
  zoomKey: "wb-page-zoom",
  editKey: "wb-layout-editing",
  clearAll() {
    layoutStorage.keys()
      .filter(k => k.startsWith("wb-cols-") || k.startsWith("wb-cardh-") || k.startsWith("wb-card-order-") || k === this.zoomKey || k === this.editKey || k === "wb-ws-width")
      .forEach(k => layoutStorage.removeItem(k));
    setPageZoom(100);
  },
};

function setPageZoom(value) {
  const zoom = Math.min(160, Math.max(60, Number(value) || 100));
  document.documentElement.style.zoom = `${zoom}%`;
  document.documentElement.style.setProperty('--page-zoom-scale',String(zoom / 100));
  layoutStorage.setItem(layoutPrefs.zoomKey, String(zoom));
  const output = $("#page-zoom-value");
  if (output) output.textContent = `${zoom}%`;
  const input = $("#page-zoom");
  if (input) input.value = String(zoom);
}

/* ---------- 登录 ---------- */
function showLogin() {
  window.settingsCenter?.close(false,true);window.workbenchContextMenu?.close();
  window.workbenchDesign?.clear();
  $("#main").classList.add("wb-redesign");
  layoutStorage.resetSession();
  document.documentElement.style.zoom = "100%";
  document.documentElement.style.setProperty('--page-zoom-scale','1');
  user = null;
  state = {projects:[],tasks:[],activities:[],summaries:[],transactions:[],settings:{}};
  summaryDraft = null;
  billPreview = null;
  $('#side-hello').textContent = '登录你的个人工作空间';
  window.dispatchEvent(new CustomEvent('workbench:state', {detail:{user:null,projects:[],tasks:[]}}));
  $("#shell-page").textContent = "登录";
  $("#main").innerHTML = `
  <div class="login-wrap">
    <div class="card login-card">
      <div class="brand workbench-brand login-brand"><span class="brand-knot" aria-hidden="true"><img class="brand-knot-light" src="assets/lingxi-logo.svg" alt=""><img class="brand-knot-dark" src="assets/lingxi-logo.svg" alt=""></span><span class="brand-name">灵犀工作坊</span></div>
      <p class="login-sub">数据保存在本机，登录后进入你的专属空间</p>
      <form id="login-form">
        <label class="login-field">用户名
          <input id="lg-user" autocomplete="username" required minlength="2" maxlength="20" placeholder="2-20 位中英文/数字/下划线">
        </label>
        <label class="login-field">密码
          <input id="lg-pass" type="password" autocomplete="current-password" required minlength="4" placeholder="至少 4 位">
        </label>
        <div class="login-error" id="lg-error" role="alert"></div>
        <div class="login-actions">
          <button type="submit" class="btn" id="lg-do-login">登 录</button>
          <button type="button" class="btn ghost" id="lg-do-reg">注册新账号</button>
        </div>
      </form>
      <p class="login-note" id="lg-note">首次使用点「注册新账号」；现有数据会自动并入第一个注册的账号。</p>
    </div>
  </div>`;
  const err = $("#lg-error");
  let authenticating=false;const form=$('#login-form'),username=$('#lg-user'),password=$('#lg-pass'),buttons=$$('button',form);
  const doAuth = async (path) => {
    if(authenticating||!form.reportValidity())return;authenticating=true;buttons.forEach(b=>b.disabled=true);
    try {
      err.textContent = "";
      const r = await api("POST", path, { username: username.value.trim(), password: password.value }, { auth: true });
      user = r.user;
      if (r.migrated && r.migrated.length) toast(`已将 ${r.migrated.length} 类原有数据并入本账号`);
      await refresh();
      render();
    } catch (e) { if(err.isConnected)err.textContent = e.message; }finally{authenticating=false;buttons.forEach(b=>b.disabled=false);}
  };
  $("#login-form").onsubmit = e => { e.preventDefault(); doAuth("/api/auth/login"); };
  $("#lg-do-reg").onclick = () => doAuth("/api/auth/register");
  $("#lg-user").focus();
}

/* ---------- 总览 ---------- */
function renderOverview(root) {
  return window.overviewBoard.mount(root,{state,toast,complete:async id=>{await store.write('tasks',id,{done:true});await refresh();return state;},add:async title=>{await store.write('tasks',null,{title});await refresh();if(root.isConnected&&root.querySelector('.overview-board'))renderOverview(root);}});
}

function todoRowHtml(t) {
  const pn = projName(t.projectId);
  return `<div class="todo-item ${t.done ? "done" : ""}" data-id="${esc(t.id)}">
    <button class="cb ${t.done ? "done" : ""}" role="checkbox" aria-checked="${t.done}" aria-label="完成：${esc(t.title)}" title="切换完成状态"></button>
    <span class="txt">${esc(t.title)}</span>
    ${t.dueAt ? `<span class="chip due" title="截止 ${esc(t.dueAt)}">📅 ${esc(fmtDue(t.dueAt))}</span>` : ""}
    ${t.location ? `<span class="chip loc" title="地点">📍 ${esc(t.location)}</span>` : ""}
    ${(t.keywords || []).length ? `<span class="task-keywords" title="识别关键词">${t.keywords.map(k => `#${esc(k)}`).join(" ")}</span>` : ""}
    ${pn ? `<span class="tag ${tagClass(pn)}">${esc(pn)}</span>` : ""}
    <button class="del" title="删除这条待办" aria-label="删除：${esc(t.title)}">✕</button>
  </div>`;
}

function bindTodoRows(root) {
  $$(".cb", root).forEach(cb => cb.onclick = async () => {
    if(cb.disabled)return;cb.disabled=true;
    try {
    const id = cb.closest(".todo-item").dataset.id;
    const t = state.tasks.find(x => x.id === id);
    await store.write("tasks", id, { done: !t.done });
    await refresh();if(root.isConnected)renderProjects(root);
    } catch(error){if(root.isConnected)toast(error.message);}finally{if(cb.isConnected)cb.disabled=false;}
  });
  $$('.todo-item .del', root).forEach(btn => btn.onclick = async () => {
    const id = btn.closest(".todo-item").dataset.id;
    if(btn.disabled)return;btn.disabled=true;
    try { await store.remove("tasks", id);
    toast("已删除待办");
    await refresh();if(root.isConnected)renderProjects(root);
    }catch(error){if(btn.isConnected)btn.disabled=false;if(root.isConnected)toast(error.message);}
  });
}

/* ---------- AI 识别面板 ---------- */
let aiResult = null;

function aiPanelHtml() {
  return `
  <div class="ai-panel" id="ai-panel" hidden>
    <div class="ai-head">✨ AI 识别通知 <button class="ai-close" id="ai-close" aria-label="关闭 AI 识别">✕</button></div>
    <textarea id="ai-text" rows="3" placeholder="把通知原文粘贴到这里，例如：&#10;明天晚上七点半在东九楼A203进行数电期中答疑" aria-label="通知原文"></textarea>
    <div class="ai-actions">
      <button class="btn small" id="ai-do">识别时间/地点/主题</button>
      <span class="ai-engine" id="ai-engine"></span>
    </div>
    <div class="ai-result" id="ai-result" hidden>
      <div class="ai-edit-row"><span>主题</span><input id="ai-title"></div>
      <div class="ai-edit-row"><span>时间</span><input id="ai-due" type="datetime-local"><em id="ai-due-raw"></em></div>
      <div class="ai-edit-row"><span>地点</span><input id="ai-loc" placeholder="未识别到"></div>
      <div class="ai-edit-row"><span>关键词</span><input id="ai-keywords" placeholder="用逗号分隔，可修改"></div>
      <button class="btn small ghost" id="ai-save">➕ 存为待办</button>
    </div>
  </div>`;
}

function bindAiPanel(root, projSel) {
  const panel = $("#ai-panel", root);
  if (!panel) return;
  $("#ai-close", panel).onclick = () => { panel.hidden = true; };
  $("#ai-do", panel).onclick = async () => {
    const text = $("#ai-text", panel).value.trim();
    if (!text) { toast("先粘贴一段通知原文"); return; }
    const btn = $("#ai-do", panel);
    if(btn.disabled)return;btn.disabled = true; btn.textContent = "识别中…";
    try {
      const parsed=await api("POST", "/api/ai/parse", { text });if(!panel.isConnected)return;
      if($("#ai-text",panel).value.trim()!==text){toast("内容已修改，请重新识别");return;}aiResult=parsed;
      $("#ai-result", panel).hidden = false;
      $("#ai-title", panel).value = aiResult.title || "";
      $("#ai-loc", panel).value = aiResult.location || "";
      $("#ai-keywords", panel).value = (aiResult.keywords || []).join("，");
      const dueInput = $("#ai-due", panel);
      dueInput.value = aiResult.dueAt ? aiResult.dueAt.slice(0, 16) : "";
      $("#ai-due-raw", panel).textContent = aiResult.dueText ? `原文：${aiResult.dueText}` : "";
      $("#ai-engine", panel).textContent = aiResult.engine === "ai" ? "已用外部 AI" : "本地解析引擎";
    } catch (e) { if(panel.isConnected)toast("识别失败：" + e.message); }finally{btn.disabled=false;btn.textContent="识别时间/地点/主题";}
  };
  $("#ai-save", panel).onclick = async () => {
    const title = $("#ai-title", panel).value.trim();
    if (!title) { toast("主题为空，请填写"); return; }
    const due = $("#ai-due", panel).value;
    const button=$("#ai-save",panel);if(button.disabled)return;button.disabled=true;
    try{await store.write("tasks", null, {
      title,
      projectId: projSel ? ($(projSel, root)?.value || null) : null,
      dueAt: due || null,
      location: $("#ai-loc", panel).value.trim() || null,
      keywords: $("#ai-keywords", panel).value.split(/[，,]/).map(s => s.trim()).filter(Boolean).slice(0, 5),
    });
    if(!panel.isConnected)return;toast("已存为待办 ✓");
    panel.hidden = true;
    $("#ai-text", panel).value = "";
    await refresh();if(root.isConnected)renderProjects(root);
    }catch(error){if(panel.isConnected)toast(error.message);}finally{if(button.isConnected)button.disabled=false;}
  };
}

function bindQuickAdd(inputSel, projSel, aiBtnSel) {
  const input = $(inputSel);
  let adding=false;
  const doAdd = async () => {
    const title = input.value.trim();
    if (!title||adding) return;adding=true;
    try {
    const pid = projSel ? $(projSel).value : null;
    await store.write("tasks", null, { title, projectId: pid || null });
    if(input.value.trim()===title){input.value="";delete input.dataset.wbDirty;}
    if(input.isConnected)toast("已记录 ✓");
    await refresh();if(input.isConnected)renderProjects(input.closest('.module-surface')||$('#main'));
    }catch(error){if(input.isConnected)toast(error.message);}finally{adding=false;}
  };
  input.onkeydown = e => { if (e.key === "Enter"&&!e.isComposing){e.preventDefault();doAdd();} };
  input.onpaste = e => {
    const pasted = e.clipboardData?.getData("text") || "";
    if (pasted.length < 55 && !pasted.includes("\n")) return;
    const panel = $("#ai-panel");
    if (!panel) return;
    e.preventDefault();
    panel.hidden = false;
    $("#ai-text", panel).value = pasted;
    $("#ai-text", panel).focus();
    toast("已放入通知识别框，请检查后点击识别");
  };
  if (aiBtnSel) {
    const btn = $(aiBtnSel);
    if (btn) btn.onclick = () => {
      const panel = $("#ai-panel");
      panel.hidden = !panel.hidden;
      if (!panel.hidden) $("#ai-text", panel).focus();
    };
  }
}

async function loadNewsPreview(el) {
  try {
    const news = await store.list("news");
    const ranked = (news.baidu?.items || []).slice(0, 2);
    const articles = Object.entries(news).filter(([id]) => id !== "baidu")
      .flatMap(([, group]) => group.items || [])
      .sort((a, b) => new Date(b.publishedAt || b.date) - new Date(a.publishedAt || a.date));
    const items = [...ranked, ...articles].slice(0, 4);
    el.className = "";
    el.innerHTML = items.length ? items.map(n =>
      `<div class="news-item"><span class="time">${esc(n.capturedAt ? `热搜 #${n.rank}` : fmtTime(n.publishedAt || n.date))}</span>
       <div><a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a><small>${esc(n.source || "国内资讯")}</small></div></div>`).join("")
      : `<div class="empty">暂时没有可验证时间的近期热点，<a href="#/news">查看平台入口</a></div>`;
  } catch (e) {
    el.className = "empty";
    el.textContent = "热点加载失败：" + e.message;
  }
}
/* ---------- 项目与待办 ---------- */
function renderProjects(root) {
  window.projectsBoard.mount(root,{state,write:store.write.bind(store),remove:store.remove.bind(store),refresh:async()=>{await refresh();return state;},toast,todo:todoRowHtml,ai:aiPanelHtml,bindAI:bindAiPanel,bindTodos:bindTodoRows,bindAdd:bindQuickAdd});
}
function statusText(s) {
  return { active: "进行中", waiting: "等待中", done: "已完成" }[s] || s;
}

/* ---------- 总结 ---------- */
function renderSummary(root) {
  window.summaryBoard.mount(root,{state,month:monthStr,list:store.list.bind(store),write:store.write.bind(store),remove:store.remove.bind(store),refresh:async()=>{await refresh();return state;},storage:layoutStorage,toast});
}

/* ---------- 热点 ---------- */
function renderNews(root) {
  if(root.querySelector('.hot-board'))return;
  return window.newsBoard.render(root, {
    load:force=>api("GET","/api/news"+(force?"?force=1":""),undefined,{signal:root._wbAbort?.signal}),esc,fmtTime,
  });
}

/* ---------- 设置 ---------- */
function renderSettings(root) {
  let host=root.querySelector('.control-host');if(!host){host=document.createElement('div');host.className='control-host';root.replaceChildren(host);}
  return window.controlCenter.settings(host,renderSettingsLegacy);
}
function renderSettingsLegacy(root) {
  const identity=user.username,request=window.workbenchRequest,notify=window.workbenchNotify;
  const $=(selector,container=root)=>container.querySelector(selector),$$=(selector,container=root)=>[...container.querySelectorAll(selector)];
  const toast=message=>{if(root.isConnected&&user?.username===identity)notify(message);};
  const api=async(...args)=>{const result=await request(...args);if(!root.isConnected||user?.username!==identity)throw new DOMException('页面已切换','AbortError');return result;};
  const demo = state.settings && state.settings.demo_seeded;
  (window.workbenchDesign?.paint||((node,html)=>node.innerHTML=html))(root,`
  <div class="greet"><div><h2>设置</h2><p>账号、AI 识别、数据与备份</p></div></div>
  <section class="appearance-panel"><h3>外观</h3><div class="appearance-controls"><label for="appearance-theme">主题</label><select id="appearance-theme"><option value="system">跟随系统</option><option value="zai-light">浅色主题</option><option value="zai-dark">深色主题</option></select><label for="appearance-font">界面字号</label><select id="appearance-font">${[12,14,16,18].map(n => `<option value="${n}">${n}</option>`).join('')}</select><span class="meta">ZCode 设计系统</span></div><p class="ws-status" id="storage-engine">本地数据存储</p></section>
  <div class="bento" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr); align-items:start;">
    <div class="card">
      <h3>账号</h3>
      <div class="set-row">当前账号<b style="margin-left:auto">${esc(user ? user.username : "")}</b></div>
      <div class="set-row"><label for="profile-name">显示昵称</label><input id="profile-name" value="${esc(state.settings.display_name || "")}" maxlength="30" placeholder="用于欢迎语"><button class="btn small ghost" id="profile-save">保存昵称</button></div>
      <div class="set-row"><div class="profile-password"><b>修改密码</b><input id="profile-current" type="password" autocomplete="current-password" placeholder="当前密码"><input id="profile-new" type="password" autocomplete="new-password" minlength="8" placeholder="新密码，至少 8 位"><button class="btn small ghost" id="profile-password-save">更新密码</button></div></div>
      <div class="set-row"><div style="width:100%;font-size:var(--text-ui-sm);color:var(--ink-3)">各账号数据隔离，保存在本机。导出数据可迁移到另一台电脑。</div></div>
      <div class="set-row"><button class="btn danger" id="btn-logout">退出登录</button></div>
    </div>
    <div class="card">
      <h3>AI 识别</h3>
      <div class="set-row"><div style="width:100%">
        <p style="font-size:var(--text-ui-caption);color:var(--ink-2);margin-bottom:8px">默认使用<b>本地解析引擎</b>（离线、免费）。配置外部 AI API 后识别更智能；Key 只保存在本机服务端，不进前端、不进备份。</p>
        <div class="ai-edit-row"><span>服务商</span><input id="ai-provider" placeholder="如 智谱 / OpenAI 兼容"></div>
        <div class="ai-edit-row"><span>Base URL</span><input id="ai-baseurl" placeholder="https://...（到 /v1）"></div>
        <div class="ai-edit-row"><span>API Key</span><input id="ai-key" type="password" placeholder="留空则继续用本地引擎"></div>
        <div class="ai-edit-row"><span>模型</span><input id="ai-model" placeholder="如 glm-4-flash"></div>
        <div class="add-row"><button class="btn small" id="btn-ai-save">保存 AI 配置</button>
        <span id="ai-cfg-status" style="font-size:var(--text-ui-sm);color:var(--ink-2);align-self:center"></span></div>
      </div></div>
    </div>
    <div class="card">
      <h3>数据与备份</h3>
      <div class="set-row">数据副本<span style="margin-left:auto;font-size:var(--text-ui-sm);color:var(--ink-2)">data/users/&lt;账号&gt;/（JSON）</span></div>
      <div class="set-row">自动备份<span style="margin-left:auto;font-size:var(--text-ui-sm);color:var(--ink-2)">每次改动后滚动快照，保留最近 10 份</span></div>
      <div class="set-row"><button class="btn ghost" id="btn-reset-layout">重置卡片布局</button>
        <span style="font-size:var(--text-ui-sm);color:var(--ink-3)">清除你拖拽调整过的栏宽和卡片高度</span></div>
      <div class="set-row"><button class="btn ghost" id="btn-backup">立即创建备份</button>
        <button class="btn ghost" id="btn-export">导出数据（JSON）</button>
        <label class="btn ghost" style="display:inline-block">导入数据（覆盖）<input id="file-import" type="file" accept=".json" style="display:none"></label></div>
      <div class="set-row"><div style="width:100%"><b style="font-size:var(--text-ui-caption)">可用的备份</b><div id="backup-list" style="margin-top:6px"><span class="empty" style="padding:8px">加载中…</span></div></div></div>
    </div>
    <div class="card">
      <h3>示例数据</h3>
      <div class="set-row"><div style="width:100%">
        <p style="font-size:var(--text-ui-caption);color:var(--ink-2);margin-bottom:10px">示例数据包含虚构的项目、待办和动态，用于熟悉界面。清空后不影响真实数据以外的内容。</p>
        ${demo
          ? `<button class="btn danger" id="btn-clear-demo">清除示例数据（清空全部数据）</button>`
          : `<button class="btn" id="btn-seed-demo">载入示例数据</button>`}
      </div></div>
      <div class="set-row"><div style="width:100%;font-size:var(--text-ui-sm);color:var(--ink-3)">
        ⚠ 载入示例会覆盖当前账号数据（会先自动备份）；清除示例同样清空当前账号记录并自动备份。
      </div></div>
    </div>
  </div>`);
  $('#appearance-theme',root).value = window.workbenchAppearance.theme;
  $('#appearance-theme',root).onchange = e => window.workbenchAppearance.setTheme(e.target.value);
  $('#appearance-font',root).value = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--ui-font-size'));
  $('#appearance-font',root).onchange = e => window.workbenchAppearance.setFontSize(e.target.value);
  api('GET','/api/storage/info').then(info => { const label = $('#storage-engine',root); if (label?.isConnected) label.textContent = `本地 SQLite · ${info.journalMode.toUpperCase()} · 存储版本 ${info.schemaVersion} · JSON 可迁移副本`; }).catch(() => {});
  $("#btn-logout").onclick = async () => {
    await layoutStorage.flush();
    await api("POST", "/api/auth/logout", {}, { auth: true });
    user = null;
    showLogin();
  };
  $("#profile-save").onclick = async () => {
    try { const r = await api("POST", "/api/profile", { displayName: $("#profile-name").value }); state.settings.display_name = r.displayName; document.querySelector("#side-hello").textContent = `${r.displayName || user.username} · 专注今天`; window.dispatchEvent(new Event('workbench:profile')); delete $("#profile-name").dataset.wbDirty;toast("昵称已保存"); }
    catch (e) { toast(e.message); }
  };
  $("#profile-password-save").onclick = async () => {
    try { await api("POST", "/api/profile/password", { current: $("#profile-current").value, new: $("#profile-new").value }); $("#profile-current").value = ""; $("#profile-new").value = ""; toast("密码已更新"); }
    catch (e) { toast(e.message); }
  };
  const loadAiCfg = async () => {
    try {
      const cfg = await api("GET", "/api/ai/config");
      $("#ai-cfg-status").textContent = cfg.configured ? `已配置（${cfg.model || cfg.provider || "AI"}）` : "未配置外部 AI，使用本地引擎";
    } catch (_) {}
  };
  loadAiCfg();
  $("#btn-ai-save").onclick = async () => {
    try {
      await api("POST", "/api/ai/config", {
        provider: $("#ai-provider").value, baseUrl: $("#ai-baseurl").value,
        apiKey: $("#ai-key").value, model: $("#ai-model").value,
      });
      $("#ai-key").value = "";["provider","baseurl","key","model"].forEach(k=>delete $("#ai-"+k).dataset.wbDirty);
      toast("AI 配置已保存 ✓");
      loadAiCfg();
    } catch (e) { if(active())toast("保存失败：" + e.message); }
  };
  $("#btn-reset-layout").onclick = () => {
    layoutPrefs.clearAll();
    toast("布局已重置 ✓");
    render();
  };
  $("#btn-backup").onclick = async () => { await api("POST", "/api/backup", {}); toast("备份已创建 ✓"); loadBackups(); };
  $("#btn-export").onclick = async () => {
    const data = await store.export();
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `workbench-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast("已导出 ✓");
  };
  $("#file-import").onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const envelope = JSON.parse(await file.text());
      if (!confirm("导入会整体覆盖当前数据（当前数据会先自动备份）。继续？")) return;
      const res = await store.import(envelope);
      toast(`导入完成，共覆盖 ${res.overwritten} 条记录`);
      await refresh(); render();
    } catch (err) { toast("导入失败：" + err.message); }
  };
  const seedBtn = $("#btn-seed-demo");
  if (seedBtn) seedBtn.onclick = async () => {
    if (!confirm("载入示例数据会覆盖当前数据（会先自动备份）。继续？")) return;
    await api("POST", "/api/demo/seed", {});
    toast("示例数据已载入 ✓");
    await refresh(); render();
  };
  const clearBtn = $("#btn-clear-demo");
  if (clearBtn) clearBtn.onclick = async () => {
    if (!confirm("清空全部数据并恢复初始状态？（当前数据会先自动备份）")) return;
    await api("POST", "/api/demo/clear", {});
    await layoutStorage.hydrate(user.username,{force:true,discardPending:true});
    toast("已清空，可从「载入示例数据」重新开始");
    await refresh(); render();
  };
  const loadBackups = async () => {
    const box = $("#backup-list");
    try {
      const { backups } = await store.list("backups");
      box.innerHTML = backups.length ? backups.slice(0, 8).map(b =>
        `<div class="backup-item"><b>${esc(b.file.replace(/^backup-|\.zip$/g, ""))}</b>
         <span>${esc(b.reason === "auto" ? "自动" : { manual: "手动", "pre-restore": "恢复前", "pre-import": "导入前", seed: "示例", clear: "清空前" }[b.reason] || b.reason)}</span>
         <button class="btn small ghost restore-btn" data-file="${esc(b.file)}">恢复</button></div>`).join("")
        : `<span class="empty" style="padding:8px">暂无备份，改动数据后会自动生成</span>`;
      $$(".restore-btn", box).forEach(btn => btn.onclick = async () => {
        if (!confirm(`用 ${btn.dataset.file} 覆盖当前数据？（当前状态会先自动备份）`)) return;
        try {
          await layoutStorage.flush();
          await api("POST", "/api/restore", { file: btn.dataset.file });
          await layoutStorage.hydrate(user.username,{force:true,discardPending:true});
          toast("恢复完成 ✓");
          await refresh(); render();
        } catch (e) { toast("恢复失败：" + e.message); }
      });
    } catch (e) { box.innerHTML = `<span class="empty" style="padding:8px">${esc(e.message)}</span>`; }
  };
  loadBackups();
  root._wbUnsaved=()=>!!root.querySelector('[data-wb-dirty="true"]:is(#profile-name,#profile-new,#profile-current,#ai-provider,#ai-baseurl,#ai-key,#ai-model)');
  $$('button').forEach(button=>{const handler=button.onclick;if(!handler||button.id==='btn-reset-layout')return;button.onclick=async event=>{if(button.disabled)return;button.disabled=true;try{return await handler(event);}catch(error){toast(error.message);}finally{if(button.isConnected)button.disabled=false;}};});
}

/* ---------- 记账：先识别预览，再明确导入 ---------- */
const financeColors = { 餐饮: "var(--color-usage-chart-1)", 交通: "var(--color-usage-chart-2)", 购物: "var(--color-usage-chart-3)", 学习: "var(--color-usage-chart-6)", 居住: "var(--color-usage-chart-5)", 娱乐: "var(--color-usage-chart-4)", 医疗: "var(--color-finance-medical)", 其他: "var(--color-foreground-subtle)", 收入: "var(--color-success)" };
const categoryColor = name => Object.hasOwn(financeColors, name) ? financeColors[name] : financeColors.其他;
let billPreview = null;
let financeMonth = monthStr();
let financeVisible = 100;
function setFinanceMonth(month) {
  financeMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : monthStr();
  layoutStorage.setItem("wb-finance-month", financeMonth);
}
const money = n => Number(n || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function renderFinance(root) {
  const savedMonth = layoutStorage.getItem("wb-finance-month");
  financeMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(savedMonth || "") ? savedMonth : monthStr();
  const rows = (state.transactions || []).filter(r => r.date.startsWith(financeMonth));
  const expense = rows.filter(r => r.kind === "expense");
  const income = rows.filter(r => r.kind === "income");
  const spent = expense.reduce((s, r) => s + Number(r.amount), 0);
  const earned = income.reduce((s, r) => s + Number(r.amount), 0);
  const byCategory = {};
  expense.forEach(r => { byCategory[r.category] = (byCategory[r.category] || 0) + Number(r.amount); });
  const total = Object.values(byCategory).reduce((a, b) => a + b, 0);
  let offset = 0;
  const wedges = Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([name, value]) => {
    const start = offset; offset += value / total * 100;
    return `${categoryColor(name)} ${start}% ${offset}%`;
  });
  const [year, month] = financeMonth.split("-").map(Number);
  const days = new Date(year, month, 0).getDate();
  const daily = Array(days).fill(0);
  expense.forEach(r => { const d = Number(r.date.slice(8, 10)); if (d >= 1 && d <= days) daily[d - 1] += Number(r.amount); });
  const peak = Math.max(1, ...daily);
  const points = daily.map((v, i) => `${(i / Math.max(1, days - 1) * 600).toFixed(1)},${(132 - v / peak * 110).toFixed(1)}`).join(" ");
  const dayDots = daily.map((v, i) => `<circle cx="${(i / Math.max(1, days - 1) * 600).toFixed(1)}" cy="${(132 - v / peak * 110).toFixed(1)}" r="5" fill="transparent"><title>${i + 1} 日支出 ¥${money(v)}</title></circle>`).join("");
  (window.workbenchDesign?.paint||((node,html)=>node.innerHTML=html))(root,`
  <div class="greet"><div><span class="eyebrow">MONEY / 每一笔都有去处</span><h2>记账</h2><p>账单留在本机，识别后核对再导入</p></div>
    <input type="month" id="finance-month" value="${financeMonth}" aria-label="选择账单月份" style="margin-left:auto">
    <label class="btn upload-btn">导入账单<input id="bill-file" type="file" accept=".csv,.tsv,.xlsx" hidden></label></div>
  <div class="finance-stats"><div><small>本月支出</small><strong>¥ ${money(spent)}</strong></div><div><small>本月收入</small><strong>¥ ${money(earned)}</strong></div><div><small>结余</small><strong>¥ ${money(earned - spent)}</strong></div></div>
  <div class="finance-grid">
    <section class="card"><h3>支出趋势<span class="meta">每日金额 · ${financeMonth}</span></h3>
      ${expense.length ? `<div class="trend-wrap"><div class="chart-peak">单日最高 ¥${money(peak)}</div><svg viewBox="0 0 620 165" role="img" aria-label="${financeMonth} 每日支出曲线"><path d="M0 132H600" stroke="var(--line)"/><path class="finance-area" d="M0 132 L${points.replaceAll(' ',' L')} L600 132 Z"/><polyline points="${points}" fill="none" stroke="var(--color-usage-chart-1)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${dayDots}</svg><div class="chart-axis"><span>1 日</span><span>${days} 日</span></div></div>` : `<div class="empty">这个月还没有支出记录。导入账单后会显示每日曲线。</div>`}</section>
    <section class="card"><h3>资金去向<span class="meta">按支出类型</span></h3>
      ${expense.length ? `<div class="pie-layout"><div class="donut" style="background:conic-gradient(${wedges.join(",")})"><span>¥ ${money(spent)}</span></div><div class="legend">${Object.entries(byCategory).sort((a,b)=>b[1]-a[1]).map(([name, value]) => `<div><i style="background:${categoryColor(name)}"></i><span>${esc(name)}</span><b>¥${money(value)} · ${(value / total * 100).toFixed(1)}%</b></div>`).join("")}</div></div>` : `<div class="empty">分类占比会在导入账单后出现。</div>`}</section>
  </div>
  <section class="card finance-ledger"><h3>交易明细<span class="meta">${rows.length} 笔</span></h3>
    <div class="finance-toolbar"><input id="txn-date" type="date" aria-label="新交易日期" value="${new Date().toLocaleDateString("sv-SE")}"><input id="txn-title" maxlength="120" placeholder="交易说明" aria-label="交易说明"><input id="txn-amount" type="number" min="0.01" step="0.01" placeholder="金额" aria-label="金额"><select id="txn-kind" aria-label="收支"><option value="expense">支出</option><option value="income">收入</option></select><select id="txn-category" aria-label="类型">${Object.keys(financeColors).map(c => `<option>${c}</option>`).join("")}</select><button class="btn small" id="txn-add">添加</button></div>
    <div class="ledger-list">${rows.length ? rows.slice().sort((a,b)=>b.date.localeCompare(a.date)).slice(0,financeVisible).map(r => `<div class="ledger-row" data-id="${esc(r.id)}"><span class="ledger-dot" style="background:${categoryColor(r.category)}"></span><time>${esc(r.date)}</time><span class="ledger-title">${esc(r.title)}</span><span class="ledger-cat">${esc(r.category)}</span><b class="${r.kind}">${r.kind === "income" ? "+" : "−"} ¥${money(r.amount)}</b><button class="del txn-del" data-id="${esc(r.id)}" aria-label="删除 ${esc(r.title)}">×</button></div>`).join("") : `<div class="empty">暂无交易。可以手动添加，或上传 CSV / XLSX 账单。</div>`}</div>${rows.length > financeVisible ? `<button class="btn small ghost" id="txn-more">显示更多（已显示 ${financeVisible} / ${rows.length}）</button>` : ""}</section>
  <dialog id="bill-dialog" class="bill-dialog"><h3>核对识别结果</h3><p id="bill-count"></p><div id="bill-rows" class="bill-rows"></div><div id="bill-pagination"></div><div class="dialog-actions"><button class="btn ghost" id="bill-cancel">取消</button><button class="btn" id="bill-confirm">确认导入</button></div></dialog>`);
  $("#finance-month").onchange = e => { setFinanceMonth(e.target.value); financeVisible = 100; renderFinance(root); };
  const more = $("#txn-more"); if (more) more.onclick = () => { financeVisible += 100; renderFinance(root); };
  $("#txn-kind").onchange=()=>{const income=$("#txn-kind").value==="income",category=$("#txn-category");category.disabled=income;if(income)category.value="收入";else if(category.value==="收入")category.value="其他";};
  $("#txn-category option:last-child").disabled=true;$("#txn-kind").onchange();
  $("#txn-add").onclick = async () => {
    const row = { date: $("#txn-date").value, title: $("#txn-title").value.trim(), amount: Number($("#txn-amount").value), kind: $("#txn-kind").value, category: $("#txn-kind").value === "income" ? "收入" : $("#txn-category").value };
    if (!row.date || !row.title || !Number.isFinite(row.amount) || row.amount < 0.01) { toast("请填写日期、说明和金额"); return; }
    const identity=user?.username,selectedMonth=financeMonth,originalTitle=$("#txn-title").value,originalAmount=$("#txn-amount").value,button=$("#txn-add");if(button.disabled)return;button.disabled=true;
    try { await api("POST", "/api/transactions", { rows: [row], allowDuplicate: true }); if(user?.username!==identity)return;if(root.isConnected&&financeMonth===selectedMonth)setFinanceMonth(row.date.slice(0,7)); await refresh();if(user?.username!==identity||!root.isConnected)return;["txn-title","txn-amount"].forEach(id=>{const input=$("#"+id,root);if(input.value===(id==="txn-title"?originalTitle:originalAmount)){input.value="";delete input.dataset.wbDirty;}});renderFinance(root);toast("交易已添加"); }
    catch (e) { if(user?.username===identity)toast(e.message); }finally{if(button.isConnected)button.disabled=false;}
  };
  $$(".txn-del", root).forEach(btn => btn.onclick = async () => {
    if(btn.disabled||!confirm("删除这笔交易？"))return;btn.disabled=true;
    try{await api("POST", `/api/transactions/${encodeURIComponent(btn.dataset.id)}`, {});
    await refresh();if(root.isConnected)renderFinance(root);
    }catch(error){if(root.isConnected)toast(error.message);}finally{if(btn.isConnected)btn.disabled=false;}
  });
  const billDialog=$("#bill-dialog");
  $("#bill-file").onchange = async e => {
    const identity=user?.username,input=e.target;if(input.disabled)return;const file = input.files[0]; if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast("账单文件不能超过 5 MB"); return; }
    input.disabled=true;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = ""; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const parsed=await api("POST", "/api/bills/preview", { filename: file.name, data: btoa(binary) });
      if(!billDialog.isConnected||user?.username!==identity)return;billPreview=parsed;
      $("#bill-count").textContent = `识别 ${billPreview.rows.length} 笔，跳过 ${billPreview.skipped} 行。可修改下方收支和分类。`;
      let offset=0;const drawPreview=()=>{
      $("#bill-rows").innerHTML = billPreview.rows.slice(offset,offset+30).map((r, pageIndex) => {const i=offset+pageIndex;return `<div><time>${esc(r.date)}</time><span>${esc(r.title)}</span><b>¥${money(r.amount)}</b><select class="bill-kind" data-i="${i}" aria-label="${esc(r.title)} 的收支方向"><option value="expense" ${r.kind === "expense" ? "selected" : ""}>支出</option><option value="income" ${r.kind === "income" ? "selected" : ""}>收入</option></select><select class="bill-category" data-i="${i}" aria-label="${esc(r.title)} 的分类">${Object.keys(financeColors).map(c => `<option ${r.category === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>`;}).join("");
      $("#bill-rows").scrollTop=0;$("#bill-pagination").innerHTML="";
      if(billPreview.rows.length>30){const controls=document.createElement('div');controls.className='bill-page-controls';controls.innerHTML=`<button type="button" class="btn ghost" id="bill-prev" ${offset===0?'disabled':''}>上一页</button><span>第 ${Math.floor(offset/30)+1} / ${Math.ceil(billPreview.rows.length/30)} 页 · 所有页的修改都会保存</span><button type="button" class="btn ghost" id="bill-next" ${offset+30>=billPreview.rows.length?'disabled':''}>下一页</button>`;$("#bill-pagination").append(controls);$("#bill-prev").onclick=()=>{offset-=30;drawPreview();};$("#bill-next").onclick=()=>{offset+=30;drawPreview();};}

      $$(".bill-kind").forEach(sel => sel.onchange = () => { const row = billPreview.rows[Number(sel.dataset.i)]; row.kind = sel.value; if (sel.value === "income") row.category = "收入"; else if (row.category === "收入") row.category = "其他"; $(".bill-category[data-i='" + sel.dataset.i + "']").value = row.category; });
      $$(".bill-category").forEach(sel => sel.onchange = () => { const row = billPreview.rows[Number(sel.dataset.i)]; row.category = sel.value; row.kind = sel.value === "收入" ? "income" : "expense"; $(".bill-kind[data-i='" + sel.dataset.i + "']").value = row.kind; });
      };drawPreview();
      $("#bill-dialog").showModal();
    } catch (err) { if(billDialog.isConnected)toast("识别失败：" + err.message); }
    finally{input.value="";input.disabled=false;}
  };
  $("#bill-cancel").onclick = () => { billPreview = null; $("#bill-dialog").close(); };
  $("#bill-confirm").onclick = async () => {
    if (!billPreview) return;
    const identity=user?.username,btn = $("#bill-confirm");if(btn.disabled)return;const preview=billPreview;btn.disabled = true;
    try { const result = await api("POST", "/api/transactions", { rows: preview.rows }); if(user?.username!==identity)return;if(billDialog.isConnected)billDialog.close();if(billPreview===preview)billPreview = null; setFinanceMonth(preview.rows.reduce((latest,row)=>row.date>latest?row.date:latest,'').slice(0,7)||financeMonth);financeVisible=100; await refresh();if(user?.username!==identity||!root.isConnected)return;renderFinance(root);toast(`已导入 ${result.added} 笔，去重 ${result.duplicates} 笔 · ${financeMonth}`); }
    catch (err) { if(user?.username===identity)toast("导入失败：" + err.message);if(btn.isConnected)btn.disabled = false; }
  };
}

/* ---------------- 启动 ---------------- */
window.addEventListener('beforeunload',event=>{if(window.workbenchDesign?.unsaved()){event.preventDefault();event.returnValue='';}});
window.addEventListener("hashchange", render);
(async function init() {
  try {
    const runtime=await api('GET','/api/runtime');window.workbenchRuntime=runtime;
    if(runtime.version!==window.WorkbenchUI.version||runtime.preview){const note=document.createElement('p');note.className='wb-runtime-note';note.setAttribute('role','status');note.textContent=runtime.preview?`${runtime.version} 隔离测试 · 合成资料；不代表正式8765验收` :`前端 ${window.WorkbenchUI.version} · 后端仍为 ${runtime.version}，新功能需重启后端服务。`;document.querySelector('.shell-heading').append(note);}
    const me = await api("GET", "/api/auth/me", undefined, { auth: true });
    if (!me.user) { showLogin(); return; }
    user = me.user;
    await refresh();
  } catch (e) {
    $("#main").innerHTML = `<div class="card" style="margin-top:40px"><h3>无法连接本地服务</h3>
      <p class="empty">请确认 server.py 正在运行（双击 start.bat）。<br>错误信息：${esc(e.message)}</p></div>`;
    return;
  }
  render();
  setInterval(async () => { try { await refresh(); const editing = document.querySelector('#main input:focus,#main textarea:focus,#main select:focus,.card-dragging,.resize-corner.active,.sidebar-resize.active,.ws-divider.active'); if (user && !editing && ["overview"].includes((location.hash || "#/overview").replace(/^#\//, ""))) render(); } catch (_) {} }, 60000);
})();
