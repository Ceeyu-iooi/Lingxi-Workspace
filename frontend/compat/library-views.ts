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
/* 技能管理中台：严格对照 skills-manager 的信息架构、页面层级与视觉语言。
   * 数据只来自 /api/skill-manager/*；扫描与预览只读，不执行 SKILL.md 或脚本。
   * 本工作台已有全局侧栏，因此模块内再现其 220px 应用侧栏 + 主区布局。 */
/* 技能管理中台：严格对照 skills-manager 的信息架构、页面层级与视觉语言。
   * 数据只来自 /api/skill-manager/*；扫描与预览只读，不执行 SKILL.md 或脚本。
   * 本工作台已有全局侧栏，因此模块内再现其 220px 应用侧栏 + 主区布局。 */
/* 技能管理中台：严格对照 skills-manager 的信息架构、页面层级与视觉语言。
   * 数据只来自 /api/skill-manager/*；扫描与预览只读，不执行 SKILL.md 或脚本。
   * 本工作台已有全局侧栏，因此模块内再现其 220px 应用侧栏 + 主区布局。 */
/* 技能管理中台：严格对照 skills-manager 的信息架构、页面层级与视觉语言。
   * 数据只来自 /api/skill-manager/*；扫描与预览只读，不执行 SKILL.md 或脚本。
   * 本工作台已有全局侧栏，因此模块内再现其 220px 应用侧栏 + 主区布局。 */
