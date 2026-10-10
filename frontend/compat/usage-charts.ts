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
  const integerFormat = new Intl.NumberFormat("zh-CN");
  const full = (n) => integerFormat.format(typeof n==="bigint"?n:typeof n==="string"&&/^\d+$/.test(n)?BigInt(n):Number(n||0));
  const moneyFormats = new Map();
  const num = (n) =>
    Number(n || 0) >= 100000000
      ? (Number(n) / 100000000).toFixed(2) + " 亿"
      : Number(n || 0) >= 10000
        ? (Number(n) / 10000).toFixed(2) + " 万"
        : full(n);
  function moneyFormat(a) {
    const digits = a > 0 && a < 1e-6 ? 12 : a > 0 && a < 1 ? 6 : 2;
    if (!moneyFormats.has(digits))
      moneyFormats.set(
        digits,
        new Intl.NumberFormat("zh-CN", {
          minimumFractionDigits: 2,
          maximumFractionDigits: digits,
        }),
      );
    return moneyFormats.get(digits);
  }
  const money = (n, currency = "CNY") => {
    const v = Number(n),
      a = Math.abs(v);
    return (
      (currency === "USD" ? "$" : "￥") +
      (a >= 10000
        ? num(v)
        : a > 0 && a < 1e-12
          ? v.toPrecision(2)
          : moneyFormat(a).format(v))
    );
  };
  const value = (host, n) =>
    host.dataset.format === "rate"
      ? Number(n).toFixed(6)
      : host.dataset.metric === "cost"
        ? money(n, host.dataset.currency)
        : num(n);
  const unit = (host) =>
    host.dataset.unit || (host.dataset.metric === "cost" ? "" : " Token");
  const updates = new WeakMap();
  const cleanups = new WeakMap(),
    hosts = new Set();
  let sequence = 0;
  const colors = Array.from(
    { length: 6 },
    (_, i) => `--color-usage-chart-${i + 1}`,
  );
  function register(host, cleanup) {
    const list = cleanups.get(host) || [];
    list.push(cleanup);
    cleanups.set(host, list);
    hosts.add(host);
  }
  function dispose(root) {
    [...hosts]
      .filter((host) => host === root || root.contains(host))
      .forEach((host) => {
        (cleanups.get(host) || []).forEach((fn) => fn());
        cleanups.delete(host);
        hosts.delete(host);
      });
  }
  new MutationObserver(() => {
    for (const host of hosts) if (!host.isConnected) dispose(host);
  }).observe(document.body, { childList: true, subtree: true });
  function tooltip(host, reset) {
    host.classList.add("usage-chart-host");
    const tip = document.createElement("div");
    tip.className = "usage-tooltip";
    tip.id = "usage-tooltip-" + ++sequence;
    tip.role = "tooltip";
    tip.hidden = true;
    let lastMarkup = '';
    host.append(tip);
    const outside = (ev) => {
      if (!host.contains(ev.target)) {
        tip.hidden = true;
        reset?.();
      }
    };
    document.addEventListener("pointerdown", outside);
    register(host, () => {
      document.removeEventListener("pointerdown", outside);
      tip.remove();
    });
    return {
      id: tip.id,
      hide: () => {
        tip.hidden = true;
      },
      show: (text, x, y) => {
        const markup=window.LingxiDesign.tooltipMarkup(text);
        if(markup!==lastMarkup){tip.innerHTML=markup;lastMarkup=markup;}
        tip.hidden = false;
        if(host.clientWidth < tip.offsetWidth + 16){
          tip.style.position="fixed";
          tip.style.left=Math.max(12,Math.min(x+12,innerWidth-tip.offsetWidth-12))+"px";
          tip.style.top=Math.max(12,Math.min(y-tip.offsetHeight-12,innerHeight-tip.offsetHeight-12))+"px";
          return;
        }
        tip.style.position="absolute";
        const rect = host.getBoundingClientRect(),
          sx = host.clientWidth / Math.max(1, rect.width),
          sy = host.clientHeight / Math.max(1, rect.height);
        const left = (x - rect.left) * sx + 12,
          top = (y - rect.top) * sy - tip.offsetHeight - 12;
        tip.style.left =
          Math.max(8, Math.min(left, host.clientWidth - tip.offsetWidth - 8)) +
          "px";
        tip.style.top =
          Math.max(
            8,
            Math.min(
              top < 8 ? (y - rect.top) * sy + 12 : top,
              host.clientHeight - tip.offsetHeight - 8,
            ),
          ) + "px";
      },
    };
  }
  const modelKey = (r) =>
    JSON.stringify([r.provider || "", r.model || "未区分模型"]);
  const highlight = (host, key) =>
    host
      .closest(".usage-charts")
      ?.dispatchEvent(
        new CustomEvent("usage-model-highlight", { detail: key }),
      );
  const modelColor = (key) => {
    let hash = 2166136261;
    for (const c of String(key)) {
      hash ^= c.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `hsl(${(hash >>> 0) % 360} 62% 46%)`;
  };
  function heatSeries(activity, mode = "day") {
    const rows = activity.map((r) => ({
      ...r,
      ...(r.unknown > 0 ? { provided: false } : {}),
    }));
    if (mode === "week") {
      const weeks = new Map();
      for (const r of rows) {
        const d = new Date(r.date + "T00:00:00Z");
        d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
        r.week = d.toISOString().slice(0, 10);
        const w = weeks.get(r.week) || { total: 0, requests: 0, unknown: 0 };
        w.total += r.total || 0;
        w.requests += r.requests || 0;
        w.unknown += r.provided === false ? 1 : 0;
        weeks.set(r.week, w);
      }
      return rows.map((r) => ({
        ...r,
        ...weeks.get(r.week),
        provided: weeks.get(r.week).unknown ? false : r.provided,
        caption: r.week + " 所在周",
      }));
    }
    if (mode === "total") {
      let total = 0,
        requests = 0,
        unknown = 0;
      for (const row of rows) {
        total += row.total || 0;
        requests += row.requests || 0;
        unknown += row.unknown || 0;
        Object.assign(row, {
          total: row.cumulativeTotal ?? total,
          requests: row.cumulativeRequests ?? requests,
          provided:
            (row.cumulativeUnknown ?? unknown) > 0
              ? false
              : row.cumulativeRequests === 0
                ? row.provided
                : true,
          caption: row.date + " 及以前累计",
        });
      }
      return rows;
    }
    return rows.map((r) => ({ ...r, caption: r.date }));
  }
  function trend(rows, label = "每日 Token 趋势", mode = "line", groups = []) {
    const series = rows.map((r) => ({
      date: r.date || r.startDate,
      total: r.total ?? r.tokens ?? null,
      models: r.models || [],
    }));
    const keys = [...new Set(groups.map(modelKey))].sort((a, b) =>
      a.localeCompare(b),
    );
    return `<div class="usage-plot" data-series="${escape(JSON.stringify(series))}" data-mode="${mode === "bar" ? "bar" : "line"}" data-model-keys="${escape(JSON.stringify(keys))}"><svg class="usage-trend" tabindex="0" role="group" aria-label="${escape(label)}，左右方向键查看每日用量" viewBox="0 0 700 260"></svg></div>`;
  }
  function point(svg, x, y) {
    const matrix = svg.getScreenCTM();
    return matrix ? new DOMPoint(x, y).matrixTransform(matrix.inverse()) : null;
  }
  function smooth(points) {
    if (!points.length) return "";
    if (points.length === 1) return `M ${points[0].join(" ")}`;
    const slopes = points
      .slice(1)
      .map(
        (p, i) => (p[1] - points[i][1]) / Math.max(0.001, p[0] - points[i][0]),
      );
    const tangents = points.map((_, i) =>
      i === 0
        ? slopes[0]
        : i === points.length - 1
          ? slopes.at(-1)
          : slopes[i - 1] * slopes[i] <= 0
            ? 0
            : (slopes[i - 1] + slopes[i]) / 2,
    );
    slopes.forEach((d, i) => {
      if (d === 0) {
        tangents[i] = tangents[i + 1] = 0;
        return;
      }
      const a = tangents[i] / d,
        b = tangents[i + 1] / d,
        n = Math.hypot(a, b);
      if (n > 3) {
        tangents[i] = ((3 * a) / n) * d;
        tangents[i + 1] = ((3 * b) / n) * d;
      }
    });
    return (
      `M ${points[0].join(" ")}` +
      points
        .slice(1)
        .map((p, i) => {
          const prev = points[i],
            dx = (p[0] - prev[0]) / 3;
          return ` C ${prev[0] + dx} ${prev[1] + dx * tangents[i]} ${p[0] - dx} ${p[1] - dx * tangents[i + 1]} ${p.join(" ")}`;
        })
        .join("")
    );
  }
  function mountTrend(host) {
    if (host.dataset.chartMounted) return;
    host.dataset.chartMounted = "true";
    host.classList.add("usage-chart-host");
    const svg = host.querySelector("svg");
    svg.setAttribute("preserveAspectRatio", "none");
    let rows = JSON.parse(host.dataset.series),
      mode = host.dataset.mode,
      keys = JSON.parse(host.dataset.modelKeys || "[]"),
      active = -1,
      layout,
      baseLayout,
      animation,
      animated = false,
      drawWidth = null,
      resizeFrame,
      morphFrame,
      geometry = new Map();
    const valid = (r) =>
      typeof r.total === "number" && Number.isFinite(r.total) && r.total >= 0;
    const reset = () => {
      active = -1;
      tip.hide();
      svg
        .querySelector(".usage-crosshair")
        ?.setAttribute("visibility", "hidden");
      svg
        .querySelectorAll(".is-active")
        .forEach((e) => e.classList.remove("is-active"));
      highlight(host, null);
    };
    const tip = tooltip(host, reset);
    svg.setAttribute("aria-describedby", tip.id);
    const show = (index, clientX, clientY, segment) => {
      if (!rows.length) return;
      active = Math.max(0, Math.min(rows.length - 1, index));
      const row = rows[active],
        x = layout.x(active),
        y = layout.y(row.total || 0),
        mark = svg.querySelector(".usage-crosshair");
      mark.setAttribute("visibility", "visible");
      mark.querySelector("line").setAttribute("x1", x);
      mark.querySelector("line").setAttribute("x2", x);
      mark.querySelector("circle").setAttribute("cx", x);
      mark.querySelector("circle").setAttribute("cy", y);
      mark
        .querySelector("circle")
        .setAttribute("visibility", valid(row) ? "visible" : "hidden");
      svg
        .querySelectorAll(".usage-bar.is-active")
        .forEach((e) => e.classList.remove("is-active"));
      segment?.classList.add("is-active");
      highlight(host, segment?.dataset.modelKey || null);
      const screen = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM());
      let text = valid(row)
        ? `${row.date}\n${row.provided === false ? "已知 " : ""}${value(host, row.total)}${unit(host)}${host.dataset.experimental === "true" ? " · API 等价值（实验）" : ""}`
        : `${row.date}\n${host.dataset.experimental === "true" ? "该日等价值未知" : "平台未返回该日" + (host.dataset.metric === "cost" ? "费用" : "用量")}`;
      const detailRows = segment ? [{ label: segment.dataset.model, value: value(host, Number(segment.dataset.total)) + unit(host), color: segment.getAttribute("fill") || "#2563EB" }] : (row.models || []).map((m,i)=>({ label:m.model, value:value(host,m.total)+unit(host), color:"#2563EB" }));
      tip.show({primary:valid(row)?value(host,row.total)+unit(host):"未返回",date:row.date,rows:detailRows}, clientX ?? screen.x, clientY ?? screen.y);
    };
    const clipId = "usage-reveal-" + ++sequence;
    const draw = () => {
      if (!host.isConnected) return;
      const width = Math.max(220, Math.round(svg.clientWidth || 700));
      if (drawWidth === width) return;
      drawWidth = width;
      animation?.cancel();
      cancelAnimationFrame(morphFrame);
      const vertical = host.dataset.transition === "vertical",
        oldGeometry = geometry;
      geometry = new Map();
      const parts = [];
      const previous = vertical
        ? null
        : svg.querySelector(".usage-chart-data")?.cloneNode(true);
      if (previous) previous.removeAttribute("clip-path");
      const height = 260,
        top = 30,
        bottom = 215;
      const max = Math.max(
          host.dataset.metric === "cost" ? 0.000001 : 1,
          ...rows.filter(valid).map((r) => r.total),
        ),
        rough = max / 4,
        unitSize = 10 ** Math.floor(Math.log10(rough));
      const step = Math.max(
          host.dataset.metric === "cost" ? 0.0000001 : 1,
          [1, 2, 5, 10].find((n) => n * unitSize >= rough) * unitSize,
        ),
        upper = Math.ceil(max / step) * step;
      const measure = document.createElement("canvas").getContext("2d");
      measure.font = "12px " + getComputedStyle(svg).fontFamily;
      const left = Math.max(
          96,
          Math.ceil(measure.measureText(value(host, upper)).width) + 18,
        ),
        right = width - 16;
      const times = rows.map((r) => Date.parse(r.date)),
        span = times.at(-1) - times[0],
        dated = times.every(Number.isFinite) && span > 0;
      const barPad =
        mode === "bar"
          ? Math.min(28, (right - left) / Math.max(1, rows.length) / 2)
          : 0;
      layout = {
        left,
        right,
        x: (i) =>
          rows.length < 2
            ? (left + right) / 2
            : left +
              barPad +
              (dated ? (times[i] - times[0]) / span : i / (rows.length - 1)) *
                (right - left - 2 * barPad),
        y: (n) => bottom - (n / upper) * (bottom - top),
      };
      layout.nearest = (x) => {
        const ratio = Math.max(
          0,
          Math.min(
            1,
            (x - left - barPad) / Math.max(1, right - left - 2 * barPad),
          ),
        );
        if (!dated) return Math.round(ratio * (rows.length - 1));
        const target = times[0] + ratio * span;
        return times.reduce(
          (best, t, i) =>
            Math.abs(t - target) < Math.abs(times[best] - target) ? i : best,
          0,
        );
      };
      baseLayout = layout;
      const ticks = Array.from(
          { length: Math.round(upper / step) + 1 },
          (_, i) => i * step,
        ),
        count = Math.min(width < 420 ? 3 : 5, rows.length);
      const indices = [
        ...new Set(
          Array.from({ length: count }, (_, i) =>
            Math.round((i / Math.max(1, count - 1)) * (rows.length - 1)),
          ),
        ),
      ];
      const tickLabel = (n) => value(host, n);
      let chart = "";
      if (mode === "bar") {
        const barWidth = Math.max(
          1,
          Math.min(42, ((right - left) / Math.max(1, rows.length)) * 0.7),
        );
        rows.forEach((row, i) => {
          if (!valid(row)) return;
          let cumulative = 0;
          const models = row.models.length
            ? [...row.models]
            : [{ model: "未区分模型", provider: "", total: row.total }];
          models
            .filter((m) => m.total > 0)
            .sort((a, b) => modelKey(a).localeCompare(modelKey(b)))
            .forEach((m) => {
              const y = layout.y(cumulative + m.total),
                h = layout.y(cumulative) - y;
              cumulative += m.total;
              const color = modelColor(modelKey(m)),
                key = JSON.stringify([row.date, modelKey(m)]),
                interactive = h >= 6 && m.total / row.total >= 0.02;
              geometry.set(key, { y, h });
              chart += `<rect class="usage-bar" ${interactive ? 'tabindex="0" role="img"' : ""} data-interactive="${interactive}" data-geometry="${escape(key)}" data-day="${i}" data-model-key="${escape(modelKey(m))}" data-model="${escape(m.model)}" data-total="${m.total}" ${interactive ? `aria-label="${escape(row.date)} ${escape(m.model)} ${value(host, m.total)}${unit(host)}"` : ""} x="${layout.x(i) - barWidth / 2}" y="${y}" width="${barWidth}" height="${h}" fill="${color}"/>`;
            });
        });
      } else {
        let part = [],
          dates = [];
        const emit = () => {
          if (!part.length) return;
          parts.push({ points: part, dates });
          chart += `<path class="usage-chart-area" style="fill:url(#${clipId}-area)" d="${smooth(part)} L ${part.at(-1)[0]} ${bottom} L ${part[0][0]} ${bottom} Z"/><path class="usage-smooth-line" d="${smooth(part)}"/>`;
          if (part.length === 1)
            chart += `<circle class="usage-trend-point" cx="${part[0][0]}" cy="${part[0][1]}" r="3"/>`;
          part = [];
          dates = [];
        };
        rows.forEach((row, i) => {
          if (valid(row)) {
            const y = layout.y(row.total);
            part.push([layout.x(i), y]);
            dates.push(row.date);
            geometry.set(row.date, { y });
          } else emit();
        });
        emit();
      }
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      svg.innerHTML = `<defs><linearGradient id="${clipId}-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="var(--accent, #1683ff)" stop-opacity=".34"/><stop offset="100%" stop-color="var(--accent, #1683ff)" stop-opacity=".03"/></linearGradient><clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><rect class="usage-reveal" x="${left - 2}" y="0" width="${right - left + 4}" height="260"/></clipPath></defs><text class="usage-chart-label" x="${left}" y="16">${escape(host.dataset.axisLabel || (host.dataset.format === "rate" ? "CNY / USD" : host.dataset.metric === "cost" ? (host.dataset.currency === "USD" ? "$" : "￥") : "Token"))}</text>${ticks.map((v) => `<line class="usage-gridline" x1="${left}" x2="${right}" y1="${layout.y(v)}" y2="${layout.y(v)}"/><text class="usage-chart-label" text-anchor="end" x="${left - 8}" y="${layout.y(v) + 4}">${escape(tickLabel(v))}</text>`).join("")}<path class="usage-coordinate-axis usage-main-axis" d="M ${left} ${top - 8} V ${bottom} H ${right + 7}"/><path class="usage-axis-arrow" d="M ${left - 4} ${top - 3} L ${left} ${top - 9} L ${left + 4} ${top - 3} M ${right + 2} ${bottom - 4} L ${right + 8} ${bottom} L ${right + 2} ${bottom + 4}"/>${indices.map((i) => `<line class="usage-coordinate-axis usage-date-mark" data-base-x="${layout.x(i)}" x1="${layout.x(i)}" x2="${layout.x(i)}" y1="${bottom}" y2="${bottom + 4}"/><text class="usage-chart-label usage-date-tick" data-base-x="${layout.x(i)}" text-anchor="${i === 0 ? "start" : i === rows.length - 1 ? "end" : "middle"}" x="${layout.x(i)}" y="${bottom + 20}">${escape(String(rows[i].date).slice(5))}</text>`).join("")}<text class="usage-chart-label usage-date-axis-label" text-anchor="end" x="${right}" y="255">日期</text><g class="usage-chart-data" clip-path="url(#${clipId})">${chart}</g>${!rows.some(valid) ? '<text class="usage-chart-label usage-no-data" text-anchor="middle" x="' + (left + right) / 2 + '" y="120">暂无用量</text>' : ""}<g class="usage-crosshair" visibility="hidden"><line y1="${top}" y2="${bottom}"/><circle r="4"/></g>`;
      svg
        .querySelectorAll(".usage-bar[data-interactive=true]")
        .forEach((bar) => {
          bar.addEventListener("focus", () =>
            show(Number(bar.dataset.day), undefined, undefined, bar),
          );
          bar.addEventListener("blur", reset);
        });
      if (
        vertical &&
        oldGeometry.size &&
        !(
          document.documentElement.dataset.motion === "reduced" ||
          matchMedia("(prefers-reduced-motion: reduce)").matches
        )
      ) {
        const started = performance.now(),
          targets = new Map(geometry),
          bars = [...svg.querySelectorAll(".usage-bar")],
          lines = [...svg.querySelectorAll(".usage-smooth-line")],
          areas = [...svg.querySelectorAll(".usage-chart-area")],
          dots = [...svg.querySelectorAll(".usage-trend-point")];
        const paint = (t) => {
          for (const [key, to] of targets) {
            const from = oldGeometry.get(key) || { y: bottom, h: 0 };
            geometry.set(key, {
              y: from.y + (to.y - from.y) * t,
              h:
                to.h === undefined
                  ? undefined
                  : (from.h || 0) + (to.h - (from.h || 0)) * t,
            });
          }
          bars.forEach((bar) => {
            const p = geometry.get(bar.dataset.geometry);
            bar.setAttribute("y", p.y);
            bar.setAttribute("height", p.h);
          });
          let dot = 0;
          parts.forEach((part, i) => {
            const points = part.points.map(([x], j) => [
                x,
                geometry.get(part.dates[j]).y,
              ]),
              d = smooth(points);
            lines[i].setAttribute("d", d);
            areas[i].setAttribute(
              "d",
              d +
                ` L ${points.at(-1)[0]} ${bottom} L ${points[0][0]} ${bottom} Z`,
            );
            if (points.length === 1)
              dots[dot++]?.setAttribute("cy", points[0][1]);
          });
        };
        paint(0);
        const tick = (now) => {
          if (!host.isConnected) return;
          const p = Math.min(1, (now - started) / 420);
          paint(1 - (1 - p) ** 3);
          if (p < 1) morphFrame = requestAnimationFrame(tick);
        };
        morphFrame = requestAnimationFrame(tick);
        host.dataset.lastAnimation = "vertical";
      } else if (
        !animated &&
        !(
          document.documentElement.dataset.motion === "reduced" ||
          matchMedia("(prefers-reduced-motion: reduce)").matches
        )
      ) {
        const clip = svg.querySelector(".usage-reveal");
        animation = clip.animate(
          [{ width: "0px" }, { width: `${right - left + 4}px` }],
          { duration: 220, easing: "cubic-bezier(.2,.6,.35,1)" },
        );
        host.dataset.lastAnimation = "reveal";
      }
      if (
        previous &&
        !(
          document.documentElement.dataset.motion === "reduced" ||
          matchMedia("(prefers-reduced-motion: reduce)").matches
        )
      ) {
        previous.setAttribute("class", "usage-chart-ghost");
        previous.setAttribute("pointer-events", "none");
        previous.setAttribute("aria-hidden", "true");
        previous
          .querySelectorAll("[tabindex]")
          .forEach((node) => node.removeAttribute("tabindex"));
        previous
          .querySelectorAll(".usage-bar")
          .forEach((node) => node.classList.remove("usage-bar"));
        svg.querySelector(".usage-chart-data").before(previous);
        const a = previous.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 220,
        });
        a.onfinish = () => previous.remove();
      }
      animated = true;
      if (active >= 0) show(active);
    };
    const move = (ev) => {
      const bar = ev.target.closest?.(".usage-bar");
      if (bar?.dataset.interactive === "false") {
        reset();
        return;
      }
      const p = point(svg, ev.clientX, ev.clientY);
      if (p) show(layout.nearest(p.x), ev.clientX, ev.clientY, bar);
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerdown", move);
    svg.addEventListener("pointerleave", (ev) => {
      if (ev.pointerType !== "touch") reset();
    });
    svg.addEventListener("pointercancel", reset);
    svg.addEventListener("blur", reset);
    svg.addEventListener("keydown", (ev) => {
      let index = active < 0 ? 0 : active;
      if (ev.key === "ArrowRight") index++;
      else if (ev.key === "ArrowLeft") index--;
      else if (ev.key === "Home") index = 0;
      else if (ev.key === "End") index = rows.length - 1;
      else if (ev.key === "Escape") {
        reset();
        return;
      } else return;
      ev.preventDefault();
      show(index);
    });
    const stretch = () => {
      if (!baseLayout || !host.isConnected) return;
      const width = Math.max(220, Math.round(svg.clientWidth || 700)),
        { left } = baseLayout,
        right = width - 16,
        scale = (right - left) / (baseLayout.right - left);
      svg.setAttribute("viewBox", `0 0 ${width} 260`);
      layout = {
        ...baseLayout,
        right,
        x: (i) => left + (baseLayout.x(i) - left) * scale,
        nearest: (x) => baseLayout.nearest(left + (x - left) / scale),
      };
      svg
        .querySelector(".usage-chart-data")
        ?.setAttribute(
          "transform",
          `translate(${left} 0) scale(${scale} 1) translate(${-left} 0)`,
        );
      svg
        .querySelectorAll(".usage-gridline")
        .forEach((n) => n.setAttribute("x2", right));
      svg
        .querySelector(".usage-main-axis")
        ?.setAttribute("d", `M ${left} 22 V 215 H ${right + 7}`);
      svg
        .querySelector(".usage-axis-arrow")
        ?.setAttribute(
          "d",
          `M ${left - 4} 27 L ${left} 21 L ${left + 4} 27 M ${right + 2} 211 L ${right + 8} 215 L ${right + 2} 219`,
        );
      svg.querySelectorAll(".usage-date-tick,.usage-date-mark").forEach((n) => {
        const x = left + (Number(n.dataset.baseX) - left) * scale;
        if (n.tagName === "line") {
          n.setAttribute("x1", x);
          n.setAttribute("x2", x);
        } else n.setAttribute("x", x);
      });
      svg.querySelector(".usage-date-axis-label")?.setAttribute("x", right);
      svg
        .querySelector(".usage-no-data")
        ?.setAttribute("x", (left + right) / 2);
      svg.querySelectorAll(".usage-chart-ghost").forEach((n) => n.remove());
      if (active >= 0) show(active);
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(stretch);
    });
    observer.observe(svg);
    register(host, () => {
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
      animation?.cancel();
      cancelAnimationFrame(morphFrame);
      updates.delete(host);
    });
    updates.set(host, () => {
      reset();
      rows = JSON.parse(host.dataset.series);
      mode = host.dataset.mode;
      keys = JSON.parse(host.dataset.modelKeys || "[]");
      drawWidth = null;
      animated = false;
      draw();
    });
    draw();
  }
  function ring(start, end) {
    const p = (angle, r) =>
      [
        100 + Math.sin((angle * Math.PI) / 180) * r,
        100 - Math.cos((angle * Math.PI) / 180) * r,
      ].join(" ");
    if (end - start >= 359.999)
      return "M 100 25 A 75 75 0 1 1 100 175 A 75 75 0 1 1 100 25 L 100 57 A 43 43 0 1 0 100 143 A 43 43 0 1 0 100 57 Z";
    const large = end - start > 180 ? 1 : 0;
    return `M ${p(start, 75)} A 75 75 0 ${large} 1 ${p(end, 75)} L ${p(end, 43)} A 43 43 0 ${large} 0 ${p(start, 43)} Z`;
  }
  function donutModels(groups) {
    const models = new Map();
    for (const g of groups) {
      if (g.total <= 0) continue;
      const key = JSON.stringify([g.provider, g.model]),
        old = models.get(key);
      if (old) old.total += g.total;
      else
        models.set(key, {
          provider: g.provider,
          model: g.model,
          total: g.total,
        });
    }
    const keys = [...new Set(groups.map(modelKey))].sort((a, b) =>
      a.localeCompare(b),
    );
    const rows = [...models.values()]
        .sort(
          (a, b) => b.total - a.total || modelKey(a).localeCompare(modelKey(b)),
        )
        .map((r) => ({ ...r, color: modelColor(modelKey(r)) })),
      total = rows.reduce((sum, r) => sum + r.total, 0);
    if (!total) return [];
    let angle = 0;
    rows.forEach((row) => {
      row.start = angle;
      angle += (row.total / total) * 360;
      row.end = angle;
    });
    return rows;
  }
  function legendHTML(rows, host = { dataset: {} }) {
    const total = rows.reduce((sum, r) => sum + r.total, 0),
      max = Math.max(1, ...rows.map((r) => r.total));
    return rows
      .map(
        (r, i) =>
          `<div data-pie-legend="${i}" tabindex="0" role="button" aria-label="${escape(r.model)} ${value(host, r.total)}${unit(host)}"><span class="usage-model-name">${escape(r.model)}<small>${escape(r.provider)}</small></span><span class="usage-model-bar"><i style="background:${r.color};--model-width:${(r.total / max) * 100}%"></i></span><span class="usage-model-value"><b>${value(host, r.total)}</b><small>${((r.total / total) * 100).toFixed(1)}%</small></span></div>`,
      )
      .join("");
  }
  function donut(groups) {
    const rows = donutModels(groups),
      total = rows.reduce((sum, r) => sum + r.total, 0);
    if (!total) return "";
    return `<div class="usage-pie-layout usage-interactive-pie" data-models="${escape(JSON.stringify(rows))}"><div class="usage-donut interactive"><svg viewBox="0 0 200 200" role="group" aria-label="模型 Token 占比">${rows.map((r, i) => `<path class="usage-segment" data-pie-index="${i}" tabindex="0" role="img" aria-label="${escape(r.model)}，${num(r.total)} Token" d="${ring(r.start, r.end)}" fill="${r.color}"/>`).join("")}</svg><strong>${num(total)}</strong></div><div class="usage-legend">${legendHTML(rows)}</div></div>`;
  }
  function mountDonut(host) {
    if (host.dataset.chartMounted) return;
    host.dataset.chartMounted = "true";
    const svg = host.querySelector("svg");
    let rows = [],
      segments = [],
      animation;
    const reset = () => {
      tip.hide();
      host
        .querySelectorAll(".is-active")
        .forEach((el) => el.classList.remove("is-active"));
    };
    const tip = tooltip(host, reset);
    const group = host.closest(".usage-charts"),
      linked = (event) => {
        host
          .querySelectorAll(".is-active")
          .forEach((el) => el.classList.remove("is-active"));
        const index = rows.findIndex((r) => modelKey(r) === event.detail);
        if (index < 0) return;
        const row = rows[index],
          segment = segments[index],
          angle = (((row.start + row.end) / 2) * Math.PI) / 180;
        segment.style.setProperty("--slice-x", Math.sin(angle) * 2 + "px");
        segment.style.setProperty("--slice-y", -Math.cos(angle) * 2 + "px");
        segment.classList.add("is-active");
        host
          .querySelector(`[data-pie-legend="${index}"]`)
          ?.classList.add("is-active");
      };
    group?.addEventListener("usage-model-highlight", linked);
    register(host, () =>
      group?.removeEventListener("usage-model-highlight", linked),
    );
    const show = (index, x, y) => {
      reset();
      const row = rows[index],
        segment = segments[index];
      if (!row || !segment) return;
      segment.classList.add("is-active");
      host
        .querySelector(`[data-pie-legend="${index}"]`)
        ?.classList.add("is-active");
      const angle = (((row.start + row.end) / 2) * Math.PI) / 180;
      segment.style.setProperty("--slice-x", Math.sin(angle) * 2 + "px");
      segment.style.setProperty("--slice-y", -Math.cos(angle) * 2 + "px");
      tip.show(
        { primary: value(host, row.total) + unit(host), rows: [{ label: row.model, value: value(host, row.total) + unit(host), color: "#2563EB" }] },
        x,
        y,
      );
    };
    const draw = () => {
      reset();
      animation?.cancel();
      rows = JSON.parse(host.dataset.models || "[]");
      svg.innerHTML = rows
        .map(
          (r, i) =>
            `<path class="usage-segment" data-pie-index="${i}" tabindex="0" role="img" aria-label="${escape(r.model)}，${value(host, r.total)}${unit(host)}" aria-describedby="${tip.id}" d="${ring(r.start, r.end)}" fill="${r.color}"/>`,
        )
        .join("");
      segments = [...svg.querySelectorAll(".usage-segment")];
      host.querySelector(".usage-legend").innerHTML = legendHTML(rows, host);
      if (!(
        document.documentElement.dataset.motion === "reduced" ||
        matchMedia("(prefers-reduced-motion: reduce)").matches
      )) {
        animation = svg.animate(
          [
            { transform: "rotate(-65deg) scale(.98)" },
            { transform: "rotate(0deg) scale(1)" },
          ],
          { duration: 240, easing: "cubic-bezier(.2,.7,.3,1)" },
        );
      }
    };
    const move = (ev) => {
      const p = point(svg, ev.clientX, ev.clientY);
      if (!p) return;
      const x = p.x - 100,
        y = p.y - 100,
        r = Math.hypot(x, y);
      if (r < 40 || r > 83) {
        reset();
        return;
      }
      const angle = ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;
      show(
        rows.findIndex((row) => angle >= row.start && angle < row.end),
        ev.clientX,
        ev.clientY,
      );
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerdown", move);
    svg.addEventListener("pointerleave", (ev) => {
      if (ev.pointerType !== "touch") reset();
    });
    svg.addEventListener("pointercancel", reset);
    svg.addEventListener("focusin", (ev) => {
      const segment = ev.target.closest(".usage-segment");
      if (segment) {
        const r = segment.getBoundingClientRect();
        show(
          Number(segment.dataset.pieIndex),
          r.left + r.width / 2,
          r.top + r.height / 2,
        );
      }
    });
    svg.addEventListener("focusout", reset);
    svg.addEventListener("keydown", (ev) => {
      const segment = ev.target.closest(".usage-segment");
      if (!segment) return;
      const i = Number(segment.dataset.pieIndex);
      if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
        ev.preventDefault();
        segments[
          (i + (ev.key === "ArrowRight" ? 1 : segments.length - 1)) %
            segments.length
        ].focus();
      } else if (ev.key === "Escape") reset();
    });
    host
      .querySelector(".usage-legend")
      .addEventListener("pointerover", (ev) => {
        const el = ev.target.closest("[data-pie-legend]");
        if (el) show(Number(el.dataset.pieLegend), ev.clientX, ev.clientY);
      });
    host.querySelector(".usage-legend").addEventListener("pointerleave", reset);
    host.querySelector(".usage-legend").addEventListener("focusin", (ev) => {
      const el = ev.target.closest("[data-pie-legend]");
      if (el) {
        const r = el.getBoundingClientRect();
        show(
          Number(el.dataset.pieLegend),
          r.left + r.width / 2,
          r.top + r.height / 2,
        );
      }
    });
    host.querySelector(".usage-legend").addEventListener("focusout", reset);
    updates.set(host, draw);
    register(host, () => {
      animation?.cancel();
      updates.delete(host);
    });
    draw();
  }
  function mountHeatmap(map) {
    if (map.dataset.chartMounted || !map.children.length) return;
    map.dataset.chartMounted = "true";
    const host = map.parentElement;
    let selected;
    const resize = () => {
      const columns = Math.ceil(map.children.length / 7),
        width = map.clientWidth - 8,
        gap = width < 500 ? 1 : 3;
      map.style.setProperty("--heat-columns", columns);
      map.style.setProperty("--heat-gap", gap + "px");
      map.style.setProperty(
        "--heat-size",
        Math.max(2, (width - gap * (columns - 1)) / columns) + "px",
      );
    };
    const observer = new ResizeObserver(resize);
    observer.observe(map);
    register(host, () => observer.disconnect());
    resize();
    const reset = () => {
      selected?.classList.remove("is-active");
      selected = null;
      tip.hide();
    };
    const tip = tooltip(host, reset);
    map.querySelectorAll(".usage-cell").forEach((cell) => {
      cell.dataset.heatLabel =
        cell.getAttribute("title") ||
        cell.getAttribute("aria-label") ||
        cell.dataset.heatLabel;
      cell.removeAttribute("title");
      cell.setAttribute("aria-describedby", tip.id);
      const show = (ev) => {
        if (selected !== cell) selected?.classList.remove("is-active");
        selected = cell;
        cell.classList.add("is-active");
        const rect = cell.getBoundingClientRect();
        tip.show(
          cell.dataset.heatLabel,
          ev?.clientX ?? rect.left + rect.width / 2,
          ev?.clientY ?? rect.top + rect.height / 2,
        );
      };
      cell.addEventListener("pointerenter", show);
      cell.addEventListener("pointermove", show);
      cell.addEventListener("pointerdown", show);
      cell.addEventListener("pointerleave", (ev) => {
        if (ev.pointerType !== "touch") reset();
      });
      cell.addEventListener("pointercancel", reset);
      cell.addEventListener("focus", () => show());
      cell.addEventListener("blur", reset);
    });
    updates.set(map, () => {
      if (selected) {
        selected.classList.add("is-active");
        const rect = selected.getBoundingClientRect();
        tip.show(
          selected.dataset.heatLabel,
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
      }
    });
    register(host, () => updates.delete(map));
  }
  function mount(root) {
    root.querySelectorAll(".usage-plot").forEach(mountTrend);
    root.querySelectorAll(".usage-interactive-pie").forEach(mountDonut);
    root.querySelectorAll(".usage-heatmap").forEach(mountHeatmap);
  }
  window.usageCharts = {
    trend,
    donut,
    models: donutModels,
    heatSeries,
    mount,
    dispose,
    tooltip,
    format: num,
    full,
    money,
    update: (host) => {
      updates.get(host)?.();
    },
    track: register,
    inspect: () => ({ mounted: hosts.size }),
  };
})();
