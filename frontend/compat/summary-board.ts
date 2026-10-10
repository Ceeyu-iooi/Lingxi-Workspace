// @ts-nocheck
// Compatibility controller: retain the validated interactions during the React migration.
(() => {
  const esc = (value) =>
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
    { state, month, list, write, remove, refresh, storage, toast },
  ) {
    if (root._summary) {
      root._summary.update(state);
      return;
    }
    const months = Array.from({ length: 6 }, (_, i) => month(-i));
    root.innerHTML = `<div class="greet"><div><h2>月度总结</h2><p>回顾进度，记录收获</p></div><select id="sum-month" aria-label="总结月份">${months.map((m) => `<option>${m}</option>`).join("")}</select><button class="btn ghost" id="btn-gen">生成初稿</button></div>
      <div class="summary-layout"><section class="card summary-writing"><h3>编辑总结</h3><div id="sum-stats" class="stat-chips"></div><textarea id="sum-editor" maxlength="32000" class="summary-editor" placeholder="记录本月进展，或生成初稿后编辑" aria-label="总结内容"></textarea><p class="summary-status" id="summary-status" role="status"></p><div class="add-row"><button class="btn" id="btn-save-summary">保存总结</button><button class="btn ghost" id="btn-regen">重新生成</button></div></section>
      <aside class="card summary-history"><h3>历史月份</h3><div id="saved-list"></div></aside></div>`;
    const q = (s) => root.querySelector(s),
      editor = q("#sum-editor"),
      paint =
        window.workbenchDesign?.paint || ((el, html) => (el.innerHTML = html));
    let snapshot = state,
      current = storage.getItem("wb-summary-month") || months[0],
      baseline = "",
      generation = 0,
      stats = null,
      saving = false;
    const key = (m) => "wb-draft-summary-" + m;
    const dirty = () => editor.value !== baseline;
    root._wbUnsaved = dirty;
    function status(text) {
      q("#summary-status").textContent = text;
    }
    function statistics(value) {
      stats = value;
      paint(
        q("#sum-stats"),
        value
          ? `<span class="stat-chip">完成 ${Number(value.done) || 0} 项</span><span class="stat-chip">新增待办 ${Number(value.created) || 0} 项</span><span class="stat-chip">新增项目 ${Number(value.newProjects) || 0} 个</span>`
          : "",
      );
    }
    function update(next) {
      snapshot = next;
      paint(
        q("#saved-list"),
        snapshot.summaries
          .map(
            (s) =>
              `<div data-month="${esc(s.month)}"><button class="summary-month ${s.month === current ? "on" : ""}" data-open-month="${esc(s.month)}"><strong>${esc(s.month)}</strong><small>已保存</small></button><button class="del sum-del" data-month="${esc(s.month)}" aria-label="删除 ${esc(s.month)} 总结">×</button></div>`,
          )
          .join("") || '<p class="empty">保存后在这里查看历史总结。</p>',
      );
      root
        .querySelectorAll("[data-open-month]")
        .forEach((b) => (b.onclick = () => select(b.dataset.openMonth)));
      root.querySelectorAll(".sum-del").forEach(
        (b) =>
          (b.onclick = async () => {
            if (saving || !confirm(`删除 ${b.dataset.month} 的总结？`)) return;
            b.disabled = true;
            try {
              await remove("summaries", b.dataset.month);
              const next = await refresh();
              if (root.isConnected) update(next);
            } catch (error) {
              if (root.isConnected) {
                b.disabled = false;
                toast(error.message, {kind:"error"});
              }
            }
          }),
      );
    }
    function select(value) {
      if (value === current && editor.value) return;
      if (dirty()) storage.setItem(key(current), editor.value);
      generation++;
      current = value;
      storage.setItem("wb-summary-month", value);
      if (![...q("#sum-month").options].some((o) => o.value === value)) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        q("#sum-month").append(option);
      }
      q("#sum-month").value = value;
      const saved = snapshot.summaries.find((s) => s.month === value);
      baseline = saved?.content || "";
      editor.value = storage.getItem(key(value)) ?? baseline;
      statistics(saved?.stats || null);
      update(snapshot);
      status(
        dirty()
          ? "草稿已保留，尚未保存"
          : saved
            ? "已保存"
            : "尚无总结，可编辑或生成初稿",
      );
    }
    editor.oninput = () => {
      storage.setItem(key(current), editor.value);
      status("草稿已保留，尚未保存");
    };
    q("#sum-month").onchange = () => select(q("#sum-month").value);
    const generate = async () => {
      if (dirty() && !confirm("重新生成会替换当前编辑内容，是否继续？")) return;
      const ticket = ++generation,
        value = editor.value,
        target = current;
      status("正在生成初稿…");
      try {
        const draft = await list("summaryDraft", { month: target });
        if (!root.isConnected || ticket !== generation || current !== target)
          return;
        if (editor.value !== value) {
          status("内容已修改，保留当前草稿");
          return;
        }
        editor.value = draft.draft;
        statistics(draft.stats);
        storage.setItem(key(current), editor.value);
        status("初稿已生成，编辑后保存");
      } catch (error) {
        if (root.isConnected && ticket === generation)
          status("生成失败：" + error.message);
      }
    };
    q("#btn-gen").onclick = generate;
    q("#btn-regen").onclick = generate;
    q("#btn-save-summary").onclick = async () => {
      const content = editor.value.trim(),
        target = current,
        original = editor.value;
      if (!content) {
        status("请先填写总结");
        return;
      }
      if (saving) return;
      saving = true;
      q("#btn-save-summary").disabled = true;
      status("正在保存…");
      try {
        await write("summaries", null, { month: target, content, stats });
        const next = await refresh();
        if (!root.isConnected) return;
        update(next);
        if (current === target && editor.value === original) {
          baseline = original;
          storage.removeItem(key(target));
          delete editor.dataset.wbDirty;
          status("已保存");
        } else status("上一版已保存，当前修改仍为草稿");
      } catch (error) {
        if (root.isConnected) status("保存失败：" + error.message);
      } finally {
        saving = false;
        if (root.isConnected) q("#btn-save-summary").disabled = false;
      }
    };
    root._summary = { update };
    root._wbDispose = () => {
      generation++;
      if (dirty()) storage.setItem(key(current), editor.value);
      root._summary = null;
    };
    select(current);
    update(state);
  }
  window.summaryBoard = { mount };
})();
