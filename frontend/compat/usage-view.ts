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
  const valueSnapshot = (state) =>
    agentScope(state.scope)
      ? state.snapshot.pricing?.enabled === true
        ? state.snapshot.valuation
        : null
      : state.scope === "api"
        ? state.snapshot
        : null;
  const chartIcon = (mode) =>
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 3v17h17" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>' +
    (mode === "bar"
      ? '<path d="M8 16V9m5 7V5m5 11v-4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>'
      : '<path d="m6 15 4-6 4 3 6-7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>') +
    "</svg>";
  const heatStops = [
    [0.0, [255, 255, 255]],
    [0.01694915254237288, [247, 252, 254]],
    [0.03389830508474576, [238, 250, 254]],
    [0.05084745762711865, [230, 247, 253]],
    [0.06779661016949153, [222, 244, 253]],
    [0.0847457627118644, [214, 242, 252]],
    [0.1016949152542373, [205, 239, 251]],
    [0.11864406779661017, [197, 236, 251]],
    [0.13559322033898305, [189, 234, 250]],
    [0.15254237288135594, [181, 231, 250]],
    [0.1694915254237288, [172, 228, 249]],
    [0.1864406779661017, [164, 226, 248]],
    [0.2033898305084746, [156, 223, 248]],
    [0.22033898305084745, [148, 221, 247]],
    [0.23728813559322035, [139, 218, 246]],
    [0.2542372881355932, [131, 215, 246]],
    [0.2711864406779661, [123, 213, 245]],
    [0.288135593220339, [115, 210, 245]],
    [0.3050847457627119, [106, 207, 244]],
    [0.3220338983050847, [98, 205, 243]],
    [0.3389830508474576, [90, 202, 243]],
    [0.3559322033898305, [82, 199, 242]],
    [0.3728813559322034, [73, 197, 242]],
    [0.3898305084745763, [65, 194, 241]],
    [0.4067796610169492, [75, 186, 237]],
    [0.423728813559322, [89, 178, 233]],
    [0.4406779661016949, [101, 170, 229]],
    [0.4576271186440678, [113, 162, 226]],
    [0.4745762711864407, [124, 154, 222]],
    [0.4915254237288136, [136, 146, 218]],
    [0.5084745762711864, [148, 138, 214]],
    [0.5254237288135594, [160, 130, 210]],
    [0.5423728813559322, [172, 122, 206]],
    [0.559322033898305, [184, 114, 202]],
    [0.576271186440678, [196, 106, 198]],
    [0.5932203389830508, [208, 98, 195]],
    [0.6101694915254238, [231, 90, 182]],
    [0.6271186440677966, [231, 82, 183]],
    [0.6440677966101694, [243, 74, 183]],
    [0.6610169491525424, [247, 63, 171]],
    [0.6779661016949152, [239, 60, 163]],
    [0.6949152542372882, [231, 57, 155]],
    [0.711864406779661, [223, 54, 146]],
    [0.7288135593220338, [215, 51, 138]],
    [0.7457627118644068, [206, 48, 130]],
    [0.7627118644067796, [198, 45, 122]],
    [0.7796610169491526, [190, 39, 106]],
    [0.7966101694915254, [174, 36, 98]],
    [0.8135593220338984, [158, 33, 90]],
    [0.8305084745762712, [158, 30, 81]],
    [0.847457627118644, [150, 27, 73]],
    [0.864406779661017, [142, 24, 65]],
    [0.8813559322033898, [134, 21, 49]],
    [0.8983050847457628, [126, 18, 49]],
    [0.9152542372881356, [117, 15, 41]],
    [0.9322033898305084, [109, 12, 33]],
    [0.9491525423728814, [101, 9, 24]],
    [0.9661016949152542, [93, 6, 16]],
    [0.9830508474576272, [85, 5, 3]],
    [1.0, [77, 0, 0]],
  ];
  function number(el, value, raw = false, suffix = "") {
    if (!el) return;
    const previous = counters.get(el);
    if (
      previous?.target === value &&
      previous.raw === raw &&
      previous.suffix === suffix &&
      previous.currency === el.dataset.currency
    )
      return;
    if (previous) cancelAnimationFrame(previous.frame);
    const state = {
      target: value,
      raw,
      suffix,
      currency: el.dataset.currency,
      current: previous?.current ?? value,
      frame: 0,
    };
    counters.set(el, state);
    el.dataset.value = Number.isFinite(value) ? String(value) : "";
    if (raw)
      el.style.setProperty(
        "--number-chars",
        String(
          Number.isFinite(value)
            ? (raw === "money"
                ? money(value, el.dataset.currency)
                : full(Math.round(value)) + suffix
              ).length
            : 1,
        ),
      );
    const paint = (v) => {
      state.current = v;
      el.textContent =
        (Number.isFinite(v)
          ? raw === "money"
            ? money(v, el.dataset.currency)
            : raw
              ? full(Math.round(v))
              : fmt(Math.round(v))
          : "—") + suffix;
    };
    if (
      !previous ||
      !Number.isFinite(value) ||
      !Number.isFinite(previous.current) ||
      quiet()
    ) {
      paint(value);
      return;
    }
    const start = performance.now(),
      from = previous.current;
    const tick = (now) => {
      if (!el.isConnected) return;
      const p = Math.min(1, (now - start) / 280);
      paint(from + (value - from) * (1 - (1 - p) ** 3));
      if (p < 1) state.frame = requestAnimationFrame(tick);
    };
    state.frame = requestAnimationFrame(tick);
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
    return `<section class="control-section usage-table-panel" data-usage-table><h3>${index ? "最近请求" : "来源与模型明细"}</h3><div class="usage-table-tools"><label>模型<select data-table-model aria-label="${index ? "请求" : "明细"}模型筛选"><option value="">全部模型</option></select></label><label>排序<select data-table-sort aria-label="${index ? "请求" : "明细"}排序"><option value="date-desc">日期 · 最近优先</option><option value="date-asc">日期 · 最早优先</option><option value="token-desc">Token · 从高到低</option><option value="token-asc">Token · 从低到高</option></select></label><span data-table-count></span></div><div class="control-table-wrap"><table class="control-table"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody></tbody></table></div></section>`;
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
      )}</div></div><div class="usage-heat-months"></div><div class="usage-heatmap"></div><div class="usage-axis"><span data-heat-start></span><span class="usage-heat-legend" aria-label="Token 活动颜色：从少到多">少 <i class="usage-heat-gradient" aria-hidden="true"></i> 多</span><span data-heat-end></span></div></section><div class="usage-charts"><section class="control-section"><div class="section-title usage-chart-heading"><button class="btn ghost usage-chart-mode" data-chart-mode="line" aria-label="切换为柱状图" title="切换为柱状图" aria-pressed="false">${chartIcon("line")}</button><h3>每日 Token 趋势</h3></div>${window.usageCharts.trend([])}<div class="usage-axis"><span data-trend-start></span><span data-trend-peak></span><span data-trend-end></span></div></section><section class="control-section"><h3>模型用量占比</h3><div class="usage-pie-layout usage-interactive-pie" data-models="[]"><div class="usage-donut interactive"><svg viewBox="0 0 200 200" role="group" aria-label="模型 Token 占比"></svg><strong>—</strong></div><div class="usage-legend"></div><div class="usage-pie-empty">暂无模型用量</div></div></section></div>${tableShell(0)}${tableShell(1)}<div class="usage-updated"></div>`;
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
      q(".usage-table-tools", section).append(b);
      b.onclick = () => {
        state.metrics["table" + i] = !state.metrics["table" + i];
        b.setAttribute("aria-pressed", String(state.metrics["table" + i]));
        table(root, state, i, true);
      };
      window.usageFilters.models(
        root,
        q("[data-table-model]", section),
        () => table(root, state, i, true),
        () => "wb-usage-table-models:" + state.scope + ":" + i,
      );
      q("[data-table-sort]", section).onchange = () =>
        table(root, state, i, true);
    });
    const viewport = document.createElement("div");
    viewport.className = "usage-trend-viewport";
    viewport.innerHTML =
      '<span data-viewport-label>鼠标滚轮缩放趋势日期；不改变其他统计</span><button type="button" class="btn ghost" data-reset-viewport>重置视窗</button>';
    q(".usage-plot", root).after(viewport);
    state.trendViewport = null;
    state.trendRows = null;
    state.trendTicket = 0;
    q("[data-reset-viewport]", root).onclick = () => {
      state.trendTicket++;
      clearTimeout(state.trendTimer);
      state.trendAbort?.abort();
      state.trendViewport = null;
      state.trendRows = null;
      state.trendGranularity = null;
      state.signatures.trend = null;
      charts(root, state);
    };
    root.addEventListener("usage-chart-zoom", (event) => {
      const s = state.snapshot;
      if (!s?.daily?.length) return;
      const daily = state.trendRows || s.daily,
        current = state.trendViewport || {
          start: daily[0].date,
          end: daily.at(-1).endDate || daily.at(-1).date,
        },
        a = Date.parse(current.start),
        b = Date.parse(current.end),
        day = 86400000,
        span = Math.max(1, (b - a) / day + 1),
        next = Math.max(1, span * event.detail.factor),
        anchor = event.detail.anchor,
        center = a + anchor * (b - a);
      let left = center - anchor * (next - 1) * day,
        right = left + (next - 1) * day;
      const low = Date.parse(
          state.trendBounds?.start || s.range?.earliest || s.daily[0].date,
        ),
        high = Date.parse(
          state.trendBounds?.end || s.range?.end || s.daily.at(-1).date,
        );
      if (left < low) {
        right += low - left;
        left = low;
      }
      if (right > high) {
        left -= right - high;
        right = high;
      }
      left = Math.max(low, left);
      state.trendViewport = {
        start: new Date(left).toISOString().slice(0, 10),
        end: new Date(Math.max(left, right)).toISOString().slice(0, 10),
      };
      clearTimeout(state.trendTimer);
      state.trendTimer = setTimeout(() => loadTrend(root, state), 80);
    });
    window.usageCharts.track(root, () => {
      clearTimeout(state.trendTimer);
      state.trendAbort?.abort();
    });
    window.usageCharts.mount(root);
    window.usageRadios?.mount(root);
    window.usageRadios?.sync(root);
    return state;
  }
  async function loadTrend(root, state) {
    const snapshot = state.snapshot;
    if (!snapshot || !state.trendViewport) return;
    state.trendAbort?.abort();
    const abort = new AbortController();
    state.trendAbort = abort;
    const ticket = ++state.trendTicket,
      valued = valueSnapshot(state),
      cash = !!valued && state.metrics.charts;
    const params = new URLSearchParams();
    Object.entries(snapshot.query || {}).forEach(([k, v]) => {
      if (
        [
          "period",
          "start_date",
          "end_date",
          "valuation_enabled",
          "include_all",
        ].includes(k) ||
        !v
      )
        return;
      if (Array.isArray(v)) v.forEach((x) => params.append(k, x));
      else params.set(k, String(v));
    });
    params.set("scope", state.scope);
    params.set("start", state.trendViewport.start);
    params.set("end", state.trendViewport.end);
    params.set("metric", cash ? "value" : "tokens");
    params.set("currency", valued?.costCurrency || "USD");
    params.set(
      "points",
      String(Math.max(60, Math.floor(q(".usage-plot", root).clientWidth))),
    );
    const stop = window.WorkbenchUI.busy(
      q(".usage-trend-viewport", root),
      "读取历史…",
    );
    try {
      const result = await window.workbenchRequest(
        "GET",
        "/api/usage/chart?" + params,
        undefined,
        { signal: abort.signal },
      );
      if (!root.isConnected || ticket !== state.trendTicket) return;
      if (result.warming) {
        state.trendTimer = setTimeout(() => loadTrend(root, state), 500);
        return;
      }
      state.trendRows = result.series;
      state.trendBounds = result.bounds;
      state.trendGranularity = result.granularity;
      state.trendLastMetric = [
        cash,
        cash ? result.currency : "",
        state.snapshot.dataVersion,
      ].join(":");
      state.signatures.trend = null;
      charts(root, state);
    } catch (error) {
      if (error.name !== "AbortError" && root.isConnected)
        q("[data-viewport-label]", root).textContent =
          error.message + "；原图保留";
    } finally {
      stop();
    }
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
      '<div class="section-title"><h3>API 等价值 · 实验</h3><button type="button" class="btn ghost" data-close aria-label="关闭">×</button></div><p class="meta">ModelRadar 当日原币文本 Token 参考折算，不含工具、缓存存储与订阅费用。缺少价格或计费明细的记录不计入金额。</p><button type="button" class="btn ghost" data-sync-value>同步价格与历史汇率</button><p class="meta" data-value-status>正在读取价格…</p><div class="control-table-wrap" data-price-list></div>';
    document.body.append(dialog);
    dialog.showModal();
    q("[data-close]", dialog).onclick = () => dialog.close();
    dialog.addEventListener(
      "close",
      () => {
        clearTimeout(state.valuePoll);
        dialog.remove();
        state.valueDialog = null;
      },
      { once: true },
    );
    window.usageCharts.track(root, () => dialog.remove());
    const paint = async () => {
      const data = await api("GET", "/api/usage/value");
      if (!dialog.isConnected || !root.isConnected) return;
      if (
        data.mode !== "ModelRadar/native-currency/text" ||
        data.source !== "https://modelradar.cn/data/models.json"
      )
        throw Error("后端仍返回旧价格接口，请重启网站服务；旧报价已拒绝显示");
      const issues = state.snapshot.valuation?.issues || {};
      q("[data-value-status]", dialog).textContent =
        `${data.prices.length} 个价格区间 · ${data.fxDays} 天历史汇率${Object.keys(issues).length ? " · 部分记录缺少历史价格或计费明细" : ""}`;
      q("[data-price-list]", dialog).innerHTML =
        '<table class="control-table"><thead><tr><th>模型</th><th>起始 / 截止</th><th>输入 / 缓存 / 写入 / 输出<br>原币 / 百万 Token</th><th>来源</th></tr></thead><tbody>' +
        data.prices
          .map(
            (p) =>
              `<tr><td>${e(p.model)} · ${e(p.currency || "未知币种")}</td><td>${e(p.start.slice(0, 10))}<br>${e(p.end.slice(0, 10))} 前</td><td>${["input", "cached", "write", "output"].map((k) => e(p.quote[k] ?? "—")).join(" / ")}</td><td><a href="${e(p.snapshotSource)}" target="_blank" rel="noopener noreferrer">ModelRadar 日期快照</a><br><a href="${e(p.source)}" target="_blank" rel="noopener noreferrer">供应商来源</a><br>${e(p.sourceType === "provider" ? "供应商数据" : "备用数据，不参与计算")}</td></tr>`,
          )
          .join("") +
        "</tbody></table>";
    };
    q("[data-sync-value]", dialog).onclick = async () => {
      const button = q("[data-sync-value]", dialog);
      button.disabled = true;
      q("[data-value-status]", dialog).textContent = "正在同步…";
      try {
        const result = await api("POST", "/api/usage/value/sync", {});
        if (!dialog.isConnected) return;
        await paint();
        if (result.errors?.length)
          q("[data-value-status]", dialog).textContent +=
            " · " + result.errors.map((r) => r.error).join("；");
        if (result.status === "running") {
          q("[data-value-status]", dialog).textContent =
            "后台同步中，当前筛选继续使用本地证据";
          const poll = async () => {
            if (!dialog.isConnected) return;
            try {
              const next = await api("GET", "/api/usage/value");
              if (next.refreshing) {
                state.valuePoll = setTimeout(poll, 1000);
                return;
              }
              await paint();
              q("[data-value-status]", dialog).textContent += next.task?.errors
                ?.length
                ? " · 部分来源同步失败"
                : "";
              root.dispatchEvent(
                new CustomEvent("usage-value-refresh", { bubbles: true }),
              );
            } catch (error) {
              if (dialog.isConnected)
                q("[data-value-status]", dialog).textContent = error.message;
            }
          };
          state.valuePoll = setTimeout(poll, 1000);
        } else
          root.dispatchEvent(
            new CustomEvent("usage-value-refresh", { bubbles: true }),
          );
      } catch (error) {
        if (dialog.isConnected)
          q("[data-value-status]", dialog).textContent = error.message;
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
    const surface = "var(--color-surface, var(--surface))";
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
    const filterKey = JSON.stringify([
      state.scope,
      Object.fromEntries(
        Object.entries(s.query || {}).filter(
          ([k]) => !["value_currency", "cost_currency"].includes(k),
        ),
      ),
      s.range?.start,
      s.range?.end,
    ]);
    if (state.trendFilterKey && state.trendFilterKey !== filterKey) {
      state.trendRows = null;
      state.trendViewport = null;
      state.trendAbort?.abort();
      state.trendTicket++;
    }
    state.trendFilterKey = filterKey;
    const trendDaily = state.trendRows || daily,
      plot = q(".usage-plot", root),
      button = q("[data-chart-mode]", root),
      pie = q(".usage-interactive-pie", root),
      series = trendDaily.map((r) => ({
        date: r.date,
        endDate: r.endDate,
        total: r.total,
        models: r.models || [],
        provided: r.provided,
      }));
    plot.dataset.experimental = String(cash && agentScope(state.scope));
    pie.dataset.experimental = String(cash && agentScope(state.scope));
    plot.dataset.transition =
      plot.dataset.metric && plot.dataset.metric !== (cash ? "cost" : "token")
        ? "vertical"
        : "reveal";
    plot.dataset.metric = cash ? "cost" : "token";
    pie.dataset.metric = cash ? "cost" : "token";
    q(".usage-chart-heading h3", root).textContent = cash
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
    if (cash && agentScope(state.scope)) {
      q(".usage-chart-heading h3", root).textContent = "每日 API 等价值 · 实验";
      q(".usage-pie-heading h3", root).textContent =
        "模型等价值占比" + (valued.summary.costUnknown ? "（已知）" : "");
    }
    if (state.trendViewport) {
      q("[data-viewport-label]", root).textContent =
        state.trendViewport.start +
        " — " +
        state.trendViewport.end +
        " · " +
        ({ day: "按日", week: "按周聚合", month: "按月聚合" }[
          state.trendGranularity
        ] || "读取中") +
        " · 仅趋势视窗";
      const key = [cash, cash ? currency : "", state.snapshot.dataVersion].join(
        ":",
      );
      if (state.trendLastMetric && state.trendLastMetric !== key) {
        state.trendLastMetric = key;
        clearTimeout(state.trendTimer);
        state.trendTimer = setTimeout(() => loadTrend(root, state), 100);
      }
    } else
      q("[data-viewport-label]", root).textContent =
        "鼠标滚轮缩放趋势日期；不改变其他统计";
    if (plot.dataset.valueCurrency && plot.dataset.valueCurrency !== currency)
      plot.dataset.transition = "vertical";
    plot.dataset.valueCurrency = currency || "";
    const trendKey = JSON.stringify([series, state.mode, keys, cash, currency]);
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
    const known = trendDaily.filter((r) => Number.isFinite(r.total));
    q("[data-trend-peak]", root).textContent =
      (cash && known.length < trendDaily.length ? "已知峰值 " : "视窗峰值 ") +
      (known.length
        ? cash
          ? money(Math.max(0, ...known.map((r) => r.total)))
          : fmt(Math.max(0, ...known.map((r) => r.total)))
        : "—");
  }
  function table(root, state, index, animated = false) {
    const s = state.snapshot;
    if (!s) return;
    const valued = valueSnapshot(state),
      cash =
        agentScope(state.scope) && !!valued && state.metrics["table" + index];
    const section = all("[data-usage-table]", root)[index],
      model = q("[data-table-model]", section),
      sort = q("[data-table-sort]", section),
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
          cash ? "API 等价值 · 实验" : "Token",
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
                "API 等价值 · 实验",
              ]
            : ["输入", "输出", "缓存", "推理", "Token"]),
          "请求 / 失败",
        ];
    all("th", section).forEach((th, i) => {
      if (th.textContent !== headers[i]) th.textContent = headers[i];
    });
    [...sort.options]
      .filter((o) => o.value.startsWith("token"))
      .forEach((o) => {
        o.textContent =
          (cash ? "API 等价值" : "Token") +
          (o.value.endsWith("asc") ? " · 从低到高" : " · 从高到低");
      });
    options(
      model,
      s.options.model || [...new Set(entries.map((r) => r.model))].sort(),
      "全部模型",
    );
    model._modelPicker.load();
    model._modelPicker.update(
      s.options.model || [...new Set(entries.map((r) => r.model))],
    );
    const chosen = model._modelPicker.get();
    const [key, direction] = sort.value.split("-"),
      rows = entries
        .filter((r) => !chosen.length || chosen.includes(r.model))
        .sort((a, b) => {
          const metric = (r) =>
            cash
              ? index
                ? r.cost == null
                  ? null
                  : Number(r.cost)
                : r.pricedRequests
                  ? r.costs?.[valued.costCurrency]
                  : null
              : r.total;
          const av = key === "date" ? Date.parse(a.at) : metric(a),
            bv = key === "date" ? Date.parse(b.at) : metric(b);
          if (av == null || !Number.isFinite(av))
            return bv != null && Number.isFinite(bv) ? 1 : 0;
          if (bv == null || !Number.isFinite(bv)) return -1;
          return (av - bv) * (direction === "asc" ? 1 : -1);
        });
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
          `<tr data-model="${e(r.model)}" data-at="${e(r.at)}" data-total="${r.total ?? ""}">${index ? `<td>${e(timestampFormat.format(new Date(r.at)))}</td><td>${e(r.agent)}</td><td>${e(r.model)}${r.requested_model ? `<br><small>${e(r.requested_model)}</small>` : ""}</td><td title="${Number.isFinite(r.total) ? full(r.total) + " Token" : "未返回用量"}">${amount(r, "total")}</td><td>${r.status === "error" ? "失败" : "已记录"}</td><td>${r.duration_ms ? fmt(r.duration_ms) + " ms" : "—"}</td>` : `<td>${r.at ? e(dateFormat.format(new Date(r.at))) : "—"}</td><td>${e(r.source === "official-api" ? "官方 API" : r.source)}${r.agent ? " / " + e(r.agent) : ""}</td><td>${e(r.provider)}<br><small>${e(r.model)}</small></td>${["input", "output", "cached", "reasoning", "total"].map((k) => `<td title="${Number.isFinite(r[k]) ? full(r[k]) : "未返回"}">${amount(r, k)}</td>`).join("")}<td>${s.aggregated ? (Number.isFinite(r.platformRequests) ? fmt(r.platformRequests) : "—") : fmt(r.requests) + " / " + fmt(r.failures)}</td>`}</tr>`,
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
      entering = state.scope !== scope;
    if (
      agentScope(scope) &&
      (entering || !s.pricing?.enabled || !state.snapshot?.pricing?.enabled)
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
      b.hidden = !valued;
      b.textContent = currency === "USD" ? "$" : "￥";
      b.title = agentScope(scope)
        ? "切换 Token／API 等价值（实验）"
        : "切换 Token／费用";
      b.setAttribute("aria-label", b.title);
    });
    all("[data-table-money]", root).forEach((b) => {
      b.hidden = !agentScope(scope) || !valued;
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
      number(el, Number.isFinite(n) ? n : null, "money");
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
      number(el, unknown ? null : lifetime[i], true, i > 1 ? " 天" : "");
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
      number(el, summary[i], true);
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
      features[state.scope + "ValuationEnabled"]
    )
      return;
    for (const key of Object.keys(state.metrics)) state.metrics[key] = false;
    all("[data-metric],[data-table-money]", root).forEach((b) =>
      b.setAttribute("aria-pressed", "false"),
    );
    state.trendAbort?.abort();
    state.trendTicket++;
    state.trendRows = null;
    state.trendValueKey = "";
    update(root, {
      ...state.snapshot,
      pricing: { ...state.snapshot.pricing, enabled: false },
      valuation: null,
    });
  }
  window.usageView = { init, update, number, options, heatColor, policy };
})();
