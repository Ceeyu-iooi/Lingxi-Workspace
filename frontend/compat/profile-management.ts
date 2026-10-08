// @ts-nocheck
// Compatibility controller: retain the validated interactions during the React migration.
(() => {
  "use strict";
  let token = "";
  const query = location.hash.split("?")[1];
  if (query) {
    token = new URLSearchParams(query).get("maintenance") || "";
    if (token)
      history.replaceState(
        null,
        "",
        location.pathname + location.search + "#/settings/data",
      );
  }
  const request = async (method, route, body) => {
    const response = await fetch(route, {
      method,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-Workbench-Maintenance": token } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "资料操作失败");
    return result;
  };
  const size = (n) => {
    n = n || 0;
    const unit =
        n >= 1073741824
          ? "GiB"
          : n >= 1048576
            ? "MiB"
            : n >= 1024
              ? "KiB"
              : "B",
      factor = { GiB: 1073741824, MiB: 1048576, KiB: 1024, B: 1 }[unit];
    return (
      new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(
        n / factor,
      ) +
      " " +
      unit
    );
  };
  function paintStorage(host, space) {
    if (
      !Array.isArray(space.categories) ||
      !Number.isFinite(space.totalBytes)
    ) {
      host.replaceChildren();
      const note = document.createElement("p");
      note.className = "storage-detail";
      note.textContent = "后台尚未提供空间分类，请重启新版后台后查看饼图。";
      host.append(note);
      for (const [label, key] of [
        ["业务资料目录", "businessBytes"],
        ["用量数据库（包含在业务目录内）", "databaseBytes"],
        ["备份", "backupsBytes"],
        ["浏览器缓存", "browserCacheBytes"],
      ]) {
        const p = document.createElement("p");
        p.textContent =
          label +
          "：" +
          (Number.isFinite(space[key]) ? size(space[key]) : "未返回");
        host.append(p);
      }
      return;
    }
    host.replaceChildren();
    const total = document.createElement("p");
    total.className = "storage-total";
    const caption = document.createElement("small");
    caption.textContent = space.incomplete
      ? "已读取资料空间（部分文件暂不可读）"
      : "资料空间 · 实际文件大小";
    total.append(caption, document.createTextNode(size(space.totalBytes)));
    host.append(total);
    const layout = document.createElement("div");
    layout.className = "storage-chart";
    const ns = "http://www.w3.org/2000/svg",
      svg = document.createElementNS(ns, "svg");
    svg.classList.add("storage-pie");
    svg.setAttribute("viewBox", "0 0 240 240");
    svg.setAttribute("role", "group");
    svg.setAttribute("aria-label", "资料空间占用饼图");
    const colors = [
        "#3976f6",
        "#7c6ee6",
        "#35a596",
        "#e6a544",
        "#d77c8c",
        "#929ba9",
      ],
      legend = document.createElement("ul");
    legend.className = "storage-legend";
    let angle = -Math.PI / 2;
    (space.categories || []).forEach((row, i) => {
      const fraction = space.totalBytes > 0 ? row.bytes / space.totalBytes : 0,
        percent = (fraction * 100).toFixed(1) + "%",
        color = colors[i % colors.length];
      if (fraction > 0) {
        const end = angle + fraction * Math.PI * 2,
          path = document.createElementNS(ns, "path");
        path.setAttribute(
          "d",
          fraction >= 0.999999
            ? "M120 12 A108 108 0 1 1 119.999 12 Z"
            : `M120 120 L${120 + 108 * Math.cos(angle)} ${120 + 108 * Math.sin(angle)} A108 108 0 ${fraction > 0.5 ? 1 : 0} 1 ${120 + 108 * Math.cos(end)} ${120 + 108 * Math.sin(end)} Z`,
        );
        path.setAttribute("fill", color);
        path.setAttribute("tabindex", "0");
        path.setAttribute("role", "img");
        path.setAttribute(
          "aria-label",
          row.label + " " + size(row.bytes) + " " + percent,
        );
        const title = document.createElementNS(ns, "title");
        title.textContent =
          row.label + " · " + size(row.bytes) + " · " + percent;
        path.append(title);
        svg.append(path);
        angle = end;
      }
      const li = document.createElement("li"),
        dot = document.createElement("i"),
        label = document.createElement("span"),
        value = document.createElement("strong"),
        ratio = document.createElement("small");
      dot.style.background = color;
      dot.setAttribute("aria-hidden", "true");
      label.textContent = row.label;
      value.textContent = size(row.bytes);
      ratio.textContent = percent;
      li.append(dot, label, value, ratio);
      legend.append(li);
    });
    if (!space.totalBytes) {
      const circle = document.createElementNS(ns, "circle");
      circle.setAttribute("cx", "120");
      circle.setAttribute("cy", "120");
      circle.setAttribute("r", "108");
      circle.setAttribute("fill", "var(--line)");
      svg.append(circle);
    }
    layout.append(svg, legend);
    host.append(layout);
    const details = document.createElement("details");
    details.className = "storage-detail";
    const summary = document.createElement("summary");
    summary.textContent = "数据库明细与内存缓存";
    details.append(summary);
    for (const [label, key] of [
      ["用量数据库", "databaseBytes"],
      ["其中：压缩价格证据", "priceEvidenceCompressedBytes"],
      ["其中：计算缓存载荷", "valuationPayloadBytes"],
      ["查询响应内存缓存（不计入饼图）", "responseCacheBytes"],
    ]) {
      const p = document.createElement("p");
      p.textContent = label + "：" + size(space[key]);
      details.append(p);
    }
    host.append(details);
  }
  window.profileManagement = {
    async mount(host) {
      const panel = document.createElement("section");
      panel.className = "control-section";
      panel.innerHTML =
        '<h3>资料位置与空间</h3><p data-location></p><p data-maintenance-note></p><div data-space></div><div class="control-actions"><button class="btn ghost" data-cache-clear>清理当前 Profile 计算缓存</button><button class="btn ghost" data-open hidden>打开资料目录</button></div><div data-migration hidden><label class="field">新资料位置<input type="text" data-target placeholder="请选择空文件夹或填写绝对路径" autocomplete="off"></label><div class="control-actions"><button class="btn ghost" data-choose hidden>选择文件夹</button><button class="btn" data-move>校验并迁移</button><button class="btn ghost danger" data-remove-old hidden>删除迁移前的旧副本</button></div></div><p data-profile-error class="control-form-error" role="alert"></p><p data-profile-status role="status"></p>';
      host.append(panel);
      const q = (s) => panel.querySelector(s),
        native = window.workbenchDesktop;
      const action = (fn) => async (event) => {
        const b = event.currentTarget;
        b.disabled = true;
        q("[data-profile-error]").textContent = "";
        try {
          await fn();
        } catch (error) {
          q("[data-profile-error]").textContent = error.message;
        } finally {
          b.disabled = false;
        }
      };
      const load = async () => {
        const done = window.WorkbenchUI.busy(panel, "正在读取空间…");
        try {
          const [state, space] = await Promise.all([
            native ? native.profile() : request("GET", "/api/profile/location"),
            request("GET", "/api/profile/storage"),
          ]);
          if (!panel.isConnected) return;
          q("[data-location]").textContent = state.managementAvailable
            ? state.root
            : "独立资料目录（本机维护入口可查看和迁移）";
          q("[data-maintenance-note]").textContent = state.managementAvailable
            ? "迁移会暂停对应后台；校验完成后重启，原副本保留。"
            : "资料迁移需通过本机 npm start 启动入口管理后台。";
          paintStorage(q("[data-space]"), space);
          q("[data-migration]").hidden = !state.managementAvailable;
          q("[data-open]").hidden = !native;
          q("[data-choose]").hidden = !native;
          q("[data-remove-old]").hidden =
            !state.managementAvailable || !state.previous?.retained;
          if (state.previous?.retained)
            q("[data-profile-status]").textContent =
              "迁移成功，旧副本保留在：" + state.previous.path;
        } finally {
          done();
        }
      };
      q("[data-cache-clear]").onclick = action(async () => {
        if (
          !confirm(
            "清理当前账号的可重建计算缓存并关闭三个Agent的参考计价？Token、价格证据和汇率保留。",
          )
        )
          return;
        const result = await request("POST", "/api/profile/clear-cache", {});
        window.dispatchEvent(
          new CustomEvent("workbench:features", { detail: result.features }),
        );
        document.dispatchEvent(
          new CustomEvent("workbench:features", { detail: result.features }),
        );
        await load();
        q("[data-profile-status]").textContent =
          "计算缓存已清理，价格证据和真实用量保留。";
      });
      q("[data-open]").onclick = action(() => native.open());
      q("[data-choose]").onclick = action(async () => {
        const path = await native.choose();
        if (path) q("[data-target]").value = path;
      });
      q("[data-move]").onclick = action(async () => {
        const target = q("[data-target]").value.trim();
        const plan = native
          ? await native.preflight(target)
          : await request("POST", "/api/profile/preflight", { target });
        if (
          !native &&
          !confirm(
            "暂停8765并迁移Profile 资料到 " +
              plan.target +
              "？需要复制约 " +
              size(plan.bytes) +
              "。原资料会保留。",
          )
        )
          return;
        const result = native
          ? await native.migrate(target)
          : await request("POST", "/api/profile/migrate", {
              target,
              confirm: true,
            });
        if (result.cancelled) return;
        q("[data-profile-status]").textContent =
          "正在迁移；后台校验并重启后恢复页面。";
        q("[data-move]").disabled = true;
        if (!native) {
          let failures = 0;
          const poll = async () => {
            if (!panel.isConnected) return;
            try {
              const status = await request("GET", "/api/profile/maintenance");
              if (status.status === "complete") {
                await load();
                q("[data-move]").disabled = false;
                return;
              }
              if (status.status === "failed") {
                q("[data-profile-error]").textContent = status.error;
                q("[data-move]").disabled = false;
                return;
              }
              failures = 0;
            } catch {
              failures++;
            }
            if (failures > 120) {
              q("[data-profile-error]").textContent =
                "后台尚未恢复，请检查本机维护窗口。";
              return;
            }
            setTimeout(poll, 1000);
          };
          setTimeout(poll, 1000);
        }
      });
      q("[data-remove-old]").onclick = action(async () => {
        if (
          !native &&
          !confirm("删除迁移清单中未变化的旧资料文件？源码和新增文件保留。")
        )
          return;
        const result = native
          ? await native.removeOld()
          : await request("POST", "/api/profile/remove-old", { confirm: true });
        if (!native)
          q("[data-profile-status]").textContent = "已提交本机旧副本清理任务。";
        else if (!result.cancelled) {
          await load();
          q("[data-profile-status]").textContent = result.changed?.length
            ? "部分旧文件已变化，已保留。"
            : "旧资料副本已清理。";
        }
      });
      try {
        await load();
      } catch (error) {
        q("[data-profile-error]").textContent = error.message;
      }
    },
  };
})();
