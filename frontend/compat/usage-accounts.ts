// @ts-nocheck
// Compatibility controller: retain the validated interactions during the React migration.
(() => {
  const escape = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const number = (n) =>
    typeof n === "number" && Number.isFinite(n)
      ? n.toLocaleString("zh-CN")
      : "—";
  const quotaTimeFormatter=new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",hour12:false,year:"numeric",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit"});
  const time = (t) =>
    t !== null && t !== undefined && t !== ""
      ? new Date(t).toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
          hour12: false,
        })
      : "尚未同步";
  const call = (method, url, body, options) => api(method, url, body, options);
  const syncConnection = async (id) => {
    const result = await call("POST", "/api/usage/connection/sync", { id });
    if (result.ok === false) throw new Error(result.error || "用量同步失败");
    return result;
  };
  const accountStates = new WeakMap();

  const ringStates = new WeakMap();
  const renderTickets = new WeakMap();
  const activeButtons = (root, disabled) =>
    root.querySelectorAll("button").forEach((b) => (b.disabled = disabled));
  function quotaWindows(quota) {
    const buckets = quota?.rateLimitsByLimitId;
    const main =
      buckets?.codex ||
      Object.values(buckets || {}).find((b) => b?.limitId === "codex") ||
      quota?.rateLimits;
    return ["primary", "secondary"].flatMap((slot) => {
      const w = main?.[slot];
      if (
        !Number.isFinite(w?.usedPercent) ||
        !Number.isFinite(w?.windowDurationMins) ||
        w.windowDurationMins <= 0
      )
        return [];
      const minutes = w.windowDurationMins;
      return [
        {
          slot,
          minutes,
          label:
            minutes === 300
              ? "5 小时额度"
              : minutes === 10080
                ? "每周额度"
                : `${number(minutes)} 分钟额度`,
          remaining: Math.max(0, Math.min(100, 100 - w.usedPercent)),
          reset: Number.isFinite(w.resetsAt) ? w.resetsAt * 1000 : null,
        },
      ];
    });
  }
  const quotaTone = (n) =>
    n === 100 ? "green" : n <= 20 ? "red" : n <= 50 ? "yellow" : "blue";
  function quotaRow(w) {
    return `<div class="account-quota-window" data-quota-slot="${w.slot}" data-quota-window="${w.minutes}" data-quota-label="${escape(w.label)}" data-remaining="${w.remaining}" data-quota-tone="${quotaTone(w.remaining)}" data-reset-at="${w.reset ?? ""}"><div class="quota-bar-area"><span>${escape(w.label)}</span><strong data-quota-percent>${w.remaining.toFixed(1)}% 剩余</strong><progress value="${w.remaining}" max="100" aria-label="${escape(w.label)}剩余 ${w.remaining.toFixed(1)}%"></progress><small data-quota-reset>${w.reset === null ? "平台未返回重置时间" : "重置 " + time(w.reset)}</small></div><div class="quota-rings" role="group" aria-label="${escape(w.label)}剩余额度与重置倒计时"><svg viewBox="0 0 120 120"><circle class="quota-track" cx="60" cy="60" r="46"/><circle class="quota-track" cx="60" cy="60" r="28"/><circle class="quota-remaining" cx="60" cy="60" r="46" pathLength="100" stroke-dasharray="${w.remaining} 100" aria-hidden="true"/><circle class="quota-time" cx="60" cy="60" r="28" pathLength="100" stroke-dasharray="0 100" aria-hidden="true"/><circle class="quota-hit-area" data-quota-ring="remaining" role="button" tabindex="0" aria-label="${escape(w.label)}剩余额度 ${w.remaining.toFixed(1)}%" cx="60" cy="60" r="46"/><circle class="quota-hit-area" data-quota-ring="time" role="button" tabindex="0" aria-label="${escape(w.label)}重置倒计时" cx="60" cy="60" r="28"/></svg></div></div>`;
  }
  function countdown(seconds) {
    if (seconds === null) return "未返回";
    if (seconds === 0) return "0分 0秒";
    return seconds >= 86400
      ? Math.floor(seconds / 86400) +
          "天 " +
          Math.floor((seconds % 86400) / 3600) +
          "时"
      : seconds >= 3600
        ? Math.floor(seconds / 3600) +
          "时 " +
          Math.floor((seconds % 3600) / 60) +
          "分"
        : Math.floor(seconds / 60) + "分 " + (seconds % 60) + "秒";
  }
  const setText = (node, value) => {
    if (node.textContent !== value) node.textContent = value;
  };
  const setAttribute = (node, key, value) => {
    if (node.getAttribute(key) !== String(value)) node.setAttribute(key, value);
  };
  function tickQuota(row) {
    if(row.dataset.quotaKnown === "false"){row.querySelector("[data-quota-ring=remaining]").setAttribute("aria-label",row.dataset.quotaLabel+"额度未返回");row.querySelector("[data-quota-ring=time]").setAttribute("aria-label",row.dataset.quotaLabel+"重置时间未返回");row.querySelectorAll(".quota-remaining,.quota-time").forEach(r=>r.setAttribute("visibility","hidden"));return;}
    const reset =
        row.dataset.resetAt === "" ? null : Number(row.dataset.resetAt),
      minutes = Number(row.dataset.quotaWindow),
      remaining = Number(row.dataset.remaining);
    const seconds =
        reset === null
          ? null
          : Math.max(0, Math.ceil((reset - Date.now()) / 1000)),
      value = countdown(seconds),
      label = row.dataset.quotaLabel;
    const ratio =
      seconds === null
        ? 0
        : Math.max(0, Math.min(100, (seconds / (minutes * 60)) * 100));
    const ring = row.querySelector(".quota-time");
    setAttribute(ring, "stroke-dasharray", ratio + " 100");
    setAttribute(
      ring,
      "visibility",
      seconds === null || ratio === 0 ? "hidden" : "visible",
    );
    setAttribute(
      row.querySelector(".quota-remaining"),
      "visibility",
      remaining === 0 ? "hidden" : "visible",
    );
    setAttribute(
      row.querySelector("[data-quota-ring=remaining]"),
      "aria-label",
      `${label}剩余额度 ${remaining.toFixed(1)}%`,
    );
    setAttribute(
      row.querySelector("[data-quota-ring=time]"),
      "aria-label",
      seconds === null
        ? `${label}：平台未返回重置时间`
        : `${label}距重置 ${value}`,
    );
    const state = ringStates.get(row),
      active = state?.hover || state?.focus || state?.pinned;
    row.dataset.ringActive = active || "";
    if (active) {
      const box = row
          .querySelector(`[data-quota-ring=${active}]`)
          .getBoundingClientRect(),
        p = state.point || {
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
        };
      state.tip.show(
        {primary: active === "remaining" ? `${remaining.toFixed(1)}% 剩余` : `距重置 ${value}`, date:reset === null ? null : time(reset), rows:[{label,value:active === "remaining" ? `${remaining.toFixed(1)}%` : value,color:"#2563EB"}]},
        p.x,
        p.y,
      );
    } else state?.tip.hide();
  }
  function bindQuota(row) {
    if (ringStates.has(row)) return;
    const state = { hover: null, focus: null, pinned: null, point: null };
    ringStates.set(row, state);
    state.tip = window.usageCharts.tooltip(row);
    row.querySelector(".usage-tooltip").classList.add("quota-tooltip");
    row.querySelectorAll("[data-quota-ring]").forEach((ring) => {
      const kind = ring.dataset.quotaRing;
      ring.addEventListener("pointerenter", (ev) => {
        if (ev.pointerType === "touch") return;
        state.hover = kind;
        state.point = { x: ev.clientX, y: ev.clientY };
        tickQuota(row);
      });
      ring.addEventListener("pointermove", (ev) => {
        state.point = { x: ev.clientX, y: ev.clientY };
        tickQuota(row);
      });
      ring.addEventListener("pointerleave", () => {
        state.hover = null;
        tickQuota(row);
      });
      ring.addEventListener("focus", () => {
        state.focus = kind;
        state.point = null;
        tickQuota(row);
      });
      ring.addEventListener("blur", () => {
        state.focus = null;
        tickQuota(row);
      });
      ring.addEventListener("click", () => {
        state.pinned = state.pinned === kind ? null : kind;
        if (!state.pinned) {
          state.focus = null;
          state.hover = null;
          ring.blur();
        }
        tickQuota(row);
      });
      ring.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          ring.dispatchEvent(new MouseEvent("click"));
        }
        if (ev.key === "Escape") {
          ev.preventDefault();
          state.pinned = null;
          state.hover = null;
          state.focus = null;
          ring.blur();
          tickQuota(row);
        }
      });
    });
    tickQuota(row);
  }
  function startQuotaClock(root) {
    root.querySelectorAll("[data-quota-slot]").forEach(bindQuota);
    const outside = (ev) =>
      root.querySelectorAll("[data-quota-slot]").forEach((row) => {
        if (row.querySelector(".quota-rings").contains(ev.target)) return;
        const state = ringStates.get(row);
        state.pinned = null;
        state.hover = null;
        if (row.contains(document.activeElement)) document.activeElement.blur();
        state.focus = null;
        tickQuota(row);
      });
    document.addEventListener("pointerdown", outside);
    const stop = () => {
      clearInterval(timer);
      document.removeEventListener("pointerdown", outside);
    };
    const timer = setInterval(() => {
      if (!root.isConnected) {
        stop();
        return;
      }
      root.querySelectorAll("[data-quota-slot]").forEach(tickQuota);
      accountStates.get(root)?.paintReset?.();
    }, 1000);
    window.usageCharts?.track(root, stop);
    return stop;
  }
  async function render(root, scope, providers, refresh, days = 30) {
    const ticket = (renderTickets.get(root) || 0) + 1;
    renderTickets.set(root, ticket);
    const { connections } = await call("GET", "/api/usage/connections");
    if (!root.isConnected || renderTickets.get(root) !== ticket)
      return connections;
    let state = accountStates.get(root);
    if (!state) {
      state = { root, connections: [], dialog: null, structure: null };
      accountStates.set(root, state);
    }
    Object.assign(state, {
      connections: connections || [],
      providers: providers || [],
      refresh,
      days,
    });
    root.hidden=scope!=="codex";const manager=root.closest(".usage-stable")?.querySelector("#usage-account-add");if(manager)manager.onclick=()=>manage(root);
    if(root.hidden){state.stopClock?.();state.stopClock=null;return connections;}
    if (!root.querySelector("[data-global-codex-quotas]")) {
      state.stopClock?.();
      state.structure = null;
      root.innerHTML =
        '<div class="section-title usage-account-heading"><h3>Codex账户</h3>'+window.LingxiDesign.connectButton()+'</div><p class="meta lingxi-account-status" data-codex-error role="status"></p><div class="account-quota-grid" data-global-codex-quotas></div>';
      root
        .closest(".usage-stable")
        .querySelector("#usage-account-add").onclick = () => manage(root);
      state.stopClock = startQuotaClock(root);
    }
    patchInline(state);
    paintSuppliers(state);
    return connections;
  }
  function patchInline(state) {
    const codex = state.connections.filter((c) => c.kind === "codex");
    const selected =
      codex.find((c) => c.id === state.root.dataset.codexAccountId) || codex[0];
    const button = state.root
      .closest(".usage-stable")
      .querySelector("#usage-account-add");
    setAttribute(button, "data-account-status", "ready");
    setAttribute(button, "title", "管理API供应商");
    const entryAccount=state.liveAccount||selected?.snapshot||{},entryKey=(user?.profileId||user?.username||"profile")+":"+(entryAccount.accountIdentity||entryAccount.credentialSource||"missing");const entryVersion=state.root.closest(".usage-stable")?.dataset.usageEntry||entryKey;state.animateEntry=state.entryVersion!==entryVersion;state.entryVersion=entryVersion;
    const windows = quotaWindows(state.liveAccount?.quota || selected?.snapshot?.quota),
      grid = state.root.querySelector("[data-global-codex-quotas]");
    if (!grid.querySelector('.lingxi-codex-account')) {
      const unknown=(slot,label,minutes)=>quotaRow({slot,label,minutes,remaining:0,reset:null}).replace('data-quota-slot=', 'data-quota-known="false" data-quota-slot=').replace('0.0% 剩余','--').replace('平台未返回重置时间','重置 --');
      grid.innerHTML='<div class="lingxi-codex-account"><div class="lingxi-quota-stack">'+unknown('primary','5 小时额度',300)+unknown('secondary','每周额度',10080)+'</div><div class="lingxi-account-details"><section class="lingxi-value-card"><div data-codex-value><section class="agent-value-panel"><header><h3>API等效参考价值</h3><div class="agent-value-commit"><span data-enabled></span><div data-slide></div></div></header><div class="agent-value-line"><div class="agent-value-amounts"><span class="agent-value-usd">USD <strong>--</strong></span><span class="agent-value-cny">CNY <strong>--</strong></span></div><a href="prices.html" target="_blank" rel="noopener" class="agent-value-source">查看价格与汇率 ↗</a></div></section></div></section><section class="lingxi-credit-single"><h4>剩余 Credit</h4><strong data-credit>--</strong></section><section class="lingxi-reset-card" data-reset-card-host></section></div><div class="lingxi-account-actions" hidden><button type="button" data-codex-refresh>刷新账户</button></div></div>';
      state.root.querySelector('[data-codex-login]').onclick=()=>{const windowShell=window.WorkbenchDialogs.open({title:'连接 Codex',size:'medium',body:'<div data-codex-authorization></div>',actions:[]});window.LingxiDesign.login(windowShell.body.querySelector('[data-codex-authorization]'),()=>{grid.querySelector('[data-codex-refresh]')?.click();});};
      grid.querySelector('[data-codex-refresh]').onclick=async()=>{
        if(state.accountPending)return;state.accountPending=true;
        try{state.liveAccount=await call('GET','/api/codex/account');if(grid.isConnected)patchInline(state);}catch(error){if(state.root.isConnected)state.root.querySelector('[data-codex-error]').textContent=error.message;}finally{state.accountPending=false;if(grid.isConnected&&(state.liveAccount?.pending||state.liveAccount?.refreshing)){clearTimeout(state.accountPoll);state.accountPoll=setTimeout(()=>{if(grid.isConnected)grid.querySelector("[data-codex-refresh]")?.click();},600);}}
      };
      grid.querySelectorAll('[data-quota-slot]').forEach(bindQuota);
      window.WorkbenchReact.slideCommit(grid.querySelector('[data-slide]'),{enabled:false,compact:true,onConfirm:async()=>{const features=await call('GET','/api/features');return window.AgentValuation.toggle('codex',features.codexValuationEnabled===true);}});
    }
    if(state.liveAccount&&!state.liveAccount.stale){grid.querySelectorAll("[data-quota-slot]").forEach(row=>{if(windows.some(w=>w.slot===row.dataset.quotaSlot))return;row.dataset.quotaKnown="false";row.querySelector("[data-quota-percent]").textContent="--";row.querySelector("[data-quota-reset]").textContent="重置 --";row.querySelector("progress").value=0;tickQuota(row);});}
    windows.forEach(w=>patchQuota(grid.querySelector('[data-quota-slot="'+w.slot+'"]'),w,state.animateEntry));
    grid.hidden=false;
    if(!state.accountAttempted||Date.now()-(state.accountRequestedAt||0)>30000){state.accountAttempted=true;state.accountRequestedAt=Date.now();queueMicrotask(()=>grid.querySelector('[data-codex-refresh]')?.click());}
    const account=state.liveAccount||selected?.snapshot||{},quota=account.quota||{},bucket=quota.rateLimitsByLimitId?.codex||quota.rateLimits||{},credits=bucket.credits||quota.credits,resets=quota.rateLimitResetCredits;
    const balance=credits?.balance,text=credits?.unlimited?'不限额':balance!=null&&balance!==''&&Number.isFinite(Number(balance))?Number(balance).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2}):'--';
    const credit=grid.querySelector('[data-credit]');if(credit.textContent!==text||state.animateEntry){window.workbenchDesign?.number(credit,text,state.animateEntry);}
    const resetSignature=JSON.stringify(resets||null);if(state.resetSignature!==resetSignature){state.resetSignature=resetSignature;state.paintReset=window.LingxiDesign.resetBatteries(grid.querySelector('[data-reset-card-host]'),resets);}
    state.root.querySelector('[data-codex-error]').dataset.pending=String(!!(account.pending||account.refreshing));
    state.root.querySelector('[data-codex-error]').textContent=account.pending?'正在读取账户…':account.refreshing?'正在刷新，先显示上次结果':account.unavailable?.quota || (account.stale?'账户刷新失败，显示上次读取结果':'');
  }
  function patchQuota(row, w, animate = true) {
    setAttribute(row,"data-quota-window",w.minutes);setAttribute(row,"data-quota-label",w.label);setText(row.querySelector(".quota-bar-area>span"),w.label);
    const first=row.dataset.quotaKnown === "false";row.dataset.quotaKnown="true";
    if(animate&&document.documentElement.dataset.motion!=="reduced"&&!matchMedia("(prefers-reduced-motion: reduce)").matches){row.classList.add("lingxi-quota-enter");cancelAnimationFrame(row._quotaFrame);const begin=performance.now();const animate=now=>{if(!row.isConnected)return;const elapsed=Math.min(1,(now-begin)/800),value=100+(w.remaining-100)*(1-Math.pow(1-elapsed,3));row.querySelector("progress").value=value;row.querySelector(".quota-remaining").setAttribute("stroke-dasharray",value+" 100");if(elapsed<1)row._quotaFrame=requestAnimationFrame(animate);};row._quotaFrame=requestAnimationFrame(animate);}
    setAttribute(row, "data-remaining", w.remaining);
    setAttribute(row, "data-reset-at", w.reset ?? "");
    setAttribute(row, "data-quota-tone", quotaTone(w.remaining));
    setText(
      row.querySelector("[data-quota-percent]"),
      w.remaining.toFixed(1) + "% 剩余",
    );
    setText(
      row.querySelector("[data-quota-reset]"),
      w.reset === null ? "平台未返回重置时间" : "重置 " + time(w.reset),
    );
    setAttribute(row.querySelector("progress"), "value", w.remaining);
    setAttribute(
      row.querySelector("progress"),
      "aria-label",
      `${w.label}剩余 ${w.remaining.toFixed(1)}%`,
    );
    setAttribute(
      row.querySelector(".quota-remaining"),
      "stroke-dasharray",
      w.remaining + " 100",
    );
    tickQuota(row);
  }
  async function refreshManaged(state, preferred) {
    const identity = state.managerOwner || user?.username;
    const result =
      typeof state.refresh === "function"
        ? await state.refresh(preferred)
        : null;
    const connections = Array.isArray(result)
      ? result
      : Array.isArray(result?.connections)
        ? result.connections
        : (await call("GET", "/api/usage/connections")).connections;
    if (user?.username !== identity) return state.connections;
    state.connections = connections || [];
    if (state.root.isConnected) patchInline(state);
    paintSuppliers(state);
    return state.connections;
  }
  const supplierId = (c) => window.usageFilters.supplierId(c);
  function authorizeLMU(state) {
    const d = document.createElement("dialog");
    d.className = "control-dialog usage-lmu-auth";
    d.setAttribute("aria-label", "授权 LMU");
    d.innerHTML =
      '<form><div class="control-dialog-head"><h3>授权 LMU</h3><button type="button" class="btn ghost" data-close aria-label="关闭">×</button></div><p class="meta">登录一次，自动续期。密码不保存。</p><label class="control-field">LMU 邮箱<input name="email" type="email" autocomplete="username"></label><label class="control-field">密码<input name="password" type="password" autocomplete="current-password"></label><label class="control-field" data-two-factor hidden>验证码<input name="totpCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></label><details><summary>已有登录凭据</summary><label class="control-field">平台登录凭据<input name="accessToken" type="password" autocomplete="off"></label><label class="control-field">续期凭据（可选）<input name="refreshToken" type="password" autocomplete="off"></label></details><p class="control-form-error" role="alert"></p><div class="control-dialog-actions"><button type="submit" class="btn">授权并同步</button><button type="button" class="btn ghost" data-close>取消</button></div></form>';
    document.body.append(d);
    const focus = document.activeElement;
    d.querySelectorAll("[data-close]").forEach(
      (b) => (b.onclick = () => d.close()),
    );
    d.addEventListener("close", () => {
      d.querySelectorAll("input").forEach((i) => (i.value = ""));
      d.remove();
      if (focus?.isConnected) focus.focus();
    });
    d.querySelector("form").onsubmit = async (event) => {
      event.preventDefault();
      const form = event.target,
        message = d.querySelector("[role=alert]");
      activeButtons(d, true);
      message.textContent = "";
      try {
        const result = await call(
          "POST",
          "/api/usage/lmu/authorize",
          Object.fromEntries(new FormData(form)),
        );
        form.elements.password.value = "";
        if (result.requires2FA) {
          d.querySelector("[data-two-factor]").hidden = false;
          form.elements.totpCode.focus();
          return;
        }
        let failed = 0;
        for (const row of state.connections.filter(
          (c) => c.kind === "lmu" && c.enabled,
        )) {
          try {
            await syncConnection(row.id);
          } catch (_) {
            failed++;
          }
        }
        await refreshManaged(state);
        if (failed) {
          message.textContent = failed + " 个 Key 同步失败，请查看对应卡片";
          return;
        }
        d.close();
        toast("LMU 已授权并同步", {kind:"success"});
      } catch (error) {
        message.textContent = error.message;
      } finally {
        form.elements.password.value = "";
        if (d.isConnected) activeButtons(d, false);
      }
    };
    d.showModal();
    return d;
  }
  const supplierIcon = (kind) => {
    const files={deepseek:'deepseek-logo.svg',glm:'glm-logo.png',lmu:'providers/lmu.svg',openrouter:'providers/openrouter.png',siliconflow:'providers/siliconflow.ico',moonshot:'providers/moonshot.ico',minimax:'providers/minimax.ico',newapi:'providers/newapi.png',sub2api:'providers/sub2api.svg'};
    return '<span class="supplier-brand-icon" aria-hidden="true">'+(files[kind]?'<img src="assets/'+files[kind]+'" alt="">':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="4" width="16" height="16" rx="5"/><path d="M8 12h8m-4-4v8"/></svg>')+'</span>';
  };
  const managerActive = (state) =>
    state.dialog?.isConnected &&
    state.root.isConnected &&
    user?.username === state.managerOwner;
  function closeKeyEditor(state, force = false) {
    const editor = state.editor;
    if (!editor) return true;
    if (!force && editor.busy) {
      toast("正在保存，请稍候");
      return false;
    }
    if (!force && editor.dirty && !confirm("APIKey 修改尚未保存，放弃修改？"))
      return false;
    editor.abort.abort();
    editor.node
      .querySelectorAll("input[type=password],textarea")
      .forEach((el) => (el.value = ""));
    editor.node.remove();
    state.editor = null;
    if (editor.focus?.isConnected) editor.focus.focus({ preventScroll: true });
    return true;
  }
  function editSupplierKey(row, state) {
    if (!managerActive(state) || !closeKeyEditor(state)) return;
    const c = row || {},
      kind = c.kind || "custom",
      preset = window.usageProviders?.[kind],
      d = document.createElement("section");
    const apiBase=String(c.apiUrl || {deepseek:"https://api.deepseek.com",glm:"https://open.bigmodel.cn/api/paas/v4",lmu:"https://api.lmuai.ai"}[kind] || preset?.url || "").replace(/\/+$/, ""),tails={deepseek:"/user/balance",glm:"/api/monitor/usage/model-usage",lmu:"/api/v1/usage",openrouter:"/key",siliconflow:"/user/info",moonshot:"/users/me/balance",newapi:"/api/usage/token/",sub2api:"/api/v1/auth/me"};
    if(kind==="newapi"&&c.credentialMode==="account")tails.newapi="/api/user/self";
    const requestURL=apiBase&&tails[kind]?(apiBase.endsWith(tails[kind].replace(/\/+$/, ""))?apiBase:["deepseek","glm","lmu","newapi","sub2api"].includes(kind)?new URL(apiBase).origin+tails[kind]:apiBase+tails[kind]):apiBase;
    d.className = "usage-key-editor";
    d.setAttribute("role", "region");
    d.setAttribute("aria-label", c.id ? "编辑 APIKey" : "导入 APIKey");
    d.innerHTML = `<form class="api-key-form"><div class="control-dialog-head"><h3>${c.id ? "编辑 API Key" : "添加 API Key"}</h3><button type="button" class="btn ghost" data-close aria-label="关闭">×</button></div>${kind === "custom" ? `<label class="control-field">供应商名称<input name="supplierName" required maxlength="60" value="${escape(c.supplierName || "")}"></label>` : ""}<label class="control-field key-endpoint-field">查询地址<input name="apiUrl" type="url" required value="${escape(requestURL)}" placeholder="https://…" autocomplete="url"></label><label class="control-field">名称<input name="name" maxlength="80" required value="${escape(c.name || (kind === "deepseek" ? "DeepSeek" : kind === "glm" ? "GLM" : kind === "lmu" ? "LMU" : preset?.name || "API") + " Key")}"></label><label class="control-field key-secret-field">${kind === "sub2api" ? "账户访问凭据" : "API Key"}<input type="password" name="apiKey" ${c.id ? "" : "required"} maxlength="4096" autocomplete="new-password" spellcheck="false" placeholder="${c.id ? "留空保留现有 Key" : "每次导入一个 API Key"}"></label><p class="meta">${kind === "lmu" ? "添加 Key 后，授权 LMU 平台查询历史。" : kind === "glm" ? "粘贴 Key 后导入，即可查询每日用量和费用。" : kind === "deepseek" ? "查询余额；历史用量需官方授权。" : preset ? "查询可用余额或额度；Token 仅来自真实用量响应。" : "接口需返回日期、模型、Token；可同时返回费用。"}</p>${kind === "deepseek" ? "" : ["newapi", "custom_balance", "minimax"].includes(kind) ? `<details class="usage-platform-import"><summary>查询配置</summary><p class="meta">填写 JSON。New API 可设 credentialMode、userId；MiniMax 订阅 Key 设 credentialMode=subscription；自定义余额设 balanceMapping，明确币种和字段。</p><textarea name="adapterOptions" rows="3" autocomplete="off" spellcheck="false">${escape(JSON.stringify({ credentialMode: c.credentialMode || "key", ...(c.userId !== undefined ? { userId: c.userId } : {}), ...(c.quotaCurrency ? { quotaCurrency: c.quotaCurrency } : {}), ...(c.balanceMapping ? { balanceMapping: c.balanceMapping } : {}) }))}</textarea></details>` : ""}<label class="control-check"><input name="enabled" type="checkbox" ${c.enabled !== false ? "checked" : ""}>自动同步</label><p class="control-form-error" role="alert"></p><div class="control-dialog-actions"><button type="button" class="btn ghost" data-close>取消</button><button type="submit" class="btn">${c.id ? "保存修改" : "添加 Key"}</button></div></form>`;
    const editor = {
      node: d,
      id: c.id,
      tab: state.supplierTab,
      dirty: false,
      busy: false,
      abort: new AbortController(),
      focus: document.activeElement,
    };
    state.editor = editor;
    const body = state.dialog.querySelector("[data-managed-accounts]"),
      card = [...body.querySelectorAll("[data-account]")].find(
        (el) => el.dataset.account === c.id,
      );
    (card || body).insertBefore(
      d,
      card ? null : body.querySelector(":scope > [data-add-key]"),
    );
    d.classList.toggle("usage-key-new", !c.id);
    d.close = () => closeKeyEditor(state, true);
    d.querySelectorAll("[data-close]").forEach(
      (b) => (b.onclick = () => closeKeyEditor(state)),
    );
    d.addEventListener("input", () => (editor.dirty = true));
    d.addEventListener("change", () => (editor.dirty = true));
    const current = () => managerActive(state) && state.editor === editor;
    d.querySelector("form").onsubmit = async (ev) => {
      ev.preventDefault();
      if (editor.busy || !current()) return;
      const form = ev.target,
        values = Object.fromEntries(new FormData(form));
      let options = {};
      try {
        options = JSON.parse(values.adapterOptions || "{}");
        if (
          !options ||
          Array.isArray(options) ||
          typeof options !== "object" ||
          Object.keys(options).some(
            (k) =>
              ![
                "credentialMode",
                "userId",
                "quotaCurrency",
                "balanceMapping",
              ].includes(k),
          )
        )
          throw Error();
      } catch {
        d.querySelector("[role=alert]").textContent = "查询配置必须是有效 JSON";
        return;
      }
      const entries = [{name: String(values.name || "").trim(), key: String(values.apiKey || "").trim()}];
      const message = d.querySelector("[role=alert]");
      if (
        !entries.length ||
        entries.length !== 1 ||
        entries.some(
          (r) =>
            !r.name ||
            r.name.length > 80 ||
            (!c.id && !r.key) ||
            r.key.length > 4096 ||
            /[\s|]/.test(r.key),
        )
      ) {
        message.textContent = "每次只导入一个有效 API Key";
        return;
      }
      editor.busy = true;
      activeButtons(d, true);
      d.querySelectorAll("input,textarea,select").forEach(
        (el) => (el.disabled = true),
      );
      message.textContent = "";
      let added = 0,
        preferred,
        failedSync = 0;
      try {
        for (const entry of entries) {
          if (!current()) return;
          const result = await call(
            "POST",
            "/api/usage/connection",
            {
              ...options,
              id: c.id,
              kind,
              name: entry.name,
              apiKey: entry.key,
              apiUrl:
                (values.apiUrl===requestURL&&c.apiUrl?c.apiUrl:values.apiUrl) ||
                c.apiUrl ||
                {
                  deepseek: "https://api.deepseek.com",
                  glm: "https://open.bigmodel.cn/api/paas/v4",
                  lmu: "https://api.lmuai.ai",
                }[kind] ||
                preset?.url,
              supplierName: values.supplierName || c.supplierName,
              platformToken: values.platformToken || "",
              enabled: form.elements.enabled.checked,
            },
            { signal: editor.abort.signal },
          );
          if (!current()) return;
          preferred = result.connection.id;
          added++;
          if (
            result.connection.configured &&
            result.connection.enabled &&
            (kind !== "lmu" || result.connection.platformConfigured)
          ) {
            try {
              await syncConnection(preferred);
            } catch (_) {
              failedSync++;
            }
          }
        }
        if (!current()) return;
        await refreshManaged(state, preferred);
        if (current()) {
          if (kind === "custom" && preferred) {
            const saved = state.connections.find((r) => r.id === preferred);
            if (saved) state.supplierTab = supplierId(saved);
            state.managementKey = null;
          }
          d.close();
          paintSuppliers(state);
          toast(
            (c.id ? "已保存" : "已导入 " + added + " 个 APIKey") +
              (failedSync ? "；" + failedSync + " 个同步失败，请查看卡片" : ""),
            {kind:failedSync?"warning":"success"},
          );
        }
      } catch (error) {
        if (current()) {
          message.textContent =
            (added ? "已导入 " + added + " 个；" : "") + error.message;
          if (added) await refreshManaged(state, preferred);
        }
      } finally {
        editor.busy = false;
        if (current()) {
          activeButtons(d, false);
          d.querySelectorAll("input,textarea,select").forEach(
            (el) => (el.disabled = false),
          );
        }
      }
    };
    d.querySelector("[name=apiKey]")?.addEventListener("paste", ev => {const value=(ev.clipboardData?.getData("text") || "").trim();if(/[\r\n]/.test(value)){ev.preventDefault();d.querySelector("[role=alert]").textContent="每次只导入一个 API Key";}});
    d.querySelector("input,textarea")?.focus({ preventScroll: true });
    d.scrollIntoView({ block: "nearest" });
    return d;
  }
  function paintSuppliers(state) {
    const d = state.dialog;
    if (!managerActive(state)) return;
    const rows = state.connections.filter((c) => c.kind !== "codex"),
      groups = [
        ...new Map(
          [
            { id: "deepseek", name: "DeepSeek", kind: "deepseek" },
            { id: "glm", name: "GLM", kind: "glm" },
            { id: "lmu", name: "LMU", kind: "lmu" },
            ...Object.entries(window.usageProviders || {}).map(([kind, p]) => ({
              id: kind,
              name: p.name,
              kind,
            })),
            ...rows
              .filter((c) => c.kind === "custom")
              .map((c) => ({
                id: supplierId(c),
                name: c.supplierName || new URL(c.apiUrl).hostname,
                kind: "custom",
                row: c,
              })),
          ].map((g) => [g.id, g]),
        ).values(),
      ];
    if (!groups.some((g) => g.id === state.supplierTab))
      state.supplierTab = "deepseek";
    const key = JSON.stringify([rows, state.supplierTab]);
    if (state.managementKey === key) return;
    state.managementKey = key;
    const tabs = d.querySelector(".usage-supplier-tabs"),
      focusedTab = tabs.contains(document.activeElement)
        ? document.activeElement.dataset.supplierTab
        : null;
    tabs.innerHTML =
      groups
        .map(
          (g) =>
            `<button type="button" role="tab" class="btn ghost" aria-selected="${g.id === state.supplierTab}" tabindex="${g.id === state.supplierTab ? 0 : -1}" data-supplier-tab="${escape(g.id)}">${supplierIcon(g.kind)}${escape(g.name)}</button>`,
        )
        .join("") +
      '<button type="button" class="btn ghost" data-new-supplier aria-label="新增 API供应商">＋ 自定义供应商</button>';
    tabs.querySelectorAll("[data-supplier-tab]").forEach(
      (b) =>
        (b.onclick = () => {
          if (
            state.supplierTab !== b.dataset.supplierTab &&
            !closeKeyEditor(state)
          )
            return;
          state.supplierTab = b.dataset.supplierTab;
          paintSuppliers(state);
          const selected = d.querySelector("[aria-selected=true]");
          selected?.focus({ preventScroll: true });
        }),
    );
    tabs.querySelector("[data-new-supplier]").onclick = () =>
      editSupplierKey({ kind: "custom" }, state);
    if (focusedTab)
      [...tabs.querySelectorAll("[data-supplier-tab]")]
        .find((b) => b.dataset.supplierTab === focusedTab)
        ?.focus({ preventScroll: true });
    tabs.onkeydown = (ev) => {
      if (
        !ev.target.matches("[data-supplier-tab]") ||
        ![
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End",
        ].includes(ev.key)
      )
        return;
      ev.preventDefault();
      const list = [...tabs.querySelectorAll("[data-supplier-tab]")],
        i = list.indexOf(ev.target),
        next =
          list[
            ev.key === "Home"
              ? 0
              : ev.key === "End"
                ? list.length - 1
                : (i +
                    (["ArrowRight", "ArrowDown"].includes(ev.key)
                      ? 1
                      : list.length - 1)) %
                  list.length
          ];
      next.click();
    };
    const group = groups.find((g) => g.id === state.supplierTab),
      selected = rows.filter((c) => supplierId(c) === state.supplierTab),
      body = d.querySelector("[data-managed-accounts]");
    state.supplierOpen ??= new Set();
    const editor = state.editor,
      editingFocus = editor?.node.contains(document.activeElement)
        ? document.activeElement
        : null,
      scroll = body.scrollTop;
    editor?.node.remove();
    body.innerHTML =
      `<div class="dsh-provider-heading">${supplierIcon(group.kind)}<div><h2>${escape(group.name)}</h2><p>${selected.length} 个 Key · ${selected.filter(c=>c.enabled!==false).length} 个自动同步</p></div></div><div class="usage-supplier-tools">${group.kind === "lmu" ? '<button type="button" class="btn ghost" data-lmu-auth>授权 LMU</button>' : ""}</div>` +
      (selected.length ? "" : '<div class="supplier-empty"><strong>还没有 API Key</strong><span>添加一个 Key，查询这个供应商的余额或用量。</span></div>') + selected
        .map(
          (c) =>
            `<article class="usage-managed-key" data-account="${escape(c.id)}"><div class="dsh-key-head"><div class="dsh-key-identity"><strong>${escape(c.name)}</strong><small class="meta">${escape(c.apiKeyHint || c.maskedKey || (c.configured ? "已配置密钥" : "未配置"))}</small><span class="dsh-credential-dot ${c.configured ? "configured" : ""}" role="img" aria-label="${c.configured ? "密钥已配置" : "尚未配置密钥"}" title="${c.configured ? "密钥已配置" : "尚未配置密钥"}"></span></div><div class="dsh-key-actions"><button type="button" class="btn ghost" data-sync="${escape(c.id)}" ${!c.configured ? "disabled" : ""}>同步</button><details class="key-more" name="usage-key-more" data-action-menu><summary aria-label="Key 更多操作">更多</summary><div>${c.kind === "deepseek" ? `<button type="button" class="btn ghost" data-deepseek-auth="${escape(c.id)}">一键获取历史用量</button>` : ""}<button type="button" class="btn ghost" data-edit="${escape(c.id)}">编辑</button><button type="button" class="btn ghost danger" data-remove="${escape(c.id)}">移除</button></div></details></div></div><span class="usage-key-status ${c.error ? "error" : ""}">${c.enabled === false ? "自动同步已暂停 · " : ""}${c.error ? "同步失败" : c.snapshot?.historyAvailable ? "已连接历史" : c.snapshot?.adapter ? "已查询余额／额度" : "尚未同步"}</span>${c.error || c.snapshot?.unavailable?.history ? `<p class="account-error">${escape(c.error || c.snapshot.unavailable.history)}</p>` : ""}<details class="usage-key-details" data-key-detail="${escape(c.id)}" ${state.supplierOpen.has(c.id) ? "open" : ""}><summary>用量详情</summary><div class="usage-managed-key-body"><p class="meta">${c.snapshot?.historyCount ? number(c.snapshot.historyCount) + " 条用量记录 · " : ""}${time(c.lastSuccessAt)}</p></div></details></article>`,
        )
        .join("") +
      '<button type="button" class="dsh-key-add-card" data-add-key><span aria-hidden="true">＋</span> 添加 API Key</button>';
    if (editor) {
      const card = [...body.querySelectorAll("[data-account]")].find(
        (el) => el.dataset.account === editor.id,
      );
      (card || body).insertBefore(
        editor.node,
        card ? null : body.querySelector(":scope > [data-add-key]"),
      );
      editingFocus?.focus({ preventScroll: true });
    }
    body.scrollTop = scroll;
    if (group.kind === "lmu")
      body.querySelector("[data-lmu-auth]").onclick = () => {
        if (closeKeyEditor(state)) authorizeLMU(state);
      };
    body.querySelector("[data-add-key]").onclick = () =>
      editSupplierKey(
        { ...group.row, id: undefined, name: "", kind: group.kind },
        state,
      );
    body.querySelectorAll("[data-key-detail]").forEach((el) =>
      el.addEventListener("toggle", () => {
        if (el.open) state.supplierOpen.add(el.dataset.keyDetail);
        else state.supplierOpen.delete(el.dataset.keyDetail);
      }),
    );
    body.querySelectorAll("[data-deepseek-auth]").forEach(button=>button.onclick=()=>authorizeDeepseek(state,button.dataset.deepseekAuth,button.closest('[data-account]')?.querySelector('strong')?.textContent));
    body.querySelectorAll("[data-edit]").forEach(
      (b) =>
        (b.onclick = () =>
          editSupplierKey(
            rows.find((c) => c.id === b.dataset.edit),
            state,
          )),
    );
    body.querySelectorAll("[data-sync]").forEach(
      (b) =>
        (b.onclick = async () => {
          if (!closeKeyEditor(state)) return;
          b.disabled = true;
          try {
            await syncConnection(b.dataset.sync);
            if (managerActive(state)) await refreshManaged(state);
          } catch (error) {
            if (managerActive(state)) toast(error.message, {kind:"error"});
          } finally {
            if (b.isConnected) b.disabled = false;
          }
        }),
    );
    body.querySelectorAll("[data-remove]").forEach(
      (b) =>
        (b.onclick = async () => {
          if (
            !closeKeyEditor(state) ||
            !confirm("移除此 APIKey 及其连接配置？")
          )
            return;
          b.disabled = true;
          try {
            await call("POST", "/api/usage/connection", {
              id: b.dataset.remove,
              delete: true,
            });
            if (!managerActive(state)) return;
            state.supplierOpen.delete(b.dataset.remove);
            await refreshManaged(state);
          } catch (error) {
            if (managerActive(state)) toast(error.message, {kind:"error"});
            if (b.isConnected) b.disabled = false;
          }
        }),
    );
  }
  function manageSuppliers(state) {
    const d = document.createElement("dialog");
    d.className = "control-dialog lingxi-dialog wb-redesign usage-supplier-manager";
    d.setAttribute("aria-label", "管理 API供应商");
    d.innerHTML =
      '<header class="control-dialog-head"><div class="dialog-brand-title"><img class="lingxi-window-logo" src="assets/lingxi-logo.svg" alt="灵犀"><h2>管理 API 供应商</h2></div><button type="button" class="btn ghost lingxi-dialog-close" data-close data-manager-close aria-label="关闭 API供应商管理">×</button></header><aside class="usage-supplier-navigation"><div class="usage-supplier-tabs" role="tablist" aria-label="API供应商"></div></aside><div data-managed-accounts></div>';
    document.body.append(d);
    state.dialog = d;
    state.managerOwner = user.username;
    state.supplierTab =
      state.root.closest(".usage-stable").querySelector("#usage-account")
        ?.value || "deepseek";
    state.managementKey = null;
    const close = () => {
      if (closeKeyEditor(state)) d.close();
    };
    d.querySelector("[data-manager-close]").onclick = close;
    d.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (state.editor) closeKeyEditor(state);
      else close();
    });
    const identityChanged = () => {
      if (user?.username !== state.managerOwner) {
        closeKeyEditor(state, true);
        d.close();
      }
    };
    window.addEventListener("workbench:state", identityChanged);
    const observer = new MutationObserver(() => {
      if (!state.root.isConnected) {
        closeKeyEditor(state, true);
        d.close();
      }
    });
    observer.observe(document.querySelector("#main"), {
      childList: true,
      subtree: true,
    });
    const focus = document.activeElement;
    d.addEventListener("close", () => {
      observer.disconnect();
      window.removeEventListener("workbench:state", identityChanged);
      closeKeyEditor(state, true);
      state.dialog = null;
      state.managerOwner = null;
      state.managementKey = null;
      d.remove();
      if (focus?.isConnected) focus.focus({ preventScroll: true });
    });
    paintSuppliers(state);
    d.showModal();
    return d;
  }
  function manage(root) {
    root = root || document.querySelector("#usage-accounts");
    const state = root && accountStates.get(root);
    if (!state) return null;
    if (state.dialog?.isConnected) {
      if (!state.dialog.open) state.dialog.showModal();
      return state.dialog;
    }
    return manageSuppliers(state);
  }
  async function onboardingSuppliers(host) {
    host.innerHTML =
      '<div class="usage-stable"><button id="usage-account-add" type="button">管理供应商</button><select id="usage-account"><option value="deepseek">DeepSeek</option></select><div data-onboarding-accounts></div></div>';
    const root = host.querySelector("[data-onboarding-accounts]"),
      refresh = () => render(root, "codex", [], refresh);
    await refresh();
    return manage(root);
  }
  async function authorizeDeepseek(state,id,label){
    if(!managerActive(state))return;
    const card=[...state.dialog.querySelectorAll('[data-account]')].find(node=>node.dataset.account===id);if(!card)return;
    let host=card.querySelector('[data-authorization-inline]');if(host?.dataset.busy==='true')return;
    if(!host){host=document.createElement('div');host.dataset.authorizationInline='';host.className='dsh-authorization-inline';card.append(host);}
    host.innerHTML='<p data-authorization-status role="status">正在准备…</p><button type="button" class="btn ghost" data-authorization-cancel>取消</button>';host.dataset.busy='true';
    const status=host.querySelector('[role=status]');let timer=null,taskId=null,finished=false;
    const valid=()=>managerActive(state)&&host.isConnected;
    const cancel=async()=>{if(finished)return;finished=true;clearTimeout(timer);try{if(taskId)await call('POST','/api/deepseek/authorization/cancel',{});}catch{}if(valid()){host.dataset.busy='false';status.textContent='已取消';host.querySelector('button').hidden=true;}};
    host.querySelector('button').onclick=cancel;
    const release=()=>{clearTimeout(timer);if(!finished)void cancel();};state.dialog.addEventListener('close',release,{once:true});
    try{
      const task=window.workbenchDesktop?.deepseekAuthorize?await window.workbenchDesktop.deepseekAuthorize(id):await call('POST','/api/deepseek/authorization/start',{connectionId:id});taskId=task.id;
      const poll=async()=>{if(finished)return;if(!valid()){await cancel();return;}
        try{const task=await call('GET','/api/deepseek/authorization/status');if(task.id!==taskId||task.connectionId!==id)throw Error('授权任务已变更');
          status.textContent=task.status==='waiting'?'请在官方临时窗口登录':task.status==='syncing'?'正在读取历史用量…':task.error||'授权已结束';
          if(task.status==='complete'){finished=true;host.dataset.busy='false';await refreshManaged(state);toast('DeepSeek 历史用量已同步',{kind:'success'});return;}
          if(['failed','cancelled'].includes(task.status)){finished=true;host.dataset.busy='false';host.querySelector('button').hidden=true;return;}timer=setTimeout(poll,700);
        }catch(error){finished=true;if(valid()){host.dataset.busy='false';status.textContent=error.message;host.querySelector('button').hidden=true;}}
      };await poll();
    }catch(error){finished=true;if(valid()){host.dataset.busy='false';status.textContent=error.message;host.querySelector('button').hidden=true;}}
  }
  window.usageAccounts = {
    render,
    manage,
    quotaTone,
    quotaPreview: quotaRow,
    onboardingSuppliers,
    scope: (root) => {
      const state = accountStates.get(root);
      if (state) patchInline(state);
    },
  };
})();
