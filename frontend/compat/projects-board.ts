// @ts-nocheck
// Compatibility controller: retain the validated interactions during the React migration.
(() => {
  const escape = (value) =>
    String(value ?? "").replace(
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
  function mount(
    root,
    {
      state,
      write,
      remove,
      refresh,
      toast,
      todo,
      ai,
      bindAI,
      bindTodos,
      bindAdd,
    },
  ) {
    if (root._projects) {
      root._projects.update(state);
      return;
    }
    root.innerHTML = `<div class="greet"><div><h2>项目与待办</h2><p>查看进度，安排下一步</p></div></div><div class="project-layout">
      <section class="card"><div class="project-heading"><h3>项目</h3><span class="meta" id="project-count"></span></div>
        <div class="project-toolbar"><input id="project-search" type="search" placeholder="搜索项目" aria-label="搜索项目"><button class="btn ghost" id="project-all">全部待办</button></div>
        <div class="project-table-wrap"><table class="project-table"><thead><tr><th>项目</th><th>完成进度</th><th>状态</th><th><span class="meta">操作</span></th></tr></thead><tbody id="proj-list"></tbody></table></div>
        <div class="add-row"><input id="proj-add-name" placeholder="新项目名称，回车创建" aria-label="新项目名称"><button class="btn" id="project-create">创建</button></div><button class="btn ghost" id="project-more" hidden>加载更多</button></section>
      <section class="card"><div class="project-heading"><h3 id="project-tasks-title">全部待办</h3><span class="meta" id="project-task-count"></span></div>${ai()}
        <div class="add-row"><input id="pj-add" placeholder="新待办，回车保存" aria-label="新待办内容"><button class="btn ghost" id="pj-ai-btn">AI 识别</button><select id="pj-proj" aria-label="归入项目"><option value="">不归组</option></select></div>
        <div id="pj-todos"></div><button class="btn ghost" id="task-more" hidden>加载更多</button></section></div>`;
    const q = (s) => root.querySelector(s),
      paint =
        window.workbenchDesign?.paint || ((el, html) => (el.innerHTML = html));
    let snapshot = state,
      selected = root._wbSaved?.custom?.selected || "",
      limit = root._wbSaved?.custom?.limit || 50,
      taskLimit = root._wbSaved?.custom?.taskLimit || 50,
      busy = false;
    const execute = async (button, fn) => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        await fn();
        const next = await refresh();
        if (root.isConnected) update(next);
      } catch (error) {
        if (root.isConnected) toast(error.message, {kind:"error"});
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    };
    function update(next) {
      snapshot = next;
      if (selected && !snapshot.projects.some((p) => p.id === selected))
        selected = "";
      const keyword = q("#project-search").value.trim().toLocaleLowerCase();
      const projects = snapshot.projects.filter((p) =>
        p.name.toLocaleLowerCase().includes(keyword),
      );
      q("#project-count").textContent = `${projects.length} 个`;
      paint(
        q("#proj-list"),
        projects
          .slice(0, limit)
          .map((p) => {
            const children = snapshot.tasks.filter((t) => t.projectId === p.id),
              done = children.filter((t) => t.done).length,
              ratio = children.length
                ? Math.round((done / children.length) * 100)
                : 0;
            return `<tr data-id="${escape(p.id)}" aria-selected="${selected === p.id}"><td><button class="project-pick" data-project="${escape(p.id)}">${escape(p.name)}</button></td><td class="project-progress">${done} / ${children.length}<span class="bar"><i style="width:${ratio}%"></i></span></td><td><select class="st-select" data-id="${escape(p.id)}" aria-label="修改 ${escape(p.name)} 的状态">${[
              ["active", "进行中"],
              ["waiting", "等待中"],
              ["done", "已完成"],
            ]
              .map(
                ([v, label]) =>
                  `<option value="${v}" ${p.status === v ? "selected" : ""}>${label}</option>`,
              )
              .join(
                "",
              )}</select></td><td><button class="del proj-del" data-id="${escape(p.id)}" aria-label="删除项目 ${escape(p.name)}">×</button></td></tr>`;
          })
          .join("") ||
          '<tr><td colspan="4" class="empty">没有匹配项目，可创建或修改搜索条件。</td></tr>',
      );
      q("#project-more").hidden = projects.length <= limit;
      const options = q("#pj-proj");
      paint(
        options,
        '<option value="">不归组</option>' +
          snapshot.projects
            .map(
              (p) =>
                `<option value="${escape(p.id)}">${escape(p.name)}</option>`,
            )
            .join(""),
      );
      const tasks = snapshot.tasks.filter(
        (t) => !selected || t.projectId === selected,
      );
      q("#project-tasks-title").textContent = selected
        ? snapshot.projects.find((p) => p.id === selected)?.name + " · 待办"
        : "全部待办";
      q("#project-task-count").textContent =
        `${tasks.filter((t) => !t.done).length} 项未完成`;
      paint(
        q("#pj-todos"),
        tasks.slice(0, taskLimit).map(todo).join("") ||
          '<div class="empty">暂无待办，在上方添加。</div>',
      );
      q("#task-more").hidden = tasks.length <= taskLimit;
      bindTodos(root, () => update(snapshot));
      root.querySelectorAll("[data-project]").forEach(
        (button) =>
          (button.onclick = () => {
            selected = button.dataset.project;
            options.value = selected;
            taskLimit = 50;
            update(snapshot);
          }),
      );
      root.querySelectorAll(".st-select").forEach((select) => {
        select.value = snapshot.projects.find(
          (p) => p.id === select.dataset.id,
        ).status;
        select.onchange = () =>
          execute(select, () =>
            write("projects", select.dataset.id, { status: select.value }),
          );
      });
      root.querySelectorAll(".proj-del").forEach(
        (button) =>
          (button.onclick = () => {
            const project = snapshot.projects.find(
              (p) => p.id === button.dataset.id,
            );
            if (confirm(`删除项目「${project.name}」及其待办？`))
              execute(button, () => remove("projects", project.id));
          }),
      );
    }
    q("#project-search").oninput = () => {
      limit = 50;
      update(snapshot);
    };
    q("#project-all").onclick = () => {
      selected = "";
      update(snapshot);
    };
    q("#project-more").onclick = () => {
      limit += 50;
      update(snapshot);
    };
    q("#task-more").onclick = () => {
      taskLimit += 50;
      update(snapshot);
    };
    const create = async () => {
      const input = q("#proj-add-name"),
        name = input.value.trim();
      if (!name || busy) return;
      busy = true;
      await execute(q("#project-create"), async () => {
        await write("projects", null, { name });
        if (input.isConnected && input.value.trim() === name) {
          input.value = "";
          delete input.dataset.wbDirty;
        }
      });
      busy = false;
    };
    q("#project-create").onclick = create;
    q("#proj-add-name").onkeydown = (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        create();
      }
    };
    update(state);
    bindAdd("#pj-add", "#pj-proj", "#pj-ai-btn");
    bindAI(root, "#pj-proj");
    root._wbSnapshot = () => ({ selected, limit, taskLimit });
    root._projects = { update };
    root._wbDispose = () => {
      root._projects = null;
    };
  }
  window.projectsBoard = { mount };
})();