/* 技能管理中台：严格对照 skills-manager 的信息架构、页面层级与视觉语言。
   * 数据只来自 /api/skill-manager/*；扫描与预览只读，不执行 SKILL.md 或脚本。
   * 本工作台已有全局侧栏，因此模块内再现其 220px 应用侧栏 + 主区布局。 */
  async function skills(root) {
    const owner = user.username;
    const signal = root._wbAbort?.signal;
    const esc = (v) => e(String(v ?? ""));

    const iconPaths = {
      dashboard: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
      layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
      bot: '<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/>',
      globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
      settings: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
      search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
      plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
      chevronRight: '<polyline points="9 18 15 12 9 6"/>',
      chevronDown: '<polyline points="6 9 12 15 18 9"/>',
      folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
      folderOpen: '<path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
      fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/>',
      refresh: '<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
      x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
      check: '<polyline points="20 6 9 17 4 12"/>',
      alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
      link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
      copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
      trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
      edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
      grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
      list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
      scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7" y1="12" x2="17" y2="12"/>',
      lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
      arrowRight: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
      download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
      upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
      spark: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
      external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
      clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    };
    const icon = (name, size = 16, cls = "") =>
      `<svg class="skm-ico ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || ""}</svg>`;

    const state = {
      view: "overview",
      overview: null,
      agents: [],
      workspaces: [],
      presets: [],
      tags: [],
      activity: [],
      scan: null,
      settings: null,
      library: {
        items: [], total: 0, q: "", tag: "", agent: "", status: "all", source: "", view: "grid",
        offset: 0, limit: 12, loading: false, loaded: false, error: "", preset: "",
      },
      agentCounts: {},
      agentSkills: {},
      entries: {},
      detail: null,
      error: "",
      busy: false,
    };

    const api = (method, path, body) =>
      U().request(method, "/api/skill-manager" + path, body, { signal });

    const nf = (n) => Number(n || 0).toLocaleString("zh-CN");
    const fmtBytes = (n) => {
      const v = Number(n || 0);
      if (!v) return "0 B";
      if (v < 1024) return `${v} B`;
      if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
      return `${(v / 1024 / 1024).toFixed(1)} MB`;
    };
    const fmtTime = (iso) => {
      if (!iso) return "未知";
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      const diff = Date.now() - d.getTime();
      if (diff >= 0 && diff < 60e3) return "刚刚";
      if (diff >= 0 && diff < 36e5) return `${Math.floor(diff / 60e3)} 分钟前`;
      if (diff >= 0 && diff < 864e5) return `${Math.floor(diff / 36e5)} 小时前`;
      return d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
    };
    const zhName = (item) => {
      const v = String(item?.displayName || "").trim();
      if (!v || v === item?.name || v === "自定义技能") return "";
      return v;
    };
    const zhDescription = (item) => {
      const v = String(item?.displayDescription || "").trim();
      if (!v || v === "暂无中文简介，可在详情中补充。") return "";
      return v;
    };
    const stripFrontmatter = (text) => String(text || "").replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    const sourceType = (type) => ({
      local: "本机目录", adopted: "已收录", git: "Git 仓库", archive: "压缩包",
      market: "技能市场", manual: "手动添加",
    }[type] || "本机目录");
    const sourceIcon = (type) => (type === "git" || type === "archive" || type === "market" ? "link" : "folder");
    const libraryStatusText = (s) => ({ ok: "可用", missing: "文件缺失", modified: "已修改" }[s] || "未知");
    const presentationText = (s) => ({
      custom: "当前 Profile 覆盖", catalog: "本地词目", source: "源文件提供", untranslated: "缺少中文资料",
    }[s] || "缺少中文资料");
    const deployText = (s) => ({
      absent: "未部署", linked: "已链接", copied: "已复制", different: "内容不同", external: "外部目录", unreadable: "不可读",
    }[s] || "未部署");
    const upstreamText = (s) => ({
      unknown: "未检查", current: "已是最新", behind: "落后上游", "local-changes": "本地已修改",
      diverged: "已分叉", unavailable: "上游不可用",
    }[s] || "未检查");
    const deployedAgents = (s) => (s?.agents || []).filter((a) => a.deployed);
    const agentName = (id) => (state.agents.find((a) => a.id === id) || {}).name || id || "Agent";
    const agentTone = { shared: "indigo", codex: "zinc", claude: "orange", cursor: "blue", gemini: "sky", dsh: "green" };
    const agentTile = (a, size = 36) => {
      const tone = agentTone[a?.id] || "violet";
      const label = a?.id === "shared" ? "SH" : String(a?.id || a?.name || "?").slice(0, 2);
      return `<span class="skm-agent-tile skm-tone-${tone}${size <= 28 ? " is-sm" : ""}" aria-hidden="true">${esc(label)}</span>`;
    };

    function statusPills(skill) {
      const out = [];
      if (skill.libraryStatus && skill.libraryStatus !== "ok") {
        out.push(`<span class="skm-mini-pill is-${skill.libraryStatus === "missing" ? "danger" : "warn"}">${libraryStatusText(skill.libraryStatus)}</span>`);
      }
      if (skill.presentationSource === "untranslated") {
        out.push('<span class="skm-mini-pill">缺少中文资料</span>');
      }
      if (skill.warning) out.push('<span class="skm-mini-pill is-warn" title="' + esc(skill.warning) + '">需检查</span>');
      return out.join("");
    }

    function skillCard(skill) {
      const zh = zhName(skill);
      const desc = zhDescription(skill) || String(skill.description || "").trim();
      const agents = deployedAgents(skill);
      const tags = (skill.tags || []).slice(0, 5);
      const title = String(skill.name || skill.displayName || "未命名技能");
      return `<article class="skm-card" data-open-skill="${esc(skill.id)}" role="button" tabindex="0" aria-label="打开技能 ${esc(title)}">
        <div class="skm-card-head">
          <span class="skm-dot${agents.length ? " is-on" : ""}" title="${agents.length ? "已部署到 " + esc(agents.map((a) => a.name).join("、")) : "尚未部署到 Agent"}"></span>
          <div class="skm-card-titles">
            <h3 class="skm-card-title" title="${esc(title)}">${esc(title)}</h3>
            ${zh ? `<p class="skm-card-zh" title="${esc(zh)}">${esc(zh)}</p>` : ""}
          </div>
          <span class="skm-card-pills">${statusPills(skill)}</span>
        </div>
        <p class="skm-card-desc">${desc ? esc(desc) : "暂无简介"}</p>
        <div class="skm-card-tags">${tags.map((t) => `<span class="skm-tag">${esc(t)}</span>`).join("")}${(skill.tags || []).length > 5 ? `<span class="skm-tag is-more">+${skill.tags.length - 5}</span>` : ""}</div>
        <div class="skm-card-foot">
          <span class="skm-card-source">${icon(sourceIcon(skill.source?.type), 14)}<span>${esc(sourceType(skill.source?.type))}</span></span>
          <span class="skm-agent-dots">
            ${agents.slice(0, 6).map((a) => `<span class="skm-agent-dot" title="${esc(a.name)}">${agentTile(a, 20)}</span>`).join("")}
            ${agents.length > 6 ? `<span class="skm-agent-more">+${agents.length - 6}</span>` : ""}
            ${agents.length ? "" : '<span class="skm-agent-none">未部署</span>'}
          </span>
        </div>
      </article>`;
    }

    function skillRow(skill) {
      const zh = zhName(skill);
      const desc = zhDescription(skill) || String(skill.description || "").trim();
      const agents = deployedAgents(skill);
      return `<article class="skm-row" data-open-skill="${esc(skill.id)}" role="button" tabindex="0" aria-label="打开技能 ${esc(skill.name)}">
        <span class="skm-dot${agents.length ? " is-on" : ""}"></span>
        <div class="skm-row-main">
          <div class="skm-row-title">${esc(skill.name)}${zh ? `<span class="skm-row-zh">${esc(zh)}</span>` : ""}</div>
          <p class="skm-row-desc">${desc ? esc(desc) : "暂无简介"}</p>
        </div>
        <div class="skm-row-tags">${(skill.tags || []).slice(0, 3).map((t) => `<span class="skm-tag">${esc(t)}</span>`).join("")}</div>
        <div class="skm-row-source">${icon(sourceIcon(skill.source?.type), 14)}${esc(sourceType(skill.source?.type))}</div>
        <div class="skm-agent-dots">${agents.slice(0, 4).map((a) => `<span class="skm-agent-dot" title="${esc(a.name)}">${agentTile(a, 20)}</span>`).join("")}${agents.length ? "" : '<span class="skm-agent-none">未部署</span>'}</div>
      </article>`;
    }

    function emptyState({ title, hint, action = "", extra = "" } = {}) {
      return `<div class="skm-empty">
        <span class="skm-empty-icon">${icon("layers", 48)}</span>
        <h3>${esc(title)}</h3>
        <p>${esc(hint)}</p>
        ${extra ? `<div class="skm-empty-extra">${extra}</div>` : ""}
        ${action || ""}
      </div>`;
    }

    function pageHead(title, { badge = "", sub = "", actions = "" } = {}) {
      return `<header class="skm-page-head">
        <div class="skm-page-head-main">
          <h1 class="skm-page-title">${esc(title)}${badge ? `<span class="skm-badge">${badge}</span>` : ""}</h1>
          ${sub ? `<p class="skm-page-sub">${sub}</p>` : ""}
        </div>
        ${actions ? `<div class="skm-page-actions">${actions}</div>` : ""}
      </header>`;
    }

    function alertBox(message, retry = true) {
      return `<div class="skm-alert" role="alert">${icon("alert", 16)}<span>${esc(message)}</span>${retry ? '<button class="skm-link" data-act="retry">重试</button>' : ""}</div>`;
    }

    function coverCount() {
      const total = state.overview?.libraryTotal ?? state.library.total;
      const items = state.library.items || [];
      const synced = items.filter((s) => deployedAgents(s).length > 0).length;
      return { total, synced };
    }

    function sideHTML() {
      const navItem = (view, label, ico, count, extra = "") => {
        const active = state.view === view || (view === "agents" && state.view.startsWith("agent:")) || (view === "workspaces" && state.view.startsWith("workspace:"));
        return `<button class="skm-nav${active ? " is-active" : ""}" data-act="nav" data-view="${view}">
          ${icon(ico, 16, "skm-nav-ico")}<span class="skm-nav-label">${esc(label)}</span>${count != null ? `<span class="skm-nav-count">${nf(count)}</span>` : ""}${extra}</button>`;
      };
      const groupHead = (label, open, key) =>
        `<button class="skm-group-head" data-act="group" data-group="${key}" aria-expanded="${open ? "true" : "false"}">${icon(open ? "chevronDown" : "chevronRight", 12, "skm-chev")}<span>${esc(label)}</span></button>`;
      const open = state.groups || (state.groups = { presets: true, agents: true, workspaces: true });
      const presets = state.presets || [];
      const linked = state.workspaces.filter((w) => w.kind === "linked");
      const project = state.workspaces.find((w) => w.kind === "project");
      return `<div class="skm-brand">
          <span class="skm-brand-mark" aria-hidden="true">${icon("layers", 16)}</span>
          <span class="skm-brand-name">技能管理</span>
          <button class="skm-mobile-settings${state.view === "settings" ? " is-active" : ""}" data-act="nav" data-view="settings" aria-label="设置" title="设置">${icon("settings", 16)}</button>
        </div>
        <nav class="skm-mobile-nav" aria-label="技能管理导航（窄屏）">
          ${navItem("overview", "概览", "dashboard")}
          ${navItem("library", "技能库", "layers", state.overview?.libraryTotal ?? state.library.total)}
          ${navItem("agents", "Agents", "bot")}
          ${navItem("workspaces", "工作区", "folderOpen")}
        </nav>
        <nav class="skm-nav-primary" aria-label="技能管理导航">
          ${navItem("overview", "概览", "dashboard")}
          ${navItem("library", "技能库", "layers", state.overview?.libraryTotal ?? state.library.total)}
        </nav>
        <div class="skm-side-scroll">
          <div class="skm-group">
            ${groupHead("预设", open.presets, "presets")}
            ${open.presets ? `<div class="skm-group-body">
              ${presets.map((p) => `<button class="skm-nav skm-nav-sub${state.library.preset === p.id ? " is-active" : ""}" data-act="preset" data-preset="${esc(p.id)}" title="${esc(p.description || p.name)}">
                <span class="skm-nav-ico skm-preset-mark" aria-hidden="true">${icon("spark", 12)}</span><span class="skm-nav-label">${esc(p.name)}</span><span class="skm-nav-count">${nf((p.skillIds || []).length)}</span></button>`).join("")}
              <button class="skm-nav skm-nav-sub is-muted" data-act="new-preset">${icon("plus", 13, "skm-nav-ico")}<span class="skm-nav-label">新建预设</span></button>
            </div>` : ""}
          </div>
          <div class="skm-group">
            ${groupHead("全局工作区", open.agents, "agents")}
            ${open.agents ? `<div class="skm-group-body">
              ${navItem("agents", "全部 Agents", "globe")}
              ${state.agents.map((a) => `<button class="skm-nav skm-nav-sub${state.view === "agent:" + a.id ? " is-active" : ""}" data-act="nav" data-view="agent:${esc(a.id)}" title="${esc(a.globalPath)}">
                ${agentTile(a, 20)}<span class="skm-nav-label">${esc(a.name)}</span>
                <span class="skm-nav-count">${state.agentCounts[a.id] == null ? "…" : nf(state.agentCounts[a.id])}</span>
                <span class="skm-dot sm${a.exists ? " is-on" : ""}" title="${a.exists ? "目录已创建" : "目录未创建"}"></span>
              </button>`).join("")}
            </div>` : ""}
          </div>
          <div class="skm-group">
            ${groupHead("项目工作区", open.workspaces, "workspaces")}
            ${open.workspaces ? `<div class="skm-group-body">
              ${navItem("workspaces", "所有工作区", "folderOpen")}
              ${project ? `<button class="skm-nav skm-nav-sub" data-act="nav" data-view="workspace:${esc(project.id)}" title="${esc(project.root)}">
                ${icon("folder", 14, "skm-nav-ico")}<span class="skm-nav-label">${esc(project.name)}</span><span class="skm-dot sm${project.exists ? " is-on" : ""}"></span>
              </button>` : ""}
              ${linked.map((w) => `<button class="skm-nav skm-nav-sub${state.view === "workspace:" + w.id ? " is-active" : ""}" data-act="nav" data-view="workspace:${esc(w.id)}" title="${esc(w.root)}">
                ${icon("link", 14, "skm-nav-ico")}<span class="skm-nav-label">${esc(w.name)}</span><span class="skm-dot sm${w.exists ? " is-on" : ""}"></span>
              </button>`).join("")}
            </div>` : ""}
          </div>
        </div>
        <div class="skm-side-foot">
          ${navItem("settings", "设置", "settings")}
        </div>`;
    }

    function overviewHTML() {
      const o = state.overview;
      if (!o) {
        return `<div class="skm-page is-narrow">${pageHead("概览")}${alertBox(state.error || "正在读取技能管理数据…", false)}</div>`;
      }
      const agents = o.agents || [];
      const workspaces = o.workspaces || [];
      const missingAgents = agents.filter((a) => !a.exists);
      const connected = agents.filter((a) => a.exists && a.enabled);
      const { total, synced } = coverCount();
      const coverage = total ? `${synced}/${total}` : "0";
      const recent = (state.activity && state.activity.length ? state.activity : (o.activity || [])).slice(0, 6);
      const dirRows = [
        { name: "中央技能库", path: o.library?.root, ok: true, tag: "中央库" },
        ...agents.map((a) => ({ name: a.name, path: a.globalPath, ok: a.exists, tag: a.origin === "builtin" ? "内置 Agent" : "自定义 Agent", agent: a.id })),
        ...workspaces.filter((w) => w.kind !== "global").map((w) => ({ name: w.name, path: w.root, ok: w.exists, tag: w.kind === "project" ? "项目工作区" : "关联目录", ws: w.id })),
      ];
      const recentHTML = recent.length
        ? `<section class="skm-section">
            <h2 class="skm-section-title">近期活动</h2>
            <div class="skm-panel skm-activity">
              ${recent.map((ev) => `<div class="skm-activity-row">
                <span class="skm-activity-mark">${esc(String(ev.skillName || ev.action || "·").charAt(0).toUpperCase())}</span>
                <div class="skm-activity-main"><b>${esc(ev.skillName || ev.action || "操作")}</b><span>${esc(ev.detail || ev.action || "")}</span></div>
                <span class="skm-activity-time">${esc(fmtTime(ev.at))}${ev.ok === false ? " · 失败" : ""}</span>
              </div>`).join("")}
            </div>
          </section>`
        : "";
      return `<div class="skm-page is-narrow">
        ${pageHead("你好！", { sub: `技能库中 ${nf(total)} 个技能 · 已接入 ${nf(connected.length)} 个 Agent · ${nf(workspaces.length)} 个工作区` })}
        ${state.error ? alertBox(state.error) : ""}
        ${missingAgents.length ? `<div class="skm-setup-card">
          <span class="skm-setup-ico">${icon("alert", 18)}</span>
          <div class="skm-setup-main"><h2>${nf(missingAgents.length)} 个 Agent 目录尚未创建</h2><p>扫描只读取已登记的目录，不会自行创建或修改任何 Agent 目录。可先在「全部 Agents」中确认路径，再扫描本机。</p></div>
          <button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="nav" data-view="agents">查看 Agents</button>
        </div>` : ""}
        <div class="skm-stats">
          <div class="skm-stat"><div><p class="skm-section-title">技能库技能</p><strong>${nf(total)}</strong></div><span class="skm-stat-ico is-accent">${icon("layers", 16)}</span></div>
          <div class="skm-stat"><div><p class="skm-section-title">同步覆盖</p><strong>${coverage}</strong></div><span class="skm-stat-ico is-ok">${icon("check", 16)}</span></div>
          <div class="skm-stat"><div><p class="skm-section-title">连接 Agent</p><strong>${nf(connected.length)}<span class="skm-stat-total">/${nf(agents.length)}</span></strong></div><span class="skm-stat-ico is-sky">${icon("bot", 16)}</span></div>
        </div>
        <div class="skm-actions">
          <button class="skm-btn skm-btn-primary" data-act="scan">${icon("scan", 16)}扫描本机目录</button>
          <button class="skm-btn skm-btn-secondary" data-act="new-workspace">${icon("plus", 16)}关联工作区目录</button>
        </div>
        <section class="skm-section">
          <h2 class="skm-section-title">登记目录</h2>
          <div class="skm-panel skm-dir-list">
            ${dirRows.map((row) => `<div class="skm-dir-row">
              <span class="skm-dir-ico">${icon(row.agent ? "bot" : row.ws ? "folder" : "layers", 15)}</span>
              <div class="skm-dir-main"><div class="skm-dir-name">${esc(row.name)}<span class="skm-mini-pill">${esc(row.tag)}</span></div><code class="skm-path" title="${esc(row.path)}">${esc(row.path || "—")}</code></div>
              <span class="skm-status ${row.ok ? "is-ok" : "is-muted"}"><span class="skm-dot sm${row.ok ? " is-on" : ""}"></span>${row.ok ? "已创建" : "目录未创建"}</span>
              ${row.agent ? `<button class="skm-icon-btn" data-act="nav" data-view="agent:${esc(row.agent)}" title="查看 Agent">${icon("chevronRight", 15)}</button>` : row.ws ? `<button class="skm-icon-btn" data-act="nav" data-view="workspace:${esc(row.ws)}" title="查看工作区">${icon("chevronRight", 15)}</button>` : ""}
            </div>`).join("")}
          </div>
        </section>
        <section class="skm-section">
          <h2 class="skm-section-title">索引与只读边界</h2>
          <div class="skm-panel skm-readonly">
            <div class="skm-readonly-row">${icon("lock", 16)}<div><b>不会执行技能内容</b><span>预览只读取 SKILL.md 文本；不会运行其中的脚本、命令或任何安装步骤。</span></div></div>
            <div class="skm-readonly-row">${icon("folder", 16)}<div><b>只扫描已登记目录</b><span>中央库、Agent 目录与项目工作区；不会遍历整块磁盘。</span></div></div>
            <div class="skm-readonly-row">${icon("fileText", 16)}<div><b>索引状态</b><span>${o.scan ? `上次索引 ${esc(fmtTime(o.scan.at))} · 收录 ${nf(o.scan.count)} 项 · 新吸收 ${nf(o.scan.absorbed)} 项` : "尚未建立索引。首次扫描会生成只读快照。"}</span></div></div>
          </div>
        </section>
        ${recentHTML}
      </div>`;
    }

    function libraryFiltered() {
      const l = state.library;
      let items = (l.items || []).slice();
      if (l.status === "deployed") items = items.filter((s) => deployedAgents(s).length > 0);
      if (l.status === "available") items = items.filter((s) => deployedAgents(s).length === 0);
      if (l.source) items = items.filter((s) => (s.source?.type || "local") === l.source);
      if (l.preset) {
        const preset = state.presets.find((p) => p.id === l.preset);
        const ids = new Set((preset?.skillIds) || []);
        items = items.filter((s) => ids.has(s.id));
      }
      return items;
    }

    function libraryResultsHTML() {
      const l = state.library;
      if (l.loading && !l.loaded) {
        return `<div class="skm-skeleton">${Array.from({ length: 6 }).map(() => '<div class="skm-skeleton-card"></div>').join("")}</div>`;
      }
      if (l.error) return alertBox(l.error);
      const items = libraryFiltered();
      const start = l.offset;
      const page = items.slice(start, start + l.limit);
      if (!items.length) {
        const filtered = l.q || l.tag || l.agent || l.status !== "all" || l.source || l.preset;
        const totalZero = !filtered && l.total === 0;
        return emptyState({
          title: totalZero ? "技能库还没有技能" : "没有可显示的 Skills",
          hint: totalZero
            ? "中央技能库为空。可以扫描本机已登记的 Agent 目录，或先把已有技能目录登记为工作区。"
            : "当前筛选条件下没有匹配的技能。可以清除筛选，或换一个关键词。",
          action: filtered
            ? '<button class="skm-btn skm-btn-secondary" data-act="clear-filters">清除筛选</button>'
            : '<div class="skm-empty-actions"><button class="skm-btn skm-btn-primary" data-act="scan">扫描本机目录</button><button class="skm-btn skm-btn-secondary" data-act="new-workspace">关联工作区</button></div>',
        });
      }
      const body = l.view === "grid"
        ? `<div class="skm-card-grid">${page.map(skillCard).join("")}</div>`
        : `<div class="skm-rows">${page.map(skillRow).join("")}</div>`;
      const loadedNote = l.total > l.items.length ? `<span class="skm-meta-note">已载入前 ${nf(l.items.length)} / ${nf(l.total)} 项</span>` : "";
      const pages = Math.max(1, Math.ceil(items.length / l.limit));
      const pageNo = Math.floor(start / l.limit) + 1;
      const pager = `<div class="skm-pager">
        <span class="skm-pager-meta">第 ${nf(start + 1)}–${nf(Math.min(start + l.limit, items.length))} 项，共 ${nf(items.length)} 项 ${loadedNote}</span>
        <div class="skm-pager-actions">
          <button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="lib-page" data-dir="-1" ${pageNo <= 1 ? "disabled" : ""}>${icon("chevronRight", 14, "skm-flip")}上一页</button>
          <span class="skm-pager-no">第 ${pageNo} / ${pages} 页</span>
          <button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="lib-page" data-dir="1" ${pageNo >= pages ? "disabled" : ""}>下一页${icon("chevronRight", 14)}</button>
        </div>
      </div>`;
      return body + pager;
    }

    function libraryHTML() {
      const l = state.library;
      const sourceTypes = [...new Set((l.items || []).map((s) => s.source?.type || "local"))];
      const tags = (state.overview?.tags || state.tags || []).slice(0, 10);
      const seg = [["all", "全部"], ["deployed", "已部署"], ["available", "未部署"]]
        .map(([v, label]) => `<button class="skm-seg${l.status === v ? " is-active" : ""}" data-act="lib-status" data-status="${v}" aria-pressed="${l.status === v}">${label}</button>`).join("");
      const sources = [["", "全部来源"], ...sourceTypes.map((t) => [t, sourceType(t)])]
        .map(([v, label]) => `<button class="skm-chip${l.source === v ? " is-active" : ""}" data-act="lib-source" data-source="${esc(v)}" aria-pressed="${l.source === v}">${esc(label)}</button>`).join("");
      const tagChips = tags.map((t) => `<button class="skm-chip${l.tag === t.name ? " is-active" : ""}" data-act="tag" data-tag="${esc(t.name)}" aria-pressed="${l.tag === t.name}">${esc(t.name)}<span>${nf(t.count)}</span></button>`).join("");
      const preset = l.preset ? state.presets.find((p) => p.id === l.preset) : null;
      return `<div class="skm-page">
        ${pageHead("技能库", { badge: nf(l.total), sub: "浏览中央库中的技能快照。搜索与预览只读取文本，不会执行技能内容。", actions: `<button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="refresh" title="刷新数据">${icon("refresh", 15)}刷新</button><button class="skm-btn skm-btn-primary skm-btn-sm" data-act="scan">${icon("scan", 15)}扫描本机</button>` })}
        ${preset ? `<div class="skm-filter-banner">正在查看预设「${esc(preset.name)}」<button class="skm-link" data-act="clear-preset">退出预设</button></div>` : ""}
        <div class="skm-toolbar-wrap">
        <div class="skm-toolbar">
          <div class="skm-toolbar-main">
            <label class="skm-search">${icon("search", 16)}<input class="skm-input" type="search" data-lib-search placeholder="搜索技能名称或简介" value="${esc(l.q)}" aria-label="搜索技能" autocomplete="off" spellcheck="false"></label>
            <div class="skm-segmented" role="group" aria-label="按部署状态筛选">${seg}</div>
          </div>
          <div class="skm-toolbar-actions">
            <div class="skm-segmented is-icon" role="group" aria-label="视图">
              <button class="skm-seg skm-seg-icon${l.view === "grid" ? " is-active" : ""}" data-act="lib-view" data-view="grid" aria-pressed="${l.view === "grid"}" title="网格视图">${icon("grid", 15)}</button>
              <button class="skm-seg skm-seg-icon${l.view === "list" ? " is-active" : ""}" data-act="lib-view" data-view="list" aria-pressed="${l.view === "list"}" title="列表视图">${icon("list", 15)}</button>
            </div>
          </div>
        </div>
        <div class="skm-chip-row">${sources}${tags.length ? '<span class="skm-chip-sep" aria-hidden="true"></span>' : ""}${tagChips}</div>
        </div>
        <div data-lib-results>${libraryResultsHTML()}</div>
      </div>`;
    }

    function agentsHTML() {
      if (!state.overview) return `<div class="skm-page">${pageHead("Agents")}${alertBox(state.error || "正在读取…", false)}</div>`;
      const agents = state.agents || [];
      const detected = agents.filter((a) => a.exists).length;
      return `<div class="skm-page">
        ${pageHead("Agents", { badge: `${detected}/${agents.length}`, sub: "已登记的 Agent 技能目录。目录存在与否、启用状态与实际部署分别判断。", actions: `<button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="new-agent">${icon("plus", 15)}自定义 Agent</button>` })}
        ${state.error ? alertBox(state.error) : ""}
        <div class="skm-agent-grid">
          ${agents.map((a) => `<button class="skm-agent-card" data-act="nav" data-view="agent:${esc(a.id)}">
            ${agentTile(a, 36)}
            <div class="skm-agent-main">
              <div class="skm-agent-name">${esc(a.name)}<span class="skm-mini-pill">${a.origin === "builtin" ? "内置" : "自定义"}</span>${a.enabled ? "" : '<span class="skm-mini-pill is-warn">已停用</span>'}</div>
              <p class="skm-agent-sub">${state.agentCounts[a.id] == null ? "正在读取技能数…" : `${nf(state.agentCounts[a.id])} 个 Skills`} · ${a.exists ? "目录已创建" : "目录未创建"}</p>
            </div>
            ${icon("chevronRight", 16, "skm-agent-chev")}
          </button>`).join("")}
        </div>
        <section class="skm-section">
          <h2 class="skm-section-title">只读边界</h2>
          <div class="skm-panel skm-readonly">
            <div class="skm-readonly-row">${icon("lock", 16)}<div><b>目录未创建 ≠ 未启用</b><span>路径不存在时仅表示本机还没有这个目录；启用状态与文件存在性分别展示，不会自动创建目录。</span></div></div>
            <div class="skm-readonly-row">${icon("folderOpen", 16)}<div><b>只读扫描</b><span>扫描只读取各 Agent 目录中的 SKILL.md，不会写入 Agent 配置或执行技能脚本。</span></div></div>
          </div>
        </section>
      </div>`;
    }

    function agentDetailHTML(id) {
      const a = state.agents.find((x) => x.id === id);
      if (!a) return `<div class="skm-page">${pageHead("Agent 未找到")}${emptyState({ title: "没有这个 Agent", hint: "它可能已被移除，或链接已失效。", action: '<button class="skm-btn skm-btn-secondary" data-act="nav" data-view="agents">返回 Agents</button>' })}</div>`;
      const skills = state.agentSkills[id];
      const bindings = state.workspaces.filter((w) => (w.agentIds || []).includes(id));
      return `<div class="skm-page">
        <header class="skm-page-head">
          <div class="skm-page-head-main">
            <h1 class="skm-page-title skm-title-with-tile">${agentTile(a, 28)}${esc(a.name)}<span class="skm-badge">${skills ? nf(skills.total) : "…"}</span></h1>
            <p class="skm-page-sub skm-path-line">${icon("folder", 13)}<code class="skm-path" title="${esc(a.globalPath)}">${esc(a.globalPath || "未设置目录")}</code></p>
          </div>
          <div class="skm-page-actions">
            <button class="skm-switch${a.enabled ? " is-on" : ""}" role="switch" aria-checked="${a.enabled}" data-act="agent-toggle" data-id="${esc(a.id)}" title="${a.enabled ? "停用" : "启用"}" aria-label="${a.enabled ? "停用" : "启用"} ${esc(a.name)}"><span></span></button>
            <button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="edit-agent" data-id="${esc(a.id)}">${icon("edit", 14)}编辑目录</button>
            ${a.origin === "builtin" ? `<button class="skm-btn skm-btn-ghost skm-btn-sm" data-act="agent-restore" data-id="${esc(a.id)}">恢复默认</button>` : `<button class="skm-btn skm-btn-ghost skm-btn-sm is-danger" data-act="agent-delete" data-id="${esc(a.id)}">${icon("trash", 14)}删除</button>`}
          </div>
        </header>
        ${state.error ? alertBox(state.error) : ""}
        <div class="skm-meta-grid">
          <div class="skm-kv"><span>目录状态</span><b class="${a.exists ? "is-ok" : "is-muted"}">${a.exists ? "已创建" : "目录未创建"}</b></div>
          <div class="skm-kv"><span>启用状态</span><b>${a.enabled ? "已启用" : "已停用"}</b></div>
          <div class="skm-kv"><span>来源</span><b>${a.origin === "builtin" ? "内置" : "自定义"}</b></div>
          <div class="skm-kv"><span>项目相对目录</span><b class="skm-mono">${esc(a.projectRelative || "无")}</b></div>
        </div>
        <section class="skm-section">
          <h2 class="skm-section-title">工作区绑定</h2>
          <div class="skm-panel skm-bind-list">
            ${bindings.length ? bindings.map((w) => `<button class="skm-bind-row" data-act="nav" data-view="workspace:${esc(w.id)}"><span class="skm-dir-ico">${icon(w.kind === "linked" ? "link" : "globe", 15)}</span><span>${esc(w.name)}</span><span class="skm-mini-pill">${w.kind === "global" ? "全局" : w.kind === "project" ? "项目" : "关联"}</span>${icon("chevronRight", 14)}</button>`).join("") : '<p class="skm-inline-note">尚未绑定到任何工作区。</p>'}
          </div>
        </section>
        <section class="skm-section">
          <div class="skm-section-head"><h2 class="skm-section-title">此 Agent 的技能</h2><button class="skm-btn skm-btn-ghost skm-btn-sm" data-act="refresh-agent" data-id="${esc(a.id)}">${icon("refresh", 14)}刷新</button></div>
          ${skills
            ? (skills.items.length
              ? `<div class="skm-card-grid">${skills.items.map(skillCard).join("")}</div>`
              : emptyState({ title: "这个 Agent 目录还没有技能", hint: a.exists ? "目录存在，但其中没有检测到 SKILL.md。" : "目录尚未创建，因此没有任何技能可读取。", action: `<button class="skm-btn skm-btn-secondary" data-act="edit-agent" data-id="${esc(a.id)}">检查目录路径</button>` }))
            : `<div class="skm-skeleton">${Array.from({ length: 3 }).map(() => '<div class="skm-skeleton-card"></div>').join("")}</div>`}
        </section>
      </div>`;
    }

    function workspaceCard(w) {
      const kindLabel = w.kind === "global" ? "全局" : w.kind === "project" ? "项目" : "关联";
      const ico = w.kind === "global" ? "globe" : w.kind === "project" ? "folder" : "link";
      return `<button class="skm-ws-card" data-act="nav" data-view="workspace:${esc(w.id)}">
        <span class="skm-ws-ico">${icon(ico, 18)}</span>
        <div class="skm-ws-main">
          <div class="skm-ws-name">${esc(w.name)}<span class="skm-mini-pill">${kindLabel}</span><span class="skm-status ${w.exists ? "is-ok" : "is-muted"}"><span class="skm-dot sm${w.exists ? " is-on" : ""}"></span>${w.exists ? "目录已创建" : "目录未创建"}</span></div>
          <code class="skm-path" title="${esc(w.root || "由各 Agent 的全局目录组成")}">${esc(w.root || "由各 Agent 的全局目录组成")}</code>
          <p class="skm-ws-meta">${nf((w.agentIds || []).length)} 个 Agent${w.kind === "global" ? ` · 中央库 ${nf(state.overview?.libraryTotal ?? 0)} 个技能` : ""}</p>
        </div>
        ${icon("chevronRight", 16, "skm-ws-chev")}
      </button>`;
    }

    function workspacesHTML() {
      const linked = state.workspaces.filter((w) => w.kind === "linked");
      const project = state.workspaces.filter((w) => w.kind === "project");
      return `<div class="skm-page">
        ${pageHead("工作区", { badge: nf(state.workspaces.length), sub: "技能在中央库与各 Agent 目录之间的映射。关联目录只读取已存在的绝对路径。", actions: `<button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="refresh-workspaces">${icon("refresh", 15)}刷新</button><button class="skm-btn skm-btn-primary skm-btn-sm" data-act="new-workspace">${icon("plus", 15)}关联目录</button>` })}
        ${state.error ? alertBox(state.error) : ""}
        <section class="skm-section">
          <h2 class="skm-section-title">全局工作区</h2>
          <div class="skm-ws-grid">${state.workspaces.filter((w) => w.kind === "global").map(workspaceCard).join("")}</div>
        </section>
        <section class="skm-section">
          <h2 class="skm-section-title">项目工作区</h2>
          ${project.length ? `<div class="skm-ws-grid">${project.map(workspaceCard).join("")}</div>` : emptyState({ title: "没有项目工作区", hint: "项目工作区来自当前工作目录，目录不存在时也会如实显示。" })}
        </section>
        <section class="skm-section">
          <div class="skm-section-head"><h2 class="skm-section-title">关联目录（${nf(linked.length)}）</h2><button class="skm-btn skm-btn-ghost skm-btn-sm" data-act="new-workspace">${icon("plus", 14)}关联目录</button></div>
          ${linked.length ? `<div class="skm-ws-grid">${linked.map(workspaceCard).join("")}</div>` : `<div class="skm-panel skm-empty-inline"><span>${icon("link", 18)}</span><p>尚未关联任何目录。关联后可浏览其中的技能条目，并与中央库对照。</p><button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="new-workspace">关联目录</button></div>`}
        </section>
      </div>`;
    }

    function entryHTML(item) {
      const zh = zhName(item);
      const desc = zhDescription(item) || String(item.description || "").trim();
      const missing = item.missingLocalization;
      return `<div class="skm-entry">
        <span class="skm-entry-ico">${icon("fileText", 16)}</span>
        <div class="skm-entry-main">
          <div class="skm-entry-name">${esc(item.name)}${zh ? `<span class="skm-row-zh">${esc(zh)}</span>` : ""}${missing ? '<span class="skm-mini-pill is-warn">缺少中文资料</span>' : ""}</div>
          ${desc ? `<p class="skm-entry-desc">${esc(desc)}</p>` : ""}
          <code class="skm-path" title="${esc(item.path)}">${esc(item.path)}</code>
          <div class="skm-entry-pills">
            <span class="skm-mini-pill ${item.inLibrary ? "is-ok" : ""}">${item.inLibrary ? "已在技能库" : "未收录"}</span>
            <span class="skm-mini-pill">${deployText(item.deployStatus)}</span>
            ${(item.tags || []).map((t) => `<span class="skm-tag">${esc(t)}</span>`).join("")}
          </div>
        </div>
        <span class="skm-entry-agent" title="${esc(agentName(item.agentId))}">${agentTile({ id: item.agentId }, 24)}<span>${esc(agentName(item.agentId))}</span></span>
      </div>`;
    }

    function workspaceDetailHTML(id) {
      const w = state.workspaces.find((x) => x.id === id);
      if (!w) return `<div class="skm-page">${pageHead("工作区未找到")}${emptyState({ title: "没有这个工作区", hint: "它可能已被移除。", action: '<button class="skm-btn skm-btn-secondary" data-act="nav" data-view="workspaces">返回工作区</button>' })}</div>`;
      const cache = state.entries[id];
      const data = cache?.data;
      const items = data?.items || [];
      const rows = data?.rows || [];
      const actionLabel = { "add-to-workspace": "待加入工作区", "add-to-library": "待收录到库", "in-sync": "已同步", "differs": "内容不同", external: "外部目录" };
      return `<div class="skm-page">
        <header class="skm-page-head">
          <div class="skm-page-head-main">
            <h1 class="skm-page-title skm-title-with-tile">${icon(w.kind === "linked" ? "link" : w.kind === "global" ? "globe" : "folder", 20)}${esc(w.name)}<span class="skm-badge">${data ? nf(items.length) : "…"}</span><span class="skm-mini-pill">${w.kind === "global" ? "全局" : w.kind === "project" ? "项目" : "关联"}</span></h1>
            <p class="skm-page-sub skm-path-line">${icon("folder", 13)}<code class="skm-path" title="${esc(w.root || "由各 Agent 的全局目录组成")}">${esc(w.root || "由各 Agent 的全局目录组成")}</code><span class="skm-status ${w.exists ? "is-ok" : "is-muted"}"><span class="skm-dot sm${w.exists ? " is-on" : ""}"></span>${w.exists ? "目录已创建" : "目录未创建"}</span></p>
          </div>
          <div class="skm-page-actions">
            <button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="ws-refresh" data-id="${esc(w.id)}">${icon("refresh", 14)}重新读取</button>
            ${w.kind === "linked" ? `<button class="skm-btn skm-btn-ghost skm-btn-sm is-danger" data-act="ws-delete" data-id="${esc(w.id)}">${icon("trash", 14)}移除</button>` : ""}
          </div>
        </header>
        ${state.error ? alertBox(state.error) : ""}
        <div class="skm-agent-chips">${(w.agentIds || []).map((aid) => `<span class="skm-agent-chip">${agentTile({ id: aid }, 20)}${esc(agentName(aid))}</span>`).join("") || '<span class="skm-inline-note">没有绑定 Agent</span>'}</div>
        <section class="skm-section">
          <h2 class="skm-section-title">工作区目录条目</h2>
          ${!cache || cache.loading ? `<div class="skm-skeleton">${Array.from({ length: 3 }).map(() => '<div class="skm-skeleton-card"></div>').join("")}</div>`
            : cache.error ? alertBox(cache.error)
            : items.length ? `<div class="skm-panel skm-entry-list">${items.map(entryHTML).join("")}</div>`
            : emptyState({ title: w.exists ? "目录中没有技能" : "目录尚未创建", hint: w.exists ? "已读取该工作区，但没有在已登记的 Agent 目录中发现 SKILL.md。" : "工作区路径尚不存在。关联目录只读取本机已存在的绝对路径，不会创建目录。", action: w.kind === "linked" ? "" : `<button class="skm-btn skm-btn-secondary" data-act="nav" data-view="agents">检查 Agent 目录</button>` })}
        </section>
        ${data && rows.length ? `<section class="skm-section">
          <h2 class="skm-section-title">库与工作区对照</h2>
          <div class="skm-panel skm-table-wrap"><table class="skm-table"><thead><tr><th>技能</th><th>技能库</th><th>工作区</th><th>部署状态</th><th>建议动作</th></tr></thead><tbody>
            ${rows.map((r) => `<tr><td>${esc(r.name)}${zhName(r) ? `<span class="skm-row-zh">${esc(zhName(r))}</span>` : ""}</td><td>${r.library ? "已收录" : "未收录"}</td><td>${r.workspace ? "存在" : "缺失"}</td><td>${esc(deployText(r.deployStatus))}</td><td><span class="skm-mini-pill">${esc(actionLabel[r.action] || r.action)}</span></td></tr>`).join("")}
          </tbody></table></div>
        </section>` : ""}
      </div>`;
    }

    function agentSettingsRows() {
      return state.agents.map((a) => `<div class="skm-set-row">
        <div class="skm-set-label"><div class="skm-set-name">${agentTile(a, 24)}<b>${esc(a.name)}</b><span class="skm-mini-pill">${a.origin === "builtin" ? "内置" : "自定义"}</span><span class="skm-status ${a.exists ? "is-ok" : "is-muted"}"><span class="skm-dot sm${a.exists ? " is-on" : ""}"></span>${a.exists ? "已创建" : "未创建"}</span></div>
          <code class="skm-path" title="${esc(a.globalPath)}">${esc(a.globalPath || "未设置")}</code></div>
        <div class="skm-set-control"><button class="skm-switch${a.enabled ? " is-on" : ""}" role="switch" aria-checked="${a.enabled}" data-act="agent-toggle" data-id="${esc(a.id)}" aria-label="${a.enabled ? "停用" : "启用"} ${esc(a.name)}"><span></span></button><button class="skm-icon-btn" data-act="edit-agent" data-id="${esc(a.id)}" title="编辑目录">${icon("edit", 15)}</button></div>
      </div>`).join("");
    }

    function settingsHTML() {
      const s = state.settings;
      const o = state.overview;
      const scan = o?.scan;
      return `<div class="skm-page is-narrow">
        ${pageHead("设置", { sub: "中央技能库、同步方式与只读边界。所有修改只写入当前 Profile，不改动源技能文件。" })}
        ${state.error ? alertBox(state.error) : ""}
        <section class="skm-section">
          <div class="skm-section-head"><h2 class="skm-section-title">支持的 Agents（${nf(state.agents.filter((a) => a.exists).length)}/${nf(state.agents.length)}）</h2><button class="skm-btn skm-btn-ghost skm-btn-sm" data-act="new-agent">${icon("plus", 14)}自定义 Agent</button></div>
          <div class="skm-panel skm-set-list">${agentSettingsRows()}</div>
        </section>
        <section class="skm-section">
          <h2 class="skm-section-title">全局配置</h2>
          <div class="skm-panel skm-set-list">
            <div class="skm-set-row">
              <div class="skm-set-label"><b>中央技能库路径</b><p>所有技能的中央副本与索引快照都保存在这里。</p><code class="skm-path" title="${esc(s?.libraryRoot || o?.library?.root || "")}">${esc(s?.libraryRoot || o?.library?.root || "读取中…")}</code></div>
              <div class="skm-set-control"><button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="edit-library">${icon("folderOpen", 14)}更改目录</button></div>
            </div>
            <div class="skm-set-row">
              <div class="skm-set-label"><b>默认同步方式</b><p>符号链接占用空间更小，复制则在目标目录保留独立副本。</p></div>
              <div class="skm-set-control"><div class="skm-segmented" role="group" aria-label="默认同步方式">
                <button class="skm-seg${s?.defaultMode === "symlink" ? " is-active" : ""}" data-act="set-mode" data-mode="symlink">符号链接</button>
                <button class="skm-seg${s?.defaultMode === "copy" ? " is-active" : ""}" data-act="set-mode" data-mode="copy">复制</button>
              </div></div>
            </div>
            <div class="skm-set-row">
              <div class="skm-set-label"><b>项目工作区路径</b><p>项目工作区中的技能目录会按 Agent 的项目相对目录解析。</p><code class="skm-path" title="${esc(s?.workspacePath || "")}">${esc(s?.workspacePath || "读取中…")}</code></div>
            </div>
            <div class="skm-set-row">
              <div class="skm-set-label"><b>索引状态</b><p>${scan ? `上次索引 ${esc(fmtTime(scan.at))}，读取 ${nf(scan.visited)} 个目录，收录 ${nf(scan.count)} 项。` : "尚未建立索引。扫描只读取已登记目录，不会执行技能内容。"}</p>${scan ? `<span class="skm-mini-pill ${scan.limited ? "is-warn" : "is-ok"}">${scan.limited ? "达到扫描上限" : "只读索引完成"}</span>` : ""}</div>
              <div class="skm-set-control"><button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="scan">${icon("scan", 14)}重建索引</button></div>
            </div>
          </div>
        </section>
        <section class="skm-section">
          <h2 class="skm-section-title">只读与安全边界</h2>
          <div class="skm-panel skm-readonly">
            <div class="skm-readonly-row">${icon("lock", 16)}<div><b>不执行任何技能内容</b><span>SKILL.md 只作为文本预览；不会运行脚本、命令、安装器或 MCP 服务。</span></div></div>
            <div class="skm-readonly-row">${icon("folder", 16)}<div><b>只扫描已登记目录</b><span>中央技能库、已登记的 Agent 目录与项目工作区；不会遍历整盘。</span></div></div>
            <div class="skm-readonly-row">${icon("fileText", 16)}<div><b>中文展示不改源文件</b><span>中文名称与简介来自本地词目或当前 Profile 覆盖，不会上传或改写 SKILL.md。</span></div></div>
          </div>
        </section>
        <section class="skm-section">
          <h2 class="skm-section-title">维护</h2>
          <div class="skm-actions">
            <button class="skm-btn skm-btn-secondary" data-act="refresh">${icon("refresh", 15)}刷新全部数据</button>
            <button class="skm-btn skm-btn-ghost" data-act="nav" data-view="library">前往技能库</button>
          </div>
        </section>
      </div>`;
    }

    function pageHTML() {
      if (state.view === "overview") return overviewHTML();
      if (state.view === "library") return libraryHTML();
      if (state.view === "agents") return agentsHTML();
      if (state.view.startsWith("agent:")) return agentDetailHTML(state.view.slice(6));
      if (state.view === "workspaces") return workspacesHTML();
      if (state.view.startsWith("workspace:")) return workspaceDetailHTML(state.view.slice(10));
      if (state.view === "settings") return settingsHTML();
      return overviewHTML();
    }

    function sheetHTML() {
      return `<div class="skm-sheet-backdrop" data-act="close-sheet"></div>
        <section class="skm-sheet-panel" role="dialog" aria-modal="true" aria-label="技能详情">
          <button class="skm-sheet-close" data-act="close-sheet" aria-label="关闭详情">${icon("x", 18)}</button>
          <div class="skm-sheet-scroll"><div class="skm-sheet-body" data-sheet-body></div></div>
        </section>`;
    }

    function docSection(d) {
      const zh = zhName(d);
      const desc = zhDescription(d) || String(d.description || "").trim();
      const agents = state.agents || [];
      const badges = d.agents || [];
      const deployed = agents.filter((a) => badges.some((b) => b.agentId === a.id && b.deployed));
      const metadata = [
        ["路径", d.path],
        ["来源类型", sourceType(d.source?.type)],
        ["来源地址", d.source?.url],
        ["来源引用", d.source?.ref],
        ["来源修订", d.source?.revision],
        ["快照摘要", d.digest],
        ["文件数", d.files ? String(d.files) : ""],
        ["占用空间", d.bytes != null ? fmtBytes(d.bytes) : ""],
        ["更新时间", d.updatedAt ? new Date(d.updatedAt).toLocaleString("zh-CN") : ""],
        ["上游状态", d.upstream ? upstreamText(d.upstream.status) : ""],
        ["内容与快照", d.contentMatchesSnapshot == null ? "" : d.contentMatchesSnapshot ? "一致" : d.source?.revision ? "不一致" : "无修订记录"],
      ].filter(([, v]) => v);
      const entries = d.entries || [];
      const deployRows = agents.map((a) => {
        const badge = badges.find((b) => b.agentId === a.id && b.deployed);
        return `<div class="skm-deploy-row">
          ${agentTile(a, 28)}
          <div class="skm-deploy-main"><b>${esc(a.name)}</b><span class="skm-deploy-path">${badge ? esc(badge.path || "") : esc(a.globalPath || "")}</span></div>
          ${badge ? `<span class="skm-mini-pill is-ok">${esc(deployText(badge.status))}</span><button class="skm-btn skm-btn-ghost skm-btn-sm" data-act="undeploy" data-skill="${esc(d.id)}" data-agent="${esc(a.id)}">移除</button>` : `<button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="deploy" data-skill="${esc(d.id)}" data-agent="${esc(a.id)}" ${a.exists ? "" : "disabled title=" + JSON.stringify("Agent 目录未创建")}>部署</button>`}
        </div>`;
      }).join("");
      const content = stripFrontmatter(d.content || "");
      return `<div class="skm-doc">
        <header class="skm-doc-head">
          <div class="skm-doc-titles">
            <h2>${esc(d.name)}</h2>
            ${zh ? `<p class="skm-doc-zh">${esc(zh)}</p>` : ""}
            <p class="skm-doc-desc">${desc ? esc(desc) : "源文件未提供简介。"}</p>
          </div>
        </header>
        <div class="skm-doc-meta">
          <span class="skm-mini-pill ${d.libraryStatus === "ok" ? "is-ok" : d.libraryStatus === "missing" ? "is-danger" : "is-warn"}">${libraryStatusText(d.libraryStatus)}</span>
          <span class="skm-mini-pill">${presentationText(d.presentationSource)}</span>
          <span class="skm-mini-pill">${sourceType(d.source?.type)}</span>
          ${(d.tags || []).map((t) => `<span class="skm-tag">${esc(t)}</span>`).join("")}
          <span class="skm-doc-meta-time">${icon("clock", 13)}${esc(fmtTime(d.updatedAt))}</span>
        </div>
        <div class="skm-doc-path">${icon("folder", 14)}<code class="skm-path" title="${esc(d.path)}">${esc(d.path || "—")}</code><button class="skm-icon-btn" data-act="copy" data-copy="${esc(d.path || "")}" title="复制路径">${icon("copy", 14)}</button></div>
        <div class="skm-doc-actions">
          <button class="skm-btn skm-btn-secondary skm-btn-sm" data-act="edit-zh" data-id="${esc(d.id)}">${icon("edit", 14)}编辑中文展示</button>
          <button class="skm-btn skm-btn-ghost skm-btn-sm" data-act="open-dir" data-path="${esc(d.path || "")}">${icon("folderOpen", 14)}复制目录路径</button>
        </div>
        <section class="skm-doc-section">
          <h3 class="skm-section-title">部署到 Agent</h3>
          <div class="skm-panel skm-deploy-list">${deployRows}</div>
          <p class="skm-inline-note">部署只复制或链接当前技能目录，不会执行其中脚本。</p>
        </section>
        ${metadata.length ? `<section class="skm-doc-section">
          <button class="skm-meta-toggle" data-act="toggle-meta" aria-expanded="false">${icon("chevronDown", 14, "skm-meta-chev")}<span>来源与索引元信息</span></button>
          <div class="skm-panel skm-meta-card" data-meta hidden><div class="skm-meta-grid">${metadata.map(([k, v]) => `<div class="skm-kv"><span>${esc(k)}</span><b class="skm-mono" title="${esc(v)}">${esc(v)}</b></div>`).join("")}</div></div>
        </section>` : ""}
        ${entries.length ? `<section class="skm-doc-section">
          <details class="skm-files"><summary>技能目录文件（${nf(entries.length)}）</summary><div class="skm-file-list">${entries.map((f) => `<code>${esc(f)}</code>`).join("")}</div></details>
        </section>` : ""}
        <section class="skm-doc-section">
          <h3 class="skm-section-title">SKILL.md</h3>
          ${content ? `<div class="skm-markdown" data-doc-md></div>` : `<p class="skm-inline-note">没有可用的 SKILL.md 正文。${d.fileExists === "no" ? "源文件当前不可读，也不会执行其中的内容。" : ""}</p>`}
        </section>
        <footer class="skm-doc-foot">${icon("lock", 13)}只读预览 · 不执行技能内容 · 中文展示只写入当前 Profile</footer>
      </div>`;
    }

    async function openSheet(id) {
      state.lastFocus = document.activeElement;
      const sheet = q("[data-skm-sheet]", root);
      sheet.hidden = false;
      requestAnimationFrame(() => sheet.classList.add("is-open"));
      const body = q("[data-sheet-body]", sheet);
      body.innerHTML = `<div class="skm-sheet-loading">${icon("refresh", 18, "skm-spin")}正在读取技能详情…</div>`;
      const ticket = (state.sheetTicket = (state.sheetTicket || 0) + 1);
      try {
        const d = await api("GET", "/skill?id=" + encodeURIComponent(id));
        if (ticket !== state.sheetTicket || !root.isConnected) return;
        state.detail = d;
        body.innerHTML = docSection(d);
        const md = q("[data-doc-md]", body);
        if (md) U().markdown(md, stripFrontmatter(d.content || ""));
        q(".skm-sheet-close", sheet)?.focus();
        syncUnsaved();
      } catch (err) {
        if (signal?.aborted) return;
        body.innerHTML = `<div class="skm-sheet-error">${alertBox(err.message || "读取技能详情失败")}</div>`;
      }
    }

    function closeSheet(force) {
      const sheet = q("[data-skm-sheet]", root);
      if (!sheet || sheet.hidden) return;
      sheet.classList.remove("is-open");
      state.sheetTicket = (state.sheetTicket || 0) + 1;
      const done = () => {
        if (!sheet.isConnected) return;
        sheet.hidden = true;
        q("[data-sheet-body]", sheet).innerHTML = "";
        state.detail = null;
        root._wbUnsaved = false;
        try { state.lastFocus?.focus?.(); } catch {}
      };
      if (force) done();
      else setTimeout(done, 160);
    }

    function syncUnsaved() {
      root._wbUnsaved = false;
    }

    function paintSide() {
      const side = q("[data-skm-side]", root);
      if (!side) return;
      side.innerHTML = sideHTML();
    }

    function paintPage() {
      const host = q("[data-skm-page]", root);
      if (!host) return;
      host.innerHTML = pageHTML();
      const active = q("[data-skm-side] .skm-nav.is-active", root);
      if (active && !active.contains(document.activeElement)) {
        // 仅在导航后把焦点交给页面标题，避免打断正在输入的搜索框。
        if (state.focusPage) {
          state.focusPage = false;
          const title = q(".skm-page-title", host);
          if (title) { title.tabIndex = -1; title.focus({ preventScroll: true }); }
        }
      }
    }

    function paint() {
      paintSide();
      paintPage();
    }

    async function loadOverview(force) {
      try {
        const d = await api("GET", "/overview");
        if (signal?.aborted) return;
        state.overview = d;
        state.agents = d.agents || [];
        state.workspaces = d.workspaces || [];
        state.presets = d.presets || [];
        state.tags = d.tags || [];
        state.activity = d.activity || [];
        state.scan = d.scan || null;
        state.error = "";
      } catch (err) {
        if (signal?.aborted) return;
        state.error = err.message || "读取概览失败";
      }
    }

    async function loadSettings() {
      try {
        state.settings = await api("GET", "/settings");
      } catch (err) {
        if (!signal?.aborted) state.settings = null;
      }
    }

    async function loadAgentCounts() {
      await Promise.all(state.agents.map(async (a) => {
        try {
          const d = await api("GET", `/library?agent=${encodeURIComponent(a.id)}&limit=1`);
          state.agentCounts[a.id] = d.total || 0;
        } catch {
          state.agentCounts[a.id] = null;
        }
      }));
      if (root.isConnected && state.view !== "library") paintSide();
    }

    async function loadLibrary() {
      const l = state.library;
      l.loading = true;
      l.error = "";
      paintLibraryResults();
      try {
        const params = new URLSearchParams({ limit: "100" });
        if (l.q) params.set("q", l.q);
        if (l.tag) params.set("tag", l.tag);
        if (l.agent) params.set("agent", l.agent);
        const d = await api("GET", "/library?" + params.toString());
        if (signal?.aborted) return;
        l.items = d.items || [];
        l.total = d.total || 0;
        l.loaded = true;
        if (l.offset >= libraryFiltered().length) l.offset = 0;
      } catch (err) {
        if (signal?.aborted) return;
        l.error = err.message || "读取技能库失败";
        if (!l.loaded) { l.items = []; l.total = 0; }
      } finally {
        l.loading = false;
        paintLibraryResults();
        paintSide();
      }
    }

    function paintLibraryResults() {
      const host = q("[data-lib-results]", root);
      if (!host) return;
      host.innerHTML = libraryResultsHTML();
      const total = q("[data-lib-total]", root);
      if (total) total.textContent = nf(state.library.total);
      const badge = q(".skm-page-title .skm-badge", root);
      if (badge && state.view === "library") badge.textContent = nf(state.library.total);
    }

    async function loadAgentSkills(id, force) {
      if (!force && state.agentSkills[id]) return;
      state.agentSkills[id] = null;
      paintPage();
      try {
        const d = await api("GET", `/library?agent=${encodeURIComponent(id)}&limit=100`);
        if (signal?.aborted) return;
        state.agentSkills[id] = { items: d.items || [], total: d.total || 0 };
      } catch (err) {
        if (signal?.aborted) return;
        state.agentSkills[id] = { items: [], total: 0, error: err.message };
      }
      if (state.view === "agent:" + id) paintPage();
    }

    async function loadEntries(id, force) {
      if (!force && state.entries[id]?.data) return;
      state.entries[id] = { loading: true };
      paintPage();
      try {
        const d = await api("POST", "/workspace/entries", { id });
        if (signal?.aborted) return;
        state.entries[id] = { data: d };
      } catch (err) {
        if (signal?.aborted) return;
        state.entries[id] = { error: err.message || "读取工作区失败" };
      }
      if (state.view === "workspace:" + id) paintPage();
    }

    async function go(view) {
      if (state.view !== view) closeSheet(true);
      state.view = view;
      state.error = "";
      state.focusPage = true;
      paintSide();
      paintPage();
      if (view === "overview" || view === "settings" || view === "agents" || view === "workspaces") {
        if (!state.overview) { await loadOverview(); paint(); }
        if (view === "settings" && !state.settings) { await loadSettings(); paintPage(); }
        if (view === "overview" && !state.library.loaded && (state.overview?.libraryTotal || 0) > 0) {
          await loadLibrary();
          paintPage();
        }
      }
      if (view === "library" && !state.library.loaded) await loadLibrary();
      if (view.startsWith("agent:")) await loadAgentSkills(view.slice(6));
      if (view.startsWith("workspace:")) await loadEntries(view.slice(10));
      paintSide();
    }

    function notify(msg, kind) { U().notify(msg, { kind: kind || "success" }); }

    async function refreshAll() {
      await Promise.all([loadOverview(true), loadSettings()]);
      state.library.loaded = false;
      state.agentSkills = {};
      state.entries = {};
      paint();
      if (state.view === "library") await loadLibrary();
      if (state.view.startsWith("agent:")) await loadAgentSkills(state.view.slice(6), true);
      if (state.view.startsWith("workspace:")) await loadEntries(state.view.slice(10), true);
      notify("数据已刷新");
    }

    async function scanLibrary(button) {
      if (button) { button.disabled = true; }
      try {
        const task = await U().request("POST", "/api/skills/scan", {}, { signal });
        await U().job(task, { signal });
        await loadOverview(true);
        state.library.loaded = false;
        state.agentSkills = {};
        state.entries = {};
        state.library.offset = 0;
        paint();
        if (state.view === "library") await loadLibrary();
        notify("只读索引已更新", "success");
      } catch (err) {
        if (!signal?.aborted) notify(err.message || "扫描失败", "error");
      } finally {
        if (button?.isConnected) button.disabled = false;
      }
    }

    function dialogForm(fields) {
      return `<form class="skm-form" data-form>${fields.map((f) => f.type === "checkbox"
        ? `<label class="skm-check"><input type="checkbox" name="${esc(f.name)}" ${f.checked ? "checked" : ""}><span>${esc(f.label)}</span></label>`
        : `<label class="skm-field"><span>${esc(f.label)}</span>${f.multiline
          ? `<textarea class="skm-input" name="${esc(f.name)}" rows="3" maxlength="${f.max || 320}" placeholder="${esc(f.placeholder || "")}">${esc(f.value || "")}</textarea>`
          : `<input class="skm-input" type="text" name="${esc(f.name)}" value="${esc(f.value || "")}" maxlength="${f.max || 200}" placeholder="${esc(f.placeholder || "")}" autocomplete="off" spellcheck="false">`}</label>`).join("")}${fields.note ? `<p class="skm-inline-note">${esc(fields.note)}</p>` : ""}</form>`;
    }

    function openAgentEditor(agent) {
      const isNew = !agent;
      const a = agent || { id: "", name: "", globalPath: "", projectRelative: "", enabled: true, origin: "custom" };
      const body = `<div class="skm-dialog">
        ${dialogForm([
          { name: "id", label: "Agent 标识（字母、数字、_ . -）", value: a.id, max: 48 },
          { name: "name", label: "显示名称", value: a.name, max: 60 },
          { name: "path", label: "全局技能目录（本机绝对路径）", value: a.globalPath || "", max: 400 },
          { name: "projectRelative", label: "项目相对目录（可选）", value: a.projectRelative || "", max: 200 },
          { type: "checkbox", name: "enabled", label: "启用此 Agent", checked: a.enabled !== false },
        ])}
        <p class="skm-inline-note">只读取这个目录，不会创建、改写或执行目录中的任何内容。</p>
        <div class="skm-dialog-actions"><button class="skm-btn skm-btn-secondary" data-dlg-cancel>取消</button><button class="skm-btn skm-btn-primary" data-dlg-save>${isNew ? "添加 Agent" : "保存"}</button></div>
      </div>`;
      const dlg = U().dialog(isNew ? "添加自定义 Agent" : "编辑 Agent 目录", body);
      q("[data-dlg-cancel]", dlg.body).onclick = () => dlg.close(true);
      q("[data-dlg-save]", dlg.body).onclick = async () => {
        const form = q("[data-form]", dlg.body);
        const data = Object.fromEntries(new FormData(form).entries());
        const payload = { id: String(data.id || "").trim(), name: String(data.name || "").trim(), path: String(data.path || "").trim(), projectRelative: String(data.projectRelative || "").trim(), enabled: !!form.querySelector('[name="enabled"]').checked };
        if (!payload.id || !payload.name) return notify("请填写 Agent 标识与名称", "error");
        if (!/^[A-Za-z0-9_.-]{1,48}$/.test(payload.id)) return notify("Agent 标识只能包含字母、数字、_ . -", "error");
        if (payload.path && !/^[A-Za-z]:[\\/]|^\//.test(payload.path)) return notify("请填写本机绝对路径", "error");
        try {
          await api("POST", "/agents", payload);
          dlg.close(true);
          await loadOverview(true);
          paint();
          if (state.view.startsWith("agent:")) await loadAgentSkills(state.view.slice(6), true);
          notify(isNew ? "已添加 Agent" : "Agent 目录已保存");
        } catch (err) { notify(err.message || "保存失败", "error"); }
      };
    }

    function openWorkspaceDialog() {
      const agents = state.agents.filter((a) => a.projectRelative || a.id);
      const body = `<div class="skm-dialog">
        <p class="skm-inline-note">关联目录必须是本机已存在的绝对路径。登记后只读取其中的 SKILL.md，不会创建目录或执行技能。</p>
        ${dialogForm([
          { name: "name", label: "工作区名称（可选，最多 80 字）", value: "", max: 80 },
          { name: "root", label: "目录绝对路径", value: "", max: 400, placeholder: "D:\\path\\to\\workspace" },
        ])}
        <div class="skm-field"><span>绑定 Agent</span><div class="skm-checks">${agents.map((a) => `<label class="skm-check"><input type="checkbox" name="agent" value="${esc(a.id)}" ${a.projectRelative ? "checked" : ""}><span>${esc(a.name)}</span></label>`).join("")}</div></div>
        <div class="skm-dialog-actions"><button class="skm-btn skm-btn-secondary" data-dlg-cancel>取消</button><button class="skm-btn skm-btn-primary" data-dlg-save>关联目录</button></div>
      </div>`;
      const dlg = U().dialog("关联工作区目录", body);
      q("[data-dlg-cancel]", dlg.body).onclick = () => dlg.close(true);
      q("[data-dlg-save]", dlg.body).onclick = async () => {
        const form = q("[data-form]", dlg.body);
        const name = String(q('[name="name"]', form).value || "").trim();
        const dir = String(q('[name="root"]', form).value || "").trim();
        const agentIds = [...form.querySelectorAll('[name="agent"]:checked')].map((x) => x.value);
        if (!dir || !/^[A-Za-z]:[\\/]|^\//.test(dir)) return notify("请填写本机绝对路径", "error");
        try {
          await api("POST", "/workspaces", { name: name || undefined, root: dir, agentIds });
          dlg.close(true);
          await loadOverview(true);
          paint();
          notify("工作区已关联");
        } catch (err) { notify(err.message || "关联失败", "error"); }
      };
    }

    async function openPresetDialog() {
      if (!state.library.loaded) await loadLibrary();
      const items = (state.library.items || []).slice(0, 40);
      const body = `<div class="skm-dialog">
        ${dialogForm([
          { name: "name", label: "预设名称", value: "", max: 80 },
          { name: "description", label: "说明（可选）", value: "", max: 240, multiline: true },
        ])}
        <div class="skm-field"><span>选择技能（当前已载入 ${nf(items.length)} 项）</span><div class="skm-checks is-scroll">${items.map((s) => `<label class="skm-check"><input type="checkbox" name="skill" value="${esc(s.id)}"><span>${esc(s.name)}${zhName(s) ? ` <em>${esc(zhName(s))}</em>` : ""}</span></label>`).join("") || '<p class="skm-inline-note">技能库为空，尚不能创建预设。</p>'}</div></div>
        <div class="skm-dialog-actions"><button class="skm-btn skm-btn-secondary" data-dlg-cancel>取消</button><button class="skm-btn skm-btn-primary" data-dlg-save>创建预设</button></div>
      </div>`;
      const dlg = U().dialog("新建预设", body);
      q("[data-dlg-cancel]", dlg.body).onclick = () => dlg.close(true);
      q("[data-dlg-save]", dlg.body).onclick = async () => {
        const form = q("[data-form]", dlg.body);
        const name = String(q('[name="name"]', form).value || "").trim();
        const description = String(q('[name="description"]', form).value || "").trim();
        const skillIds = [...form.querySelectorAll('[name="skill"]:checked')].map((x) => x.value);
        if (!name) return notify("请填写预设名称", "error");
        try {
          await api("POST", "/preset", { name, description, skillIds });
          dlg.close(true);
          await loadOverview(true);
          paint();
          notify("预设已创建");
        } catch (err) { notify(err.message || "创建失败", "error"); }
      };
    }

    function confirmDialog(title, message, onConfirm, confirmLabel) {
      const body = `<div class="skm-dialog"><p class="skm-confirm-text">${esc(message)}</p><div class="skm-dialog-actions"><button class="skm-btn skm-btn-secondary" data-dlg-cancel>取消</button><button class="skm-btn skm-btn-danger" data-dlg-save>${esc(confirmLabel || "确认")}</button></div></div>`;
      const dlg = U().dialog(title, body);
      q("[data-dlg-cancel]", dlg.body).onclick = () => dlg.close(true);
      q("[data-dlg-save]", dlg.body).onclick = async () => {
        try { await onConfirm(); dlg.close(true); } catch (err) { notify(err.message || "操作失败", "error"); }
      };
    }

    function editPresentation(id) {
      const d = state.detail;
      if (!d) return;
      const body = `<div class="skm-dialog">
        <p class="skm-inline-note">中文展示来自本地词目或当前 Profile 覆盖，不会修改 SKILL.md，也不会上传正文。标题与简介都必须包含中文。</p>
        ${dialogForm([
          { name: "title", label: "中文名称（最多 80 字）", value: zhName(d), max: 80 },
          { name: "description", label: "中文简介（最多 320 字）", value: zhDescription(d), max: 320, multiline: true },
        ])}
        <div class="skm-dialog-actions"><button class="skm-btn skm-btn-ghost" data-dlg-clear>清除覆盖</button><button class="skm-btn skm-btn-secondary" data-dlg-cancel>取消</button><button class="skm-btn skm-btn-primary" data-dlg-save>保存到当前 Profile</button></div>
      </div>`;
      const dlg = U().dialog("编辑中文展示", body);
      q("[data-dlg-cancel]", dlg.body).onclick = () => dlg.close(true);
      q("[data-dlg-clear]", dlg.body).onclick = async () => {
        try {
          await api("POST", "/presentation", { id, title: "清除中文展示", description: "清除当前 Profile 中的中文覆盖", clear: true });
          dlg.close(true);
          await reloadDetail(id);
          notify("已清除中文覆盖");
        } catch (err) { notify(err.message || "清除失败", "error"); }
      };
      q("[data-dlg-save]", dlg.body).onclick = async () => {
        const form = q("[data-form]", dlg.body);
        const title = String(q('[name="title"]', form).value || "").trim();
        const description = String(q('[name="description"]', form).value || "").trim();
        if (!title || !/[\u3400-\u9fff]/.test(title)) return notify("中文名称必须包含中文", "error");
        if (!description || !/[\u3400-\u9fff]/.test(description)) return notify("中文简介必须包含中文", "error");
        try {
          const d2 = await api("POST", "/presentation", { id, title, description });
          dlg.close(true);
          state.detail = d2;
          const bodyHost = q("[data-sheet-body]", root);
          if (bodyHost) {
            bodyHost.innerHTML = docSection(d2);
            const md = q("[data-doc-md]", bodyHost);
            if (md) U().markdown(md, stripFrontmatter(d2.content || ""));
          }
          notify("中文展示已保存");
        } catch (err) { notify(err.message || "保存失败", "error"); }
      };
    }

    async function reloadDetail(id) {
      const d = await api("GET", "/skill?id=" + encodeURIComponent(id));
      state.detail = d;
      const host = q("[data-sheet-body]", root);
      if (host) {
        host.innerHTML = docSection(d);
        const md = q("[data-doc-md]", host);
        if (md) U().markdown(md, stripFrontmatter(d.content || ""));
      }
    }

    async function deployAction(skillId, agentId, deploy) {
      try {
        const payload = { skillId, agentId };
        if (deploy) payload.mode = state.settings?.defaultMode || "symlink";
        await api("POST", deploy ? "/deploy" : "/undeploy", payload);
        notify(deploy ? "已部署到 Agent" : "已从 Agent 移除");
        await reloadDetail(skillId);
        await loadOverview(true);
        paintSide();
      } catch (err) { notify(err.message || "操作失败", "error"); }
    }

    function bindEvents(app) {
      app.addEventListener("click", async (ev) => {
        const card = ev.target.closest("[data-open-skill]");
        if (card && app.contains(card)) { await openSheet(card.dataset.openSkill); return; }
        const target = ev.target.closest("[data-act]");
        if (!target || !app.contains(target)) return;
        const act = target.dataset.act;
        if (act === "nav") { closeSheet(true); await go(target.dataset.view); return; }
        if (act === "group") {
          const key = target.dataset.group;
          state.groups[key] = !state.groups[key];
          paintSide();
          return;
        }
        if (act === "preset") {
          state.library.preset = target.dataset.preset || "";
          state.library.offset = 0;
          if (state.view !== "library") await go("library");
          else { paintPage(); paintLibraryResults(); }
          return;
        }
        if (act === "lib-status") { state.library.status = target.dataset.status; state.library.offset = 0; paintPage(); return; }
        if (act === "lib-source") { state.library.source = target.dataset.source; state.library.offset = 0; paintPage(); return; }
        if (act === "lib-view") { state.library.view = target.dataset.view === "list" ? "list" : "grid"; paintPage(); return; }
        if (act === "lib-page") {
          const dir = Number(target.dataset.dir || 0);
          const max = Math.max(1, Math.ceil(libraryFiltered().length / state.library.limit));
          const page = Math.min(max, Math.max(1, Math.floor(state.library.offset / state.library.limit) + 1 + dir));
          state.library.offset = (page - 1) * state.library.limit;
          paintLibraryResults();
          q("[data-lib-results]", root)?.scrollIntoView({ block: "nearest" });
          return;
        }
        if (act === "tag") { state.library.tag = state.library.tag === target.dataset.tag ? "" : target.dataset.tag; state.library.offset = 0; await loadLibrary(); paintPage(); return; }
        if (act === "clear-filters") {
          Object.assign(state.library, { q: "", tag: "", agent: "", status: "all", source: "", preset: "", offset: 0 });
          await loadLibrary();
          paintPage();
          return;
        }
        if (act === "clear-preset") { state.library.preset = ""; state.library.offset = 0; paintPage(); return; }
        if (act === "refresh") { await refreshAll(); return; }
        if (act === "scan") { await scanLibrary(target); return; }
        if (act === "new-workspace") { openWorkspaceDialog(); return; }
        if (act === "new-preset") { await openPresetDialog(); return; }
        if (act === "new-agent") { openAgentEditor(null); return; }
        if (act === "edit-agent") { openAgentEditor(state.agents.find((a) => a.id === target.dataset.id)); return; }
        if (act === "agent-toggle") {
          const a = state.agents.find((x) => x.id === target.dataset.id);
          if (!a) return;
          target.disabled = true;
          try {
            const d = await api("POST", "/agents", { id: a.id, enabled: !a.enabled });
            state.agents = d.items || state.agents;
            if (state.overview) state.overview.agents = state.agents;
            paint();
            notify(!a.enabled ? "Agent 已启用" : "Agent 已停用");
          } catch (err) { notify(err.message || "操作失败", "error"); target.disabled = false; }
          return;
        }
        if (act === "agent-restore") {
          const id = target.dataset.id;
          confirmDialog("恢复默认目录", `确定将「${agentName(id)}」的全局目录恢复为默认路径吗？`, async () => {
            await api("POST", "/agents", { id, restore: true });
            await loadOverview(true);
            paint();
            notify("已恢复默认目录");
          }, "恢复默认");
          return;
        }
        if (act === "agent-delete") {
          const id = target.dataset.id;
          confirmDialog("移除自定义 Agent", `确定移除「${agentName(id)}」吗？只会移除登记，不会删除本机目录。`, async () => {
            await api("POST", "/agents", { id, delete: true });
            await loadOverview(true);
            await go("agents");
            notify("已移除 Agent");
          }, "移除");
          return;
        }
        if (act === "refresh-agent") { await loadAgentSkills(target.dataset.id, true); notify("已刷新"); return; }
        if (act === "refresh-workspaces") { await loadOverview(true); paint(); notify("已刷新"); return; }
        if (act === "ws-refresh") { await loadEntries(target.dataset.id, true); return; }
        if (act === "ws-delete") {
          const w = state.workspaces.find((x) => x.id === target.dataset.id);
          confirmDialog("移除关联工作区", `确定移除「${w?.name || "该工作区"}」吗？只会移除登记，不会删除本机目录。`, async () => {
            await api("POST", "/workspaces/delete", { id: target.dataset.id });
            await loadOverview(true);
            await go("workspaces");
            notify("已移除工作区");
          }, "移除");
          return;
        }
        if (act === "edit-library") {
          const current = state.settings?.libraryRoot || state.overview?.library?.root || "";
          const body = `<div class="skm-dialog"><p class="skm-inline-note">中央技能库路径必须是本机绝对路径。修改后不会移动或删除已有文件。</p>${dialogForm([{ name: "root", label: "中央技能库绝对路径", value: current, max: 400 }])}<div class="skm-dialog-actions"><button class="skm-btn skm-btn-secondary" data-dlg-cancel>取消</button><button class="skm-btn skm-btn-primary" data-dlg-save>保存</button></div></div>`;
          const dlg = U().dialog("更改中央技能库目录", body);
          q("[data-dlg-cancel]", dlg.body).onclick = () => dlg.close(true);
          q("[data-dlg-save]", dlg.body).onclick = async () => {
            const dir = String(q('[name="root"]', dlg.body).value || "").trim();
            if (!dir || !/^[A-Za-z]:[\\/]|^\//.test(dir)) return notify("请填写本机绝对路径", "error");
            try {
              await api("POST", "/settings", { libraryRoot: dir });
              dlg.close(true);
              await Promise.all([loadOverview(true), loadSettings()]);
              paint();
              notify("中央技能库路径已保存");
            } catch (err) { notify(err.message || "保存失败", "error"); }
          };
          return;
        }
        if (act === "set-mode") {
          try {
            await api("POST", "/settings", { defaultMode: target.dataset.mode });
            await loadSettings();
            paintPage();
            notify("默认同步方式已更新");
          } catch (err) { notify(err.message || "保存失败", "error"); }
          return;
        }
        if (act === "open-skill") { await openSheet(target.dataset.openSkill); return; }
        if (act === "close-sheet") { closeSheet(); return; }
        if (act === "copy" || act === "open-dir") {
          const value = target.dataset.copy || target.dataset.path || "";
          if (!value) return;
          try { await navigator.clipboard.writeText(value); notify("路径已复制"); }
          catch { notify("无法访问剪贴板", "error"); }
          return;
        }
        if (act === "deploy") { await deployAction(target.dataset.skill, target.dataset.agent, true); return; }
        if (act === "undeploy") { await deployAction(target.dataset.skill, target.dataset.agent, false); return; }
        if (act === "toggle-meta") {
          const expanded = target.getAttribute("aria-expanded") === "true";
          target.setAttribute("aria-expanded", expanded ? "false" : "true");
          const card = q("[data-meta]", target.parentElement);
          if (card) card.hidden = expanded;
          return;
        }
        if (act === "edit-zh") { editPresentation(state.detail?.id); return; }
        if (act === "retry") { await refreshAll(); return; }
      });

      app.addEventListener("input", (ev) => {
        const input = ev.target.closest("[data-lib-search]");
        if (!input) return;
        state.library.q = input.value;
        state.library.offset = 0;
        clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(() => loadLibrary(), 220);
      });

      app.addEventListener("keydown", async (ev) => {
        const card = ev.target.closest?.("[data-open-skill]");
        if (card && (ev.key === "Enter" || ev.key === " ")) {
          ev.preventDefault();
          await openSheet(card.dataset.openSkill);
          return;
        }
        const sheet = q("[data-skm-sheet]", root);
        if (sheet && !sheet.hidden) {
          if (ev.key === "Escape") { ev.preventDefault(); closeSheet(); return; }
          if (ev.key === "Tab") {
            const focusables = [...sheet.querySelectorAll("button, [href], input, textarea, [tabindex]:not([tabindex='-1'])")].filter((el) => !el.disabled && el.offsetParent !== null);
            if (!focusables.length) return;
            const first = focusables[0], last = focusables[focusables.length - 1];
            if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
            else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
          }
        }
      });
    }

    function injectCss() {
      if (document.querySelector("link[data-skill-manager-css]")) return;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/skill-manager.css";
      link.dataset.skillManagerCss = "1";
      document.head.append(link);
    }

    injectCss();
    root.classList.add("wb-fixed-layout");
    root.innerHTML = `<div class="skm-app" data-skm>
      <aside class="skm-side" data-skm-side aria-label="技能管理侧栏"></aside>
      <main class="skm-main" data-skm-main><div class="skm-main-scroll"><div data-skm-page></div></div></main>
      <div class="skm-sheet" data-skm-sheet hidden></div>
      <div class="skm-live" aria-live="polite"></div>
    </div>`;
    const app = q("[data-skm]", root);
    const sheet = q("[data-skm-sheet]", root);
    sheet.innerHTML = sheetHTML();
    bindEvents(app);
    root._wbUnsaved = false;
    const priorDispose = root._wbDispose;
    root._wbDispose = () => {
      clearTimeout(state.searchTimer);
      try { priorDispose?.(); } catch {}
    };
    state.groups = { presets: true, agents: true, workspaces: true };
    paint();
    await Promise.all([loadOverview(), loadSettings()]);
    if (signal?.aborted || !root.isConnected) return;
    if ((state.overview?.libraryTotal || 0) > 0) await loadLibrary();
    paint();
    void loadAgentCounts();
    if (state.view === "library" && !state.library.loaded) await loadLibrary();
    if (state.view.startsWith("agent:")) await loadAgentSkills(state.view.slice(6));
    if (state.view.startsWith("workspace:")) await loadEntries(state.view.slice(10));
  }

  window.LibraryViews = { prompts, skills };
})();
