// @ts-nocheck
// Compatibility controller: retain the validated interactions during the React migration.
/* Prompt-Tools / Skills-Manager presentation adapted to the workbench UI contract.
 * Their MIT source licences are retained in static/vendor; all storage uses owned HTTP APIs. */
(() => {
  const U = () => window.WorkbenchUI,
    e = (s) => U().e(s),
    q = (s, r = document) => r.querySelector(s),
    qa = (s, r = document) => [...r.querySelectorAll(s)];
  const current = (root, owner) =>
    root.isConnected && typeof user !== "undefined" && user?.username === owner;
  const fileData = async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let value = "";
    for (let i = 0; i < bytes.length; i += 8192)
      value += String.fromCharCode(...bytes.slice(i, i + 8192));
    return btoa(value);
  };
  function shell(root, title, desc, actions) {
    root.classList.add("wb-fixed-layout");
    root.innerHTML = `<header class="wb-page-head"><div><h1>${e(title)}</h1><p>${e(desc)}</p></div><div class="wb-page-actions">${actions}</div></header><div class="wb-library-tabs"></div><div class="wb-library-content"></div>`;
    return q(".wb-library-content", root);
  }
  function modal(title, body, { close } = {}) {
    return U().dialog(title, body, { beforeClose: close });
  }
  async function prompts(root) {
    const owner = user.username,
      signal = root._wbAbort?.signal,
      content = shell(
        root,
        "提示词管理",
        "保存、整理与改进你的提示词。",
        '<button class="btn ghost" data-import>导入</button><button class="btn ghost" data-export>导出</button><button class="btn" data-create>＋ 新建提示词</button>',
      );
    const modeParams = {};
    let mode = "library",
      result,
      params = { q: "", sort: "updated", offset: 0, limit: 40, tags: [] },
      selected = new Set(),
      editor = null,
      ticket = 0,
      timer,
      features = { promptAutosave: true, promptAIEnabled: true },
      cache = new Map();
    try {
      features = await U().request("GET", "/api/features", undefined, {
        signal,
      });
    } catch (error) {
      if (current(root, owner)) U().notify(error.message, {kind:"error"});
    }
    if (!current(root, owner)) return;
    root._wbUnsaved = () => editor?.dirty || false;
    root._wbDispose = () => {
      clearTimeout(timer);
      editor?.forceClose();
      cache.clear();
    };
    const changedFeatures = (event) => {
      features = { ...features, ...event.detail };
      editor?.syncFeatures?.();
    };
    window.addEventListener("workbench:features", changedFeatures);
    const disposeFeatures = root._wbDispose;
    root._wbDispose = () => {
      window.removeEventListener("workbench:features", changedFeatures);
      disposeFeatures();
    };
    const modeHost = q(".wb-library-tabs", root);
    const paintMode = () =>
      U().radio(modeHost, {
        label: "提示词页面",
        items: [
          ["library", "我的提示词"],
          ["market", "模板市场"],
          ["stats", "使用分析"],
        ],
        value: mode,
        onChange: (value) => {
          if (editor?.dirty && !confirm("提示词修改尚未保存，切换页面？"))
            return;
          editor?.forceClose();
          modeParams[mode] = { ...params, tags: [...params.tags] };
          mode = value;
          params = {
            q: "",
            sort: "updated",
            offset: 0,
            limit: 40,
            tags: [],
            ...(modeParams[mode] || {}),
          };
          selected.clear();
          paintMode();
          draw();
          load();
        },
      });
    paintMode();
    function draw() {
      if (mode === "stats") {
        content.innerHTML =
          '<div class="wb-panel wb-stats-filters"><label>开始<input type="date" data-stat-start></label><label>截止<input type="date" data-stat-end></label><label>分类<select data-stat-folder><option value="">全部分类</option></select></label><label>标签<select data-stat-tag><option value="">全部标签</option></select></label><button class="btn ghost" data-stat-load>查看</button></div><div class="wb-stats-output"></div>';
        q("[data-stat-load]", content).onclick = () => {
          params.start = q("[data-stat-start]", content).value;
          params.end = q("[data-stat-end]", content).value;
          params.folder = q("[data-stat-folder]", content).value;
          params.tag = q("[data-stat-tag]", content).value;
          load();
        };
        return;
      }
      content.innerHTML = `<div class="wb-filter-layout"><aside class="wb-filter-pane" aria-label="提示词筛选"><section class="wb-filter-section"><h3>${mode === "market" ? "模板来源" : "分类文件夹"}</h3><div data-folder-list></div>${mode === "library" ? '<button class="btn ghost" data-folder-add>＋ 新建分类</button>' : '<button class="btn ghost" data-source-add>＋ 添加公开来源</button>'}</section>${mode === "library" ? '<section class="wb-filter-section"><h3>标签</h3><div class="wb-filter-tags" data-tags></div></section><section class="wb-filter-section"><h3>条件</h3><label><input type="checkbox" data-favorite>仅收藏</label><label><input type="checkbox" data-trash>回收站</label><label>格式<select data-format><option value="">全部格式</option><option value="text">纯文本</option><option value="markdown">Markdown</option><option value="rich">富文本</option><option value="json">JSON</option><option value="custom">自定义文本</option></select></label></section><section class="wb-filter-section"><h3>修改日期</h3><label>开始<input type="date" data-start></label><label>截止<input type="date" data-end></label></section>' : '<p class="wb-muted">模板仅在手动同步时联网。副本保存在自己的库里，不会被来源更新覆盖。</p>'}<button class="btn ghost" data-clear-filter>重置筛选</button></aside><section><div class="wb-list-toolbar"><button class="btn ghost wb-filter-mobile" data-filter-toggle>筛选</button><input type="search" data-search aria-label="搜索提示词全文" placeholder="搜索标题、正文或关键字" maxlength="300"><select data-sort aria-label="提示词排序"><option value="updated">最近修改</option><option value="created">最近创建</option><option value="name">名称</option><option value="usage">使用次数</option></select>${mode === "market" ? '<button class="btn ghost" data-market-sync>同步来源</button>' : ""}<span class="wb-list-count" data-count></span></div><div class="wb-bulk-bar" hidden><span data-selected-count></span><button class="btn ghost" data-bulk="favorite">收藏</button><button class="btn ghost" data-bulk="move">移动分类</button><button class="btn ghost" data-bulk="tag">添加标签</button><button class="btn ghost" data-bulk="trash">移入回收站</button><button class="btn ghost" data-bulk="restore">恢复</button><button class="btn ghost" data-bulk="export">导出</button></div><div class="wb-card-list"></div><div class="wb-pager"><button class="btn ghost" data-prev>上一页</button><span data-page></span><button class="btn ghost" data-next>下一页</button></div><p class="wb-inline-error" data-list-error role="alert"></p></section></div>`;
      q("[data-search]", content).value = params.q;
      q("[data-sort]", content).value = params.sort;
      q("[data-search]", content).oninput = (ev) => {
        params.q = ev.target.value;
        params.offset = 0;
        clearTimeout(timer);
        timer = setTimeout(load, 180);
      };
      q("[data-sort]", content).onchange = (ev) => {
        params.sort = ev.target.value;
        params.offset = 0;
        load();
      };
      q("[data-filter-toggle]", content).onclick = () => {
        const pane = q(".wb-filter-pane", content);
        pane.dataset.open = pane.dataset.open === "true" ? "false" : "true";
      };
      for (const name of ["favorite", "trash", "format", "start", "end"]) {
        const input = q("[data-" + name + "]", content);
        if (input) {
          if (input.type === "checkbox") input.checked = !!params[name];
          else input.value = params[name] || "";
          input.onchange = () => {
            params[name] =
              input.type === "checkbox"
                ? input.checked
                  ? "1"
                  : ""
                : input.value;
            params.offset = 0;
            selected.clear();
            load();
          };
        }
      }
      q("[data-clear-filter]", content).onclick = () => {
        params = { q: "", sort: "updated", offset: 0, limit: 40, tags: [] };
        draw();
        load();
      };
      q("[data-prev]", content).onclick = () => {
        params.offset = Math.max(0, params.offset - 40);
        load();
      };
      q("[data-next]", content).onclick = () => {
        params.offset += 40;
        load();
      };
      qa("[data-bulk]", content).forEach(
        (button) => (button.onclick = () => bulk(button.dataset.bulk)),
      );
      if (mode === "library")
        q("[data-folder-add]", content).onclick = () => folderDialog();
      else {
        q("[data-source-add]", content).onclick = () => sourceDialog();
        q("[data-market-sync]", content).onclick = () => syncMarket();
      }
    }
    async function load() {
      const id = ++ticket,
        modeAt = mode;
      const query = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) =>
        Array.isArray(v)
          ? v.forEach((x) => query.append(k, x))
          : v !== "" && query.set(k, String(v)),
      );
      const url =
        mode === "stats"
          ? "/api/prompts/stats?" + query
          : (mode === "market" ? "/api/prompts/market" : "/api/prompts") +
            "?" +
            query;
      const stop = U().busy(content, "正在查询…");
      try {
        const cached = cache.get(url);
        if (cached) paint(cached);
        const data = await U().request("GET", url, undefined, { signal });
        if (!current(root, owner) || id !== ticket || mode !== modeAt) return;
        result = data;
        cache.set(url, data);
        paint(data);
      } catch (error) {
        if (
          error.name !== "AbortError" &&
          current(root, owner) &&
          id === ticket
        ) {
          q("[data-list-error]", content) &&
            (q("[data-list-error]", content).textContent = error.message);
          if (!result)
            q(".wb-card-list", content)?.replaceChildren(
              U().el("div", { class: "wb-empty", text: error.message }),
            );
        }
      } finally {
        stop();
      }
    }
    function paint(data) {
      if (mode === "stats") {
        paintStats(data);
        return;
      }
      const list = q(".wb-card-list", content);
      if (!list) return;
      const focus = document.activeElement,
        focusId = focus?.closest("[data-id]")?.dataset.id;
      list.innerHTML = data.items.length
        ? data.items
            .map((item) =>
              U().promptCard(item, {
                market: mode === "market",
                selected: selected.has(item.id),
              }),
            )
            .join("")
        : '<div class="wb-empty"><strong>没有匹配的提示词</strong><span>调整筛选，或新建／导入一条提示词。</span></div>';
      q("[data-count]", content).textContent = data.total + " 条";
      q("[data-page]", content).textContent =
        "第 " + (Math.floor(params.offset / 40) + 1) + " 页";
      q("[data-prev]", content).disabled = params.offset === 0;
      q("[data-next]", content).disabled =
        params.offset + data.items.length >= data.total;
      const folders = q("[data-folder-list]", content);
      if (mode === "library") {
        folders.innerHTML =
          '<button class="btn ghost" data-folder="" aria-pressed="' +
          !params.folder +
          '">全部分类</button>' +
          data.folders
            .map(
              (f) =>
                `<div class="wb-folder-row"><button class="btn ghost" data-folder="${e(f.id)}" aria-pressed="${params.folder === f.id}">${e(f.name)}</button><button class="btn ghost" data-folder-edit="${e(f.id)}" aria-label="编辑分类 ${e(f.name)}">···</button></div>`,
            )
            .join("");
        qa("[data-folder]", folders).forEach((button) => {
          button.onclick = () => {
            params.folder = button.dataset.folder;
            params.offset = 0;
            load();
          };
          button.ondragover = (ev) => {
            ev.preventDefault();
            button.classList.add("on");
          };
          button.ondragleave = () => button.classList.remove("on");
          button.ondrop = async (ev) => {
            ev.preventDefault();
            button.classList.remove("on");
            const pid = ev.dataTransfer.getData("text/x-workbench-prompt");
            if (!pid) return;
            await U().request("POST", "/api/prompts/bulk", {
              ids: [pid],
              action: "move",
              folder: button.dataset.folder,
            });
            cache.clear();
            load();
          };
        });
        qa("[data-folder-edit]", folders).forEach(
          (b) =>
            (b.onclick = () =>
              folderDialog(
                data.folders.find((f) => f.id === b.dataset.folderEdit),
              )),
        );
        q("[data-tags]", content).innerHTML = data.tags
          .map(
            (tag) =>
              `<button type="button" data-tag="${e(tag)}" aria-pressed="${params.tags.includes(tag)}">${e(tag)}</button>`,
          )
          .join("");
        qa("[data-tag]", content).forEach(
          (b) =>
            (b.onclick = () => {
              params.tags = params.tags.includes(b.dataset.tag)
                ? params.tags.filter((t) => t !== b.dataset.tag)
                : [...params.tags, b.dataset.tag];
              params.offset = 0;
              load();
            }),
        );
      } else {
        folders.innerHTML =
          '<button class="btn ghost" data-source="" aria-pressed="' +
          !params.source +
          '">全部来源</button>' +
          data.sources
            .map(
              (s) =>
                `<button class="btn ghost" data-source="${e(s.id)}" aria-pressed="${params.source === s.id}">${e(s.name)}</button>`,
            )
            .join("");
        qa("button", folders).forEach(
          (b) =>
            (b.onclick = () => {
              params.source = b.dataset.source;
              params.offset = 0;
              load();
            }),
        );
      }
      qa(".wb-library-card", list).forEach((card) => {
        const item = data.items.find((x) => x.id === card.dataset.id);
        q("[data-select]", card) &&
          (q("[data-select]", card).onchange = (ev) => {
            ev.target.checked
              ? selected.add(item.id)
              : selected.delete(item.id);
            card.setAttribute("aria-selected", String(ev.target.checked));
            paintBulk();
          });
        q("[data-open]", card).onclick = () =>
          mode === "market" ? marketPreview(item) : editPrompt(item.id);
        card.onkeydown = (ev) => {
          if (ev.key === "Enter" && ev.target === card)
            q("[data-open]", card).click();
        };
        card.ondragstart = (ev) => {
          ev.dataTransfer.setData("text/x-workbench-prompt", item.id);
          ev.dataTransfer.effectAllowed = "move";
        };
        q("[data-copy]", card) &&
          (q("[data-copy]", card).onclick = () => copy(item.id));
        q("[data-pin]", card) &&
          (q("[data-pin]", card).onclick = async () => {
            await U().request("POST", "/api/prompts/bulk", {
              ids: [item.id],
              action: "pin",
              value: !item.pinned,
            });
            cache.clear();
            load();
          });
        q("[data-fav]", card) &&
          (q("[data-fav]", card).onclick = async () => {
            await U().request("POST", "/api/prompts/bulk", {
              ids: [item.id],
              action: "favorite",
              value: !item.favorite,
            });
            cache.clear();
            load();
          });
        q("[data-apply]", card) &&
          (q("[data-apply]", card).onclick = () => applyMarket(item));
        card.addEventListener("contextmenu", (ev) => {
          const actions = [
            {
              label: "打开提示词",
              action: () => q("[data-open]", card).click(),
            },
          ];
          if (mode === "library")
            actions.push(
              { label: "复制内容", action: () => copy(item.id) },
              { label: "移入回收站", action: () => bulk("trash", [item.id]) },
            );
          card._wbContextActions = actions;
        });
        let point;
        card.onpointerdown = (ev) => {
          if (ev.pointerType === "touch")
            point = { x: ev.clientX, y: ev.clientY };
        };
        card.onpointerup = (ev) => {
          if (
            point &&
            Math.abs(ev.clientX - point.x) > 60 &&
            Math.abs(ev.clientY - point.y) < 25
          ) {
            card.classList.toggle("wb-quick-actions");
          }
          point = null;
        };
      });
      paintBulk();
      if (focusId)
        q(`[data-id="${CSS.escape(focusId)}"]`, list)?.focus({
          preventScroll: true,
        });
    }
    function paintBulk() {
      const bar = q(".wb-bulk-bar", content);
      if (!bar) return;
      bar.hidden = mode !== "library" || !selected.size;
      q("[data-selected-count]", bar).textContent =
        "已选 " + selected.size + " 条";
      q("[data-bulk=restore]", bar).hidden = !params.trash;
      q("[data-bulk=trash]", bar).hidden = !!params.trash;
    }
    async function bulk(action, ids = [...selected]) {
      if (!ids.length) return;
      if (action === "export") {
        U().download(
          await U().request(
            "GET",
            "/api/prompts/export?ids=" + ids.join(",") + "&format=json",
          ),
        );
        return;
      }
      const body = { ids, action };
      if (action === "trash" && !confirm("将所选提示词移入回收站？")) return;
      if (action === "move") {
        const m = modal(
          "移动分类",
          `<label class="control-field">分类<select>${result.folders.map((f) => `<option value="${e(f.id)}">${e(f.name)}</option>`).join("")}<option value="">未分类</option></select></label>`,
        );
        q("footer", m.d).innerHTML =
          '<button class="btn" data-confirm>移动</button>';
        q("[data-confirm]", m.d).onclick = async () => {
          await U().request("POST", "/api/prompts/bulk", {
            ...body,
            folder: q("select", m.d).value,
          });
          m.close(true);
          cache.clear();
          load();
        };
        return;
      }
      if (action === "tag") {
        const tag = prompt("输入标签名称");
        if (!tag?.trim()) return;
        body.tag = tag.trim();
      }
      try {
        await U().request("POST", "/api/prompts/bulk", body);
        selected.clear();
        cache.clear();
        load();
      } catch (error) {
        U().notify(error.message, {kind:"error"});
      }
    }
    function folderDialog(folder = {}) {
      const m = modal(
        folder.id ? "编辑分类" : "新建分类",
        `<form><label class="control-field">名称<input name="name" required maxlength="100" value="${e(folder.name || "")}"></label><label class="control-field">上级分类<select name="parent"><option value="">顶层</option>${(
          result?.folders || []
        )
          .filter((f) => f.id !== folder.id)
          .map(
            (f) =>
              `<option value="${e(f.id)}" ${f.id === folder.parent ? "selected" : ""}>${e(f.name)}</option>`,
          )
          .join(
            "",
          )}</select></label><p class="wb-inline-error" role="alert"></p></form>`,
      );
      q("footer", m.d).innerHTML =
        (folder.id
          ? '<button class="btn ghost danger" data-delete>删除分类</button>'
          : "") + '<button class="btn" data-save>保存</button>';
      q("[data-save]", m.d).onclick = async () => {
        try {
          const body = Object.fromEntries(new FormData(q("form", m.d)));
          await U().request("POST", "/api/prompts/folder", {
            ...body,
            id: folder.id,
          });
          m.close(true);
          cache.clear();
          load();
        } catch (error) {
          q("[role=alert]", m.d).textContent = error.message;
        }
      };
      q("[data-delete]", m.d) &&
        (q("[data-delete]", m.d).onclick = async () => {
          if (!confirm("删除分类，提示词将移到未分类？")) return;
          await U().request("POST", "/api/prompts/folder", {
            id: folder.id,
            delete: true,
          });
          m.close(true);
          params.folder = "";
          cache.clear();
          load();
        });
    }
    async function copy(pid) {
      try {
        const r = await U().request("POST", "/api/prompts/render", { id: pid });
        await navigator.clipboard.writeText(r.content);
        await U().request("POST", "/api/prompts/event", {
          id: pid,
          action: "copy",
        });
        U().notify("提示词已复制", {kind:"success"});
        cache.clear();
      } catch (error) {
        U().notify(error.message, {kind:"error"});
      }
    }
    async function editPrompt(pid, draft) {
      if (editor) {
        if (editor.dirty && !confirm("放弃当前草稿？")) return;
        editor.forceClose();
      }
      let item = pid
        ? await U().request("GET", "/api/prompts/item?id=" + pid)
        : draft || {
            title: "未命名提示词",
            content: "",
            format: "markdown",
            folder: params.folder || "",
            tags: [],
            variables: {},
            favorite: false,
            pinned: false,
            origin: {},
          };
      const draftKey = "wb-prompt-draft:" + owner + ":" + (pid || "new");
      let recovered;
      try {
        recovered = JSON.parse(localStorage.getItem(draftKey));
      } catch {}
      if (recovered && confirm("发现未完成的本地草稿，恢复吗？"))
        item = { ...item, ...recovered };
      const m = modal(
        pid ? "编辑提示词" : "新建提示词",
        `<div class="wb-conflict" hidden role="alert"></div><div class="wb-editor-fields"><label>标题<input name="title" maxlength="160" value="${e(item.title)}"></label><label>格式<select name="format">${[
          ["markdown", "Markdown"],
          ["text", "纯文本"],
          ["rich", "富文本"],
          ["json", "JSON"],
          ["custom", "自定义文本"],
        ]
          .map(
            ([v, t]) =>
              `<option value="${v}" ${item.format === v ? "selected" : ""}>${t}</option>`,
          )
          .join(
            "",
          )}</select></label><label>分类<select name="folder"><option value="">未分类</option>${(result?.folders || []).map((f) => `<option value="${e(f.id)}" ${item.folder === f.id ? "selected" : ""}>${e(f.name)}</option>`).join("")}</select></label><label>标签<input name="tags" value="${e((item.tags || []).join(", "))}" placeholder="多个标签用逗号分隔"></label></div><div class="wb-editor-columns"><section><div class="wb-rich-toolbar" hidden><button class="btn ghost" data-rich="bold">粗体</button><button class="btn ghost" data-rich="italic">斜体</button><button class="btn ghost" data-rich="underline">下划线</button><button class="btn ghost" data-rich="insertUnorderedList">列表</button></div><textarea class="wb-editor-source" aria-label="提示词内容" spellcheck="false"></textarea><div class="wb-rich-editor" contenteditable="true" role="textbox" aria-label="富文本提示词内容" hidden></div></section><section><h3 class="wb-muted">实时预览</h3><div class="wb-editor-preview"></div></section></div><details class="wb-prompt-variables"><summary>模板变量与来源</summary><label class="control-field">变量默认值（JSON）<textarea name="variables" rows="3">${e(JSON.stringify(item.variables || {}, null, 2))}</textarea></label><p class="wb-muted">使用 {{变量}} 与 {{#if 变量}}…{{else}}…{{/if}}；不执行代码。</p>${item.origin?.url ? '<p class="wb-muted">来源：' + e(item.origin.repo || "") + " · " + e(item.origin.license || "") + "</p>" : ""}</details><div class="wb-ai-actions"><select name="provider" aria-label="AI 服务"><option value="">默认 AI 服务</option></select><button class="btn ghost" data-ai="evaluate">AI 评估</button><button class="btn ghost" data-ai="optimize">AI 优化</button><button class="btn ghost" data-versions>版本历史</button><button class="btn ghost" data-feedback>记录反馈</button><button class="btn ghost" data-copy-editor>应用变量并复制</button></div><p class="wb-inline-error" data-editor-error role="alert"></p><section class="wb-ai-output"></section>`,
        {
          close: () =>
            !editor?.dirty || confirm("提示词尚未保存，关闭后保留本地草稿？"),
        },
      );
      let saveTimer,
        saving = false,
        pending = false,
        dirty = !!recovered,
        sequence = 0,
        base = item.revision || 0,
        live = true,
        modeAt = item.format,
        editorAbort = new AbortController();
      editor = {
        get dirty() {
          return dirty;
        },
        forceClose() {
          live = false;
          clearTimeout(saveTimer);
          editorAbort.abort();
          m.close(true);
          if (editor?.node === m.d) editor = null;
          cache.clear();
          if (current(root, owner)) load();
        },
        node: m.d,
      };
      m.d.addEventListener("close", () => {
        live = false;
        clearTimeout(saveTimer);
        editorAbort.abort();
        if (editor?.node === m.d) editor = null;
        cache.clear();
        if (current(root, owner)) load();
      });
      const source = q(".wb-editor-source", m.d),
        rich = q(".wb-rich-editor", m.d),
        preview = q(".wb-editor-preview", m.d),
        error = q("[data-editor-error]", m.d);
      source.value = item.content;
      if (item.templateUpdate)
        q(".wb-editor-fields", m.d).before(
          U().el("p", {
            class: "wb-template-update",
            text: item.templateUpdate.message,
          }),
        );
      const alive = () => live && m.d.isConnected && current(root, owner);
      editor.syncFeatures = () => {
        clearTimeout(saveTimer);
        if (features.promptAutosave && dirty)
          saveTimer = setTimeout(() => save(), 800);
        qa("[data-ai]", m.d).forEach(
          (b) =>
            (b.disabled =
              !features.promptAIEnabled ||
              !editor.canAI ||
              b.dataset.pending === "true"),
        );
      };
      if (item.variablesRaw !== undefined)
        q("[name=variables]", m.d).value = item.variablesRaw;
      const rawDraft = () => ({
        id: item.id,
        title: q("[name=title]", m.d).value,
        content:
          modeAt === "rich" ? JSON.stringify(U().richDoc(rich)) : source.value,
        format: q("[name=format]", m.d).value,
        folder: q("[name=folder]", m.d).value,
        tags: q("[name=tags]", m.d)
          .value.split(/[，,]/)
          .map((x) => x.trim())
          .filter(Boolean),
        variablesRaw: q("[name=variables]", m.d).value,
        variables: item.variables || {},
        favorite: item.favorite,
        pinned: item.pinned,
        origin: item.origin || {},
        expectedRevision: base,
      });
      const payload = () => {
        const { variablesRaw, ...value } = rawDraft();
        return { ...value, variables: JSON.parse(variablesRaw || "{}") };
      };
      const paintPreview = () => {
        try {
          const body =
            modeAt === "rich"
              ? JSON.stringify(U().richDoc(rich))
              : source.value;
          U().preview(preview, body, modeAt);
        } catch (error) {
          preview.textContent = error.message;
        }
      };
      const status = () => {
        q("[data-save-status]", m.d).textContent = saving
          ? "正在保存…"
          : dirty
            ? "有未保存的修改"
            : "已保存";
        q("[data-save-prompt]", m.d).disabled = saving;
      };
      async function save(checkpoint = false) {
        if (!alive()) return;
        if (saving) {
          pending = true;
          return;
        }
        let data;
        try {
          data = payload();
        } catch {
          error.textContent = "变量 JSON 暂不完整；草稿保留";
          return;
        }
        const submitted = sequence;
        saving = true;
        status();
        error.textContent = "";
        try {
          const saved = await U().request(
            "POST",
            "/api/prompts",
            { ...data, checkpoint },
            { signal: editorAbort.signal },
          );
          if (!alive()) return;
          item = { ...item, ...saved };
          base = saved.revision;
          dirty = submitted !== sequence;
          if (!dirty) localStorage.removeItem(draftKey);
          q(".wb-conflict", m.d).hidden = true;
        } catch (ex) {
          if (alive()) {
            error.textContent = ex.message;
            if (ex.status === 409 && ex.current) {
              const seat = q(".wb-conflict", m.d);
              seat.hidden = false;
              seat.replaceChildren(
                U().el("p", {
                  text: "其他窗口已保存新版本。当前草稿保留，请选择处理方式。",
                }),
              );
              const copy = U().el("button", {
                class: "btn ghost",
                text: "另存为新提示词",
              });
              copy.onclick = () => {
                item.id = undefined;
                base = 0;
                seat.hidden = true;
                save(true);
              };
              const load = U().el("button", {
                class: "btn ghost",
                text: "载入最新版本",
              });
              load.onclick = () => {
                if (confirm("保留本地草稿并载入最新版本？")) {
                  localStorage.setItem(
                    draftKey + ":conflict",
                    localStorage.getItem(draftKey) || "{}",
                  );
                  localStorage.removeItem(draftKey);
                  editor.forceClose();
                  editPrompt(ex.current.id);
                }
              };
              seat.append(copy, load);
              pending = false;
            }
          }
        } finally {
          saving = false;
          if (alive()) {
            status();
            if (pending) {
              pending = false;
              clearTimeout(saveTimer);
              saveTimer = setTimeout(() => save(), 800);
            }
          }
        }
        return item;
      }
      const change = () => {
        dirty = true;
        sequence++;
        try {
          localStorage.setItem(draftKey, JSON.stringify(rawDraft()));
        } catch {
          error.textContent = "浏览器草稿存储不可用，请手动保存或导出文本";
        }
        paintPreview();
        status();
        clearTimeout(saveTimer);
        if (features.promptAutosave) saveTimer = setTimeout(() => save(), 800);
      };
      function setFormat() {
        source.hidden = modeAt === "rich";
        rich.hidden = modeAt !== "rich";
        q(".wb-rich-toolbar", m.d).hidden = modeAt !== "rich";
        if (modeAt === "rich") {
          try {
            rich.innerHTML = U().richHTML(JSON.parse(source.value));
          } catch {
            rich.replaceChildren(U().el("p", { text: source.value }));
          }
        }
        paintPreview();
      }
      q("[name=format]", m.d).onchange = () => {
        const next = q("[name=format]", m.d).value;
        if (modeAt === "rich") source.value = U().richText(U().richDoc(rich));
        else if (next === "rich") {
          rich.replaceChildren(U().el("p", { text: source.value }));
          source.value = JSON.stringify(U().richDoc(rich));
        }
        modeAt = next;
        setFormat();
        change();
      };
      source.oninput = change;
      rich.oninput = change;
      rich.onpaste = (ev) => {
        ev.preventDefault();
        const value = ev.clipboardData.getData("text/plain");
        const range = getSelection()?.rangeCount
          ? getSelection().getRangeAt(0)
          : null;
        if (range) {
          range.deleteContents();
          range.insertNode(document.createTextNode(value));
        } else rich.append(document.createTextNode(value));
        change();
      };
      qa(
        "[name=title],[name=tags],[name=folder],[name=variables]",
        m.d,
      ).forEach((input) => {
        input.addEventListener("input", change);
        input.addEventListener("change", change);
      });
      qa("[data-rich]", m.d).forEach((b) => {
        b.onmousedown = (ev) => ev.preventDefault();
        b.onclick = () => {
          rich.focus();
          document.execCommand(b.dataset.rich, false, null);
          change();
        };
      });
      q("footer", m.d).innerHTML =
        '<span data-save-status></span><div class="control-actions"><button class="btn ghost" data-close-editor>关闭</button><button class="btn" data-save-prompt>保存</button></div>';
      q("[data-save-prompt]", m.d).onclick = () => save(true);
      q("[data-close-editor]", m.d).onclick = () => m.close(false);
      m.d.onkeydown = (ev) => {
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
          ev.preventDefault();
          save(true);
        }
      };
      q("[data-copy-editor]", m.d).onclick = async () => {
        const saved = dirty || !item.id ? await save(true) : item;
        if (!saved?.id || dirty) return;
        const value = await U().request("POST", "/api/prompts/render", {
          id: saved.id,
          variables: JSON.parse(q("[name=variables]", m.d).value || "{}"),
        });
        await navigator.clipboard.writeText(value.content);
        await U().request("POST", "/api/prompts/event", {
          id: saved.id,
          action: "apply",
        });
        U().notify("已应用变量并复制", {kind:"success"});
      };
      q("[data-feedback]", m.d).onclick = async () => {
        const saved = dirty || !item.id ? await save(true) : item;
        if (!saved?.id || dirty) return;
        const rating = Number(prompt("你的使用评分（1–5）", "4"));
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) return;
        const note = prompt("使用反馈（可留空）", "");
        if (note === null) return;
        await U().request("POST", "/api/prompts/event", {
          id: item.id,
          action: "feedback",
          details: { rating, note },
        });
        U().notify("反馈已记录", {kind:"success"});
      };
      q("[data-versions]", m.d).onclick = async () => {
        if (!item.id) return;
        const data = await U().request(
          "GET",
          "/api/prompts/versions?id=" + item.id,
        );
        const v = modal("版本历史", '<div class="wb-version-list"></div>');
        const list = q(".wb-version-list", v.d);
        if (!data.items.length) list.textContent = "暂无历史版本";
        for (const version of data.items) {
          const node = U().el("section", { class: "wb-panel" });
          node.append(
            U().el("h3", {
              text:
                "版本 " +
                version.revision +
                " · " +
                new Date(version.at).toLocaleString(),
            }),
            U().el("pre", {
              class: "wb-text-preview",
              text: version.value.content,
            }),
          );
          const compare = U().el("details");
          compare.append(U().el("summary", { text: "对比当前草稿" }));
          const diff = U().el("div");
          U().diff(diff, source.value, version.value.content);
          compare.append(diff);
          node.append(compare);
          const b = U().el("button", {
            class: "btn ghost",
            text: "载入为当前草稿",
          });
          b.onclick = () => {
            source.value = version.value.content;
            for (const key of ["title", "folder"])
              q("[name=" + key + "]", m.d).value = version.value[key] || "";
            q("[name=tags]", m.d).value = (version.value.tags || []).join(", ");
            q("[name=variables]", m.d).value = JSON.stringify(
              version.value.variables || {},
              null,
              2,
            );
            item.favorite = version.value.favorite;
            item.pinned = version.value.pinned;
            item.origin = version.value.origin || {};
            modeAt = version.value.format;
            q("[name=format]", m.d).value = modeAt;
            setFormat();
            change();
            v.close(true);
          };
          node.append(b);
          list.append(node);
        }
      };
      async function runAI(kind, button) {
        if (!features.promptAIEnabled) {
          U().notify("设置中已关闭 AI 评估与优化");
          return;
        }
        const saved = dirty || !item.id ? await save(true) : item;
        if (!saved?.id || dirty) return;
        button.disabled = true;
        button.dataset.pending = "true";
        const stop = U().busy(q(".wb-ai-output", m.d), "正在请求 AI…", 0);
        try {
          const task = await U().request(
            "POST",
            "/api/prompts/ai",
            {
              id: item.id,
              kind,
              provider: q("[name=provider]", m.d).value || undefined,
              variables: JSON.parse(q("[name=variables]", m.d).value || "{}"),
            },
            { signal: editorAbort.signal },
          );
          const value = await U().job(task, { signal: editorAbort.signal });
          if (!alive()) return;
          const result = value.result,
            output = q(".wb-ai-output", m.d);
          output.replaceChildren();
          const section = U().el("article", { class: "wb-ai-result" });
          section.append(
            U().el("h3", {
              text: kind === "evaluate" ? "AI 评估建议" : "优化建议",
            }),
            U().el("p", {
              class: "wb-muted",
              text:
                (result.model || "") +
                " · 基于版本 " +
                value.revision +
                "；建议不代表客观效果",
            }),
          );
          if (kind === "evaluate") {
            section.append(
              U().el("strong", {
                class: "wb-ai-score",
                text: result.score + " / 100",
              }),
            );
            for (const [key, score] of Object.entries(result.scores))
              section.append(
                U().el("p", { text: key + "：" + score + " / 5" }),
              );
            section.append(U().el("p", { text: result.explanation || "" }));
          } else {
            section.append(U().el("p", { text: result.reason || "" }));
            const diff = U().el("div");
            U().diff(
              diff,
              saved.format === "rich"
                ? U().richText(JSON.parse(saved.content))
                : saved.content,
              result.content,
            );
            section.append(diff);
            const apply = U().el("button", {
              class: "btn",
              text: "载入优化结果为新草稿",
            });
            apply.onclick = () => {
              if (
                (base !== value.revision || dirty) &&
                !confirm("评估期间原文有变化，仍载入此版本的建议？")
              )
                return;
              source.value = result.content;
              modeAt = "markdown";
              q("[name=format]", m.d).value = "markdown";
              setFormat();
              change();
            };
            section.append(apply);
          }
          const usage = U().el("details"),
            usageTitle = U().el("summary", {
              text: result.usage
                ? "本次响应 usage（API 用量证据）"
                : "本次响应未返回 usage，用量未知",
            });
          usage.append(usageTitle);
          if (result.usage)
            usage.append(
              U().el("pre", {
                class: "wb-text-preview",
                text: JSON.stringify(result.usage, null, 2),
              }),
            );
          section.append(usage);
          output.append(section);
        } catch (ex) {
          if (alive() && ex.name !== "AbortError")
            error.textContent = ex.message;
        } finally {
          stop();
          if (alive()) {
            delete button.dataset.pending;
            button.disabled = !features.promptAIEnabled || !editor.canAI;
          }
        }
      }
      qa("[data-ai]", m.d).forEach(
        (b) => (b.onclick = () => runAI(b.dataset.ai, b)),
      );
      U()
        .request("GET", "/api/control", undefined, {
          signal: editorAbort.signal,
        })
        .then((control) => {
          if (!alive()) return;
          const select = q("[name=provider]", m.d);
          for (const provider of control.providers.filter(
            (p) => p.configured && p.enabled,
          ))
            select.append(
              U().el("option", {
                value: provider.id,
                text: provider.name + " · " + provider.model,
              }),
            );
          editor.canAI = control.providers.some(
            (p) => p.configured && p.enabled,
          );
          editor.syncFeatures();
        })
        .catch(() => {});
      setFormat();
      status();
      q("[name=title]", m.d).focus();
    }
    async function marketPreview(item) {
      const value = await U().request(
        "GET",
        "/api/prompts/market/item?source=" +
          encodeURIComponent(item.source) +
          "&id=" +
          item.id,
      );
      const m = modal(value.title, '<div class="wb-template-preview"></div>');
      U().preview(q(".wb-template-preview", m.d), value.content, value.format);
      q("footer", m.d).innerHTML =
        `<span>${e(value.origin.license)} · ${e(value.origin.repo)}</span><button class="btn" data-apply>创建个人副本</button>`;
      q("[data-apply]", m.d).onclick = () => {
        m.close(true);
        editPrompt(null, value);
      };
    }
    async function applyMarket(item) {
      try {
        const p = await U().request("POST", "/api/prompts/market/apply", {
          source: item.source,
          id: item.id,
        });
        U().notify("已保存到我的提示词库", {kind:"success"});
        cache.clear();
        return p;
      } catch (error) {
        U().notify(error.message, {kind:"error"});
      }
    }
    async function syncMarket() {
      const sources = result?.sources || [];
      const source = params.source || sources[0]?.id;
      if (!source) return;
      const stop = U().busy(content, "正在同步公开模板…", 0);
      try {
        const task = await U().request("POST", "/api/prompts/market/sync", {
          source,
        });
        await U().job(task, { signal });
        cache.clear();
        load();
      } catch (error) {
        U().notify(error.message, {kind:"error"});
      } finally {
        stop();
      }
    }
    function sourceDialog() {
      const m = modal(
        "添加公开模板源",
        '<form><label class="control-field">名称<input name="name"></label><label class="control-field">GitHub 仓库<input name="repo" placeholder="owner/repository" required></label><label class="control-field">文件路径<input name="path" placeholder="prompts.json" required></label><label class="control-field">分支<input name="ref" value="main"></label><label class="control-field">格式<select name="format"><option value="json">JSON</option><option value="csv">CSV</option><option value="markdown">Markdown</option></select></label><label class="control-field">模板数据许可<input name="license" placeholder="核验来源许可后填写" required></label><label class="control-field">字段映射（JSON，可选）<textarea name="mapping" rows="2">{}</textarea></label><div data-source-preview></div><p class="wb-inline-error" role="alert"></p></form>',
      );
      let previewed, previewCommit;
      const form = q("form", m.d),
        error = q("[role=alert]", m.d),
        read = () => {
          const data = Object.fromEntries(new FormData(form));
          data.mapping = JSON.parse(data.mapping);
          return data;
        };
      q("footer", m.d).innerHTML =
        '<button class="btn ghost" data-preview>预览来源</button><button class="btn" data-save disabled>确认并同步到本地</button>';
      form.oninput = () => {
        previewed = null;
        q("[data-save]", m.d).disabled = true;
      };
      q("[data-preview]", m.d).onclick = async (ev) => {
        if (!form.reportValidity()) return;
        const stop = U().busy(
          q("[data-source-preview]", m.d),
          "正在读取公开模板…",
        );
        ev.target.disabled = true;
        try {
          const data = read(),
            task = await U().request(
              "POST",
              "/api/prompts/market/preview",
              data,
            ),
            result = await U().job(task, { signal });
          if (
            !m.d.isConnected ||
            JSON.stringify(read()) !== JSON.stringify(data)
          )
            return;
          previewed = data;
          previewCommit = result.commit;
          error.textContent = "";
          const seat = q("[data-source-preview]", m.d);
          seat.replaceChildren(
            U().el("p", {
              text:
                "识别 " +
                result.count +
                " 条 · " +
                result.license +
                " · " +
                result.commit.slice(0, 8),
            }),
          );
          result.items.forEach((item) =>
            seat.append(
              U().el("p", { text: item.title + " · " + item.excerpt }),
            ),
          );
          q("[data-save]", m.d).disabled = !result.count;
        } catch (ex) {
          error.textContent = ex.message;
        } finally {
          stop();
          if (ev.target.isConnected) ev.target.disabled = false;
        }
      };
      q("[data-save]", m.d).onclick = async (ev) => {
        if (!previewed) return;
        ev.target.disabled = true;
        try {
          const source = await U().request(
              "POST",
              "/api/prompts/market/source",
              previewed,
            ),
            task = await U().request("POST", "/api/prompts/market/sync", {
              source: source.id,
              expectedCommit: previewCommit,
            });
          await U().job(task, { signal });
          m.close(true);
          cache.clear();
          load();
        } catch (ex) {
          error.textContent = ex.message;
          ev.target.disabled = false;
        }
      };
    }
    function paintStats(data) {
      const output = q(".wb-stats-output", content);
      if (!output) return;
      const folder = q("[data-stat-folder]", content),
        tag = q("[data-stat-tag]", content);
      folder.innerHTML =
        '<option value="">全部分类</option>' +
        data.folders
          .map(
            (f) => '<option value="' + e(f.id) + '">' + e(f.name) + "</option>",
          )
          .join("");
      folder.value = params.folder || "";
      tag.innerHTML =
        '<option value="">全部标签</option>' +
        data.tags.map((t) => "<option>" + e(t) + "</option>").join("");
      tag.value = params.tag || "";
      output.innerHTML = `<section class="wb-panel"><div class="section-title"><h2>使用记录</h2><div class="control-actions"><button class="btn ghost" data-report-json>JSON</button><button class="btn ghost" data-report-csv>CSV</button><button class="btn ghost" data-report-html>HTML</button></div></div><p class="wb-muted">复制、模板应用与 AI 操作分开统计；打开预览不计入使用。</p><div class="wb-stats-cards">${data.actions.map((a) => `<div class="wb-panel"><span>${e({ copy: "复制", apply: "模板应用", evaluate: "AI评估", optimize: "AI优化", feedback: "反馈" }[a.action] || a.action)}</span><strong>${a.count}</strong></div>`).join("")}</div><h3>使用趋势</h3><div data-stat-trend></div><h3>每日记录</h3><div class="control-table-wrap"><table class="control-table"><thead><tr><th>日期</th><th>操作</th><th>次数</th></tr></thead><tbody>${data.daily.map((r) => `<tr><td>${e(r.date)}</td><td>${e(r.action)}</td><td>${r.count}</td></tr>`).join("")}</tbody></table></div><h3>分类与标签分析</h3><div class="wb-stats-cards">${Object.entries(
        data.categories,
      )
        .sort((a, b) => b[1] - a[1])
        .map(
          ([id, count]) =>
            `<div class="wb-panel"><span>${e(data.folders.find((f) => f.id === id)?.name || "未分类")}</span><strong>${count}</strong></div>`,
        )
        .join("")}${Object.entries(data.tagCounts)
        .sort((a, b) => b[1] - a[1])
        .map(
          ([tag, count]) =>
            `<div class="wb-panel"><span>${e(tag)}</span><strong>${count}</strong></div>`,
        )
        .join(
          "",
        )}</div><h3>提示词使用频率</h3>${data.prompts.map((p) => `<p>${e(p.title)} · ${p.count} 次 · ${e(p.tags)}</p>`).join("")}<h3>你的反馈</h3>${data.feedback.map((f) => `<p>${e(new Date(f.at).toLocaleString())} · ${f.details.rating || "—"} / 5 · ${e(f.details.note || "")}</p>`).join("")}</section>`;
      const counts = new Map();
      data.daily
        .filter((r) => ["copy", "apply"].includes(r.action))
        .forEach((r) =>
          counts.set(r.date, (counts.get(r.date) || 0) + r.count),
        );
      const trend = q("[data-stat-trend]", output);
      trend.innerHTML = window.usageCharts.trend(
        [...counts].map(([date, total]) => ({ date, total })),
        "复制与模板应用次数",
      );
      const plot = q(".usage-plot", trend);
      plot.dataset.unit = " 次";
      plot.dataset.axisLabel = "次数";
      window.usageCharts.mount(trend);
      q("[data-report-json]", output).onclick = () =>
        U().download({
          filename: "prompt-report.json",
          mime: "application/json",
          content: JSON.stringify(data, null, 2),
        });
      q("[data-report-csv]", output).onclick = () =>
        U().download({
          filename: "prompt-report.csv",
          mime: "text/csv",
          content:
            "date,action,count\n" +
            data.daily
              .map((r) => [r.date, r.action, r.count].join(","))
              .join("\n"),
        });
      q("[data-report-html]", output).onclick = () =>
        U().download({
          filename: "prompt-report.html",
          mime: "text/html",
          content:
            '<!doctype html><meta charset="utf-8"><title>提示词使用报告</title><style>body{font:14px system-ui;max-width:1000px;margin:40px auto}table{border-collapse:collapse}td,th{padding:8px;border:1px solid #ddd}</style>' +
            output.innerHTML,
        });
    }
    async function importDialog() {
      const m = modal(
        "导入提示词",
        '<p class="wb-muted">支持 TXT、Markdown、JSON、CSV、HTML、ZIP；先预览再保存。</p><input type="file" data-file accept=".txt,.md,.markdown,.json,.csv,.html,.htm,.zip"><button class="btn ghost" data-clipboard>从剪贴板导入</button><textarea data-paste class="wb-editor-source" placeholder="也可粘贴纯文本或 JSON" rows="4"></textarea><button class="btn ghost" data-preview>预览文本</button><div data-import-preview></div><p class="wb-inline-error" role="alert"></p>',
      );
      let data;
      const preview = async (filename, bytes) => {
        try {
          data = await U().request("POST", "/api/prompts/import/preview", {
            filename,
            data: bytes,
          });
          const seat = q("[data-import-preview]", m.d);
          seat.replaceChildren(
            U().el("p", {
              text: "识别 " + data.total + " 条；重复内容默认跳过。",
            }),
          );
          for (const item of data.items.slice(0, 30))
            seat.append(
              U().el("p", { text: item.title + " · " + item.format }),
            );
          q("[data-import-confirm]", m.d).disabled = !data.items.length;
        } catch (error) {
          q("[role=alert]", m.d).textContent = error.message;
        }
      };
      q("[data-file]", m.d).onchange = async (ev) => {
        const file = ev.target.files[0];
        if (file) preview(file.name, await fileData(file));
      };
      q("[data-preview]", m.d).onclick = () => {
        const value = q("[data-paste]", m.d).value;
        preview(
          value.trim().startsWith("{") || value.trim().startsWith("[")
            ? "clipboard.json"
            : "clipboard.txt",
          btoa(unescape(encodeURIComponent(value))),
        );
      };
      q("[data-clipboard]", m.d).onclick = async () => {
        try {
          q("[data-paste]", m.d).value = await navigator.clipboard.readText();
          q("[data-preview]", m.d).click();
        } catch {
          q("[role=alert]", m.d).textContent =
            "浏览器未允许读取剪贴板，请粘贴到文本框。";
        }
      };
      q("footer", m.d).innerHTML =
        '<span>内容不会被执行</span><button class="btn" data-import-confirm disabled>确认导入</button>';
      q("[data-import-confirm]", m.d).onclick = async () => {
        const button = q("[data-import-confirm]", m.d);
        button.disabled = true;
        let done = 0;
        try {
          for (let i = 0; i < data.items.length; i += 1000) {
            await U().request("POST", "/api/prompts/import", {
              items: data.items.slice(i, i + 1000),
            });
            done = i + Math.min(1000, data.items.length - i);
          }
          m.close(true);
          cache.clear();
          load();
          U().notify("导入完成", {kind:"success"});
        } catch (error) {
          data.items = data.items.slice(done);
          q("[role=alert]", m.d).textContent =
            "已处理 " + done + " 条；剩余内容保留。" + error.message;
          button.disabled = false;
        }
      };
    }
    function exportDialog() {
      const m = modal(
        "导出提示词",
        '<label class="control-field">格式<select><option value="json">JSON（含变量与来源）</option><option value="md">Markdown</option><option value="txt">纯文本</option><option value="csv">CSV</option><option value="html">HTML</option><option value="zip">ZIP 批量文件</option></select></label><p class="wb-muted">只导出当前账号；不包含模型服务凭据。</p>',
      );
      q("footer", m.d).innerHTML =
        '<button class="btn" data-export-confirm>导出</button>';
      q("[data-export-confirm]", m.d).onclick = async () => {
        const value = await U().request(
          "GET",
          "/api/prompts/export?format=" + q("select", m.d).value,
        );
        U().download(value);
        m.close(true);
      };
    }
    q("[data-create]", root).onclick = () => editPrompt();
    q("[data-import]", root).onclick = importDialog;
    q("[data-export]", root).onclick = exportDialog;
    const off = window.workbenchContextMenu?.register?.(({ target }) => {
      const card = target?.closest?.(".wb-library-card");
      return card && root.contains(card) ? card._wbContextActions || [] : [];
    });
    const dispose = root._wbDispose;
    root._wbDispose = () => {
      dispose();
      off?.();
    };
    draw();
    await load();
  }

