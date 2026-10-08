// @ts-nocheck
// Compatibility controller: retain the validated interactions during the React migration.
(() => {
  const esc = (s) =>
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
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
  });
  const day = (value) =>
    value && Number.isFinite(new Date(value).getTime())
      ? formatter.format(new Date(value))
      : "";
  function mount(root, { state, complete, add, toast }) {
    const limit = root._overviewLimit || 50;
    root._overviewState = state;
    const signature = JSON.stringify([
      state.projects,
      state.tasks,
      day(Date.now()),
      limit,
    ]);
    if (
      root.querySelector(".overview-board") &&
      root._overviewSignature === signature
    )
      return;
    root._overviewSignature = signature;
    const date = day(Date.now()),
      month = date.slice(0, 7),
      tasks = state.tasks || [],
      projects = state.projects || [],
      pending = tasks.filter((t) => !t.done),
      finished = tasks.filter((t) => t.done),
      active = projects.filter((p) => p.status !== "done");
    const overdue = pending.filter((t) => t.dueAt && day(t.dueAt) < date),
      pct = tasks.length
        ? Math.round((finished.length / tasks.length) * 100)
        : 0;
    const stats = [
      ["▤", "进行中项目", active.length, "全部 " + projects.length + " 个项目"],
      [
        "☷",
        "待办事项",
        pending.length,
        "今日到期 " +
          pending.filter((t) => t.dueAt && day(t.dueAt) === date).length +
          " 项",
      ],
      ["△", "逾期待办", overdue.length, "需要优先处理"],
      ["✓", "任务完成率", pct + "%", "已完成 " + finished.length + " 项"],
      [
        "◷",
        "本月完成",
        finished.filter(
          (t) => t.completedAt && day(t.completedAt).startsWith(month),
        ).length,
        month,
      ],
    ];
    (
      window.workbenchDesign?.paint || ((node, html) => (node.innerHTML = html))
    )(
      root,
      `<section class="overview-board"><header class="ob-top"><span>工作坊 <i>/</i> 总览</span><div><span class="ob-date">${date}</span><a class="ob-dark-button" href="#/projects">＋ 新建待办</a></div></header><div class="ob-stats">${stats.map(([icon, label, value, caption]) => `<article><h3><span class="ob-icon">${icon}</span>${label}</h3><strong>${value}</strong><small>${caption}</small></article>`).join("")}</div><div class="ob-body"><div class="ob-left"><section class="ob-panel"><header><h3>项目进度</h3><p>任务完成情况</p><a href="#/projects">${active.length} 个进行中</a></header><div class="ob-project-scroll"><table><thead><tr><th>项目</th><th>完成进度</th><th>待办</th><th>已完成</th><th>状态</th></tr></thead><tbody>${
        projects
          .slice(0, 30)
          .map((p) => {
            const list = tasks.filter((t) => t.projectId === p.id),
              done = list.filter((t) => t.done).length,
              ratio = list.length ? Math.round((done / list.length) * 100) : 0;
            return `<tr data-project="${esc(p.id)}"><td><span class="ob-avatar">${esc(p.name?.slice(0, 1) || "项")}</span><a href="#/projects">${esc(p.name)}</a></td><td><div class="ob-ratio">${list.length ? ratio + "%" : "—"}<span>${list.length ? list.length + " 项任务" : "尚无任务"}</span></div><div class="ob-bar"><i style="width:${ratio}%"></i></div></td><td>${list.length - done}</td><td>${done}</td><td><span class="ob-dot ${p.status === "waiting" ? "waiting" : ""}"></span>${p.status === "done" ? "已完成" : p.status === "waiting" ? "等待中" : "进行中"}</td></tr>`;
          })
          .join("") ||
        '<tr><td colspan="5" class="ob-empty">还没有项目 · <a href="#/projects">新建项目</a></td></tr>'
      }</tbody></table></div></section><section class="ob-panel ob-demand"><header><h3>任务趋势</h3><p>最近 21 天 · 新建与完成</p><span class="ob-legend">▰ 新建 ━ 完成</span></header><div class="ob-chart" data-wb-slot="chart" role="img" aria-label="最近21天任务新建和完成趋势"></div><footer>数据来自项目与待办</footer></section></div><section class="ob-panel ob-queue"><header><h3>待办队列</h3><p data-pending>${pending.length} 项未完成</p></header><div class="ob-actions">${
        pending
          .slice(0, limit)
          .map(
            (t) =>
              `<div class="ob-action" data-task="${esc(t.id)}"><span class="ob-icon">${t.dueAt ? "◷" : "☷"}</span><div><strong>${esc(t.title)}</strong><small>${esc(projects.find((p) => p.id === t.projectId)?.name || "未归入项目")}${t.dueAt ? " · " + esc(day(t.dueAt)) : ""}</small></div><button type="button" data-complete="${esc(t.id)}" aria-label="完成 ${esc(t.title)}">完成</button></div>`,
          )
          .join("") || '<p class="ob-empty">暂无待办</p>'
      }</div><button class="btn ghost" id="overview-more" ${pending.length <= limit ? "hidden" : ""}>加载更多</button><footer><span data-cleared>已完成 0 / ${pending.length}</span><div class="ob-bar"><i></i></div></footer><div class="ob-add"><input id="overview-add" aria-label="新待办内容" placeholder="添加待办，回车保存"><button type="button">＋</button></div></section></div></section>`,
    );
    function drawChart(currentTasks) {
      const created = new Map(),
        completed = new Map();
      currentTasks.forEach((t) => {
        const a = day(t.createdAt),
          b = t.done ? day(t.completedAt) : "";
        if (a) created.set(a, (created.get(a) || 0) + 1);
        if (b) completed.set(b, (completed.get(b) || 0) + 1);
      });
      const days = Array.from({ length: 21 }, (_, i) => {
          const d = new Date(date + "T12:00:00+08:00");
          d.setDate(d.getDate() - 20 + i);
          const key = day(d);
          return {
            key,
            new: created.get(key) || 0,
            done: completed.get(key) || 0,
          };
        }),
        max = Math.max(1, ...days.flatMap((d) => [d.new, d.done]));
      (
        window.workbenchDesign?.paint ||
        ((node, html) => (node.innerHTML = html))
      )(
        root.querySelector(".ob-chart"),
        days
          .map(
            (d) =>
              `<div class="ob-chart-day" data-key="${d.key}" tabindex="0" aria-label="${d.key} 新建 ${d.new}，完成 ${d.done}"><i style="height:${(d.new / max) * 100}%"></i><b style="bottom:${(d.done / max) * 100}%"></b><span>${d.key}<br>新建 ${d.new} · 完成 ${d.done}</span></div>`,
          )
          .join(""),
      );
    }
    drawChart(tasks);
    root.querySelector("#overview-more").onclick = () => {
      root._overviewLimit = limit + 50;
      mount(root, { state: root._overviewState, complete, add, toast });
    };
    let cleared = 0;
    root.querySelectorAll("[data-complete]").forEach(
      (button) =>
        (button.onclick = async () => {
          if (button.disabled) return;
          button.disabled = true;
          try {
            const snapshot = await complete(button.dataset.complete);
            if (!root.isConnected || !root.contains(button)) return;
            if (snapshot) {
              root._overviewState = snapshot;
              root._overviewSignature = JSON.stringify([
                snapshot.projects,
                snapshot.tasks,
                day(Date.now()),
                limit,
              ]);
              drawChart(snapshot.tasks || []);
              const list = snapshot.tasks || [],
                done = list.filter((t) => t.done),
                waiting = list.filter((t) => !t.done),
                values = [
                  (snapshot.projects || []).filter((p) => p.status !== "done")
                    .length,
                  waiting.length,
                  waiting.filter((t) => t.dueAt && day(t.dueAt) < date).length,
                  (list.length
                    ? Math.round((done.length / list.length) * 100)
                    : 0) + "%",
                  done.filter(
                    (t) =>
                      t.completedAt && day(t.completedAt).startsWith(month),
                  ).length,
                ];
              root
                .querySelectorAll(".ob-stats article")[3]
                .querySelector("small").textContent =
                "已完成 " + done.length + " 项";
              root
                .querySelectorAll(".ob-stats article>strong")
                .forEach((node, i) =>
                  (
                    window.workbenchDesign?.number ||
                    ((el, text) => (el.textContent = text))
                  )(node, values[i]),
                );
              root.querySelectorAll("[data-project]").forEach((row) => {
                const children = list.filter(
                    (t) => t.projectId === row.dataset.project,
                  ),
                  count = children.filter((t) => t.done).length,
                  ratio = children.length
                    ? Math.round((count / children.length) * 100)
                    : 0;
                row.querySelector(".ob-ratio").firstChild.textContent =
                  children.length ? ratio + "%" : "—";
                row.querySelector(".ob-bar i").style.width = ratio + "%";
                row.children[2].textContent = children.length - count;
                row.children[3].textContent = count;
              });
            }
            button.closest(".ob-action").remove();
            cleared++;
            root.querySelector("[data-pending]").textContent =
              pending.length - cleared + " 项未完成";
            root.querySelector("[data-cleared]").textContent =
              `已完成 ${cleared} / ${pending.length}`;
            root.querySelector(".ob-queue footer i").style.width =
              (cleared / Math.max(1, pending.length)) * 100 + "%";
            if (cleared === pending.length)
              root.querySelector(".ob-actions").innerHTML =
                '<p class="ob-empty">已完成所有待办</p>';
          } catch (e) {
            if (button.isConnected) {
              button.disabled = false;
              toast(e.message);
            }
          }
        }),
    );
    const input = root.querySelector(".ob-add input"),
      button = root.querySelector(".ob-add button");
    const submit = async () => {
      const title = input.value.trim();
      if (!title || button.disabled) return;
      button.disabled = true;
      try {
        await add(title);
        if (input.isConnected && input.value.trim() === title) {
          input.value = "";
          delete input.dataset.wbDirty;
        }
      } catch (e) {
        if (input.isConnected) toast(e.message);
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    };
    button.onclick = submit;
    input.onkeydown = (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    };
  }
  window.overviewBoard = { mount };
})();
