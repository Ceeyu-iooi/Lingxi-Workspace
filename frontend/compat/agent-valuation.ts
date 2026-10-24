// @ts-nocheck
// Compatibility controller: retain the validated interactions during the React migration.
/* Account-specific preparation barrier; all ordinary filtering stays local. */
(() => {
  const U = window.WorkbenchUI,
    names = { codex: "Codex" },
    states = new WeakMap();
  let modal = null;
  const signalFeatures = (features) =>
    window.dispatchEvent(
      new CustomEvent("workbench:features", { detail: features }),
    );
  const retryTask = (scope, task) => U.request("POST", task.background ? "/api/valuation/refresh" : "/api/valuation/prepare", { scope });
  async function preparation(scope, task) {
    if (modal) return modal.promise;
    const focus=document.activeElement;
    const d = U.el("dialog", {
      class: "valuation-modal lingxi-dialog",
      "data-dialog-size":"small",
      "aria-label": "准备 API 参考等价值",
    });
    d._skipMotion=true;
    d.innerHTML =
      '<div class="valuation-wait"><button type="button" class="lingxi-dialog-close btn ghost valuation-close" data-dismiss aria-label="取消计价准备并关闭">×</button><div data-loader></div><div class="valuation-progress" data-progress></div><p data-error class="wb-inline-error" role="alert" hidden></p><div class="control-actions"><button type="button" class="btn" data-retry hidden>重试</button><button type="button" class="btn ghost" data-cancel hidden>取消并关闭计价</button></div></div>';
    document.body.append(d);
    d.showModal();
    d.querySelector("[data-dismiss]").onclick=()=>d.querySelector("[data-cancel]").click();
    document.documentElement.dataset.valuationBusy = "true";
    const dispose = window.WorkbenchReact.loader(
      d.querySelector("[data-loader]"),
      "",
    );
    const disposeProgress = window.WorkbenchReact.progress(
      d.querySelector("[data-progress]"),
      0,
    );
    const blocked = (event) => {
      if (!d.open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        d.querySelector("[data-cancel]").click();
        return;
      }
      if (
        !d.contains(event.target) ||
        event.key === "Escape" ||
        ((event.ctrlKey || event.metaKey) && event.key !== "a")
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener("keydown", blocked, true);
    d.addEventListener("cancel", (event) => event.preventDefault());
    let settled = false,
      closeFailed = false,
      resolve,
      timer,
      pollToken = 0;
    const promise = new Promise((r) => (resolve = r));
    modal = { d, promise };
    const close = async (success) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      dispose();
      disposeProgress();
      document.removeEventListener("keydown", blocked, true);
      delete document.documentElement.dataset.valuationBusy;
      d.addEventListener("close",()=>d.remove(),{once:true});
      d.close();
      if(focus?.isConnected)focus.focus({preventScroll:true});
      modal = null;
      try {
        signalFeatures(await U.request("GET", "/api/features"));
      } catch {}
      resolve(success);
    };
    d.querySelector("[data-cancel]").onclick = async () => {
      const b = d.querySelector("[data-cancel]");
      b.disabled = true;
      try {
        const r = await U.request("POST", "/api/valuation/disable", { scope });
        signalFeatures(r.features);
        await close(false);
      } catch (error) {
        closeFailed=true;
        d.querySelector("[data-error]").textContent = error.message+"；取消尚未确认，关闭窗口后后台任务可能继续。";
        d.querySelector("[data-error]").hidden=false;
        let exit=d.querySelector('[data-return]');
        if(!exit){exit=document.createElement('button');exit.type='button';exit.className='btn ghost';exit.dataset.return='';exit.textContent='关闭窗口';exit.onclick=()=>close(false);d.querySelector('.control-actions').append(exit);}
        b.disabled = false;
        b.hidden=false;
      }
    };
    const poll = async () => {
      if (settled) return;
      const token = ++pollToken;
      try {
        const t = await U.request(
          "GET",
          "/api/valuation/status?scope=" + scope,
        );
        if (settled || token !== pollToken) return;
        if (t.status === "running" && !closeFailed) {
          d.querySelector("[data-error]").hidden = true;
          d.querySelector("[data-retry]").hidden = true;
          d.querySelector("[data-cancel]").hidden = true;
        }
        const bands = {
            usage: [0, 20],
            prices: [20, 70],
            fx: [70, 80],
            valuation: [80, 99],
            ready: [100, 100],
          },
          band = bands[t.phase] || [0, 0],
          fraction = t.total
            ? Math.max(0, Math.min(1, t.completed / t.total))
            : 0;
        window.WorkbenchReact.progress(
          d.querySelector("[data-progress]"),
          Math.round(band[0] + (band[1] - band[0]) * fraction),
        );
        if (t.status === "complete") {
          await close(true);
          return;
        }
        if (t.status === "cancelled") {
          await close(false);
          return;
        }
        if (t.status === "failed") throw new Error(t.error);
        timer = setTimeout(poll, 500);
      } catch (error) {
        if (settled || token !== pollToken) return;
        d.querySelector("[data-error]").textContent = error.message;
        d.querySelector("[data-retry]").hidden = false;
        d.querySelector("[data-error]").hidden = false;
        d.querySelector("[data-cancel]").hidden = false;
        timer = setTimeout(poll, 1500);
      }
    };
    d.querySelector("[data-retry]").onclick = async () => {
      clearTimeout(timer);
      pollToken++;
      const b = d.querySelector("[data-retry]");
      b.disabled = true;
      try {
        task = await retryTask(scope, task);
        d.querySelector("[data-error]").textContent = "";
        d.querySelector("[data-error]").hidden = true;
        d.querySelector("[data-cancel]").hidden = true;
        b.hidden = true;
        await poll();
      } catch (error) {
        d.querySelector("[data-error]").textContent = error.message;
        d.querySelector("[data-error]").hidden = false;
        d.querySelector("[data-cancel]").hidden = false;
        b.hidden = false;
      } finally {
        b.disabled = false;
      }
    };
    poll();
    return promise;
  }
  async function toggle(scope, enabled) {
    if (enabled) {
      const r = await U.request("POST", "/api/valuation/disable", { scope });
      signalFeatures(r.features);
      return;
    }
    const task = await U.request("POST", "/api/valuation/prepare", { scope });
    if(task.status === "complete"){signalFeatures(await U.request("GET","/api/features"));return true;}
    return preparation(scope, task);
  }
  function update(root, snapshot) {
    const scope = root.dataset.usageScope;
    if (!names[scope]) {
      root.querySelector(".agent-value-panel")?.remove();
      return;
    }
    let state = states.get(root);
    if (!state) {
      state = { ticket: 0, scope: null };
      states.set(root, state);
    }
    const compatible = window.workbenchRuntime?.version === U.version;
    const enabled = compatible && snapshot.pricing?.available === true;
    let panel = root.querySelector(".agent-value-panel");
    if (!panel) {
      panel = U.el("section", { class: "agent-value-panel" });
      panel.innerHTML =
        '<header><h3></h3><div class="agent-value-commit"><span data-enabled></span><div data-slide></div></div></header><div class="agent-value-line"><div class="agent-value-amounts"><span class="agent-value-usd">USD <strong>--</strong></span><span class="agent-value-cny">CNY <strong>--</strong></span></div><a href="prices.html" target="_blank" rel="noopener" class="agent-value-source">查看价格与汇率 <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14 4h6v6M20 4 10 14M20 14v6H4V4h6" stroke="currentColor" stroke-width="1.6"/></svg></a></div>';
      root.querySelector(".usage-summary").after(panel);
      panel
        .querySelectorAll("[data-currency]")
        .forEach(
          (b) =>
            (b.onclick = () =>
              root.dispatchEvent(
                new CustomEvent("usage-value-currency", {
                  bubbles: true,
                  detail: b.dataset.currency,
                }),
              )),
        );
    }
    panel.dataset.scope = scope;
    if (!panel.querySelector('[data-value-refresh]')) {
      const refresh = U.el('button', {type:'button',class:'btn ghost valuation-refresh','data-value-refresh':'','aria-label':'更新价格并增量计算',title:'更新价格并增量计算'}, '↻');
      panel.querySelector('[data-slide]').before(refresh);
      refresh.onclick = async () => {
        refresh.disabled=true;
        try { const task=await U.request('POST','/api/valuation/refresh',{scope}); if(task.status!=='complete')await preparation(scope,task); panel.querySelector('[data-preparation-error]')?.remove(); signalFeatures(await U.request('GET','/api/features')); }
        catch(error){U.notify(error.message,{kind:'error'});} finally {if(refresh.isConnected)refresh.disabled=false;}
      };
    }
    panel.querySelector("h3").textContent =
      scope === "codex"
        ? "API 基准估算"
        : names[scope] + " · API 参考等价值";
    if(!panel.querySelector('[data-value-assumptions]')){const note=U.el('p',{class:'wb-muted valuation-assumptions','data-value-assumptions':''},'全球标准文本档基准；未报告缓存写入时按0估算，不含工具附加费，非真实账单。');panel.append(note);}
    const quotaHeading = root.querySelector(".usage-account-heading");
    if (scope === "codex" && quotaHeading) {
      quotaHeading.querySelector("h3").hidden = false;
      const target=root.querySelector("[data-codex-value]");
      if(target&&panel.parentElement!==target)target.replaceChildren(panel);
    } else if (panel.parentElement !== root) {
      root.querySelector(".usage-summary").after(panel);
    }
    panel.querySelector("[data-enabled]").textContent = !compatible
      ? "等待后台更新"
      : enabled
        ? "已开启"
        : "未开启";
    const autoHost=panel.querySelector('[data-slide]');
    if(!autoHost.querySelector('[data-price-auto]')){
      const button=U.el('button',{type:'button',class:'btn ghost valuation-auto','data-price-auto':'','aria-pressed':'false'},'自动更新（每天）');
      autoHost.replaceChildren(button);
      button.onclick=async()=>{
        if(state.autoPending)return;state.autoPending=true;button.disabled=true;
        try{
          const current=await U.request('GET','/api/pricing/auto-update');
          const updated=await U.request('POST','/api/pricing/auto-update',{enabled:!current.enabled});
          button.setAttribute('aria-pressed',String(updated.enabled));button.title=(updated.enabled?'已开启；':'已暂停；')+updated.notice;
          U.notify(updated.enabled?'已开启每日自动更新，当前缓存继续显示':'已暂停每日自动更新，价格缓存保留',{kind:'success'});
        }catch(error){U.notify(error.message,{kind:'error'});}finally{state.autoPending=false;if(button.isConnected)button.disabled=!compatible;}
      };
    }
    if(!state.autoPending){const b=autoHost.querySelector('[data-price-auto]'),active=snapshot.pricing?.autoUpdate===true;b.setAttribute('aria-pressed',String(active));b.title=(active?'已开启；':'已暂停；')+'应用运行时按上海日期每天更新一次；关闭后下次启动补查。';}
    autoHost.querySelector('button').disabled=!compatible||!!state.autoPending;
    const ticket = ++state.ticket;
    state.abort?.abort();
    state.abort = new AbortController();
    const paint = (values) => {
      if (ticket !== state.ticket || !panel.isConnected) return;
      for (const currency of ["USD", "CNY"]) {
        const v = values[currency],
          summary = v?.summary;
        panel.querySelector(
          ".agent-value-" + currency.toLowerCase() + " strong",
        ).textContent =
          enabled && summary?.pricedRequests > 0
            ? Number(summary.costs[currency]).toLocaleString("zh-CN", {
                minimumFractionDigits: 2,
                maximumFractionDigits: Math.abs(Number(summary.costs[currency]))>0&&Math.abs(Number(summary.costs[currency]))<.0001?12:4,
              })
            : "--";
      }
      const v = values.USD || values.CNY;
      panel.querySelector(".agent-value-amounts").title =
        enabled && v
          ? "可估算 " +
            v.summary.pricedRequests +
            " / " +
            v.summary.requests +
            " 条；原供应商全球标准文本档。未报告的缓存写入按0估算，不含工具附加费；缺价未计入，非真实账单。"
          : "";
    };
    if(enabled){
      const params=new URLSearchParams();Object.entries(snapshot.query||{}).forEach(([k,v])=>{if(Array.isArray(v))v.forEach(x=>params.append(k,x));else if(v!==undefined)params.set(k,v);});params.set('scope',scope);
      U.request('GET','/api/valuation/summary?'+params,undefined,{signal:state.abort.signal}).then(result=>paint(result.values||{})).catch(()=>{});
    }else paint({});
    if (compatible && !state.resumed) {
      state.resumed = true;
      Promise.all(
        ["codex"].map((x) =>
          U.request("GET", "/api/valuation/status?scope=" + x),
        ),
      )
        .then((tasks) => {
          const t =
            tasks.find((t) => t.status === "running" && !t.background);
          if (t) preparation(t.scope, t);
          const failed=tasks.find(t=>t.scope===scope&&t.status==='failed');
          if(failed&&panel.isConnected){
            let error=panel.querySelector('[data-preparation-error]');
            if(!error){error=U.el('p',{class:'wb-inline-error',role:'alert','data-preparation-error':''});panel.append(error);}
            error.textContent=failed.error||'计价准备失败，请重试';
            const retry=U.el('button',{type:'button',class:'btn ghost'},'重试');
            retry.onclick=async()=>{retry.disabled=true;try{const task=await retryTask(scope,failed);if(task.status!=='complete')await preparation(scope,task);error.remove();signalFeatures(await U.request('GET','/api/features'));}catch(e){U.notify(e.message,{kind:'error'});}finally{if(retry.isConnected)retry.disabled=false;}};
            error.append(retry);
          }
        })
        .catch(() => {});
    }
  }
  window.AgentValuation = { update, toggle, preparation };
})();