/* 技能管理中台：概览 / 技能库 / Agent / 工作区 / 设置。
   * 数据只来自 /api/skill-manager/*；扫描与预览只读，不执行 SKILL.md 或脚本。
   * 视觉与信息架构参考 skills-manager，使用本工作台的令牌与交互规范。 */
  async function skills(root) {
    const owner = user.username,
      signal = root._wbAbort?.signal,
      content = shell(
        root,
        "技能管理",
        "集中浏览已登记的技能目录、Agent 与工作区。索引和预览都是只读的，不会执行 SKILL.md 或任何脚本。",
        '<button class="btn ghost" data-refresh>刷新数据</button><button class="btn" data-rescan>重建索引</button>',
      );
    content.classList.add("sm-page");
    content.id = "sm-view";
    content.setAttribute("role", "tabpanel");
    if (!document.querySelector("link[data-skill-manager-css]")) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/skill-manager.css";
      link.dataset.skillManagerCss = "1";
      document.head.append(link);
    }

    /* ------------------------------------------------------------ 图标与格式化 */
    const ICONS = {
      overview:
        '<rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/>',
      library:
        '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>',
      agents:
        '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M9 12h.01M15 12h.01M9 16h6M12 7V4"/>',
      workspaces:
        '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
      settings:
        '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
      search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>',
      refresh: '<path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 5v6h-6"/>',
      scan:
        '<path d="M3 8V4h4M21 8V4h-4M3 16v4h4M21 16v4h-4"/><circle cx="12" cy="12" r="4"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      shield:
        '<path d="M12 3 5 6v6c0 4.4 3 7.3 7 9 4-1.7 7-4.6 7-9V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
      alert:
        '<path d="M10.3 4.3 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
      info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
      copy:
        '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
      edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
      trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
      back: '<path d="m15 18-6-6 6-6"/>',
      chevron: '<path d="m9 6 6 6-6 6"/>',
      close: '<path d="M6 6l12 12M18 6 6 18"/>',
      check: '<path d="m5 12 5 5L20 7"/>',
      link:
        '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
      folder:
        '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
    };
    const icon = (name, size = 16) =>
      `<svg class="sm-ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
    const SOURCE_LABEL = {
      local: "本机目录",
      adopted: "工作区收编",
      git: "Git 仓库",
      archive: "归档导入",
      market: "市场安装",
      manual: "手工安装",
      url: "链接导入",
    };
    const sourceText = (source) =>
      (source && SOURCE_LABEL[source.type]) || (source?.type ? String(source.type) : "来源未知");
    const P10N_LABEL = {
      custom: ["当前 Profile 覆盖", "accent"],
      catalog: ["本地词目", "ok"],
      source: ["源文件为中文", "quiet"],
      untranslated: ["缺少中文资料", "warn"],
    };
    const p10n = (card) => P10N_LABEL[card.presentationSource] || ["中文状态未知", "quiet"];
    const UPSTREAM_LABEL = {
      unknown: "未检查",
      current: "与上游一致",
      behind: "落后上游",
      "local-changes": "本地有改动",
      diverged: "已分叉",
      unavailable: "无法比较",
    };
    const upstreamText = (upstream) => UPSTREAM_LABEL[upstream?.status] || "未检查";
    const LIB_LABEL = {
      ok: ["可用", "ok"],
      missing: ["文件缺失", "danger"],
      modified: ["内容已变更", "warn"],
    };
    const libState = (card) => LIB_LABEL[card.libraryStatus] || ["状态未知", "quiet"];
    const DEPLOY_LABEL = {
      absent: "未部署",
      linked: "符号链接",
      copied: "副本一致",
      different: "内容不同",
      external: "外部来源",
      unreadable: "不可读",
    };
    const deployText = (status) => DEPLOY_LABEL[status] || "未知";
    const deployTone = (status) =>
      status === "linked" || status === "copied"
        ? "ok"
        : status === "different"
          ? "warn"
          : status === "unreadable"
            ? "danger"
            : status === "external"
              ? "quiet"
              : "";
    const MODE_LABEL = {
      symlink: "符号链接",
      junction: "目录联接",
      copy: "复制",
      "symlink-fallback-copy": "链接失败后复制",
      "": "",
    };
    const ACTION_LABEL = {
      scan: "重建索引",
      deploy: "部署技能",
      undeploy: "撤下技能",
      "sync-to-workspace": "同步到工作区",
      "add-to-library": "收进中央库",
      "remove-from-library": "移出中央库",
      presentation: "更新中文展示",
      tags: "更新标签",
      "workspace-save": "关联工作区",
      "workspace-delete": "移除工作区",
      "agent-save": "更新 Agent",
    };
    const actionText = (action) => ACTION_LABEL[action] || action || "操作";
    const SYNC_ACTION = {
      "in-sync": ["已同步", "ok"],
      "add-to-workspace": ["待加入工作区", "warn"],
      "add-to-library": ["待收进中央库", "warn"],
      differs: ["内容不同", "danger"],
      external: ["外部来源", "quiet"],
    };
    const KIND_LABEL = { global: "全局", project: "项目", linked: "自定义关联" };
    const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
    const pad2 = (value) => String(value).padStart(2, "0");
    const asDate = (value) => {
      if (value === undefined || value === null || value === "") return null;
      if (typeof value === "number") return new Date(value < 1e12 ? value * 1000 : value);
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    };
    const fmtTime = (value) => {
      const date = asDate(value);
      if (!date) return "未知";
      const diff = Date.now() - date.getTime();
      if (diff >= 0) {
        if (diff < 60e3) return "刚刚";
        if (diff < 3600e3) return Math.floor(diff / 60e3) + " 分钟前";
        if (diff < 86400e3) return Math.floor(diff / 3600e3) + " 小时前";
        if (diff < 7 * 86400e3) return Math.floor(diff / 86400e3) + " 天前";
      }
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    };
    const fullTime = (value) => {
      const date = asDate(value);
      return date ? date.toLocaleString("zh-CN", { hour12: false }) : "未知";
    };
    const fmtBytes = (value) => {
      let size = num(value);
      if (size <= 0) return "0 B";
      const units = ["B", "KB", "MB", "GB"];
      let index = 0;
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index++;
      }
      return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
    };
    const compactPath = (value) => {
      if (!value) return "—";
      const parts = String(value).split(/[\\/]/).filter(Boolean);
      return parts.length <= 3 ? String(value) : "…\\" + parts.slice(-2).join("\\");
    };
    const coverageTone = (status) =>
      status === "complete" || status === "ok"
        ? "ok"
        : status === "limited" || status === "partial"
          ? "warn"
          : status === "error" || status === "missing"
            ? "danger"
            : "quiet";
    const coverageText = (status) =>
      ({ complete: "完整", ok: "完整", limited: "受限", partial: "部分", error: "失败", missing: "缺失", skipped: "跳过" })[
        status
      ] ||
      status ||
      "未知";
    const loadingBlock = (label) =>
      `<div class="sm-loading" role="status"><span class="sm-spinner" aria-hidden="true"></span><span>${e(label)}</span></div>`;
    const errorBlock = (message) =>
      `<div class="sm-error-banner" role="alert">${icon("alert", 16)}<div><strong>读取失败</strong><span>${e(message)}</span><div><button class="btn ghost small" type="button" data-retry>重试</button></div></div></div>`;
    const emptyBlock = (title, text, action = "") =>
      `<div class="sm-empty"><strong>${e(title)}</strong><p>${e(text)}</p>${action}</div>`;
    const skeletonCards = (count = 6) =>
      Array.from({ length: count }, () => '<div class="sm-skeleton sm-skeleton-card"></div>').join("");

    const api = (method, path, body, options) =>
      U().request(method, "/api/skill-manager" + path, body, { signal: options?.signal || signal });
    const copyText = async (value) => {
      try {
        await navigator.clipboard.writeText(value);
        U().notify("路径已复制", { kind: "success" });
      } catch {
        U().notify(value, { kind: "info" });
      }
    };

    /* ------------------------------------------------------------ 状态与页签 */
    const state = {
      tab: "overview",
      overview: null,
      overviewError: "",
      attentionItems: [],
      attentionTotal: 0,
      agents: null,
      agentsError: "",
      workspaces: null,
      workspacesError: "",
      settings: null,
      settingsError: "",
      entriesFor: "",
      entriesName: "",
      entries: null,
      entriesError: "",
      entriesLoading: false,
      library: { q: "", tag: "", agent: "", offset: 0, limit: 12, data: null, error: "", loading: false },
      detail: null,
      scanBusy: false,
      disposed: false,
    };
    let searchTimer = 0,
      libraryToken = 0,
      overviewToken = 0,
      agentsToken = 0,
      workspacesToken = 0,
      settingsToken = 0,
      entriesToken = 0,
      detailAbort = null;

    const TABS = [
      ["overview", "概览", "overview"],
      ["library", "技能库", "library"],
      ["agents", "Agent", "agents"],
      ["workspaces", "工作区", "workspaces"],
      ["settings", "设置", "settings"],
    ];
    const tabsHost = q(".wb-library-tabs", root);
    tabsHost.classList.add("sm-tabs");
    tabsHost.setAttribute("role", "tablist");
    tabsHost.setAttribute("aria-label", "技能管理页面");
    tabsHost.innerHTML = TABS.map(
      ([id, label, ico]) =>
        `<button class="sm-tab" type="button" role="tab" id="sm-tab-${id}" aria-controls="sm-view" aria-selected="false" tabindex="-1" data-tab="${id}">${icon(ico)}<span>${label}</span><span class="sm-tab-count" data-count="${id}" hidden></span></button>`,
    ).join("");

    function tabCounts() {
      const overview = state.overview;
      return {
        library: overview ? overview.libraryTotal : "",
        agents: overview ? (overview.agents || []).length : "",
        workspaces: overview ? (overview.workspaces || []).length : "",
      };
    }
    function syncTabCounts() {
      const counts = tabCounts();
      qa("[data-count]", tabsHost).forEach((node) => {
        const value = counts[node.dataset.count];
        node.hidden = value === "" || value === undefined;
        node.textContent = value === "" || value === undefined ? "" : value;
      });
    }
    function selectTab(id, focus = false) {
      if (!TABS.some((tab) => tab[0] === id)) id = "overview";
      state.tab = id;
      if (id !== "workspaces") {
        state.entriesFor = "";
        state.entries = null;
        state.entriesError = "";
      }
      qa(".sm-tab", tabsHost).forEach((button) => {
        const on = button.dataset.tab === id;
        button.setAttribute("aria-selected", on ? "true" : "false");
        button.tabIndex = on ? 0 : -1;
        if (on && focus) button.focus();
      });
      content.setAttribute("aria-labelledby", "sm-tab-" + id);
      if (id === "overview") {
        paintOverview();
        void loadOverview();
      } else if (id === "library") {
        paintLibraryShell();
        paintLibrary();
        void loadLibrary();
      } else if (id === "agents") {
        paintAgents();
        void loadAgents();
      } else if (id === "workspaces") {
        paintWorkspaces();
        if (state.entriesFor) {
          if (!state.entries && !state.entriesLoading) void loadEntries(state.entriesFor);
        } else void loadWorkspaces({ force: true });
      } else {
        paintSettings();
        void loadSettings();
      }
    }
    tabsHost.addEventListener("click", (event) => {
      const button = event.target.closest(".sm-tab");
      if (button) selectTab(button.dataset.tab);
    });
    tabsHost.addEventListener("keydown", (event) => {
      const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
      if (!keys.includes(event.key)) return;
      const buttons = qa(".sm-tab", tabsHost);
      const index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      selectTab(buttons[next].dataset.tab, true);
    });

    content.addEventListener("click", (event) => {
      const target = event.target;
      const stat = target.closest("[data-stat]");
      if (stat) {
        selectTab(stat.dataset.stat);
        return;
      }
      const openSkill = target.closest("[data-open-skill]");
      if (openSkill) {
        void openDetail(openSkill.dataset.openSkill);
        return;
      }
      const openWorkspaceButton = target.closest("[data-open-workspace]");
      if (openWorkspaceButton) {
        openWorkspace(openWorkspaceButton.dataset.openWorkspace);
        return;
      }
      const goto = target.closest("[data-goto]");
      if (goto) {
        selectTab(goto.dataset.goto);
        return;
      }
      const copy = target.closest("[data-copy]");
      if (copy) {
        void copyText(copy.dataset.copy);
        return;
      }
      const retry = target.closest("[data-retry]");
      if (retry) {
        selectTab(state.tab);
        return;
      }
      const scanButton = target.closest("[data-scan-inline]");
      if (scanButton) void rescan();
    });
    content.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const card = event.target.closest("[data-open-skill]");
      if (!card || event.target.closest("button")) return;
      event.preventDefault();
      void openDetail(card.dataset.openSkill);
    });

    /* ------------------------------------------------------------ 概览 */
    function attentionData() {
      const items = state.attentionItems || [];
      const missing = items.filter((item) => item.libraryStatus === "missing");
      const modified = items.filter((item) => item.libraryStatus === "modified");
      const groups = new Map();
      for (const item of items) {
        if (!item.digest) continue;
        if (!groups.has(item.digest)) groups.set(item.digest, []);
        groups.get(item.digest).push(item);
      }
      const dupGroups = [...groups.values()].filter((group) => group.length > 1);
      const dupExtra = dupGroups.reduce((sum, group) => sum + group.length - 1, 0);
      return {
        items,
        missing,
        modified,
        dupGroups,
        dupExtra,
        total: missing.length + modified.length + dupExtra,
        totalKnown: state.attentionTotal,
      };
    }
    function paintOverview() {
      if (state.disposed) return;
      const overview = state.overview;
      if (!overview) {
        content.innerHTML = `<div class="sm-view">${
          state.overviewError ? errorBlock(state.overviewError) : loadingBlock("正在读取技能管理概览…")
        }</div>`;
        return;
      }
      const library = overview.library || {};
      const agents = overview.agents || [];
      const workspaces = overview.workspaces || [];
      const exists = agents.filter((agent) => agent.exists).length;
      const enabled = agents.filter((agent) => agent.enabled).length;
      const kindCount = (kind) => workspaces.filter((workspace) => workspace.kind === kind).length;
      const attention = attentionData();
      const scan = overview.scan || null;
      const coverage = Array.isArray(scan?.coverage) ? scan.coverage : [];
      const activity = (overview.activity || []).slice(0, 6);
      const stat = (label, iconName, value, sub, action, warn) =>
        `<button class="sm-stat${warn ? " warn" : ""}" type="button" data-stat="${action}"><span class="sm-stat-label">${icon(iconName, 14)}${e(label)}</span><strong class="sm-stat-value">${e(value)}</strong><span class="sm-stat-sub">${e(sub)}</span></button>`;
      const attentionRows = [];
      for (const item of attention.missing.slice(0, 2))
        attentionRows.push(
          `<div class="sm-source-row"><span class="sm-dot danger"></span><div class="sm-source-main"><div class="sm-source-title"><strong>${e(item.name)}</strong><span class="sm-pill danger">文件缺失</span></div><p class="sm-path">${e(item.path || "")}</p></div><button class="sm-link" type="button" data-open-skill="${e(item.id)}">查看</button></div>`,
        );
      for (const item of attention.modified.slice(0, 2))
        attentionRows.push(
          `<div class="sm-source-row"><span class="sm-dot warn"></span><div class="sm-source-main"><div class="sm-source-title"><strong>${e(item.name)}</strong><span class="sm-pill warn">内容已变更</span></div><p class="sm-path">${e(item.path || "")}</p></div><button class="sm-link" type="button" data-open-skill="${e(item.id)}">查看</button></div>`,
        );
      for (const group of attention.dupGroups.slice(0, 2))
        attentionRows.push(
          `<div class="sm-source-row"><span class="sm-dot warn"></span><div class="sm-source-main"><div class="sm-source-title"><strong>${group
            .slice(0, 3)
            .map((item) => e(item.name))
            .join("、")}</strong><span class="sm-pill warn">内容重复 ${group.length} 份</span></div><p class="sm-path">按正文摘要识别；不会自动合并或删除。</p></div><button class="sm-link" type="button" data-open-skill="${e(group[0].id)}">查看</button></div>`,
        );
      const sourceRows = [
        {
          key: "library",
          name: "中央技能库",
          path: library.root || "",
          exists: true,
          kind: "中央库",
          meta: `${overview.libraryTotal} 项 · ${fmtBytes(library.bytes)}`,
          iconName: "library",
        },
        ...agents.map((agent) => ({
          key: "agent-" + agent.id,
          name: agent.name,
          path: agent.globalPath,
          exists: agent.exists,
          kind: agent.origin === "builtin" ? "内置 Agent" : "自定义 Agent",
          enabled: agent.enabled,
          meta: agent.enabled ? "参与扫描" : "已停用",
          iconName: "agents",
        })),
        ...workspaces
          .filter((workspace) => workspace.kind !== "global")
          .map((workspace) => ({
            key: "ws-" + workspace.id,
            name: workspace.name,
            path: workspace.root,
            exists: workspace.exists,
            kind: KIND_LABEL[workspace.kind] || workspace.kind,
            meta: `${(workspace.agentIds || []).length} 个 Agent`,
            iconName: "workspaces",
          })),
      ];
      const coverageByPath = new Map(
        coverage.map((row) => [String(row.path || "").toLowerCase(), row]),
      );
      const indexScope =
        attention.totalKnown > attention.items.length
          ? `基于前 ${attention.items.length} / ${attention.totalKnown} 项计算`
          : "";
      content.innerHTML = `<div class="sm-view">
        <div class="sm-stats">
          ${stat(
            "中央技能库",
            "library",
            String(overview.libraryTotal),
            `${fmtBytes(library.bytes)} · ${library.defaultMode === "copy" ? "默认复制" : "默认符号链接"}`,
            "library",
            false,
          )}
          ${stat(
            "Agent 目录",
            "agents",
            `${exists} / ${agents.length}`,
            `已启用 ${enabled} · 目录未创建 ${agents.length - exists}`,
            "agents",
            false,
          )}
          ${stat(
            "工作区",
            "workspaces",
            String(workspaces.length),
            `全局 ${kindCount("global")} · 项目 ${kindCount("project")} · 关联 ${kindCount("linked")}`,
            "workspaces",
            false,
          )}
          ${stat(
            "需关注",
            "alert",
            String(attention.total),
            `缺失 ${attention.missing.length} · 变更 ${attention.modified.length} · 重复 ${attention.dupExtra}`,
            "library",
            attention.total > 0,
          )}
        </div>
        <div class="sm-split">
          <div class="sm-stack">
            <section class="sm-section">
              <div class="sm-section-head"><div><h2>${icon("alert", 16)}资料状态 <span class="sm-count">${attention.total}</span></h2><p>只读核验中央库文件是否存在、内容是否与索引快照一致，并按正文摘要检查重复。${indexScope ? " " + indexScope + "。" : ""}</p></div><div class="sm-section-tools"><button class="btn ghost small" type="button" data-goto="library">打开技能库</button></div></div>
              ${
                overview.libraryTotal === 0
                  ? emptyBlock(
                      "中央库还没有技能",
                      "重建索引会从已登记目录只读吸收技能资料，不会修改或执行任何文件。",
                      `<button class="btn ghost" type="button" data-scan-inline>重建索引</button>`,
                    )
                  : attentionRows.length
                    ? `<div class="sm-source-list">${attentionRows.join("")}</div>${attention.total > attentionRows.length ? `<p class="sm-muted">另有 ${attention.total - attentionRows.length} 项需关注，可在技能库中逐项查看。</p>` : ""}`
                    : `<p class="sm-muted">资料状态正常，未发现缺失、变更或重复内容。</p>`
              }
            </section>
            <section class="sm-section">
              <div class="sm-section-head"><div><h2>${icon("folder", 16)}登记目录</h2><p>只扫描下列已登记目录；不存在的目录会跳过，不会扫描整盘。</p></div></div>
              <div class="sm-source-list">${sourceRows
                .map((row) => {
                  const cov = coverageByPath.get(String(row.path || "").toLowerCase());
                  return `<div class="sm-source-row"><span class="sm-avatar">${icon(row.iconName, 15)}</span><div class="sm-source-main"><div class="sm-source-title"><strong>${e(row.name)}</strong><span class="sm-pill quiet">${e(row.kind)}</span>${row.enabled === false ? '<span class="sm-pill quiet">已停用</span>' : ""}</div><p class="sm-path" title="${e(row.path || "")}">${e(row.path || "—")}</p></div><div class="sm-source-side"><span class="sm-pill ${row.exists ? "ok" : "warn"}">${row.exists ? "目录存在" : "目录未创建"}</span><span>${e(row.meta)}${cov ? ` · 索引 ${num(cov.count)} 项` : ""}</span></div></div>`;
                })
                .join("")}</div>
            </section>
          </div>
          <div class="sm-stack">
            <section class="sm-section">
              <div class="sm-section-head"><div><h2>${icon("workspaces", 16)}工作区</h2><p>全局、项目与自定义关联目录。管理入口在工作区页签。</p></div><div class="sm-section-tools"><button class="btn ghost small" type="button" data-goto="workspaces">管理</button></div></div>
              <div class="sm-source-list">${workspaces
                .map(
                  (workspace) =>
                    `<div class="sm-source-row"><span class="sm-avatar">${icon(workspace.kind === "global" ? "agents" : "workspaces", 15)}</span><div class="sm-source-main"><div class="sm-source-title"><strong>${e(workspace.name)}</strong><span class="sm-pill quiet">${e(KIND_LABEL[workspace.kind] || workspace.kind)}</span></div><p class="sm-path">${e(workspace.kind === "global" ? "由各 Agent 的全局技能目录组成" : workspace.root)}</p></div><span class="sm-pill ${workspace.exists ? "ok" : "warn"}">${workspace.exists ? "存在" : "未创建"}</span></div>`,
                )
                .join("")}</div>
            </section>
            <div class="sm-callout">${icon("shield", 14)}<h3>只读边界</h3><ul><li>只读取中央库、已登记 Agent 目录与工作区目录，不扫描整盘。</li><li>不会执行 SKILL.md、脚本或安装过程；详情预览是安全快照，并重新核验文件是否存在。</li><li>中文展示只写入当前 Profile，不修改源文件、不上传正文。</li><li>目录存在、来源启用、技能已部署是不同状态，分别展示。</li></ul></div>
            <section class="sm-section">
              <div class="sm-section-head"><div><h2>${icon("scan", 16)}索引状态</h2></div></div>
              ${
                scan
                  ? `<p class="sm-muted">上次索引 ${fullTime(scan.at)} · 检查 ${num(scan.visited)} 个目录 · 收录 ${num(scan.absorbed)} 项${scan.limited ? " · 已达数量上限" : ""}</p>${coverage.length ? `<div class="sm-coverage">${coverage
                      .map(
                        (row) =>
                          `<span class="sm-pill ${coverageTone(row.status)}" title="${e((row.errors || []).join("；") || "无错误")}">${e(compactPath(row.path))} · ${num(row.count)} 项 · ${e(coverageText(row.status))}</span>`,
                      )
                      .join("")}</div>` : ""}`
                  : `<p class="sm-muted" data-scan-status>尚未建立本机索引。索引只读取已登记目录，不会执行技能。</p>`
              }
            </section>
            <section class="sm-section">
              <div class="sm-section-head"><div><h2>${icon("scan", 16)}最近活动</h2></div></div>
              ${
                activity.length
                  ? `<ul class="sm-activity">${activity
                      .map(
                        (event) =>
                          `<li><time title="${e(fullTime(event.at))}">${e(fmtTime(event.at))}</time><span class="sm-dot ${event.ok ? "ok" : "danger"}"></span><span>${e(actionText(event.action))}${event.skillName ? ` · ${e(event.skillName)}` : ""}${event.detail ? ` · <span class="sm-muted">${e(event.detail)}</span>` : ""}</span></li>`,
                      )
                      .join("")}</ul>`
                  : `<p class="sm-muted">还没有技能操作记录。扫描、部署或更新中文展示后会记录在这里。</p>`
              }
            </section>
          </div>
        </div>
      </div>`;
    }

    /* ------------------------------------------------------------ 技能库 */
    function tagChips(tags) {
      if (!tags.length) return "";
      return [`<button class="sm-chip" type="button" data-lib-tag="" aria-pressed="${!state.library.tag}">全部标签</button>`]
        .concat(
          tags
            .slice(0, 16)
            .map(
              (tag) =>
                `<button class="sm-chip" type="button" data-lib-tag="${e(tag.name)}" aria-pressed="${state.library.tag === tag.name}">${e(tag.name)}<em>${num(tag.count)}</em></button>`,
            ),
        )
        .join("");
    }
    // 后端的未收录占位词不是真正的译名，界面不把它当作中文名展示。
    function zhName(item) {
      const value = String(item.displayName || "").trim();
      return value && value !== item.name && value !== "自定义技能" ? value : "";
    }
    function zhDescription(item, short = false) {
      const value = String(item.displayDescription || "").trim();
      if (value && value !== "暂无中文简介，可在详情中补充。") return value;
      return short ? "暂无中文简介" : "";
    }
    // 详情预览不展示 frontmatter 元数据；它属于文件结构，不是技能正文。
    function stripFrontmatter(text) {
      return String(text || "").replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    }
    function agentName(id) {
      const found = (state.overview?.agents || []).find((agent) => agent.id === id);
      return found ? found.name : id;
    }
    function detailIntro(item) {
      const hasContent = !!(item.content && item.content.trim());
      if (item.libraryStatus === "missing" && !hasContent)
        return "技能目录已不在登记位置，也没有可用的索引快照正文。";
      return hasContent ? "源文件未提供中文简介，可在右侧补充。" : "源文件未提供简介。";
    }
    function skillCard(item) {
      const status = libState(item);
      const zh = zhName(item);
      const description = zhDescription(item, true) || "暂无中文简介";
      const tags = (item.tags || []).slice(0, 3);
      const deployed = (item.agents || []).filter((agent) => agent.deployed);
      const shownAgents = deployed.slice(0, 3);
      return `<article class="sm-skill-card" role="button" tabindex="0" data-open-skill="${e(item.id)}" aria-label="${e(
        `${item.name}${zh ? "，" + zh : ""}，${status[0]}`,
      )}">
        <div class="sm-skill-head"><span class="sm-dot ${status[1]}"></span><div class="sm-skill-title"><h3>${e(item.name)}</h3>${zh ? `<span class="sm-skill-cn">${e(zh)}</span>` : ""}</div></div>
        ${item.libraryStatus !== "ok" ? `<span class="sm-pill ${status[1]}">${status[0]}</span>` : ""}
        <p class="sm-skill-desc">${e(description)}</p>
        ${tags.length ? `<div class="sm-skill-tags">${tags.map((tag) => `<span class="sm-tag">${e(tag)}</span>`).join("")}${(item.tags || []).length > 3 ? `<span class="sm-tag">+${item.tags.length - 3}</span>` : ""}</div>` : ""}
        <div class="sm-agent-chips">${
          shownAgents.length
            ? shownAgents
                .map(
                  (agent) =>
                    `<span class="sm-agent-chip"><span class="sm-dot ${deployTone(agent.status)}"></span>${e(agent.name)}</span>`,
                )
                .join("") + (deployed.length > 3 ? `<span class="sm-agent-chip off">+${deployed.length - 3}</span>` : "")
            : '<span class="sm-agent-chip off">尚未部署到 Agent</span>'
        }</div>
        <div class="sm-card-foot">${icon("link", 13)}<span>${e(sourceText(item.source))}</span><span aria-hidden="true">·</span><span>${num(item.files)} 个文件 · ${fmtBytes(item.bytes)}</span><span class="sm-spacer"></span><span title="${e(fullTime(item.updatedAt))}">${e(fmtTime(item.updatedAt))}</span></div>
      </article>`;
    }
    function paintLibraryShell() {
      if (state.disposed) return;
      const overview = state.overview;
      const agents = overview?.agents || [];
      const tags = overview?.tags || [];
      const lib = state.library;
      content.innerHTML = `<div class="sm-view"><section class="sm-section">
        <div class="sm-section-head"><div><h2>${icon("library", 16)}技能库 <span class="sm-count" data-lib-total>${overview ? overview.libraryTotal : ""}</span></h2><p>中央库技能的安全快照。筛选与分页只读取已提交的索引结果；搜索不会触发扫描。</p></div></div>
        <div class="sm-lib-toolbar">
          <div class="sm-search">${icon("search", 16)}<input type="search" data-lib-q placeholder="搜索中文名、原名或简介" aria-label="搜索技能" maxlength="200" autocomplete="off"></div>
          <label class="sm-select"><select data-lib-agent aria-label="按 Agent 筛选"><option value="">全部 Agent</option>${agents
            .map(
              (agent) =>
                `<option value="${e(agent.id)}">${e(agent.name)}${agent.enabled ? "" : "（已停用）"}</option>`,
            )
            .join("")}</select></label>
        </div>
        <div class="sm-chips" data-lib-tags role="group" aria-label="按标签筛选">${tagChips(tags)}</div>
        <div class="sm-lib-meta"><span data-lib-meta>尚未读取</span><span role="status" data-lib-state></span></div>
        <div data-lib-error></div>
        <div class="sm-library-grid" data-lib-grid aria-busy="false"></div>
        <div class="sm-pager"><span class="sm-pager-info" data-lib-page></span><div class="sm-pager-actions"><button class="btn ghost" type="button" data-lib-prev>上一页</button><button class="btn ghost" type="button" data-lib-next>下一页</button></div></div>
      </section></div>`;
      const qInput = q("[data-lib-q]", content);
      qInput.value = lib.q;
      q("[data-lib-agent]", content).value = lib.agent;
      qInput.addEventListener("input", () => {
        lib.q = qInput.value;
        lib.offset = 0;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => void loadLibrary({ quiet: true }), 220);
      });
      qInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          clearTimeout(searchTimer);
          lib.q = qInput.value;
          lib.offset = 0;
          void loadLibrary();
        } else if (event.key === "Escape" && qInput.value) {
          qInput.value = "";
          lib.q = "";
          lib.offset = 0;
          void loadLibrary();
        }
      });
      q("[data-lib-agent]", content).addEventListener("change", (event) => {
        lib.agent = event.target.value;
        lib.offset = 0;
        void loadLibrary();
      });
      q("[data-lib-tags]", content).addEventListener("click", (event) => {
        const chip = event.target.closest("[data-lib-tag]");
        if (!chip) return;
        lib.tag = chip.dataset.libTag;
        lib.offset = 0;
        qa("[data-lib-tag]", content).forEach((node) =>
          node.setAttribute("aria-pressed", node === chip ? "true" : "false"),
        );
        void loadLibrary();
      });
      q("[data-lib-prev]", content).addEventListener("click", () => {
        lib.offset = Math.max(0, lib.offset - lib.limit);
        void loadLibrary();
      });
      q("[data-lib-next]", content).addEventListener("click", () => {
        const data = lib.data;
        lib.offset = data
          ? Math.min(lib.offset + lib.limit, Math.max(0, Math.floor((data.total - 1) / lib.limit) * lib.limit))
          : lib.offset + lib.limit;
        void loadLibrary();
      });
    }
    function paintLibrary() {
      if (state.disposed) return;
      const lib = state.library;
      const grid = q("[data-lib-grid]", content);
      if (!grid) return;
      const meta = q("[data-lib-meta]", content),
        stateNode = q("[data-lib-state]", content),
        pageNode = q("[data-lib-page]", content),
        errorNode = q("[data-lib-error]", content),
        totalNode = q("[data-lib-total]", content);
      if (totalNode && state.overview) totalNode.textContent = state.overview.libraryTotal;
      errorNode.innerHTML = lib.error
        ? `<div class="sm-error-banner" role="alert">${icon("alert", 16)}<div><strong>${lib.data ? "已保留上次结果" : "无法读取技能库"}</strong><span>${e(lib.error)}</span>${
            lib.data ? "" : '<div><button class="btn ghost small" type="button" data-retry>重试</button></div>'
          }</div></div>`
        : "";
      const data = lib.data;
      if (!data) {
        grid.innerHTML = skeletonCards();
        meta.textContent = "正在读取…";
        pageNode.textContent = "";
        q("[data-lib-prev]", content).disabled = true;
        q("[data-lib-next]", content).disabled = true;
        return;
      }
      const total = num(data.total);
      const start = data.items.length ? num(data.offset) + 1 : 0;
      const end = num(data.offset) + data.items.length;
      const filters = [lib.q ? `搜索“${lib.q}”` : "", lib.tag ? `标签“${lib.tag}”` : "", lib.agent ? "指定 Agent" : ""].filter(Boolean);
      meta.textContent = total
        ? `第 ${start}–${end} 项，共 ${total} 项${filters.length ? " · " + filters.join(" · ") : ""}`
        : "0 项" + (filters.length ? " · " + filters.join(" · ") : "");
      pageNode.textContent = total
        ? `第 ${Math.floor(num(data.offset) / lib.limit) + 1} / ${Math.ceil(total / lib.limit)} 页`
        : "";
      grid.innerHTML = data.items.length
        ? data.items.map(skillCard).join("")
        : emptyBlock(
            filters.length ? "没有匹配的技能" : "中央库还没有技能",
            filters.length
              ? "调整关键词或清除筛选后再试。"
              : "点击右上角「重建索引」，从已登记目录只读吸收技能资料。",
            filters.length ? "" : '<button class="btn ghost" type="button" data-scan-inline>重建索引</button>',
          );
      q("[data-lib-prev]", content).disabled = num(data.offset) <= 0;
      q("[data-lib-next]", content).disabled = num(data.offset) + data.items.length >= total;
      if (stateNode) stateNode.textContent = "";
    }
    async function loadLibrary({ quiet = false } = {}) {
      if (state.disposed || signal?.aborted) return;
      const lib = state.library;
      const seq = ++libraryToken;
      lib.loading = true;
      const grid = q("[data-lib-grid]", content);
      if (grid) grid.setAttribute("aria-busy", "true");
      const stateNode = q("[data-lib-state]", content);
      if (stateNode && !lib.data) stateNode.textContent = "正在读取…";
      const params = new URLSearchParams({ offset: String(lib.offset), limit: String(lib.limit) });
      if (lib.q) params.set("q", lib.q);
      if (lib.tag) params.set("tag", lib.tag);
      if (lib.agent) params.set("agent", lib.agent);
      try {
        const data = await api("GET", "/library?" + params.toString());
        if (state.disposed || seq !== libraryToken || state.tab !== "library") return;
        if (num(data.offset) > 0 && num(data.offset) >= num(data.total)) {
          lib.offset = data.total ? Math.floor((data.total - 1) / lib.limit) * lib.limit : 0;
          lib.loading = false;
          if (grid) grid.setAttribute("aria-busy", "false");
          void loadLibrary({ quiet: true });
          return;
        }
        lib.data = data;
        lib.error = "";
        paintLibrary();
      } catch (error) {
        if (state.disposed || seq !== libraryToken || error.name === "AbortError") return;
        lib.error = error.message || "读取失败";
        paintLibrary();
      } finally {
        if (seq === libraryToken) {
          lib.loading = false;
          const node = q("[data-lib-grid]", content);
          if (node) node.setAttribute("aria-busy", "false");
        }
      }
    }

    /* ------------------------------------------------------------ 详情 */
    async function openDetail(id) {
      if (!id || state.disposed) return;
      detailAbort?.abort();
      const own = new AbortController();
      detailAbort = own;
      const stop = U().busy(content, "正在核验技能详情…", 0);
      try {
        const data = await api("GET", "/skill?id=" + encodeURIComponent(id), undefined, { signal: own.signal });
        if (state.disposed || own.signal.aborted) return;
        showDetail(data);
      } catch (error) {
        if (!state.disposed && error.name !== "AbortError")
          U().notify("读取详情失败：" + error.message, { kind: "error" });
      } finally {
        stop();
      }
    }
    function shortRevision(value) {
      return value.length > 18 ? value.slice(0, 12) + "…" : value;
    }
    function detailBody(data) {
      const status = libState(data);
      const presentation = p10n(data);
      const zh = zhName(data);
      const zhDesc = zhDescription(data);
      const agents = data.agents || [];
      const upstream = data.upstream || {};
      const source = data.source || {};
      const entries = data.entries || [];
      const hasContent = !!(data.content && data.content.trim());
      const fileFlag =
        data.fileExists === "yes"
          ? '<span class="sm-pill ok">SKILL.md 可读</span>'
          : data.fileExists === "no"
            ? hasContent
              ? '<span class="sm-pill quiet" title="正文已只读读取；后端未返回源文件核验结果">内容已读取</span>'
              : '<span class="sm-pill danger">SKILL.md 不存在</span>'
            : '<span class="sm-pill quiet">SKILL.md 未核验</span>';
      return `<div class="sm-detail">
        <div class="sm-detail-main">
          <div class="sm-detail-title">
            <h2>${e(data.name)}</h2>
            <p class="sm-detail-cn" data-detail-cn ${zh ? "" : "hidden"}>${e(zh)}</p>
            <p class="sm-detail-desc" data-detail-desc>${e(zhDesc || detailIntro(data))}</p>
            <div class="sm-detail-flags">
              <span class="sm-pill ${status[1]}">${status[0]}</span>
              <span class="sm-pill ${presentation[1]}" data-presentation-pill>${presentation[0]}</span>
              <span class="sm-pill quiet">${e(sourceText(source))}</span>
              ${fileFlag}
            </div>
          </div>
          <div class="sm-detail-toolbar">${icon("folder", 14)}<p class="sm-path" title="${e(data.path || "")}">${e(data.path || "路径未知")}</p><button class="sm-link" type="button" data-copy="${e(
            data.path || "",
          )}">复制</button></div>
          <div class="sm-md-scroll" data-detail-md></div>
        </div>
        <div class="sm-detail-side">
          <section>
            <h3>${icon("edit", 14)}中文展示</h3>
            <p class="sm-hint">来自本地词目或当前 Profile 的覆盖，不会修改源文件。未收录时只补充已有资料，不猜测翻译。</p>
            <form class="sm-form" data-presentation-form>
              <label>中文名称<input name="title" maxlength="80" value="${e(zh)}" required></label>
              <label>中文简介<textarea name="description" maxlength="320" rows="3" required>${e(zhDesc)}</textarea></label>
              <div class="sm-form-foot"><button class="btn" type="submit" data-presentation-save>保存</button><button class="btn ghost" type="button" data-presentation-clear ${
                data.presentationSource === "custom" ? "" : "hidden"
              }>清除覆盖</button><span class="sm-form-status" data-presentation-status role="status"></span></div>
            </form>
          </section>
          <section>
            <h3>${icon("agents", 14)}部署到 Agent</h3>
            ${
              agents.length
                ? `<ul class="sm-deploy-list">${agents
                    .filter((agent) => agent.deployed)
                    .map(
                      (agent) =>
                        `<li><span class="sm-dot ${deployTone(agent.status)}"></span><strong>${e(agent.name)}</strong><span class="sm-pill ${deployTone(agent.status)}">${e(deployText(agent.status))}</span>${agent.mode ? `<span class="sm-pill quiet">${e(MODE_LABEL[agent.mode] || agent.mode)}</span>` : ""}${agent.path ? `<p class="sm-path">${e(agent.path)}</p>` : ""}</li>`,
                    )
                    .join("")}</ul>${
                    agents.some((agent) => !agent.deployed)
                      ? `<p class="sm-hint">未部署：${agents.filter((agent) => !agent.deployed).map((agent) => e(agent.name)).join("、")}</p>`
                      : ""
                  }`
                : '<p class="sm-muted">没有可展示的 Agent 核验结果。</p>'
            }
            <p class="sm-hint">文件存在不等于技能已启用；部署状态来自本次实时核验。</p>
          </section>
          <section>
            <h3>${icon("link", 14)}来源与索引</h3>
            <dl class="sm-kv">
              <dt>来源</dt><dd>${e(sourceText(source))}</dd>
              <dt>地址</dt><dd>${source.url ? `<span class="sm-path" title="${e(source.url)}">${e(compactPath(source.url))}</span>` : "—"}</dd>
              <dt>版本</dt><dd>${e(shortRevision(source.ref || source.revision || "未知"))}</dd>
              <dt>上游</dt><dd>${e(upstreamText(upstream))}${upstream.status === "unknown" && upstream.kind === "none" ? "（未跟踪）" : ""}${upstream.checkedAt ? ` · ${e(fmtTime(upstream.checkedAt))}` : ""}</dd>
              <dt>内容</dt><dd>${num(data.files)} 个文件 · ${fmtBytes(data.bytes)}</dd>
              <dt>快照一致</dt><dd>${data.contentMatchesSnapshot ? "是" : source.revision ? "否" : "无修订记录"}</dd>
              <dt>目录修改</dt><dd>${e(fullTime(data.updatedAt))}</dd>
            </dl>
            ${upstream.error ? `<p class="sm-hint">${e(upstream.error)}</p>` : ""}
          </section>
          <section class="sm-files"><details><summary>目录内文件（${entries.length}）</summary><ul>${
            entries.map((entry) => `<li>${e(entry)}</li>`).join("") || "<li>未返回文件清单</li>"
          }</ul></details></section>
          <p class="sm-dialog-note">${icon("shield", 13)} 只读打开：不会执行 SKILL.md、脚本或安装过程。${
            data.fileExists === "no" && data.libraryStatus === "missing"
              ? hasContent
                ? " 源文件已不在登记目录内，正文来自上次索引的安全快照。"
                : " 源文件已不在登记目录内，也没有可用的索引快照正文。"
              : ""
          }</p>
        </div>
      </div>`;
    }
    function showDetail(initial) {
      state.detail?.close();
      let latest = initial,
        dirty = false,
        saving = false;
      const dialog = modal("技能详情", detailBody(latest), {
        close: () => {
          if (saving) return false;
          if (dirty && !confirm("中文展示修改尚未保存，关闭详情？")) return false;
          return true;
        },
      });
      const dialogEl = dialog.d;
      dialogEl.classList.add("sm-detail-dialog");
      const body = dialog.body || q(".wb-dialog-body", dialogEl);
      const footer = dialog.footer || q(".wb-dialog-foot", dialogEl);
      const handle = {
        d: dialogEl,
        get dirty() {
          return dirty || saving;
        },
        close() {
          try {
            dialog.close(true);
          } catch {
            /* 已关闭 */
          }
        },
      };
      state.detail = handle;
      root._wbUnsaved = () => !!(state.detail && state.detail.dirty);
      dialogEl.addEventListener(
        "close",
        () => {
          if (state.detail === handle) {
            state.detail = null;
            root._wbUnsaved = () => false;
          }
        },
        { once: true },
      );
      const md = q("[data-detail-md]", body);
      if (md) {
        const preview = stripFrontmatter(latest.content);
        if (preview.trim()) U().markdown(md, preview);
        else md.innerHTML = '<p class="sm-muted">源文件没有可预览的正文。</p>';
      }
      if (footer) {
        footer.hidden = false;
        footer.innerHTML = `<span class="sm-muted">只读预览 · 不执行技能内容</span><span class="sm-spacer"></span><button class="btn ghost" type="button" data-detail-copy>复制目录路径</button><button class="btn" type="button" data-detail-close>关闭</button>`;
        q("[data-detail-copy]", footer).onclick = () => copyText(latest.path || "");
        q("[data-detail-close]", footer).onclick = () => dialog.close(true);
      }
      const form = q("[data-presentation-form]", body);
      if (!form) return;
      const titleInput = form.elements.title,
        descriptionInput = form.elements.description;
      const statusNode = q("[data-presentation-status]", form);
      const setStatus = (text, kind = "") => {
        statusNode.textContent = text;
        statusNode.className = "sm-form-status" + (kind ? " " + kind : "");
      };
      const applyDetail = (next) => {
        latest = next;
        const zhNode = q("[data-detail-cn]", body);
        const zh = zhName(next);
        if (zhNode) {
          zhNode.textContent = zh;
          zhNode.hidden = !zh;
        }
        const descNode = q("[data-detail-desc]", body);
        if (descNode) {
          descNode.textContent = zhDescription(next) || detailIntro(next);
        }
        const pill = q("[data-presentation-pill]", body);
        if (pill) {
          const presentation = p10n(next);
          pill.className = "sm-pill " + presentation[1];
          pill.textContent = presentation[0];
        }
        const clear = q("[data-presentation-clear]", form);
        if (clear) clear.hidden = next.presentationSource !== "custom";
      };
      const markDirty = () => {
        dirty = true;
        setStatus("有未保存的修改");
      };
      titleInput.addEventListener("input", markDirty);
      descriptionInput.addEventListener("input", markDirty);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (saving) return;
        const title = titleInput.value.trim(),
          description = descriptionInput.value.trim();
        if (!title || !description) {
          setStatus("中文名称和简介都需要填写。", "error");
          return;
        }
        if (!/[\u3400-\u9fff]/.test(title) || !/[\u3400-\u9fff]/.test(description)) {
          setStatus("中文展示需要包含中文，不能把英文原文当作翻译。", "error");
          return;
        }
        if (title.length > 80 || description.length > 320) {
          setStatus("中文名称最多 80 字，简介最多 320 字。", "error");
          return;
        }
        saving = true;
        const saveButton = q("[data-presentation-save]", form);
        if (saveButton) saveButton.disabled = true;
        setStatus("正在保存…");
        try {
          const next = await api("POST", "/presentation", { id: latest.id, title, description });
          dirty = false;
          applyDetail(next);
          setStatus("已保存到当前 Profile。", "ok");
          U().notify("中文展示已保存", { kind: "success" });
          if (state.library.data) void loadLibrary({ quiet: true });
        } catch (error) {
          setStatus(error.message || "保存失败", "error");
        } finally {
          saving = false;
          if (saveButton && saveButton.isConnected) saveButton.disabled = false;
        }
      });
      const clearButton = q("[data-presentation-clear]", form);
      if (clearButton)
        clearButton.onclick = async () => {
          if (saving) return;
          if (!confirm("清除当前 Profile 的中文展示覆盖？不会修改源文件，也不会删除技能。")) return;
          saving = true;
          clearButton.disabled = true;
          setStatus("正在清除…");
          try {
            const next = await api("POST", "/presentation", {
              id: latest.id,
              clear: true,
              title: "已清除中文展示",
              description: "当前使用本地词目或源文件中的中文信息",
            });
            dirty = false;
            applyDetail(next);
            titleInput.value = zhName(next);
            descriptionInput.value = zhDescription(next);
            setStatus("已清除中文覆盖。", "ok");
            U().notify("已清除中文覆盖", { kind: "success" });
            if (state.library.data) void loadLibrary({ quiet: true });
          } catch (error) {
            setStatus(error.message || "清除失败", "error");
          } finally {
            saving = false;
            if (clearButton.isConnected) clearButton.disabled = false;
          }
        };
    }

    /* ------------------------------------------------------------ Agent */
    function paintAgents() {
      if (state.disposed) return;
      const agents = state.agents;
      const workspaces = state.overview?.workspaces || [];
      const binding = (id) => workspaces.filter((workspace) => (workspace.agentIds || []).includes(id));
      const body = !agents
        ? state.agentsError
          ? errorBlock(state.agentsError)
          : loadingBlock("正在读取 Agent 列表…")
        : `${state.agentsError ? `<div class="sm-error-banner" role="alert">${icon("alert", 16)}<div><strong>已保留上次结果</strong><span>${e(state.agentsError)}</span></div></div>` : ""}
          <div class="sm-agent-grid">${agents
            .map((agent) => {
              const bound = binding(agent.id);
              return `<article class="sm-agent-card${agent.enabled ? "" : " is-off"}" data-agent-id="${e(agent.id)}">
                <div class="sm-agent-top">
                  <span class="sm-avatar">${e(String(agent.name || agent.id).slice(0, 1).toUpperCase())}</span>
                  <div class="sm-agent-name"><strong>${e(agent.name)}</strong><span>${e(agent.id)}</span></div>
                  <button class="sm-switch" type="button" role="switch" aria-checked="${agent.enabled ? "true" : "false"}" aria-label="${agent.enabled ? "停用" : "启用"} ${e(agent.name)}" data-agent-toggle><span></span></button>
                </div>
                <div class="sm-agent-flags"><span class="sm-pill ${agent.origin === "builtin" ? "quiet" : "accent"}">${agent.origin === "builtin" ? "内置" : "自定义"}</span><span class="sm-pill ${agent.exists ? "ok" : "warn"}">${agent.exists ? "全局目录存在" : "全局目录未创建"}</span>${agent.enabled ? "" : '<span class="sm-pill quiet">已停用（不参与扫描）</span>'}</div>
                <p class="sm-path" title="${e(agent.globalPath)}">${e(agent.globalPath)}</p>
                <div class="sm-agent-meta"><span>项目目录 ${agent.projectRelative ? `<span class="sm-code">${e(agent.projectRelative)}</span>` : "不支持"}</span><span>${bound.length} 个工作区</span></div>
                <div class="sm-agent-ws">${bound.map((workspace) => `<span class="sm-tag">${e(workspace.name)}</span>`).join("") || '<span class="sm-tag">未加入工作区</span>'}</div>
                <div class="sm-ws-foot"><span class="sm-spacer"></span><button class="btn ghost" type="button" data-agent-edit>编辑目录</button></div>
              </article>`;
            })
            .join("")}</div>`;
      content.innerHTML = `<div class="sm-view">
        <section class="sm-section">
          <div class="sm-section-head"><div><h2>${icon("agents", 16)}Agent <span class="sm-count">${agents ? agents.length : ""}</span></h2><p>登记各 Agent 的全局技能目录与项目相对目录。启用状态只影响当前 Profile 的扫描，不代表技能已在该 Agent 中启用。</p></div><div class="sm-section-tools"><button class="btn" type="button" data-agent-add>＋ 添加 Agent</button></div></div>
          ${body}
        </section>
        <div class="sm-callout">${icon("shield", 14)}<h3>只读与启用状态</h3><ul><li>只读取已登记的绝对路径，不创建或修改目录，不执行其中的技能。</li><li>“全局目录存在”“来源已启用”“技能已部署”分别是文件、扫描来源与实时部署状态。</li><li>内置 Agent 可恢复默认目录；自定义 Agent 可删除登记，不会删除磁盘文件。</li></ul></div>
      </div>`;
      if (!agents) return;
      qa("[data-agent-id]", content).forEach((card) => {
        const agent = agents.find((item) => item.id === card.dataset.agentId);
        if (!agent) return;
        const toggle = q("[data-agent-toggle]", card);
        if (toggle)
          toggle.onclick = async () => {
            if (toggle.disabled) return;
            const next = toggle.getAttribute("aria-checked") !== "true";
            toggle.disabled = true;
            toggle.setAttribute("aria-checked", String(next));
            try {
              const result = await api("POST", "/agents", { id: agent.id, enabled: next });
              if (Array.isArray(result.items)) {
                state.agents = result.items;
                if (state.overview) state.overview.agents = result.items;
              }
              U().notify(next ? `已启用 ${agent.name}` : `已停用 ${agent.name}`, { kind: "success" });
              paintAgents();
              syncTabCounts();
            } catch (error) {
              toggle.setAttribute("aria-checked", String(!next));
              U().notify(error.message, { kind: "error" });
            } finally {
              if (toggle.isConnected) toggle.disabled = false;
            }
          };
        const edit = q("[data-agent-edit]", card);
        if (edit) edit.onclick = () => agentDialog(agent);
      });
      const add = q("[data-agent-add]", content);
      if (add) add.onclick = () => agentDialog(null);
    }
    async function loadAgents() {
      if (state.disposed) return;
      const seq = ++agentsToken;
      try {
        const result = await api("GET", "/agents");
        if (state.disposed || seq !== agentsToken || state.tab !== "agents") return;
        state.agents = result.items || [];
        state.agentsError = "";
        if (state.overview) state.overview.agents = state.agents;
        paintAgents();
        syncTabCounts();
      } catch (error) {
        if (state.disposed || seq !== agentsToken || error.name === "AbortError") return;
        state.agentsError = error.message || "读取失败";
        paintAgents();
      }
    }
    function agentDialog(agent) {
      const editing = !!agent;
      const dialog = modal(
        editing ? "编辑 Agent · " + agent.name : "添加 Agent",
        `<form class="sm-form" data-agent-form>
          ${
            editing
              ? ""
              : '<label>标识<input name="id" maxlength="64" pattern="[A-Za-z0-9._-]+" required placeholder="例如 my-agent" autocomplete="off"></label>'
          }
          <label>显示名称<input name="name" maxlength="80" value="${e(agent?.name || "")}" required autocomplete="off"></label>
          <label>全局技能目录（绝对路径）<input name="path" value="${e(agent?.globalPath || "")}" placeholder="C:\\Users\\…\\.agent\\skills" required autocomplete="off"></label>
          <label>项目级目录（相对工作区根，可留空）<input name="projectRelative" value="${e(agent?.projectRelative || "")}" placeholder="例如 .agent/skills" autocomplete="off"></label>
          <p class="sm-hint">只登记本机绝对路径；不会创建、修改或执行目录中的技能。</p>
          <div class="sm-form-foot"><button class="btn" type="submit">${editing ? "保存" : "登记 Agent"}</button>${
            editing && agent?.origin === "custom"
              ? '<button class="btn ghost" type="button" data-agent-delete>删除</button>'
              : ""
          }${
            editing && agent?.origin === "builtin"
              ? '<button class="btn ghost" type="button" data-agent-restore>恢复默认目录</button>'
              : ""
          }<span class="sm-form-status" data-agent-status role="status"></span></div>
        </form>`,
      );
      const dialogEl = dialog.d;
      const form = q("[data-agent-form]", dialogEl);
      const statusNode = q("[data-agent-status]", dialogEl);
      const setStatus = (text, kind = "") => {
        statusNode.textContent = text;
        statusNode.className = "sm-form-status" + (kind ? " " + kind : "");
      };
      const submit = q('button[type="submit"]', form);
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (submit.disabled) return;
        const values = Object.fromEntries(new FormData(form));
        const path = String(values.path || "").trim();
        const name = String(values.name || "").trim();
        const projectRelative = String(values.projectRelative || "").trim();
        if (!name) {
          setStatus("显示名称不能为空。", "error");
          return;
        }
        if (!/^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path)) {
          setStatus("请输入本机绝对路径，例如 C:\\Users\\…\\skills。", "error");
          return;
        }
        const body = { name, path, projectRelative };
        if (editing) body.id = agent.id;
        else body.id = String(values.id || "").trim();
        if (!editing && !/^[A-Za-z0-9._-]{1,64}$/.test(body.id)) {
          setStatus("标识只允许字母、数字、点、下划线和短横线。", "error");
          return;
        }
        submit.disabled = true;
        setStatus("正在保存…");
        try {
          const result = await api("POST", "/agents", body);
          if (Array.isArray(result.items)) {
            state.agents = result.items;
            if (state.overview) state.overview.agents = result.items;
          }
          dialog.close(true);
          U().notify(editing ? "Agent 已更新" : "Agent 已登记", { kind: "success" });
          paintAgents();
          syncTabCounts();
        } catch (error) {
          setStatus(error.message || "保存失败", "error");
        } finally {
          if (submit.isConnected) submit.disabled = false;
        }
      };
      const remove = q("[data-agent-delete]", dialogEl);
      if (remove)
        remove.onclick = async () => {
          if (!confirm(`删除 Agent 登记「${agent.name}」？不会删除磁盘目录或已部署的技能。`)) return;
          remove.disabled = true;
          setStatus("正在删除…");
          try {
            const result = await api("POST", "/agents", { id: agent.id, delete: true });
            if (Array.isArray(result.items)) {
              state.agents = result.items;
              if (state.overview) state.overview.agents = result.items;
            }
            dialog.close(true);
            U().notify("Agent 登记已删除", { kind: "success" });
            paintAgents();
            syncTabCounts();
          } catch (error) {
            setStatus(error.message || "删除失败", "error");
          } finally {
            if (remove.isConnected) remove.disabled = false;
          }
        };
      const restore = q("[data-agent-restore]", dialogEl);
      if (restore)
        restore.onclick = async () => {
          if (!confirm(`恢复 ${agent.name} 的默认全局目录？`)) return;
          restore.disabled = true;
          setStatus("正在恢复…");
          try {
            const result = await api("POST", "/agents", { id: agent.id, restore: true });
            if (Array.isArray(result.items)) {
              state.agents = result.items;
              if (state.overview) state.overview.agents = result.items;
            }
            dialog.close(true);
            U().notify("已恢复默认目录", { kind: "success" });
            paintAgents();
          } catch (error) {
            setStatus(error.message || "恢复失败", "error");
          } finally {
            if (restore.isConnected) restore.disabled = false;
          }
        };
    }

    /* ------------------------------------------------------------ 工作区 */
    function workspaceCard(workspace) {
      const agents = (state.overview?.agents || []).filter((agent) =>
        (workspace.agentIds || []).includes(agent.id),
      );
      const kind = KIND_LABEL[workspace.kind] || workspace.kind;
      return `<article class="sm-ws-card">
        <div class="sm-ws-top"><span class="sm-avatar">${icon(workspace.kind === "global" ? "agents" : "workspaces", 15)}</span><div class="sm-ws-name"><h3><span>${e(workspace.name)}</span><span class="sm-pill quiet">${e(kind)}</span></h3><p title="${e(workspace.root || "")}">${e(workspace.kind === "global" ? "由各 Agent 的全局技能目录组成" : workspace.root)}</p></div></div>
        <div class="sm-ws-meta"><span>${agents.length} 个 Agent</span><span class="sm-pill ${workspace.exists ? "ok" : "warn"}">${workspace.exists ? "目录存在" : "目录未创建"}</span></div>
        <div class="sm-ws-agents">${agents.slice(0, 6).map((agent) => `<span class="sm-tag">${e(agent.name)}</span>`).join("")}${agents.length > 6 ? `<span class="sm-tag">+${agents.length - 6}</span>` : ""}</div>
        <div class="sm-ws-foot"><button class="btn ghost" type="button" data-open-workspace="${e(workspace.id)}">浏览条目</button><span class="sm-spacer"></span>${workspace.kind === "linked" ? `<button class="btn ghost sm-danger" type="button" data-workspace-delete="${e(workspace.id)}">移除</button>` : ""}</div>
      </article>`;
    }
    function paintWorkspaces() {
      if (state.disposed) return;
      if (state.entriesFor) return paintEntries();
      const workspaces = state.workspaces;
      const body = !workspaces
        ? state.workspacesError
          ? errorBlock(state.workspacesError)
          : `<div class="sm-ws-grid">${skeletonCards(3)}</div>`
        : `<div class="sm-ws-grid">${workspaces.map(workspaceCard).join("")}</div>`;
      content.innerHTML = `<div class="sm-view">
        <section class="sm-section">
          <div class="sm-section-head"><div><h2>${icon("workspaces", 16)}工作区 <span class="sm-count">${workspaces ? workspaces.length : ""}</span></h2><p>全局工作区聚合各 Agent 的全局目录；项目工作区位于 Profile 工作区；自定义关联目录需要本机绝对路径。</p></div><div class="sm-section-tools"><button class="btn" type="button" data-workspace-add>＋ 关联目录</button></div></div>
          ${state.workspacesError && workspaces ? `<div class="sm-error-banner" role="alert">${icon("alert", 16)}<div><strong>已保留上次结果</strong><span>${e(state.workspacesError)}</span></div></div>` : ""}
          ${body}
        </section>
        <div class="sm-callout">${icon("shield", 14)}<h3>只读边界</h3><ul><li>条目浏览只读取工作区目录与中央库的对照结果，不会部署、同步或删除技能。</li><li>关联目录只登记本机绝对路径；后端会核验目录存在，不会创建目录。</li><li>只有自定义关联工作区可以移除登记，不影响磁盘目录。</li></ul></div>
      </div>`;
      const add = q("[data-workspace-add]", content);
      if (add) add.onclick = workspaceDialog;
      qa("[data-workspace-delete]", content).forEach((button) => {
        button.onclick = async () => {
          const workspace = (state.workspaces || []).find((item) => item.id === button.dataset.workspaceDelete);
          if (!workspace) return;
          if (!confirm(`移除关联工作区「${workspace.name}」？只删除登记，不会删除磁盘目录或已部署的技能。`)) return;
          button.disabled = true;
          try {
            await api("POST", "/workspaces/delete", { id: workspace.id });
            U().notify("关联工作区已移除", { kind: "success" });
            state.workspaces = null;
            await loadWorkspaces({ force: true });
            void loadOverview({ quiet: true });
          } catch (error) {
            U().notify(error.message, { kind: "error" });
            if (button.isConnected) button.disabled = false;
          }
        };
      });
    }
    async function loadWorkspaces({ force = false } = {}) {
      if (state.disposed) return;
      if (state.workspaces && !force) {
        paintWorkspaces();
        return;
      }
      const seq = ++workspacesToken;
      try {
        const result = await api("GET", "/workspaces");
        if (state.disposed || seq !== workspacesToken) return;
        state.workspaces = result.items || [];
        state.workspacesError = "";
        if (state.overview) state.overview.workspaces = state.workspaces;
        paintWorkspaces();
        syncTabCounts();
      } catch (error) {
        if (state.disposed || seq !== workspacesToken || error.name === "AbortError") return;
        state.workspacesError = error.message || "读取失败";
        paintWorkspaces();
      }
    }
    function workspaceDialog() {
      const agents = state.overview?.agents || [];
      const dialog = modal(
        "关联目录",
        `<form class="sm-form" data-workspace-form>
          <label>名称（可选）<input name="name" maxlength="80" placeholder="默认使用目录名" autocomplete="off"></label>
          <label>本机绝对目录<input name="root" placeholder="D:\\path\\to\\workspace" required autocomplete="off"></label>
          <p class="sm-hint">后端会核验目录真实存在；只登记路径，不会创建或修改目录。</p>
          <fieldset class="sm-checks"><legend>参与的 Agent</legend>${agents
            .map(
              (agent) =>
                `<label class="sm-check"><input type="checkbox" name="agent" value="${e(agent.id)}" ${
                  agent.projectRelative ? "" : "disabled"
                }> <span>${e(agent.name)}</span><span class="sm-muted">${agent.projectRelative ? e(agent.projectRelative) : "不支持项目目录"}</span></label>`,
            )
            .join("")}</fieldset>
          <p class="sm-hint">不勾选时使用默认：所有支持项目相对目录的 Agent。</p>
          <div class="sm-form-foot"><button class="btn" type="submit">登记关联目录</button><span class="sm-form-status" data-workspace-status role="status"></span></div>
        </form>`,
      );
      const dialogEl = dialog.d;
      const form = q("[data-workspace-form]", dialogEl);
      const statusNode = q("[data-workspace-status]", dialogEl);
      const submit = q('button[type="submit"]', form);
      const setStatus = (text, kind = "") => {
        statusNode.textContent = text;
        statusNode.className = "sm-form-status" + (kind ? " " + kind : "");
      };
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (submit.disabled) return;
        const values = Object.fromEntries(new FormData(form));
        const rootPath = String(values.root || "").trim();
        if (!/^[A-Za-z]:[\\/]/.test(rootPath) || /^\\\\/.test(rootPath)) {
          setStatus("请输入本机绝对路径，例如 D:\\work\\project。", "error");
          return;
        }
        const body = { root: rootPath };
        const name = String(values.name || "").trim();
        if (name) body.name = name;
        const checked = qa('input[name="agent"]:checked', form).map((input) => input.value);
        if (checked.length) body.agentIds = checked;
        submit.disabled = true;
        setStatus("正在核验目录并登记…");
        try {
          await api("POST", "/workspaces", body);
          dialog.close(true);
          U().notify("已关联工作区", { kind: "success" });
          state.workspaces = null;
          await loadWorkspaces({ force: true });
          void loadOverview({ quiet: true });
        } catch (error) {
          setStatus(error.message || "登记失败", "error");
        } finally {
          if (submit.isConnected) submit.disabled = false;
        }
      };
    }
    function openWorkspace(id) {
      if (!id) return;
      state.entriesFor = id;
      state.entries = null;
      state.entriesError = "";
      const workspace = (state.workspaces || []).find((item) => item.id === id);
      state.entriesName = workspace ? workspace.name : "";
      selectTab("workspaces");
    }
    function paintEntries() {
      if (state.disposed) return;
      const data = state.entries;
      const workspace = data?.workspace || null;
      const name = workspace?.name || state.entriesName || "工作区";
      const root = workspace ? workspace.root : "";
      const kind = workspace ? KIND_LABEL[workspace.kind] || workspace.kind : "";
      const items = data?.items || [];
      const rows = data?.rows || [];
      const inLibrary = items.filter((item) => item.inLibrary).length;
      const missingChinese = items.filter((item) => item.missingLocalization).length;
      const actionCount = (action) => rows.filter((row) => row.action === action).length;
      const summary = [
        `${items.length} 项技能`,
        `中央库 ${inLibrary}`,
        missingChinese ? `缺少中文 ${missingChinese}` : "",
      ].filter(Boolean);
      const body = state.entriesLoading && !data
        ? `<div class="sm-entry-list">${skeletonCards(3)}</div>`
        : state.entriesError && !data
          ? errorBlock(state.entriesError)
          : !data
            ? loadingBlock("正在读取工作区条目…")
            : `${
                state.entriesError
                  ? `<div class="sm-error-banner" role="alert">${icon("alert", 16)}<div><strong>已保留上次结果</strong><span>${e(state.entriesError)}</span></div></div>`
                  : ""
              }
              ${
                items.length
                  ? `<ul class="sm-entry-list">${items
                      .map((item) => {
                        const zh = zhName(item);
                        const description =
                          zhDescription(item, true) || "暂无中文简介";
                        return `<li class="sm-entry">
                          <div class="sm-entry-main">
                            <div class="sm-entry-title"><strong>${e(item.name)}</strong>${zh ? `<span class="sm-entry-cn">${e(zh)}</span>` : ""}${item.missingLocalization ? '<span class="sm-pill warn">缺少中文资料</span>' : ""}</div>
                            <p class="sm-entry-desc">${e(description)}</p>
                            <p class="sm-path">${e(item.path)}</p>
                          </div>
                          <div class="sm-entry-side">
                            ${item.agentId ? `<span class="sm-pill quiet">${e(agentName(item.agentId))}</span>` : ""}
                            <span class="sm-pill ${item.inLibrary ? "ok" : "quiet"}">${item.inLibrary ? "已在中央库" : "未收录到中央库"}</span>
                            <span class="sm-pill ${deployTone(item.deployStatus)}">${e(deployText(item.deployStatus))}</span>
                            ${(item.tags || []).slice(0, 2).map((tag) => `<span class="sm-tag">${e(tag)}</span>`).join("")}
                          </div>
                        </li>`;
                      })
                      .join("")}</ul>`
                  : emptyBlock(
                      "工作区目录中没有可读技能",
                      root && workspace?.exists === false
                        ? "工作区根目录尚未创建；创建目录并放入包含 SKILL.md 的技能后刷新即可。"
                        : "只读取已登记目录的直接子目录，不会扫描整盘或执行技能。",
                    )
              }
              ${rows.length ? `<div class="sm-callout"><h3>${icon("info", 14)}中央库对照</h3><div class="sm-coverage">${Object.keys(SYNC_ACTION)
                .filter((action) => actionCount(action) > 0)
                .map(
                  (action) =>
                    `<span class="sm-pill ${SYNC_ACTION[action][1]}">${SYNC_ACTION[action][0]} ${actionCount(action)}</span>`,
                )
                .join("")}</div><p class="sm-hint">只读对照，不会自动部署或收编技能。</p></div>` : ""}`;
      content.innerHTML = `<div class="sm-view">
        <button class="sm-back" type="button" data-workspace-back>${icon("back", 14)}返回工作区</button>
        <section class="sm-section">
          <div class="sm-entries-head">
            <div><h2>${icon("workspaces", 16)}<span>${e(name)}</span>${kind ? `<span class="sm-pill quiet">${e(kind)}</span>` : ""}</h2><p class="sm-path" title="${e(root)}">${e(workspace?.kind === "global" ? "由各 Agent 的全局技能目录组成" : root || "—")}</p><div class="sm-entry-summary">${summary.map((text) => `<span class="sm-pill quiet">${e(text)}</span>`).join("")}</div></div>
            <div class="sm-entries-tools"><button class="btn ghost" type="button" data-entries-refresh>刷新</button></div>
          </div>
          ${body}
        </section>
      </div>`;
      q("[data-workspace-back]", content).onclick = () => {
        state.entriesFor = "";
        state.entries = null;
        state.entriesError = "";
        paintWorkspaces();
        void loadWorkspaces({ force: true });
      };
      q("[data-entries-refresh]", content).onclick = () => void loadEntries(state.entriesFor, { force: true });
    }
    async function loadEntries(id, { force = false } = {}) {
      if (!id || state.disposed) return;
      if (state.entriesLoading && !force) return;
      if (state.entries && !force && state.entriesFor === id) {
        paintWorkspaces();
        return;
      }
      const seq = ++entriesToken;
      state.entriesFor = id;
      state.entriesLoading = true;
      state.entriesError = "";
      paintWorkspaces();
      try {
        const data = await api("POST", "/workspace/entries", { id });
        if (state.disposed || seq !== entriesToken || state.entriesFor !== id) return;
        state.entries = data;
        state.entriesError = "";
        if (data.workspace) state.entriesName = data.workspace.name;
      } catch (error) {
        if (state.disposed || seq !== entriesToken || error.name === "AbortError") return;
        state.entriesError = error.message || "读取失败";
      } finally {
        if (seq === entriesToken) {
          state.entriesLoading = false;
          paintWorkspaces();
        }
      }
    }

    /* ------------------------------------------------------------ 设置 */
    function paintSettings() {
      if (state.disposed) return;
      const settings = state.settings;
      const overview = state.overview;
      const scan = overview?.scan || null;
      const coverage = Array.isArray(scan?.coverage) ? scan.coverage : [];
      const body = !settings
        ? state.settingsError
          ? errorBlock(state.settingsError)
          : loadingBlock("正在读取设置…")
        : `<div class="sm-setting-card">
            <div class="sm-setting-row"><div class="sm-setting-text"><p class="sm-setting-label">中央技能库</p><p class="sm-setting-desc">当前 Profile 内的中央库目录。修改只改变指向，不移动已有文件；修改后需要重建索引。</p></div><div class="sm-setting-value"><p class="sm-path" title="${e(settings.libraryRoot)}">${e(settings.libraryRoot)}</p><button class="btn ghost" type="button" data-setting-library ${settings.libraryRootEditable === false ? "disabled" : ""}>修改</button></div></div>
            <div class="sm-setting-row"><div class="sm-setting-text"><p class="sm-setting-label">默认同步方式</p><p class="sm-setting-desc">部署技能到 Agent 时优先使用符号链接；目标不支持时自动回退复制。此处只保存偏好，不会立即部署。</p></div><div class="sm-setting-value"><div class="sm-segment" role="group" aria-label="默认同步方式"><button type="button" data-mode="symlink" aria-pressed="${settings.defaultMode === "symlink"}">符号链接</button><button type="button" data-mode="copy" aria-pressed="${settings.defaultMode === "copy"}">复制</button></div></div></div>
            <div class="sm-setting-row"><div class="sm-setting-text"><p class="sm-setting-label">工作区路径</p><p class="sm-setting-desc">项目工作区的根目录，由当前 Profile 决定，只读展示。</p></div><div class="sm-setting-value"><p class="sm-path" title="${e(settings.workspacePath)}">${e(settings.workspacePath)}</p></div></div>
            <div class="sm-setting-row"><div class="sm-setting-text"><p class="sm-setting-label">中央库占用</p><p class="sm-setting-desc">只统计中央库内已登记目录的普通文件。</p></div><div class="sm-setting-value"><span>${overview ? `${overview.libraryTotal} 项 · ${fmtBytes(overview.library.bytes)}` : "未知"}</span></div></div>
          </div>`;
      content.innerHTML = `<div class="sm-view"><div class="sm-settings">
        <section class="sm-section"><div class="sm-section-head"><div><h2>${icon("settings", 16)}设置</h2><p>中央库与扫描偏好。所有路径只在本机使用，不会上传技能正文。</p></div></div>${body}</section>
        <section class="sm-section"><div class="sm-section-head"><div><h2>${icon("scan", 16)}索引</h2><p>索引只读取已登记目录，跳过不存在的目录与符号链接。</p></div><div class="sm-section-tools"><button class="btn ghost" type="button" data-scan-inline>重建索引</button></div></div>
          <div class="sm-setting-card">
            <div class="sm-setting-row"><div class="sm-setting-text"><p class="sm-setting-label">上次索引</p><p class="sm-setting-desc" data-scan-status>${scan ? `${fullTime(scan.at)} · 检查 ${num(scan.visited)} 个目录 · 收录 ${num(scan.absorbed)} 项${scan.limited ? " · 已达数量上限" : ""}` : "尚未建立本机索引。"}</p></div><div class="sm-setting-value"><span class="sm-pill ${scan ? "ok" : "quiet"}">${scan ? "已建立" : "未建立"}</span></div></div>
            <div class="sm-setting-row"><div class="sm-setting-text"><p class="sm-setting-label">覆盖范围</p><p class="sm-setting-desc">每个来源的索引状态与收录数量；失败原因保留在上次索引记录中。</p></div><div class="sm-setting-value">${coverage.length ? `<div class="sm-coverage">${coverage.map((row) => `<span class="sm-pill ${coverageTone(row.status)}" title="${e((row.errors || []).join("；") || "无错误")}">${e(compactPath(row.path))} · ${num(row.count)} 项 · ${e(coverageText(row.status))}</span>`).join("")}</div>` : '<span class="sm-muted">尚无覆盖记录</span>'}</div></div>
            <div class="sm-setting-row"><div class="sm-setting-text"><p class="sm-setting-label">只读扫描</p><p class="sm-setting-desc">不执行 SKILL.md 或脚本，不写入来源目录；只更新当前 Profile 的索引。</p></div><div class="sm-setting-value"><span class="sm-pill ok">始终只读</span></div></div>
          </div>
        </section>
        <div class="sm-callout">${icon("shield", 14)}<h3>安全边界</h3><ul><li>技能正文只在详情中预览，来自安全快照；详情会重新核验 SKILL.md 是否仍在登记目录内。</li><li>中文展示保存到当前 Profile，不修改源文件、不上传正文。</li><li>来源启用、文件存在与技能实际部署分别说明，不相互替代。</li></ul></div>
      </div></div>`;
      if (!settings) return;
      const libraryButton = q("[data-setting-library]", content);
      if (libraryButton)
        libraryButton.onclick = () => {
          const dialog = modal(
            "修改中央技能库",
            `<form class="sm-form" data-library-form><label>中央库绝对路径<input name="libraryRoot" value="${e(settings.libraryRoot)}" required autocomplete="off"></label><p class="sm-hint">修改只改变指向，不移动已有文件；保存后需要重建索引。</p><div class="sm-form-foot"><button class="btn" type="submit">保存</button><span class="sm-form-status" data-library-status role="status"></span></div></form>`,
          );
          const form = q("[data-library-form]", dialog.d);
          const statusNode = q("[data-library-status]", dialog.d);
          const setStatus = (text, kind = "") => {
            statusNode.textContent = text;
            statusNode.className = "sm-form-status" + (kind ? " " + kind : "");
          };
          form.onsubmit = async (event) => {
            event.preventDefault();
            const value = String(form.elements.libraryRoot.value || "").trim();
            if (!/^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)) {
              setStatus("请输入本机绝对路径。", "error");
              return;
            }
            const submit = q('button[type="submit"]', form);
            submit.disabled = true;
            setStatus("正在保存…");
            try {
              await api("POST", "/settings", { libraryRoot: value });
              dialog.close(true);
              U().notify("中央库路径已更新", { kind: "success" });
              state.overview = null;
              void loadOverview({ quiet: true });
              void loadSettings();
            } catch (error) {
              setStatus(error.message || "保存失败", "error");
            } finally {
              if (submit.isConnected) submit.disabled = false;
            }
          };
        };
      qa("[data-mode]", content).forEach((button) => {
        button.onclick = async () => {
          if (button.disabled || button.getAttribute("aria-pressed") === "true") return;
          const mode = button.dataset.mode;
          qa("[data-mode]", content).forEach((node) => (node.disabled = true));
          try {
            await api("POST", "/settings", { defaultMode: mode });
            state.settings.defaultMode = mode;
            if (state.overview) state.overview.library.defaultMode = mode;
            U().notify("默认同步方式已更新", { kind: "success" });
            paintSettings();
          } catch (error) {
            U().notify(error.message, { kind: "error" });
            qa("[data-mode]", content).forEach((node) => (node.disabled = false));
          }
        };
      });
    }
    async function loadSettings() {
      if (state.disposed) return;
      const seq = ++settingsToken;
      try {
        const data = await api("GET", "/settings");
        if (state.disposed || seq !== settingsToken || state.tab !== "settings") return;
        state.settings = data;
        state.settingsError = "";
        paintSettings();
      } catch (error) {
        if (state.disposed || seq !== settingsToken || error.name === "AbortError") return;
        state.settingsError = error.message || "读取失败";
        paintSettings();
      }
    }

    /* ------------------------------------------------------------ 概览数据与索引 */
    async function loadOverview({ quiet = false } = {}) {
      if (state.disposed) return;
      const seq = ++overviewToken;
      try {
        const data = await api("GET", "/overview");
        if (state.disposed || seq !== overviewToken) return;
        state.overview = data;
        state.overviewError = "";
        syncTabCounts();
        if (num(data.libraryTotal) > 0) await loadAttention(seq);
        else {
          state.attentionItems = [];
          state.attentionTotal = 0;
        }
        if (state.disposed || seq !== overviewToken) return;
        if (state.tab === "overview") paintOverview();
      } catch (error) {
        if (state.disposed || seq !== overviewToken || error.name === "AbortError") return;
        state.overviewError = error.message || "读取失败";
        if (state.tab === "overview") paintOverview();
      }
    }
    async function loadAttention(seq) {
      try {
        const data = await api("GET", "/library?offset=0&limit=100");
        if (state.disposed || seq !== overviewToken) return;
        state.attentionItems = data.items || [];
        state.attentionTotal = num(data.total);
      } catch {
        if (seq === overviewToken) {
          state.attentionItems = [];
          state.attentionTotal = 0;
        }
      }
    }
    async function rescan() {
      if (state.scanBusy || state.disposed) return;
      state.scanBusy = true;
      const headerButton = q("[data-rescan]", root);
      const originalText = headerButton?.textContent;
      if (headerButton) {
        headerButton.disabled = true;
        headerButton.textContent = "索引中…";
      }
      try {
        const task = await U().request("POST", "/api/skills/scan", {}, { signal });
        await U().job(task, {
          signal,
          onProgress: (progress) => {
            if (!progress) return;
            const node = q("[data-scan-status]", content);
            if (node)
              node.textContent = `已检查 ${num(progress.done)} / ${num(progress.total)} 个来源 · ${num(progress.skills)} 项技能`;
          },
        });
        U().notify("索引已更新", { kind: "success" });
        state.overview = null;
        await loadOverview({ quiet: true });
        if (state.tab === "library") void loadLibrary({ quiet: true });
        if (state.tab === "workspaces") {
          state.workspaces = null;
          void loadWorkspaces({ force: true });
        }
        if (state.tab === "settings") void loadSettings();
        if (state.tab === "agents") void loadAgents();
      } catch (error) {
        if (error.name !== "AbortError") U().notify("索引失败：" + error.message, { kind: "error" });
      } finally {
        state.scanBusy = false;
        if (headerButton && headerButton.isConnected) {
          headerButton.disabled = false;
          headerButton.textContent = originalText || "重建索引";
        }
      }
    }

    /* ------------------------------------------------------------ 关闭与初始载入 */
    root._wbUnsaved = () => !!(state.detail && state.detail.dirty);
    root._wbDispose = () => {
      state.disposed = true;
      clearTimeout(searchTimer);
      detailAbort?.abort();
      state.detail?.close();
      state.detail = null;
      root._wbUnsaved = () => false;
    };

    q("[data-refresh]", root).onclick = async () => {
      const button = q("[data-refresh]", root);
      if (button.disabled) return;
      button.disabled = true;
      try {
        state.overview = null;
        state.overviewError = "";
        await loadOverview({ quiet: true });
        if (state.tab === "library") await loadLibrary();
        else if (state.tab === "agents") await loadAgents();
        else if (state.tab === "workspaces") {
          state.workspaces = null;
          await loadWorkspaces({ force: true });
        } else if (state.tab === "settings") await loadSettings();
        U().notify("数据已刷新", { kind: "success" });
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    };
    q("[data-rescan]", root).onclick = () => void rescan();

    syncTabCounts();
    selectTab("overview");
  }

  window.LibraryViews = { prompts, skills };
})();
