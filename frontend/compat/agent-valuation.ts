// @ts-nocheck
// Compatibility controller: retain the validated interactions during the React migration.
/* Account-specific preparation barrier; all ordinary filtering stays local. */
(() => {
  const U = window.WorkbenchUI,
    names = { codex: "Codex", zcode: "ZCode", dsh: "DeepSeek Harness" },
    states = new WeakMap();
  let modal = null;
  const signalFeatures = (features) =>
    window.dispatchEvent(
      new CustomEvent("workbench:features", { detail: features }),
    );
  async function preparation(scope, task) {
    if (modal) return modal.promise;
    const d = U.el("dialog", {
      class: "valuation-modal",
      "aria-label": "准备 API 参考等价值",
    });
    d.innerHTML =
      '<div class="valuation-wait"><div data-loader></div><div class="valuation-progress" data-progress></div><p data-error class="wb-inline-error" role="alert" hidden></p><div class="control-actions"><button type="button" class="btn" data-retry hidden>重试</button><button type="button" class="btn ghost" data-cancel hidden>取消并关闭计价</button></div></div>';
    document.body.append(d);
    d.showModal();
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
      d.close();
      d.remove();
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
        d.querySelector("[data-error]").textContent = error.message;
        b.disabled = false;
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
        if (t.status === "running") {
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
        await U.request("POST", "/api/valuation/prepare", { scope });
        d.querySelector("[data-error]").textContent = "";
        d.querySelector("[data-error]").hidden = true;
        d.querySelector("[data-cancel]").hidden = true;
        b.hidden = true;
        await poll();
      } catch (error) {
        d.querySelector("[data-error]").textContent = error.message;
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
    const enabled = compatible && snapshot.pricing?.enabled === true;
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
    panel.querySelector("h3").textContent =
      scope === "codex"
        ? "API等效参考价值"
        : names[scope] + " · API 参考等价值";
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
    if (
      state.scope !== scope ||
      state.enabled !== enabled ||
      state.compatible !== compatible
    ) {
      state.scope = scope;
      state.enabled = enabled;
      state.compatible = compatible;
      window.WorkbenchReact.slideCommit(panel.querySelector("[data-slide]"), {
        enabled,
        compact: scope === "codex",
        disabled: !compatible,
        onConfirm: () => toggle(scope, enabled),
      });
    }
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
          ? "已核验 " +
            v.summary.pricedRequests +
            " / " +
            v.summary.requests +
            " 条；价格缺口保持未知，金额仅包含已核验部分。"
          : "";
    };
    if(enabled){
      const params=new URLSearchParams();Object.entries(snapshot.query||{}).forEach(([k,v])=>{if(Array.isArray(v))v.forEach(x=>params.append(k,x));else if(v!==undefined)params.set(k,v);});params.set('scope',scope);
      U.request('GET','/api/valuation/summary?'+params,undefined,{signal:state.abort.signal}).then(result=>paint(result.values||{})).catch(()=>{});
    }else paint({});
    if (compatible && !state.resumed) {
      state.resumed = true;
      Promise.all(
        ["codex", "zcode", "dsh"].map((x) =>
          U.request("GET", "/api/valuation/status?scope=" + x),
        ),
      )
        .then((tasks) => {
          const t =
            tasks.find((t) => t.status === "running") ||
            tasks.find((t) => t.scope === scope && t.status === "failed");
          if (t) preparation(t.scope, t);
        })
        .catch(() => {});
    }
  }
  window.AgentValuation = { update, toggle, preparation };
})();
