import { formatCount, formatRate } from "../../src/shared/session-usage";
// @ts-nocheck
// Compatibility controller: retain the validated interactions during the React migration.
(() => {
  const states = new WeakMap(),
    counters = new WeakMap();
  const agentScope = (scope) => ["codex", "zcode", "dsh"].includes(scope);
  const e = (s) =>
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
  const q = (s, r) => r.querySelector(s),
    all = (s, r) => [...r.querySelectorAll(s)];
  const dateFormat = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
    }),
    timestampFormat = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hour12: false,
    });
  const fmt = (n) => window.usageCharts.format(n),
    full = (n) => window.usageCharts.full(n);
  const quiet = () =>
    document.documentElement.dataset.motion === "reduced" ||
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  const money = (n, currency) => window.usageCharts.money(n, currency);
  const costRows = (
    rows,
    available = true,
    currency = "CNY",
    partial = false,
  ) =>
    rows.map((r) => ({
      ...r,
      total: !available
        ? null
        : r.costUnknown && !(partial && r.requests > r.costUnknown)
          ? null
          : (r.costs?.[currency] ?? (r.requests === 0 ? 0 : null)),
      unknown: !available ? 1 : r.costUnknown || 0,
      provided: available && !r.costUnknown,
      cumulativeTotal: available ? r.cumulativeCost : null,
      cumulativeUnknown: available ? r.cumulativeCostUnknown : 1,
      models: (r.models || []).map((m) => ({
        ...m,
        total:
          m.costUnknown && !(partial && m.requests > m.costUnknown)
            ? null
            : (m.costs?.[currency] ?? 0),
      })),
    }));
  /**
   * Priced ledger for the current scope. Every local source (dsh/zcode) now carries
   * official prices, so the cost views must not be limited to codex any more. When the
   * payload has no explicit `costAvailable` flag, "there is at least one priced row"
   * is the honest reading: unpriced rows still count as unknown, never as zero.
   */
  const valueSnapshot = (state) => {
    if(state.scope==='api')return state.snapshot;
    const ledger=state.snapshot.valuation;
    if(ledger){
      if(ledger.costAvailable!==undefined)return ledger;
      return {...ledger,costAvailable:(Number(ledger.summary&&ledger.summary.pricedRequests)||0)>0};
    }
    if(state.scope!=='codex')return null;
    const unknown=rows=>(rows||[]).map(row=>({...row,costUnknown:row.requests||1,pricedRequests:0,cost:null,costs:{CNY:null,USD:null}}));
    return {...state.snapshot,costCurrency:'CNY',cachedAvailable:false,activity:unknown(state.snapshot.activity),daily:unknown(state.snapshot.daily),groups:unknown(state.snapshot.groups),events:unknown(state.snapshot.events)};
  };
  const chartIcon = (mode) =>
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 3v17h17" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>' +
    (mode === "bar"
      ? '<path d="M8 16V9m5 7V5m5 11v-4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>'
      : '<path d="m6 15 4-6 4 3 6-7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>') +
    "</svg>";
  const heatStops = [
    [0, [250, 250, 250]],
    [0.25, [199, 193, 251]],
    [0.5, [149, 135, 252]],
    [0.75, [98, 78, 253]],
    [1, [31, 1, 254]],
  ];
  function number(el, value, raw = false, suffix = "", replay = false) {
    if (!el) return;
    const previous=counters.get(el), signature=JSON.stringify([value,raw,suffix,el.dataset.currency]);
    if(!replay&&previous===signature)return;
    counters.set(el,signature);
    el.dataset.value=Number.isFinite(value)?String(value):"";
    const format=v=>(Number.isFinite(v)?raw==="money"?money(v,el.dataset.currency):raw?full(Math.round(v)):fmt(Math.round(v)):"—")+suffix;
    if(raw)el.style.setProperty("--number-chars",String(format(value).length));
    animateCount(el,Number.isFinite(value)?value:null,format,replay,quiet());
  }

  function options(select, values, first = "全部") {
    const current = select.value,
      signature = JSON.stringify([first, values]);
    if (select.dataset.optionsKey !== signature) {
      select.innerHTML =
        `<option value="">${first}</option>` +
        values
          .map(
            (x) =>
              `<option value="${e(x)}">${e({ official: "官方账户汇总", codex: "本机日志", zcode: "ZCode 日志", dsh: "Harness 日志" }[x] || x)}</option>`,
          )
          .join("");
      select.dataset.optionsKey = signature;
    }
    select.value = values.includes(current) ? current : "";
  }
  function tableShell(index) {
    const headers = index
      ? ["时间", "Agent", "实际模型 / 请求模型", "Token", "状态", "耗时"]
      : [
          "最新日期",
          "来源 / Agent",
          "服务商 / 模型",
          "输入",
          "输出",
          "缓存",
          "推理",
          "Token",
          "请求 / 失败",
        ];
    return `<section class="control-section usage-table-panel" data-usage-table><h3>${index ? "最近请求" : "来源与模型明细"}</h3><div class="usage-table-tools"><span data-table-count></span></div><div class="control-table-wrap"><table class="control-table"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody></tbody></table></div></section>`;
  }
  function init(root) {
    if (states.has(root)) return states.get(root);
    root.innerHTML = `<div class="usage-lifetime">${["累计 Token", "单日峰值 Token", "当前连续", "最长连续"].map((label, i) => `<div><strong data-lifetime="${i}">—</strong><span class="usage-lifetime-caption">${label}</span></div>`).join("")}</div><div class="usage-summary">${["范围内已知 Token", "输入（含缓存）", "输出（含推理）", "缓存命中", "请求数"].map((label, i) => `<div><span>${label}</span><strong data-summary="${i}">—</strong><small class="usage-unit"></small></div>`).join("")}</div><section class="control-section usage-activity"><div class="section-title"><h3>Token 活动</h3><div class="usage-heat-modes" role="group" aria-label="活动统计方式">${[
      ["day", "每日"],
      ["week", "每周"],
      ["total", "累计"],
    ]
      .map(
        ([m, t]) =>
          `<button class="btn ghost" data-heat-mode="${m}" aria-pressed="${m === "day"}">${t}</button>`,
      )
      .join(
        "",
      )}</div></div><div class="usage-heat-months"></div><div class="usage-heatmap"></div><div class="usage-axis"><span data-heat-start></span><span class="usage-heat-legend" aria-label="Token 活动颜色：从少到多">少 <i class="usage-heat-gradient" aria-hidden="true"></i> 多</span><span data-heat-end></span></div></section><div class="usage-charts"><section class="control-section"><div class="section-title usage-chart-heading"><button class="btn ghost usage-chart-mode" data-chart-mode="line" aria-label="切换为柱状图" title="切换为柱状图" aria-pressed="false">${chartIcon("line")}</button><h3>每日 Token 趋势</h3></div>${window.usageCharts.trend([])}<div class="usage-axis"><span data-trend-start></span><span data-trend-peak></span><span data-trend-end></span></div></section><section class="control-section"><h3>模型用量占比</h3><div class="usage-pie-layout usage-interactive-pie" data-models="[]"><div class="usage-donut interactive"><svg viewBox="0 0 200 200" role="group" aria-label="模型 Token 占比"></svg><strong>—</strong></div><div class="usage-legend"></div><div class="usage-pie-empty">暂无模型用量</div></div></section></div>${tableShell(0)}${sessionShell()}${tableShell(1)}<div class="usage-updated"></div>`;
    const toolbar = root.parentElement.querySelector(".usage-toolbar");
    if (toolbar) q(".usage-lifetime", root).after(toolbar);
    const accountSlot = root.parentElement.querySelector(".usage-account-slot");
    if (accountSlot) q(".usage-summary", root).after(accountSlot);
    const state = {
      snapshot: null,
      heat: "day",
      mode: "line",
      metrics: { heat: false, charts: false },
      signatures: {},
      heatAnimations: new Set(),
      heatTimers: new Set(),
    };
    states.set(root, state);
    const valueCard = q('[data-lifetime="3"]', root).parentElement,
      tools = document.createElement("div");
    tools.className = "usage-value-tools";
    tools.hidden = true;
    tools.innerHTML =
      '<button type="button" class="btn ghost" data-value-currency="USD">$</button><button type="button" class="btn ghost" data-value-currency="CNY">￥</button><button type="button" class="btn ghost" data-value-details>计算依据</button>';
    valueCard.append(tools);
    const coverage = document.createElement("div");
    coverage.className = "usage-value-coverage";
    coverage.hidden = true;
    valueCard.append(coverage);
    all("[data-value-currency]", tools).forEach(
      (b) =>
        (b.onclick = () =>
          root.dispatchEvent(
            new CustomEvent("usage-value-currency", {
              bubbles: true,
              detail: b.dataset.valueCurrency,
            }),
          )),
    );
    q("[data-value-details]", tools).onclick = () => valueDetails(root, state);
    const summaryCard = q('[data-summary="4"]', root).parentElement,
      finance = document.createElement("div");
    finance.className = "usage-account-finance";
    finance.hidden = true;
    finance.innerHTML =
      '<div><span>账户余额</span><strong data-finance="balance">—</strong></div><div><span>账户累计消费</span><strong data-finance="spent">—</strong></div>';
    summaryCard.append(finance);
    all("[data-heat-mode]", root).forEach(
      (b) =>
        (b.onclick = () => {
          if (state.heat === b.dataset.heatMode) return;
          state.heat = b.dataset.heatMode;
          heat(root, state, true);
        }),
    );
    q("[data-chart-mode]", root).onclick = () => {
      state.mode = state.mode === "line" ? "bar" : "line";
      charts(root, state);
    };
    const heading = q(".usage-chart-heading", root);
    const pieHeading = q(".usage-charts", root).children[1];
    const pieTitle = q("h3", pieHeading),
      pieTools = document.createElement("div");
    pieTools.className = "section-title usage-pie-heading";
    pieTitle.before(pieTools);
    pieTools.append(pieTitle);
    const chartTools = document.createElement("div");
    chartTools.className = "usage-chart-tools";
    chartTools.setAttribute("role", "group");
    chartTools.setAttribute("aria-label", "图表显示");
    chartTools.append(q("[data-chart-mode]", root));
    heading.append(chartTools);
    [
      ["heat", q(".usage-heat-modes", root)],
      ["charts", chartTools],
    ].forEach(([key, target]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn ghost usage-money-toggle";
      b.textContent = "￥";
      b.dataset.metric = key;
      b.hidden = true;
      b.setAttribute("aria-label", "切换费用显示");
      b.title = "切换费用显示";
      b.setAttribute("aria-pressed", "false");
      if (key === "heat") target.prepend(b);
      else target.append(b);
      b.onclick = () => {
        const selected =
          key === "heat" ? !state.metrics.heat : !state.metrics.charts;
        if (key === "heat") state.metrics.heat = selected;
        else state.metrics.charts = selected;
        b.setAttribute("aria-pressed", String(selected));
        b.setAttribute(
          "aria-label",
          selected ? "切换 Token 显示" : "切换费用显示",
        );
        b.title = b.getAttribute("aria-label");
        if (key === "heat") heat(root, state, true);
        else charts(root, state);
      };
    });
    q(".usage-charts", root).dataset.pieHidden = "false";
    all("[data-usage-table]", root).forEach((section, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn ghost usage-money-toggle";
      b.dataset.tableMoney = String(i);
      b.hidden = true;
      b.setAttribute("aria-pressed", "false");
      b.setAttribute("aria-label", "切换 API 等价值");
      if (i === 0) q(".usage-table-tools", section).append(b);
      b.onclick = () => {
        state.metrics["table" + i] = !state.metrics["table" + i];
        b.setAttribute("aria-pressed", String(state.metrics["table" + i]));
        window.usageRadios?.sync(root);
        table(root, state, i, true);
      };
      q("thead",section).onclick=event=>{
        const button=event.target.closest("[data-sort-col]");
        if(!button)return;
        const column=Number(button.dataset.sortCol),previous=section._sort||[0,-1];
        section._sort=[column,previous[0]===column?-previous[1]:column===0?-1:1];
        table(root,state,i);
      };
    });
    window.usageCharts.mount(root);
    window.usageRadios?.mount(root);
    window.usageRadios?.sync(root);
    return state;
  }
  async function valueDetails(root, state) {
    if (state.valueDialog?.isConnected) {
      state.valueDialog.showModal();
      return;
    }
    const dialog = document.createElement("dialog");
    dialog.className = "usage-value-dialog";
    state.valueDialog = dialog;
    dialog.innerHTML =
      '<div class="section-title"><h3>API 等价值 · 实验</h3><button type="button" class="btn ghost" data-close aria-label="关闭">×</button></div><p class="meta" data-price-source>官方价格表 · 原币文本 Token 参考折算，峰谷按时段自动折算，不含工具、缓存存储与订阅费用。缺少价格或计费明细的记录不计入金额。</p><button type="button" class="btn ghost" data-sync-value>刷新价格与历史汇率</button><p class="meta" data-official-status>正在读取官方定价页…</p><p class="meta" data-value-status>正在读取价格…</p><div class="control-table-wrap" data-price-list></div>';
    document.body.append(dialog);
    dialog.showModal();
    q("[data-close]", dialog).onclick = () => dialog.close();
    dialog.addEventListener(
      "close",
      () => {
        // A refresh started from this dialog must stop reporting into a closed one.
        state.valueClosed = true;
        clearTimeout(state.valuePoll);
        dialog.remove();
        state.valueDialog = null;
      },
      { once: true },
    );
    window.usageCharts.track(root, () => dialog.remove());
    const paint = async () => {
      // Ask for the compact projection: the full catalogue carries a raw pricing
      // `dimensions` block per interval (~14 MB), which stalls this dialog. The compact
      // response keeps the quote/source/status columns it actually renders.
      const data = await api("GET", "/api/usage/value?compact=1&limit=300");
      if (!dialog.isConnected || !root.isConnected) return;
      // The backend owns the price engine identity. Reject a response that cannot
      // prove it came from a supported, evidence-bearing catalog, but do not pin a
      // single historical vendor name: the engine has moved from ModelRadar to
      // Portkey/CloudPrice and would otherwise fail every read.
      if (
        typeof data?.mode !== "string" ||
        !data.mode ||
        typeof data?.source !== "string" ||
        !/^https:\/\//.test(data.source) ||
        !Array.isArray(data.prices)
      )
        throw Error("价格接口响应不完整，旧报价已拒绝显示");
      const issues = state.snapshot.valuation?.issues || {};
      const sourceLabel = q("[data-price-source]", dialog);
      if (sourceLabel)
        sourceLabel.textContent =
          `${e(data.mode)} · 原币文本 Token 参考折算，不含工具、缓存存储与订阅费用。缺少价格或计费明细的记录不计入金额。`;
      const shown = data.prices.length;
      const total = Number(data.totalIntervals) || shown;
      q("[data-value-status]", dialog).textContent =
        `${shown}${total > shown ? ` / ${total}` : ""} 个价格区间 · ${Number(data.fxDays) || 0} 天历史汇率${Object.keys(issues).length ? " · 部分记录缺少历史价格或计费明细" : ""}${data.refreshing ? " · 正在后台同步" : ""}`;
      const officialLine = q("[data-official-status]", dialog);
      if (officialLine) officialLine.textContent = officialBrief(data.official);
      q("[data-price-list]", dialog).innerHTML =
        '<table class="control-table"><thead><tr><th>模型</th><th>起始 / 截止</th><th>输入 / 缓存 / 写入 / 输出<br>原币 / 百万 Token</th><th>来源</th></tr></thead><tbody>' +
        data.prices
          .map((p) => {
            const start = String(p.start || "").slice(0, 10) || "—";
            const end = String(p.end || "").slice(0, 10) || "—";
            const quote = p.quote || {};
            const snapshot = String(p.snapshotSource || p.source || "");
            const source = String(p.source || "");
            const link = (url, label) =>
              /^https:\/\//.test(url)
                ? `<a href="${e(url)}" target="_blank" rel="noopener noreferrer">${e(label)}</a>`
                : e(label);
            const typeLabel =
              p.sourceType === "registry"
                ? "公开版本化目录"
                : p.sourceType === "current_catalog"
                  ? "当日目录"
                  : "备用数据，不参与计算";
            const issue = p.integrityIssue
              ? `<br>报价冲突：${e(p.integrityIssue)}`
              : p.unsupported
                ? "<br>复杂规则，不参与单值计价"
                : "";
            return `<tr><td>${e(p.model)} · ${e(p.currency || "未知币种")}</td><td>${e(start)}<br>${e(end)} 前</td><td>${["input", "cached", "write", "output"].map((k) => e(quote[k] ?? "—")).join(" / ")}</td><td>${link(snapshot, "版本化快照")}<br>${link(source, "供应商来源")}<br>${e(typeLabel)}${issue}</td></tr>`;
          })
          .join("") +
        "</tbody></table>";
    };
    /**
     * 手动刷新同时读取官方定价页：新增模型与调价都来自官方页的逐行核对，
     * 这里只做一句话回报，不把未核验数字写进价格表。
     */
    const officialBrief = (result) => {
      const pages = result?.official;
      if (!Array.isArray(pages) || !pages.length) return "";
      const drift = pages.reduce((n, p) => n + (p.drift?.length || 0), 0),
        missing = pages.reduce((n, p) => n + (p.missing?.length || 0), 0),
        names = [
          ...new Set(pages.flatMap((p) => (p.missing || []).map((m) => m.model))),
        ];
      if (drift)
        return ` · 官方页有 ${drift} 项调价待核验，暂按已核对价表计算`;
      if (missing)
        return ` · 官方新增 ${names.slice(0, 3).join("、")}${names.length > 3 ? ` 等 ${missing} 个` : ""}，待核验后计价`;
      return " · 已核对官方定价页，价格表为最新";
    };
    state.valueClosed = false;
    q("[data-sync-value]", dialog).onclick = async () => {
      const button = q("[data-sync-value]", dialog),
        status = q("[data-value-status]", dialog);
      button.disabled = true;
      q("[data-value-status]", dialog).textContent =
        "正在读取官方定价页与历史汇率…";
      try {
        const job = await api("POST", "/api/usage/value/sync", {});
        if (!dialog.isConnected) return;
        if (!job?.id) {
          q("[data-value-status]", dialog).textContent = "刷新未开始，已保存的价格保留";
          return;
        }
        /* The sync runs as a background job on the server; read its result so the
           dialog can name the models the vendors added or repriced this time. */
        let result = null;
        for (let attempt = 0; attempt < 60; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          if (state.valueClosed || !dialog.isConnected || !dialog.open) return;
          const done = await api("GET", `/api/jobs?id=${encodeURIComponent(job.id)}`);
          if (done?.status === "failed") {
            q("[data-value-status]", dialog).textContent =
              done.error || "刷新未完成，已保存的价格保留";
            return;
          }
          if (done?.status !== "running" && done?.status !== "queued") {
            result = done?.result || null;
            break;
          }
        }
        if (state.valueClosed || !dialog.isConnected || !dialog.open) return;
        if (!result) {
          q("[data-value-status]", dialog).textContent =
            "后台仍在刷新，当前筛选继续使用已保存的价格与汇率";
          return;
        }
        await paint();
        if (!dialog.isConnected) return;
        const failures = result.errors || [];
        q("[data-value-status]", dialog).textContent =
          "已刷新官方价格与历史汇率" +
          (result.official ? " " + officialBrief(result.official) : "") +
          (failures.length ? " · 部分来源读取失败，沿用已保存的价格" : "");
      } catch (error) {
        if (dialog.isConnected) status.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    };
    try {
      await paint();
    } catch (error) {
      if (dialog.isConnected)
        q("[data-value-status]", dialog).textContent = error.message;
    }
  }
  /**
   * What the last official-page read changed, in one line.
   *
   * The backend prices from the vendor table it read most recently, so this line
   * reports the fact, not a review queue: added models, changed numbers and models
   * the vendor dropped are all applied on that read.
   */
  function officialBrief(official) {
    if (!official || typeof official !== "object") return "官方定价页：本次未读取，沿用上次结果";
    const added = (official.added || []).map((r) => r.model).filter(Boolean);
    const drift = official.drift || [];
    const partial = official.partial || [];
    const withdrawn = (official.withdrawn || []).map((r) => r.model).filter(Boolean);
    const readAt = String(official.readAt || "").slice(0, 10);
    const parts = [];
    if (added.length) parts.push(`新增 ${added.slice(0, 4).join("、")}${added.length > 4 ? ` 等 ${added.length} 个模型` : ""}`);
    if (drift.length) parts.push(`${drift.length} 项调价已按官方页更新`);
    if (withdrawn.length) parts.push(`官方已下架 ${withdrawn.slice(0, 3).join("、")}`);
    if (partial.length) parts.push(`${partial.length} 个模型价格未能完整读取，保持未知`);
    const when = readAt ? `官方定价页读取于 ${readAt}` : "官方定价页";
    return parts.length ? `${when} · ${parts.join(" · ")}` : `${when} · 价格表与官方一致`;
  }
  function heat(root, state, animate = false) {
    const s = state.snapshot;
    if (!s) return;
    const valued = valueSnapshot(state),
      currency = valued?.costCurrency || s.costCurrency;
    const money = (n) => window.usageCharts.money(n, currency);
    const cash = !!valued && state.metrics.heat,
      activity = window.usageCharts.heatSeries(
        cash
          ? costRows(
              valued.activity || valued.daily,
              valued.costAvailable,
              currency,
              agentScope(state.scope),
            )
          : s.activity || s.daily,
        state.heat,
      ),
      map = q(".usage-heatmap", root),
      max = Math.max(Number.EPSILON, ...activity.map((r) => r.total || 0));
    q(".usage-activity h3", root).textContent = cash
      ? agentScope(state.scope)
        ? "API 等价值活动 · 实验"
        : "费用活动"
      : "Token 活动";
    all("[data-heat-mode]", root).forEach((b) => {
      const selected = b.dataset.heatMode === state.heat;
      b.classList.toggle("selected", selected);
      b.setAttribute("aria-pressed", String(selected));
    });
    root.dataset.heatViewMode = state.heat;
    const dateKey = activity.map((r) => r.date).join(",");
    if (state.signatures.heatDates !== dateKey) {
      const padding =
        (new Date(activity[0]?.date + "T00:00:00Z").getUTCDay() + 6) % 7 || 0;
      if (!map.children.length) {
        map.innerHTML =
          Array.from(
            { length: padding },
            () => '<div aria-hidden="true" class="usage-heat-padding"></div>',
          ).join("") +
          activity
            .map(() => '<div class="usage-cell level-0" tabindex="0"></div>')
            .join("");
        window.usageCharts.mount(root);
      } else {
        all(".usage-heat-padding", map).forEach((c) => c.remove());
        for (let i = 0; i < padding; i++) {
          const blank = document.createElement("div");
          blank.className = "usage-heat-padding";
          blank.setAttribute("aria-hidden", "true");
          map.prepend(blank);
        }
      }
      const months = new Map(),
        columns = Math.ceil((activity.length + padding) / 7);
      activity.forEach((r, i) => {
        if (i === 0 || r.date.endsWith("-01"))
          months.set(
            Math.floor((i + padding) / 7),
            Number(r.date.slice(5, 7)) + "月",
          );
      });
      q(".usage-heat-months", root).innerHTML = [...months]
        .map(
          ([column, name]) =>
            `<span style="left:${Math.min(96, (column / columns) * 100)}%">${name}</span>`,
        )
        .join("");
      state.signatures.heatDates = dateKey;
    }
    const cancel = () => {
      state.heatTimers.forEach(clearTimeout);
      state.heatTimers.clear();
      state.heatAnimations.forEach((a) => a.cancel());
      state.heatAnimations.clear();
    };
    if (!state.heatCleanup) {
      const media = matchMedia("(prefers-reduced-motion: reduce)"),
        change = () => {
          cancel();
          if (media.matches) state.heatFinish?.();
        };
      media.addEventListener("change", change);
      window.usageCharts.track(map.parentElement, () => {
        cancel();
        media.removeEventListener("change", change);
      });
      state.heatCleanup = true;
    }
    const cells = all(".usage-cell", map),
      padding = all(".usage-heat-padding", map).length,
      columns = Math.ceil(map.children.length / 7);
    const key = JSON.stringify([activity, state.heat, cash]);
    // Keep empty cells theme-aware without forcing layout after counter updates.
    const surface = heatColor(0);
    const paint = (cell, r, motion) => {
      const before = cell.style.backgroundColor || surface,
        color = r.total ? heatColor(r.total / max) : surface;
      const label = `${r.caption || r.date}\n${r.provided === false ? (r.total ? "已知 " + (cash ? money(r.total) : fmt(r.total) + " Token") : "未返回" + (cash ? "费用" : "用量")) : cash ? money(r.total) : fmt(r.total) + " Token"}`;
      const renderKey = color + "\n" + label;
      if (cell.dataset.heatRenderKey === renderKey) return;
      cell.dataset.heatRenderKey = renderKey;
      cell.classList.remove(
        "level-0",
        "level-1",
        "level-2",
        "level-3",
        "level-4",
      );
      cell.classList.add(
        "level-" + (!r.total ? 0 : Math.min(4, Math.ceil((r.total / max) * 4))),
      );
      cell.style.background = color;
      Object.assign(cell.dataset, {
        intensity: r.total ? r.total / max : 0,
        date: r.date,
        total: r.total || 0,
        heatLabel: label,
      });
      cell.setAttribute("aria-label", label);
      if (motion) {
        const a = cell.animate(
          [{ backgroundColor: before }, { backgroundColor: color }],
          {
            duration: 160,
            delay: motion.delay || 0,
            easing: "ease-out",
            fill: "backwards",
          },
        );
        state.heatAnimations.add(a);
        a.onfinish = a.oncancel = () => state.heatAnimations.delete(a);
      }
    };
    state.heatFinish = () => {
      cells.forEach((cell, i) => {
        if (activity[i]) paint(cell, activity[i], false);
      });
      window.usageCharts.update(map);
    };
    if (animate || state.signatures.heatValues !== key) {
      cancel();
      state.signatures.heatValues = key;
      if (quiet()) state.heatFinish();
      else {
        cells.forEach((cell, i) => {
          if (!activity[i]) return;
          const n = i + padding,
            delay =
              ((Math.floor(n / 7) + (n % 7)) / Math.max(1, columns + 5)) * 100;
          cell.dataset.updateDelay = delay;
          paint(cell, activity[i], { delay });
        });
        window.usageCharts.update(map);
      }
    }
    const legend = q(".usage-heat-gradient", root);
    legend.style.background =
      "linear-gradient(90deg, " +
      heatStops
        .map(([n, c]) => "rgb(" + c.join(",") + ") " + n * 100 + "%")
        .join(", ") +
      ")";
    legend.title =
      "0 — " +
      (cash
        ? money(Math.max(0, ...activity.map((r) => r.total || 0)))
        : fmt(Math.max(0, ...activity.map((r) => r.total || 0))) + " Token");
    q(".usage-heat-legend", root).setAttribute(
      "aria-label",
      (cash ? "费用" : "Token") + "活动颜色：从少到多",
    );
    q("[data-heat-start]", root).textContent = activity[0]?.date || "—";
    q("[data-heat-end]", root).textContent = activity.at(-1)?.date || "—";
    window.usageRadios?.sync(root);
  }
  function charts(root, state) {
    const s = state.snapshot;
    if (!s) return;
    const valued = valueSnapshot(state),
      currency = valued?.costCurrency || s.costCurrency;
    const money = (n) => window.usageCharts.money(n, currency);
    const cash = !!valued && state.metrics.charts,
      daily = cash
        ? costRows(
            valued.daily,
            valued.costAvailable,
            currency,
            agentScope(state.scope),
          )
        : s.daily,
      groups = cash
        ? costRows(
            valued.groups,
            valued.costAvailable,
            currency,
            agentScope(state.scope),
          )
        : s.groups;
    const trendCash = cash;
    root.dataset.trendPeriod = "day";
    const trendDaily = daily,
      plot = q(".usage-plot", root),
      button = q("[data-chart-mode]", root),
      pie = q(".usage-interactive-pie", root),
      series = trendDaily.map((r) => ({
        ...r,
        date: r.date,
        endDate: r.endDate,
        total: typeof r.total==="string"?Number(r.total):r.total,
        exactTotal: typeof r.total==="string"?r.total:undefined,
        models: r.models || [],
        provided: r.provided,
      }));
    plot.dataset.granularity='day';
    plot.dataset.experimental = String(trendCash && agentScope(state.scope));
    pie.dataset.experimental = String(cash && agentScope(state.scope));
    plot.dataset.transition =
      plot.dataset.metric && plot.dataset.metric !== (trendCash ? "cost" : "token")
        ? "vertical"
        : "reveal";
    plot.dataset.metric = trendCash ? "cost" : "token";
    pie.dataset.metric = cash ? "cost" : "token";
    q(".usage-chart-heading h3", root).textContent = trendCash
      ? "每日费用趋势"
      : "每日 Token 趋势";
    q(".usage-pie-heading h3", root).textContent = cash
      ? "模型费用占比" + (s.groups.some((g) => g.costUnknown) ? "（已知）" : "")
      : "模型用量占比";
    plot
      .querySelector("svg")
      .setAttribute(
        "aria-label",
        (cash ? "每日费用趋势" : "每日 Token 趋势") +
          "，左右方向键查看每日用量",
      );
    pie
      .querySelector("svg")
      .setAttribute("aria-label", cash ? "模型费用占比" : "模型 Token 占比");
    const keys = [
      ...new Set(
        s.groups.map((r) =>
          JSON.stringify([r.provider || "", r.model || "未区分模型"]),
        ),
      ),
    ].sort((a, b) => a.localeCompare(b));
    if (button.dataset.iconMode !== state.mode) {
      button.innerHTML = chartIcon(state.mode);
      button.dataset.iconMode = state.mode;
    }
    button.dataset.chartMode = state.mode;
    button.setAttribute("aria-pressed", String(state.mode === "bar"));
    button.setAttribute(
      "aria-label",
      state.mode === "bar" ? "切换为曲线图" : "切换为柱状图",
    );
    button.title = button.getAttribute("aria-label");
    root.dataset.chartViewMode = state.mode;
    if (cash && ["codex", "api"].includes(state.scope)) {
      q(".usage-chart-heading h3", root).textContent = "每日 API 基准估算 · 已知部分";
      q(".usage-pie-heading h3", root).textContent =
        "模型基准估算占比" + (valued.summary.costUnknown ? "（已知）" : "");
    }
    if (plot.dataset.valueCurrency && plot.dataset.valueCurrency !== currency)
      plot.dataset.transition = "vertical";
    plot.dataset.valueCurrency = currency || "";
    const trendKey = JSON.stringify([series, state.mode, keys, trendCash, currency]);
    if (state.signatures.trend !== trendKey) {
      plot.dataset.series = JSON.stringify(series);
      plot.dataset.mode = state.mode;
      plot.dataset.modelKeys = JSON.stringify(keys);
      window.usageCharts.update(plot);
      state.signatures.trend = trendKey;
    }
    const models = JSON.stringify(window.usageCharts.models(groups)),
      pieKey = models + cash + currency;
    if (state.signatures.pie !== pieKey) {
      pie.dataset.models = models;
      window.usageCharts.update(pie);
      state.signatures.pie = pieKey;
    }
    const pieRows = JSON.parse(models);
    const center = q(".usage-donut strong", root);
    number(
      center,
      pieRows.reduce((sum, r) => sum + r.total, 0),
      cash ? "money" : false,
    );
    center.style.visibility = pieRows.length ? "visible" : "hidden";
    q(".usage-pie-empty", root).hidden = !!pieRows.length;
    q(".usage-pie-empty", root).textContent = cash
      ? "暂无模型费用"
      : "暂无模型用量";
    q("[data-trend-start]", root).textContent = trendDaily[0]?.date || "—";
    q("[data-trend-end]", root).textContent =
      trendDaily.at(-1)?.endDate || trendDaily.at(-1)?.date || "—";
    window.usageRadios?.sync(root);
    const known = series.filter((r) => Number.isFinite(r.total));
    q("[data-trend-peak]", root).textContent =
      (trendCash && known.length < trendDaily.length ? "已知峰值 " : "视窗峰值 ") +
      (known.length
        ? trendCash
          ? money(Math.max(0, ...known.map((r) => r.total)))
          : fmt(Math.max(0, ...known.map((r) => r.total)))
        : "—");
  }
  function compareTable(a,b,direction,numeric=false){
    if(a==null||b==null)return a==null?(b==null?0:1):-1;
    if(numeric&&/^\d+$/.test(String(a))&&/^\d+$/.test(String(b))){
      const first=BigInt(a),second=BigInt(b);
      return (first>second?1:first<second?-1:0)*direction;
    }
    return (numeric?Number(a)-Number(b):String(a).localeCompare(String(b),"zh-CN",{numeric:true}))*direction;
  }

  function sortableHeaders(section,labels,column,direction){
    const row=q("thead tr",section);
    const signature=labels.join("\0");
    if(row.dataset.labels!==signature){
      row.innerHTML=labels.map((name,i)=>`<th scope="col"><button type="button" data-sort-col="${i}">${e(name)} <span aria-hidden="true"></span></button></th>`).join("");
      row.dataset.labels=signature;
    }
    all("th",row).forEach((th,i)=>{
      th.setAttribute("aria-sort",i===column?(direction===1?"ascending":"descending"):"none");
      q("span",th).textContent=i===column?(direction===1?"↑":"↓"):"↕";
    });
  }

  function sessionShell(){
    return '<section class="control-section usage-table-panel" data-usage-sessions hidden><h3>会话</h3><p data-session-status aria-live="polite"></p><div class="control-table-wrap"><table class="control-table"><thead><tr></tr></thead><tbody></tbody></table></div></section>';
  }

  function updateSessions(root,query,version,available){
    const section=q("[data-usage-sessions]",root);
    const status=q("[data-session-status]",section),tbody=q("tbody",section);
    section.hidden=!available;
    if(!available){section._sessionRequest?.controller.abort();section._sessionRequest=null;return;}
    const key=query+"|"+version;
    if(section._sessionRequest?.key===key)return;
    section._sessionRequest?.controller.abort();
    const controller=new AbortController();
    section._sessionRequest={key,controller};
    tbody.replaceChildren();
    status.textContent="正在读取会话…";
    const params=new URLSearchParams(query);
    params.set("limit","200");
    window.workbenchRequest("GET","/api/usage/sessions?"+params,undefined,{signal:controller.signal}).then(data=>{
      if(controller.signal.aborted||!root.isConnected)return;
      const records=data.sessions||[];
      const name=r=>r.title||(r.unknownIdentity?"未识别会话":r.session.slice(0,12));
      const rate=r=>r.cacheCoverage<1&&r.cacheHitRate!=null?"已知 "+formatRate(r.cacheHitRate):formatRate(r.cacheHitRate);
      const date=value=>value?dateFormat.format(new Date(value)):"—";
      let sort=[4,-1],open=null;
      const render=()=>{
        const [column,direction]=sort;
        sortableHeaders(section,["会话","Token","请求","缓存命中","最近活动"],column,direction);
        const get=r=>[name(r),r.total,r.requests,r.cacheHitRate,r.lastAt][column];
        tbody.innerHTML=[...records].sort((a,b)=>compareTable(get(a),get(b),direction,column>=1&&column<=3)).map((r,index)=>{
          const expanded=open===r;
          return `<tr><th scope="row"><button type="button" data-session-toggle="${records.indexOf(r)}" aria-expanded="${expanded}" aria-controls="usage-session-detail-${index}">${e(name(r))}</button></th><td>${r.unknownFields.total&&r.total!=null?"已知 ":""}${formatCount(r.total)}</td><td>${formatCount(r.requests)}</td><td>${rate(r)}</td><td>${date(r.lastAt)}</td></tr><tr id="usage-session-detail-${index}" class="usage-session-detail" ${expanded?"":"hidden"}><td colspan="5">${r.modelTotals.length?`<ul>${r.modelTotals.map(m=>`<li><span>${e([m.provider,m.model].filter(Boolean).join(" / ")||"未知模型")}</span><b>${formatCount(m.total)} Token</b><small>${formatCount(m.requests)} 次请求</small></li>`).join("")}</ul>`:"暂无模型明细"}</td></tr>`;
        }).join("");
      };
      q("thead",section).onclick=event=>{
        const button=event.target.closest("[data-sort-col]");if(!button)return;
        const column=Number(button.dataset.sortCol);
        sort=[column,sort[0]===column?-sort[1]:column===0?1:-1];render();
      };
      tbody.onclick=event=>{
        const button=event.target.closest("[data-session-toggle]");if(!button)return;
        const index=button.dataset.sessionToggle,row=records[index];
        open=open===row?null:row;render();
        q(`[data-session-toggle="${index}"]`,tbody)?.focus({preventScroll:true});
      };
      status.textContent=records.length?(data.truncated?`最近 ${records.length} 个会话 / 共 ${data.totalSessions} 个`:""):"所选范围暂无会话记录";
      render();
    }).catch(error=>{
      if(!controller.signal.aborted&&root.isConnected){section._sessionRequest=null;status.textContent="会话读取失败："+error.message;}
    });
  }

  function table(root, state, index, animated = false) {
    const s = state.snapshot;
    if (!s) return;
    const valued = valueSnapshot(state),
      cash =
        index === 0 && !!valued && state.metrics["table" + index];
    const section = all("[data-usage-table]", root)[index],
      entries = index
        ? cash
          ? valued.events
          : s.events
        : cash
          ? valued.groups
          : s.groups;
    const headers = index
      ? [
          "时间",
          "Agent",
          "实际模型 / 请求模型",
          cash ? (state.scope==="codex"||state.scope==="api"?"API 参考费用":"费用（官方价）") : "Token",
          "状态",
          "耗时",
        ]
      : [
          "最新日期",
          "来源 / Agent",
          "服务商 / 模型",
          ...(cash
            ? [
                "普通输入金额",
                "输出金额",
                "缓存命中金额",
                "缓存写入金额",
                state.scope === "codex" || state.scope === "api"
                  ? "API 等价值 · 实验"
                  : "费用合计 · 官方价",
              ]
            : ["输入", "输出", "缓存", "推理", "Token"]),
          "请求 / 失败",
        ];
    const [column,direction]=section._sort||[0,-1];
    sortableHeaders(section,headers,column,direction);
    const metric=(row,i)=>{
      if(i===0)return row.at||null;
      if(index)return [null,row.agent,row.model,row.total,row.status,row.duration_ms][i]??null;
      if(i===1)return [row.source,row.agent].filter(Boolean).join(" / ");
      if(i===2)return [row.provider,row.model].filter(Boolean).join(" / ");
      if(i===8)return s.aggregated?row.platformRequests:row.requests;
      const field=(cash?["input","output","cached","write","total"]:["input","output","cached","reasoning","total"])[i-3];
      if(cash)return row.pricedRequests?(field==="total"?row.costs?.[valued.costCurrency]:row.valueParts?.[field]):null;
      return row.requests&&row.unknownFields?.[field]===row.requests?null:row[field];
    };
    const rows=[...entries].sort((a,b)=>compareTable(metric(a,column),metric(b,column),direction,column>=3&&(!index||column===3||column===5)));
    const amount = (row, k) =>
      row.unknownFields?.[k] === row.requests && row.requests
        ? "—"
        : Number.isFinite(row[k])
          ? fmt(row[k])
          : "—";
    const valueCell = (r) => {
      const total = index
        ? r.cost == null
          ? null
          : Number(r.cost)
        : r.pricedRequests
          ? r.costs?.[valued.costCurrency]
          : r.requests
            ? null
            : 0;
      return total == null
        ? "—"
        : (r.costUnknown ? "已知 " : "") + money(total, valued.costCurrency);
    };
    const html = rows
      .map(
        (r) =>
          `<tr data-model="${e(r.model)}" data-at="${e(r.at)}" data-total="${r.total ?? ""}">${index ? `<td>${e(timestampFormat.format(new Date(r.at)))}</td><td>${e(r.agent)}</td><td>${e(r.model)}${r.requested_model ? `<br><small>${e(r.requested_model)}</small>` : ""}</td><td title="${Number.isFinite(r.total) ? full(r.total) + " Token" : "未返回用量"}">${amount(r, "total")}</td><td>${r.status === "error" ? "失败" : "已记录"}</td><td>${r.duration_ms ? fmt(r.duration_ms) + " ms" : "—"}</td>` : `<td>${r.at ? e(dateFormat.format(new Date(r.at))) : "—"}</td><td>${e(r.source === "official-api" ? "官方 API" : r.source)}${r.agent ? " / " + e(r.agent) : ""}</td><td><span class="usage-model-cell"><span>${e(r.provider)}<br><small>${e(r.model)}</small></span></span></td>${["input", "output", "cached", "reasoning", "total"].map((k) => `<td title="${Number.isFinite(r[k]) ? full(r[k]) : "未返回"}">${amount(r, k)}</td>`).join("")}<td>${s.aggregated ? (Number.isFinite(r.platformRequests) ? fmt(r.platformRequests) : "—") : fmt(r.requests) + " / " + fmt(r.failures)}</td>`}</tr>`,
      )
      .join("");
    const signature = JSON.stringify([html, cash, valued?.costCurrency]);
    const tbody = q("tbody", section);
    if (state.signatures["table" + index] !== signature) {
      tbody.innerHTML = html;
      state.signatures["table" + index] = signature;
      if (animated && !quiet())
        tbody.animate(
          [{ transform: "translateY(6px)" }, { transform: "translateY(0)" }],
          { duration: 240, easing: "ease-out" },
        );
    }
    if (cash)
      all("tbody tr", section).forEach((tr, i) => {
        const r = rows[i],
          cells = all("td", tr);
        if (index) {
          cells[3].textContent = valueCell(r);
          cells[3].title =
            r.cost == null
              ? "价格或计费明细不完整"
              : JSON.stringify(r.valueProof);
          cells[4].textContent = r.cost == null ? "金额未知" : "已折算";
        } else {
          ["input", "output", "cached", "write"].forEach((key, n) => {
            cells[n + 3].textContent = r.pricedRequests
              ? (r.costUnknown ? "已知 " : "") +
                money(Number(r.valueParts[key]), valued.costCurrency)
              : "—";
            cells[n + 3].title = "API 等价值（实验）";
          });
          cells[7].textContent = valueCell(r);
          cells[7].title = "API 等价值（实验）";
        }
      });
    q("[data-table-count]", section).textContent = fmt(rows.length) + " 条";
    if (index)
      q("h3", section).textContent = s.aggregated ? "平台汇总记录" : "最近请求";
  }
  function update(root, s) {
    const updateStarted = performance.now();
    const state = init(root),
      unknown =
        (["official-provider-api", "official-codex-account"].includes(
          s.origin,
        ) &&
          !s.available) ||
        (s.origin !== "official-codex-account" &&
          s.accounting?.incomplete &&
          !s.lifetime?.requests),
      scope = root.dataset.usageScope || s.origin,
      entering = state.scope !== scope || state.entryPending;
    state.entryPending=false;
    if(entering){root.dataset.usageEntry=String(Number(root.dataset.usageEntry||0)+1);const shell=root.closest(".usage-stable");if(shell)shell.dataset.usageEntry=root.dataset.usageEntry;}
    if (
      agentScope(scope) &&
      entering
    ) {
      for (const key of Object.keys(state.metrics)) state.metrics[key] = false;
      all("[data-metric],[data-table-money]", root).forEach((b) =>
        b.setAttribute("aria-pressed", "false"),
      );
    }
    state.scope = scope;
    state.snapshot = s;
    root.dataset.usageOrigin = s.origin || "codex";
    const valued = valueSnapshot(state),
      currency = valued?.costCurrency || s.costCurrency || "CNY";
    all("button[data-metric]", root).forEach((b) => {
      b.hidden = !valued && scope !== "codex";
      b.textContent = currency === "USD" ? "$" : "￥";
      b.title = agentScope(scope)
        ? "切换 Token／API 等价值（实验）"
        : "切换 Token／费用";
      b.setAttribute("aria-label", b.title);
    });
    all("[data-table-money]", root).forEach((b) => {
      b.hidden = !valued;
      b.textContent = currency === "USD" ? "$" : "￥";
    });
    all(
      ".usage-plot,.usage-interactive-pie,[data-finance],.usage-donut strong",
      root,
    ).forEach((el) => (el.dataset.currency = currency));
    const summaryCard = q('[data-summary="4"]', root).parentElement;
    [...summaryCard.children].forEach((el) => {
      el.hidden = el.classList.contains("usage-account-finance")
        ? scope !== "api"
        : scope === "api";
    });
    all("[data-finance]", root).forEach((el) => {
      const n = s.accountFinance?.[el.dataset.finance];
      el.previousElementSibling.textContent =
        s.accountFinance?.scope === "key"
          ? el.dataset.finance === "balance"
            ? "Key 配额"
            : "Key 累计消费"
          : el.dataset.finance === "balance"
            ? "账户余额"
            : "账户累计消费";
      number(el, Number.isFinite(n) ? n : null, "money", "", entering);
      el.title = Number.isFinite(n)
        ? (s.costCurrency === "USD" ? "$" : "￥") + n.toFixed(6)
        : "未返回";
    });
    const cashCard = agentScope(scope) && !!valued,
      lifetime = [
        s.lifetime.total,
        s.lifetime.peak,
        s.lifetime.currentStreak,
        s.lifetime.longestStreak,
      ];
    all("[data-lifetime]", root).forEach((el, i) => {
      number(el, unknown ? null : lifetime[i], true, i > 1 ? " 天" : "", entering);
      el.nextElementSibling.textContent =
        i < 2
          ? (i ? "单日峰值" : "累计") + " Token"
          : i === 2
            ? "当前连续"
            : "最长连续";
    });
    q(".usage-value-tools", root).hidden = q(
      ".usage-value-coverage",
      root,
    ).hidden = true;
    window.AgentValuation?.update(root, s);
    const summary = ["total", "input", "output", "cached"].map((k) =>
      unknown ||
      (s.summary.requests &&
        s.summary.unknownFields?.[k] === s.summary.requests)
        ? null
        : s.summary[k],
    );
    summary.push(
      unknown
        ? null
        : s.aggregated
          ? s.platformRequests
          : s.summary.requestCount !== undefined
            ? s.summary.requestCount
            : s.summary.requests,
    );
    all("[data-summary]", root).forEach((el, i) => {
      number(el, summary[i], true, "", entering);
      el.nextElementSibling.textContent =
        summary[i] >= 10000 ? fmt(summary[i]) : "";
    });
    const mainBound = performance.now();
    heat(root, state, entering);
    const heatBound = performance.now();
    charts(root, state);
    const chartBound = performance.now();
    table(root, state, 0, true);
    table(root, state, 1, true);
    root.dataset.updateStages = JSON.stringify({
      main: mainBound - updateStarted,
      heat: heatBound - mainBound,
      charts: chartBound - heatBound,
      tables: performance.now() - chartBound,
    });
    q(".usage-updated", root).textContent =
      (s.dataSource?.message
        ? s.dataSource.message + " · "
        : s.accounting?.incomplete
          ? s.accounting.message + " · "
          : s.incomplete
            ? "部分 APIKey 尚未返回用量 · "
            : "") +
      "更新 " +
      new Date(s.updatedAt || Date.now()).toLocaleTimeString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      });
  }
  function heatColor(value) {
    const t = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0,
      index = heatStops.findIndex(
        (s, i) => i < heatStops.length - 1 && t <= heatStops[i + 1][0],
      ),
      [from, a] = heatStops[index],
      [to, b] = heatStops[index + 1],
      p = (t - from) / (to - from);
    return (
      "rgb(" + a.map((v, i) => Math.round(v + (b[i] - v) * p)).join(", ") + ")"
    );
  }
  function policy(root, features) {
    const state = states.get(root);
    if (
      !state?.snapshot ||
      !agentScope(state.scope) ||
      state.scope === "codex" || features[state.scope + "ValuationEnabled"]
    )
      return;
    for (const key of Object.keys(state.metrics)) state.metrics[key] = false;
    all("[data-metric],[data-table-money]", root).forEach((b) =>
      b.setAttribute("aria-pressed", "false"),
    );

    update(root, {
      ...state.snapshot,
      pricing: { ...state.snapshot.pricing, enabled: false },
      valuation: null,
    });
  }
  window.addEventListener("workbench:usage-enter",()=>{document.querySelectorAll("#usage-body").forEach(root=>{const state=states.get(root);if(state?.snapshot){state.entryPending=true;update(root,state.snapshot);}});});
  window.usageView = { init, update, updateSessions, number, options, heatColor, policy };
})();
