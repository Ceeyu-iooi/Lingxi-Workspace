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

  async function skills(root) {
    const owner = user.username,
      signal = root._wbAbort?.signal,
      content = shell(
        root,
        "技能管理",
        "查看本机各 Agent 的技能来源；所有技能操作均为只读。",
        '<button class="btn ghost" data-sources>技能来源</button><button class="btn" data-scan>刷新索引</button>',
      );
    content.innerHTML =
      '<div class="wb-filter-layout"><aside class="wb-filter-pane"><h3>Agent</h3><div data-agent-filters></div><h3>来源</h3><select data-kind><option value="">全部来源</option><option value="user">用户级</option><option value="project">项目级</option><option value="cache">插件缓存</option><option value="custom">自定义来源</option></select><h3>具体来源</h3><select data-root><option value="">全部目录</option></select><h3>项目</h3><select data-project><option value="">全部项目</option></select><label><input type="checkbox" data-duplicates>仅重复内容</label><p class="wb-muted">文件存在不等于技能已启用；不会运行 SKILL.md 或脚本。</p></aside><section><div class="wb-list-toolbar"><button class="btn ghost wb-filter-mobile" data-filter-toggle>筛选</button><input type="search" data-search placeholder="搜索名称、描述或正文" aria-label="搜索本地技能"><span class="wb-list-count"></span></div><p class="wb-muted" data-scan-status></p><div class="wb-card-list"></div><div class="wb-pager"><button class="btn ghost" data-prev>上一页</button><span data-page></span><button class="btn ghost" data-next>下一页</button></div><p class="wb-inline-error" role="alert"></p></section></div>';
    let params = { q: "", offset: 0, limit: 40 },
      result,
      ticket = 0,
      timer,
      dialog = null;
    root._wbDispose = () => {
      clearTimeout(timer);
      dialog?.close();
    };
    async function load() {
      const seq = ++ticket,
        stop = U().busy(content, "正在查询技能…");
      try {
        const data = await U().request(
          "GET",
          "/api/skills?" + new URLSearchParams(params),
          undefined,
          { signal },
        );
        if (!current(root, owner) || seq !== ticket) return;
        result = data;
        paint(data);
        if (!data.scan && !params.q) scan();
      } catch (error) {
        if (current(root, owner))
          q("[role=alert]", content).textContent = error.message;
      } finally {
        stop();
      }
    }
    function paint(data) {
      const list = q(".wb-card-list", content);
      list.innerHTML = data.items.length
        ? data.items
            .map(
              (item) =>
                `<article class="wb-library-card" data-skill="${e(item.id)}"><div class="wb-skill-seat"></div><div class="wb-card-bottom"><span class="wb-pill">只读</span>${item.meta.duplicateCount > 1 ? '<span class="wb-pill">重复内容 ' + item.meta.duplicateCount + " 份</span>" : ""}<span class="wb-muted">${e(item.meta.sources.map((s) => ({ user: "用户级", cache: "缓存", project: "项目", custom: "自定义" })[s.kind] || s.kind).join(" / "))}</span><div class="wb-card-actions"><button class="btn ghost" data-view>查看原文</button><button class="btn ghost" data-path>复制路径</button></div></div></article>`,
            )
            .join("")
        : '<div class="wb-empty"><strong>没有匹配的技能</strong><span>刷新索引，或检查技能来源。</span></div>';
      for (const item of data.items) {
        const card = q(`[data-skill="${item.id}"]`, list);
        window.WorkbenchReact.skillIdentity(q(".wb-skill-seat", card), {
          title: item.title,
          description: item.description,
          agents: [...new Set(item.meta.sources.map((s) => s.agent))],
        });
        q("[data-view]", card).onclick = () => view(item.id);
        q("[data-path]", card).onclick = async () => {
          try {
            await navigator.clipboard.writeText(item.meta.path);
            U().notify("路径已复制", {kind:"success"});
          } catch {
            U().notify(item.meta.path);
          }
        };
      }
      q(".wb-list-count", content).textContent = data.total + " 项";
      q("[data-page]", content).textContent =
        "第 " + (Math.floor(params.offset / 40) + 1) + " 页";
      q("[data-prev]", content).disabled = params.offset === 0;
      q("[data-next]", content).disabled =
        params.offset + data.items.length >= data.total;
      q("[data-scan-status]", content).textContent = data.scan
        ? "上次索引 " +
          new Date(data.scan.at * 1000).toLocaleString() +
          " · " +
          data.scan.coverage.filter((r) => r.status === "complete").length +
          " 个完整来源 · 缺失／受限来源 " +
          data.scan.coverage.filter((r) => r.status !== "complete").length
        : "尚未建立本机索引";
      const roots = q("[data-root]", content),
        projects = q("[data-project]", content);
      roots.innerHTML =
        '<option value="">全部目录</option>' +
        data.sources
          .filter((s) => s.enabled)
          .map(
            (s) =>
              '<option value="' +
              e(s.id) +
              '">' +
              e(s.name + " · " + s.kind) +
              "</option>",
          )
          .join("");
      roots.value = params.source || "";
      projects.innerHTML =
        '<option value="">全部项目</option>' +
        [...new Set(data.sources.map((s) => s.project).filter(Boolean))]
          .map((p) => "<option>" + e(p) + "</option>")
          .join("");
      projects.value = params.project || "";
      const agents = [...new Set(data.sources.map((s) => s.name))];
      q("[data-agent-filters]", content).innerHTML =
        '<button class="btn ghost" data-agent="">全部 Agent</button>' +
        agents
          .map(
            (a) =>
              `<button class="btn ghost" data-agent="${e(a)}" aria-pressed="${params.agent === a}">${e(a)}</button>`,
          )
          .join("");
      qa("[data-agent]", content).forEach(
        (b) =>
          (b.onclick = () => {
            params.agent = b.dataset.agent;
            params.offset = 0;
            load();
          }),
      );
    }
    async function scan() {
      const button = q("[data-scan]", root);
      if (button.disabled) return;
      button.disabled = true;
      const stop = U().busy(content, "正在建立只读索引…", 0);
      try {
        const task = await U().request(
          "POST",
          "/api/skills/scan",
          {},
          { signal },
        );
        await U().job(task, {
          signal,
          onProgress: (p) => {
            if (p && current(root, owner))
              q("[data-scan-status]", content).textContent =
                "已检查 " +
                p.done +
                " / " +
                p.total +
                " 个来源 · " +
                p.skills +
                " 项技能";
          },
        });
        if (current(root, owner)) load();
      } catch (error) {
        if (current(root, owner) && error.name !== "AbortError")
          q("[role=alert]", content).textContent = error.message;
      } finally {
        stop();
        if (button.isConnected) button.disabled = false;
      }
    }
    async function view(id) {
      const data = await U().request(
        "GET",
        "/api/skills/item?id=" + id,
        undefined,
        { signal },
      );
      const m = modal(
        data.title,
        '<p class="wb-muted" data-skill-meta></p><div class="wb-markdown" data-skill-body></div>',
      );
      dialog = m.d;
      q("[data-skill-meta]", m.d).textContent =
        data.meta.path +
        " · " +
        data.meta.status +
        (data.meta.available === false
          ? " · 来源已不可读，显示上次索引快照"
          : "") +
        (data.meta.warning ? " · " + data.meta.warning : "");
      U().markdown(q("[data-skill-body]", m.d), data.content);
      q("footer", m.d).innerHTML =
        '<span>只读索引快照；不会修改技能或执行内容</span><button class="btn ghost" data-path>复制来源路径</button>';
      q("[data-path]", m.d).onclick = () =>
        navigator.clipboard.writeText(data.meta.path);
    }
    async function sources() {
      const data = await U().request("GET", "/api/skills/sources", undefined, {
        signal,
      });
      const m = modal(
        "技能扫描来源",
        '<div data-source-list></div><form><label class="control-field">来源名称<input name="name" required></label><label class="control-field">本机技能目录<input name="path" placeholder="C:\\Users\\…\\skills" required></label><p class="wb-inline-error" role="alert"></p><button class="btn" type="submit">登记只读来源</button></form>',
      );
      dialog = m.d;
      const list = q("[data-source-list]", m.d);
      for (const row of data.items) {
        const n = U().el("div", { class: "wb-panel" });
        n.append(
          U().el("strong", { text: row.name }),
          U().el("p", {
            class: "wb-muted",
            text: row.path + " · " + (row.exists ? "目录可见" : "目录不存在"),
          }),
        );
        const label = U().el("label", { class: "wb-source-toggle" }),
          toggle = U().el("input", { type: "checkbox" });
        toggle.checked = row.enabled;
        label.append(toggle, document.createTextNode("纳入只读扫描"));
        toggle.onchange = async () => {
          toggle.disabled = true;
          try {
            await U().request("POST", "/api/skills/source", {
              id: row.id,
              enabled: toggle.checked,
            });
            load();
          } catch (ex) {
            toggle.checked = !toggle.checked;
            q("[role=alert]", m.d).textContent = ex.message;
          } finally {
            toggle.disabled = false;
          }
        };
        n.append(label);
        if (row.kind === "custom") {
          const remove = U().el("button", {
            class: "btn ghost",
            text: "移除此扫描来源",
          });
          remove.onclick = async () => {
            await U().request("POST", "/api/skills/source", {
              id: row.id,
              delete: true,
            });
            n.remove();
            load();
          };
          n.append(remove);
        }
        list.append(n);
      }
      q("form", m.d).onsubmit = async (ev) => {
        ev.preventDefault();
        try {
          await U().request(
            "POST",
            "/api/skills/source",
            Object.fromEntries(new FormData(ev.target)),
          );
          m.close(true);
          scan();
        } catch (error) {
          q("[role=alert]", m.d).textContent = error.message;
        }
      };
    }
    q("[data-root]", content).onchange = (ev) => {
      params.source = ev.target.value;
      params.offset = 0;
      load();
    };
    q("[data-project]", content).onchange = (ev) => {
      params.project = ev.target.value;
      params.offset = 0;
      load();
    };
    q("[data-scan]", root).onclick = scan;
    q("[data-sources]", root).onclick = sources;
    q("[data-search]", content).oninput = (ev) => {
      params.q = ev.target.value;
      params.offset = 0;
      clearTimeout(timer);
      timer = setTimeout(load, 180);
    };
    q("[data-kind]", content).onchange = (ev) => {
      params.source = ev.target.value;
      params.offset = 0;
      load();
    };
    q("[data-duplicates]", content).onchange = (ev) => {
      params.duplicates = ev.target.checked ? "1" : "";
      params.offset = 0;
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
    q("[data-filter-toggle]", content).onclick = () => {
      const pane = q(".wb-filter-pane", content);
      pane.dataset.open = pane.dataset.open === "true" ? "false" : "true";
    };
    await load();
  }
  window.LibraryViews = { prompts, skills };
})();
