// @ts-nocheck
// Compatibility controller: retain the validated interactions during the React migration.
/* Shared settings and usage adapters, scoped to the current account. */
(() => {
  const sections = [
    ["general", "个人资料", "Profile", "account"],
    ["appearance", "外观", "Appearance", "account"],
    ["modelProvider", "AI 服务", "AI services", "services"],
    ["usage", "用量与实验", "Usage", "services"],
    ["data", "数据与备份", "Data", "account"],
    ["shortcuts", "快捷键", "Shortcuts", "account"],
    ["about", "关于", "About", "account"],
  ];
  if (window.workbenchDesktop?.updateState)
    sections.push(["updates", "关于与更新", "About and updates", "account"]);
  const groups = [
    ["account", "个人设置"],
    ["services", "服务与用量"],
  ];
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
  const q = (s, r = document) => r.querySelector(s),
    qa = (s, r = document) => [...r.querySelectorAll(s)];
  const call = (method, url, body, options) => api(method, url, body, options);
  const paint = (root, html) =>
    window.workbenchDesign
      ? window.workbenchDesign.paint(root, html)
      : (root.innerHTML = html);
  let data = null,
    owner = "",
    usageTimer = null,
    loadSequence = 0;
  const sectionIcon = (id) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="${{ appearance: "M8 12h8m-4-4v8", modelProvider: "M8 9h8m-8 6h5", automations: "m10 8 5 4-5 4Z", memory: "M8 8v8h8V8Z", subagents: "M8 16v-3m4 3V8m4 8v-5", usage: "M8 16V9m4 7V6m4 10v-5" }[id] || "M8 9h8m-8 3h8m-8 3h5"}"/></svg>`;
  const label = (s) => (data?.config.locale === "en-US" ? s[2] : s[1]);
  const button = (text, id, ghost = true) =>
    `<button type="button" class="btn ${ghost ? "ghost" : ""}" id="${id}">${text}</button>`;
  const title = (text, description, actions = "") =>
    `<div class="control-heading"><div><h2>${e(text)}</h2><p>${e(description)}</p></div><div class="control-actions">${actions}</div></div>`;
  const field = (name, text, value = "", type = "text") =>
    `<label class="control-field">${text}<input name="${name}" type="${type}" value="${e(value)}" ${type === "number" ? 'min="0" step="any"' : ""}></label>`;
  const blank = (text) => `<div class="control-empty">${e(text)}</div>`;
  async function load(signal) {
    const identity = user?.username,
      ticket = ++loadSequence;
    const result = await api("GET", "/api/control", undefined, { signal });
    if (identity && user?.username === identity && ticket === loadSequence) {
      const switched = owner !== identity;
      data = result;
      owner = identity;
      data.uiOwner = identity;
      window.workbenchControlData = data;
      if (switched) window.workbenchAppearance?.config(data.config);
      refreshFooter();
    }
    return result;
  }
  async function refreshFooter() {
    window.dispatchEvent(new Event("workbench:profile"));
  }
  async function action(fn) {
    const identity = user?.username;
    try {
      await fn();
    } catch (error) {
      if (error.name !== "AbortError" && user?.username === identity)
        toast(error.message, {kind:"error"});
    }
  }
  function dialog(titleText, html, save) {
    const d = document.createElement("dialog");
    d.className =
      "control-dialog lingxi-dialog" +
      (location.hash.includes("usage") ? "" : " wb-redesign");
    d.setAttribute("aria-label", titleText);
    d.dataset.dialogSize="medium";
    d.innerHTML = `<form class="lingxi-dialog-form"><div class="control-dialog-head"><h3>${e(titleText)}</h3><button type="button" class="btn ghost dialog-close" aria-label="关闭">×</button></div><div class="lingxi-dialog-body">${html}<p class="control-form-error" role="alert"></p></div><div class="control-dialog-actions"><button type="submit" class="btn">保存</button><button type="button" class="btn ghost dialog-close">取消</button></div></form>`;
    document.body.append(d);
    const focus = document.activeElement;
    d.addEventListener("close", () => {
      d.remove();
      if (focus?.isConnected) focus.focus();
    });
    const baseline=JSON.stringify([...new FormData(q('form',d))]);let saving=false;
    const close=()=>{if(saving){toast('正在保存，关闭窗口后操作仍会继续',{kind:'info'});d.close();return;}if(JSON.stringify([...new FormData(q('form',d))])!==baseline&&!confirm('尚未保存，关闭窗口并放弃修改？'))return;d.close();};
    qa(".dialog-close", d).forEach((b) => (b.onclick = close));
    d.addEventListener('cancel',event=>{event.preventDefault();close();});
    q("form", d).onsubmit = async (event) => {
      event.preventDefault();
      const submit = q("[type=submit]", d);
      if (submit.disabled) return;
      submit.disabled = true;
      saving=true;
      try {
        await save(Object.fromEntries(new FormData(event.target)), d);
        if(!d.isConnected)toast('保存完成',{kind:'success'});
        d.close();
      } catch (error) {
        if(d.isConnected)q(".control-form-error", d).textContent = error.message;else toast(error.message,{kind:'error'});
      } finally {
        submit.disabled = false;
        saving=false;
      }
    };
    d.showModal();
    q("input,textarea,select", d)?.focus();
    return d;
  }
  function showResult(titleText, text) {
    const d = dialog(
      titleText,
      `<pre class="control-result"></pre>`,
      async () => {},
    );
    q("pre", d).textContent = text;
    q("[type=submit]", d).textContent = "完成";
  }
  function download(value, name) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function viewHeader(root, text, desc, actions) {
    paint(
      root,
      title(text, desc, actions) + '<div class="control-content"></div>',
    );
    return q(".control-content", root);
  }
  async function settings(root, legacy) {
    if (!root.closest("dialog")) clearInterval(usageTimer);
    const hash = location.hash,
      ticket = (root._settingsSequence || 0) + 1;
    root._settingsSequence = ticket;
    if (!root.querySelector(".settings-layout"))
      root.innerHTML = '<div class="control-loading">正在读取设置…</div>';
    let current;
    try {
      current = await load(root.closest(".module-surface")?._wbAbort?.signal);
    } catch (err) {
      if (root.isConnected && ticket === root._settingsSequence)
        toast(err.message, {kind:"error"});
      return;
    }
    if (
      !root.isConnected ||
      !user ||
      owner !== user.username ||
      location.hash !== hash ||
      ticket !== root._settingsSequence
    )
      return;
    const requested = location.hash.split("/")[2] || "general";
    const selected = sections.find((s) => s[0] === requested) || sections[0];
    root
      .closest(".module-surface")
      ?.classList.toggle("wb-redesign", selected[0] !== "usage");
    if (!root.querySelector(".settings-layout"))
      root.innerHTML =
        '<div class="settings-layout"><aside class="settings-nav"></aside><section id="settings-panel" class="settings-panel"></section></div>';
    paint(
      q(".settings-nav", root),
      `<div class="settings-nav-top"><a href="#/overview" class="btn ghost">‹ 返回工作台</a><h2>设置</h2></div><input type="search" id="settings-search" placeholder="搜索设置" aria-label="搜索设置"><div class="settings-nav-list">${groups
        .map(
          ([id, name]) =>
            `<section class="settings-group"><h3>${name}</h3>${sections
              .filter((s) => s[3] === id)
              .map(
                (s) =>
                  `<a href="#/settings/${s[0]}" data-section="${s[0]}" class="settings-nav-item ${s[0] === selected[0] ? "selected" : ""}" ${s[0] === selected[0] ? 'aria-current="page"' : ""}>${sectionIcon(s[0])}<span>${e(label(s))}</span></a>`,
              )
              .join("")}</section>`,
        )
        .join("")}</div>`,
    );
    const holder = q("#settings-panel", root);
    q("#settings-search", root).oninput = (ev) => {
      const value = ev.target.value.toLowerCase();
      qa(".settings-nav-item", root).forEach(
        (a) => (a.hidden = !a.textContent.toLowerCase().includes(value)),
      );
      qa(".settings-group", root).forEach(
        (g) => (g.hidden = !qa(".settings-nav-item", g).some((a) => !a.hidden)),
      );
    };
    const filter = q("#settings-search", root);
    if (filter.value)
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    if (root.dataset.section === selected[0]) return;
    window.workbenchDesign?.dispose(holder);
    holder.replaceChildren();
    root.dataset.section = selected[0];
    const panel = document.createElement("div");
    panel.className = "settings-content";
    holder.append(panel);
    holder._wbUnsaved = () =>
      panel._wbUnsaved
        ? panel._wbUnsaved()
        : !!panel.querySelector('form [data-wb-dirty="true"]');
    holder._wbDispose = () => {
      panel._wbDispose?.();
      panel._wbUnsaved = null;
    };
    if (selected[0] === "about") {
      window.LingxiDesign.mountAbout(panel);
      return;
    }
    if (selected[0] === "general") return accountSettings(panel);
    if (selected[0] === "data") return dataSettings(panel);
    if (selected[0] === "appearance") return appearance(panel);
    if (selected[0] === "modelProvider") return providers(panel);
    if (selected[0] === "usage") return usageSettings(panel);
    if (selected[0] === "shortcuts") return shortcuts(panel);

  }
  function usageSettings(root) {
    const scopes = [
      ["codex", "Codex"],
      ["zcode", "ZCode"],
      ["dsh", "DeepSeek Harness"],
    ];
    const body = viewHeader(root, "用量采集", "管理本机日志连接与自动采集。");
    body.innerHTML =
      '<form class="control-section" data-log-settings>' +
      scopes
        .map(
          ([scope, name]) =>
            `<fieldset><legend>${name}</legend>${field(scope + "Path", "日志目录", data.config[scope + "Path"] || data[{ codex: "defaultCodexPath", zcode: "defaultZcodePath", dsh: "defaultDshPath" }[scope]] || "")}<label class="control-checkbox"><input name="${scope}Enabled" type="checkbox" ${data.config[scope + "Enabled"] ? "checked" : ""}>启用自动采集</label></fieldset>`,
        )
        .join("") +
      '<p class="control-form-error" role="alert"></p><div class="wb-save-state"><span>修改后保存</span><button type="submit" class="btn">保存采集设置</button></div></form><a href="#/usage" class="btn ghost">打开用量监测与 API供应商管理</a>';
    const form = q("form", body);
    root._wbUnsaved = () => !!form.querySelector("[data-wb-dirty=true]");
    const feature = document.createElement("section");
    feature.className = "wb-panel";
    feature.innerHTML = `<h3>实验与提示词</h3>${[
      [
        "promptAutosave",
        "提示词自动保存",
        "停止输入约 800 ms 后保存，失败保留草稿。",
      ],
      [
        "promptAIEnabled",
        "允许 AI 评估与优化",
        "仅在点击后发送提示词到当前账号配置的 AI 服务。",
      ],
    ]
      .map(
        ([name, label, desc]) =>
          `<label class="wb-setting-switch"><span>${label}<small>${desc}</small></span><input type="checkbox" data-feature="${name}" ${data.config[name] ? "checked" : ""}></label>`,
      )
      .join(
        "",
      )}<p class="wb-inline-error" data-feature-error role="alert"></p><a class="btn ghost" href="prices.html" data-price-page>查看模型价格与汇率 ↗</a>`;
    body.prepend(feature);
    qa("[data-feature]", feature).forEach(
      (input) =>
        (input.onchange = async () => {
          input.disabled = true;
          const before = !input.checked;
          try {
            const r = await call("POST", "/api/features", {
              [input.dataset.feature]: input.checked,
            });
            await load();
            if (!root.isConnected) return;
            delete input.dataset.wbDirty;
            window.dispatchEvent(
              new CustomEvent("workbench:features", { detail: r.features }),
            );
            toast(r.task ? "已开启，价格缓存正在后台准备" : "设置已保存", {kind:"success"});
          } catch (error) {
            if (root.isConnected) {
              input.checked = before;
              q("[data-feature-error]", feature).textContent = error.message;
            }
          } finally {
            if (input.isConnected) {
              input.disabled = false;
              window.WorkbenchUI.refreshControls?.(feature);
            }
          }
        }),
    );
    form.onsubmit = async (event) => {
      event.preventDefault();
      const button = q("[type=submit]", form);
      if (button.disabled) return;
      const values = new FormData(form),
        config = {};
      scopes.forEach(([scope]) => {
        config[scope + "Path"] = values.get(scope + "Path");
        config[scope + "Enabled"] = values.has(scope + "Enabled");
      });
      button.disabled = true;
      try {
        await call("POST", "/api/control/config", config);
        await load();
        qa("[data-wb-dirty]", form).forEach((el) => {
          if (
            (el.type === "checkbox" ? el.checked : el.value) === config[el.name]
          )
            delete el.dataset.wbDirty;
        });
        toast("采集设置已保存", {kind:"success"});
      } catch (error) {
        q("[role=alert]", form).textContent = error.message;
      } finally {
        if (form.isConnected) button.disabled = false;
      }
    };
  }
  function accountSettings(root) {
    const body = viewHeader(root, "个人资料", "设置当前 Profile 的用户名与头像。");
    window.LingxiDesign.identity(body, { name: state.settings.display_name || user.display_name, avatar: data.avatar?.url, save: async (name, avatar, remove) => {
      await call("POST", "/api/profile", { displayName: name });
      if (avatar) await call("POST", "/api/profile/avatar", { data: avatar });
      if (remove) await call("POST", "/api/profile/avatar", { remove: true });
      await load(); await refresh(); refreshFooter(); toast("资料已保存", {kind:"success"});
    }});
  }
  function dataSettings(root) {
    const body = viewHeader(
      root,
      "数据与备份",
      "备份整个 Profile，包含工作内容、个人资料、设置与凭据。",
    );
    body.innerHTML =
      '<section class="control-section"><div class="control-actions"><button class="btn" data-backup>创建加密备份</button><button class="btn ghost" data-export-profile>导出加密 Profile</button></div><p class="meta">请妥善保存备份口令，恢复时需要使用。</p><p class="control-form-error" role="alert"></p><div data-backup-list></div></section>';
    const identity = user.username,
      active = () => root.isConnected && user?.username === identity;
    const passwordDialog = (title, confirmPassword, submit) =>
      dialog(
        title,
        `<label class="control-field">备份口令<input type="password" name="password" required minlength="8" maxlength="1024" autocomplete="new-password"></label>${confirmPassword ? '<label class="control-field">再次输入口令<input type="password" name="confirmPassword" required minlength="8" autocomplete="new-password"></label>' : ""}<p class="meta">口令只用于本次加密或恢复，不会保存在浏览器中。</p>`,
        async (fields) => {
          if (confirmPassword && fields.password !== fields.confirmPassword)
            throw new Error("两次输入的口令不一致");
          await submit(fields.password);
        },
      );
    const reloadProfile = async () => {
      const result = await call("GET", "/api/profile/session", undefined, {
        auth: true,
      });
      if (result.user?.username !== user?.username) {
        window.settingsCenter?.close(false, true);
        layoutStorage.resetSession();
      }
      user = result.user;
      await refresh();
      render();
    };
    const downloadBackup = async (filename) => {
      const response = await fetch(
        "/api/backups/file?file=" + encodeURIComponent(filename),
      );
      if (!response.ok)
        throw new Error((await response.json()).error || "备份下载失败");
      const url = URL.createObjectURL(await response.blob()),
        a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const list = async () => {
      try {
        const result = await call("GET", "/api/backups");
        if (!active()) return;
        q("[data-backup-list]", body).innerHTML = result.backups.length
          ? result.backups
              .map(
                (row) =>
                  `<div class="resource-row"><div class="resource-details"><h3>${e(new Date(row.at * 1000).toLocaleString())}</h3><small>${(row.size / 1024).toFixed(1)} KB · 完整 Profile · 已加密</small></div><div class="resource-actions"><button class="btn ghost" data-download-backup="${e(row.file)}">下载</button><button class="btn ghost" data-restore-profile="${e(row.file)}">恢复</button></div></div>`,
              )
              .join("")
          : '<div class="control-empty">尚无 Profile 备份</div>';
        qa("[data-download-backup]", body).forEach(
          (b) =>
            (b.onclick = () =>
              action(() => downloadBackup(b.dataset.downloadBackup))),
        );
        qa("[data-restore-profile]", body).forEach(
          (b) =>
            (b.onclick = () => {
              if (!confirm("恢复此 Profile 备份？当前资料会先生成加密恢复副本。"))
                return;
              passwordDialog("恢复 Profile", false, async (password) => {
                await call("POST", "/api/restore", {
                  file: b.dataset.restoreProfile,
                  password,
                });
                await reloadProfile();
                toast("Profile 已恢复", {kind:"success"});
              });
            }),
        );
      } catch (error) {
        if (active()) q("[role=alert]", body).textContent = error.message;
      }
    };
    q("[data-backup]", body).onclick = () =>
      passwordDialog("创建加密备份", true, async (password) => {
        await call("POST", "/api/backup", { password });
        toast("加密备份已创建", {kind:"success"});
        await list();
      });
    q("[data-export-profile]", body).onclick = () =>
      passwordDialog("导出加密 Profile", true, async (password) => {
        const result = await call("POST", "/api/backup", { password });
        await downloadBackup(result.file);
        await list();
        toast("加密 Profile 已导出", {kind:"success"});
      });
    if (!window.workbenchDesktop) {
      const access = document.createElement("section");
      access.className = "control-section";
      access.innerHTML =
        '<h3>局域网访问</h3><p class="meta">重启网页后台后生效。实例凭证每次启动更新，仅在本机显示。</p><label class="control-checkbox"><input type="checkbox" data-lan-enabled>允许局域网设备访问</label><button class="btn ghost" data-lan-save>保存访问范围</button><details><summary>查看实例访问凭证</summary><input class="wb-instance-token" readonly aria-label="实例访问凭证" autocomplete="off"><button class="btn ghost" data-copy-token>复制凭证</button></details><p role="alert" class="control-form-error"></p>';
      body.append(access);
      call("GET", "/api/instance/access")
        .then((result) => {
          if (!active()) return;
          q("[data-lan-enabled]", access).checked = result.host === "0.0.0.0";
          q(".wb-instance-token", access).value = result.token;
        })
        .catch(() => access.remove());
      q("[data-lan-save]", access).onclick = async () => {
        const button = q("[data-lan-save]", access);
        button.disabled = true;
        try {
          await call("POST", "/api/instance/access", {
            enabled: q("[data-lan-enabled]", access).checked,
          });
          delete q("[data-lan-enabled]", access).dataset.wbDirty;
          toast("访问范围已保存，请正常退出并重启网页后台", {kind:"success"});
        } catch (error) {
          q("[role=alert]", access).textContent = error.message;
        } finally {
          button.disabled = false;
        }
      };
      q("[data-copy-token]", access).onclick = () =>
        navigator.clipboard.writeText(q(".wb-instance-token", access).value).then(
          () => toast("实例凭证已复制", {kind:"success"}),
          () => toast("请选中凭证手动复制"),
        );
    }
    const profiles=document.createElement("section");profiles.className="control-section";body.prepend(profiles);window.LingxiDesign.profileCards(profiles).catch(error=>profiles.textContent=error.message);
    list();
    window.profileManagement?.mount(body);
    const restart = document.createElement("button");
    restart.className = "btn ghost onboarding-start-again";
    restart.textContent = "重新打开启动引导";
    restart.onclick = () =>
      window.lingxiOnboarding?.open().catch((error) => toast(error.message, {kind:"error"}));
    body.append(restart);
  }

  function appearance(root) {
    const body = viewHeader(root, "外观", "主题、字号、强调色与界面亮度。");
    const icons = {
      "zai-light":
        '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
      "zai-dark":
        '<path d="M20 14.2A8.5 8.5 0 0 1 9.8 4 8.5 8.5 0 1 0 20 14.2Z"/>',
      system:
        '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
    };
    body.innerHTML = `<form class="control-section dsh-appearance-form" data-appearance-form><fieldset class="dsh-theme-group"><legend>主题</legend><div class="dsh-theme-cubes">${[
      ["zai-light", "浅色"],
      ["zai-dark", "深色"],
      ["system", "跟随系统"],
    ]
      .map(
        ([value, label]) =>
          `<label class="dsh-theme-cube"><input type="radio" name="appearanceTheme" value="${value}" aria-label="${label}"><span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${icons[value]}</svg><span>${label}</span></span></label>`,
      )
      .join(
        "",
      )}</div><select id="appearance-theme" hidden aria-hidden="true" tabindex="-1"><option value="system">跟随系统</option><option value="zai-light">浅色</option><option value="zai-dark">深色</option></select></fieldset><div class="dsh-setting-row"><div><label for="appearance-font">界面字号</label><p>编辑内容字号单独设置</p></div><div class="dsh-font-control"><input type="number" id="appearance-font" min="12" max="18" step="2" aria-label="界面字号"><span>px</span><div class="dsh-font-arrows"><button type="button" data-font-step="2" aria-label="增大字号">⌃</button><button type="button" data-font-step="-2" aria-label="减小字号">⌄</button></div></div></div><label class="dsh-setting-row"><span>强调色</span><select id="appearance-accent"><option value="blue">蓝色</option><option value="violet">紫色</option><option value="teal">青绿色</option><option value="orange">橙色</option></select></label><label class="dsh-setting-row"><span>界面亮度 <small class="wb-muted">只调整项目界面</small></span><div><input id="appearance-brightness" type="range" min="85" max="110" step="1" aria-label="界面亮度"><output data-brightness></output></div></label><label class="wb-setting-switch"><span>减少动画<small>保留选中与加载状态，减少动态效果。</small></span><input type="checkbox" id="appearance-motion"></label><label class="dsh-setting-row"><span>界面模式</span><select id="interface-mode"><option value="office">办公</option><option value="coding">编程</option></select></label><label class="dsh-setting-row"><span>菜单语言</span><select id="menu-locale"><option value="zh-CN">简体中文</option><option value="en-US">English</option><option value="system">跟随系统</option></select></label><p class="meta dsh-preview-hint">修改即时预览，保存后保留；放弃会恢复原设置。</p><button type="button" class="btn ghost" data-appearance-reset>恢复默认草稿</button><p class="control-form-error" role="alert"></p><div class="settings-unsaved-bar" hidden><span role="status" aria-live="polite">有未保存的修改</span><div><button type="button" class="btn ghost" data-appearance-discard>放弃修改</button><button type="submit" class="btn">保存修改</button></div></div></form>`;
    const form = q("form", body),
      appearance = window.workbenchAppearance,
      identity = user.username;
    const fields = {
      theme: q("#appearance-theme", root),
      uiFontSize: q("#appearance-font", root),
      accent: q("#appearance-accent", root),
      brightness: q("#appearance-brightness", root),
      reduceMotion: q("#appearance-motion", root),
      interfaceMode: q("#interface-mode", root),
      locale: q("#menu-locale", root),
    };
    let saved = {
        theme: appearance.theme,
        uiFontSize:
          parseInt(
            getComputedStyle(document.documentElement).getPropertyValue(
              "--ui-font-size",
            ),
          ) || 14,
        accent: data.config.accent || "blue",
        brightness: data.config.brightness || 100,
        reduceMotion: !!data.config.reduceMotion,
        interfaceMode: data.config.interfaceMode || "office",
        locale: data.config.locale || "zh-CN",
      },
      busy = false;
    const read = () =>
      Object.fromEntries(
        Object.entries(fields).map(([key, field]) => [
          key,
          field.type === "checkbox"
            ? field.checked
            : ["uiFontSize", "brightness"].includes(key)
              ? Number(field.value)
              : field.value,
        ]),
      );
    const dirty = () =>
      Object.keys(saved).some((key) => read()[key] !== saved[key]);
    const preview = (value, origin) => {
      appearance.previewTheme(value.theme, origin);
      appearance.previewFontSize(value.uiFontSize);
      appearance.details(value);
    };
    const syncControls = () => {
      qa("[name=appearanceTheme]", form).forEach(
        (r) => (r.checked = r.value === fields.theme.value),
      );
      qa("[data-font-step]", form).forEach(
        (b) =>
          (b.disabled =
            Number(fields.uiFontSize.value) + Number(b.dataset.fontStep) < 12 ||
            Number(fields.uiFontSize.value) + Number(b.dataset.fontStep) > 18),
      );
      q("[data-brightness]", form).textContent = fields.brightness.value + "%";
      window.WorkbenchUI.refreshControls?.(form);
    };
    const show = (value) => {
      Object.entries(fields).forEach(([key, field]) => {
        if (field.type === "checkbox") field.checked = value[key];
        else field.value = value[key];
        delete field.dataset.wbDirty;
      });
      syncControls();
    };
    const update = () => {
      q(".settings-unsaved-bar", form).hidden = !dirty() && !busy;
      q("[type=submit]", form).disabled = busy;
      q("[data-appearance-discard]", form).disabled = busy;
      q("[role=status]", form).textContent = busy
        ? "正在保存…"
        : "有未保存的修改";
    };
    show(saved);
    root._wbUnsaved = dirty;
    root._wbDispose = () => preview(saved);
    const change = (event) => {
      if (event.target.name === "appearanceTheme")
        fields.theme.value = event.target.value;
      fields.uiFontSize.value = String(
        Math.max(12, Math.min(18, Number(fields.uiFontSize.value) || 14)),
      );
      syncControls();
      preview(read(), event.target.closest(".dsh-theme-cube"));
      update();
    };
    form.onchange = change;
    fields.brightness.oninput = change;
    qa("[data-font-step]", form).forEach(
      (b) =>
        (b.onclick = () => {
          fields.uiFontSize.value = String(
            Number(fields.uiFontSize.value) + Number(b.dataset.fontStep),
          );
          fields.uiFontSize.dispatchEvent(
            new Event("change", { bubbles: true }),
          );
        }),
    );
    q("[data-appearance-discard]", form).onclick = () => {
      show(saved);
      preview(saved);
      q("[role=alert]", form).textContent = "";
      update();
    };
    q("[data-appearance-reset]", form).onclick = () => {
      show({
        theme: "zai-light",
        uiFontSize: 14,
        accent: "blue",
        brightness: 100,
        reduceMotion: false,
        interfaceMode: "office",
        locale: "zh-CN",
      });
      preview(read());
      update();
    };
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (busy || !dirty()) return;
      const submitted = read();
      busy = true;
      update();
      q("[role=alert]", form).textContent = "";
      try {
        await call("POST", "/api/control/config", submitted);
        if (!root.isConnected || user?.username !== identity) return;
        const editing = read();
        saved = submitted;
        appearance.config(saved);
        preview(editing);
        await load();
        if (root.isConnected && user?.username === identity) {
          applyMode();
          toast("外观设置已保存", {kind:"success"});
        }
      } catch (error) {
        if (root.isConnected && user?.username === identity)
          q("[role=alert]", form).textContent = error.message;
      } finally {
        busy = false;
        if (root.isConnected) update();
      }
    };
  }
  function applyMode() {
    document.documentElement.dataset.interfaceMode =
      data?.config.interfaceMode || "office";
    q("#shell-page")?.setAttribute(
      "title",
      data?.config.interfaceMode === "coding" ? "编程工作模式" : "办公工作模式",
    );
  }
  function providers(root) {
    const body = viewHeader(
      root,
      "模型服务",
      "兼容 Chat Completions 的服务商，密钥只保存在当前账号的服务端。",
      button("添加服务", "provider-add", false),
    );
    const draw = () => {
      if (!body.isConnected) return;
      paint(
        body,
        data.providers.length
          ? `<div class="resource-list">${data.providers.map((p) => `<article class="resource-row" data-id="${e(p.id)}"><div class="resource-icon">API</div><div class="resource-details"><h3>${e(p.name)} ${data.config.defaultProvider === p.id ? '<span class="control-badge">默认</span>' : ""}</h3><p>${e(p.model)} · ${e(p.baseUrl)}</p><small>${p.configured ? "密钥已配置" : "尚未配置密钥"} · ${p.enabled ? "启用" : "停用"} · ${p.rates && Object.keys(p.rates).length ? "已设置估算单价" : "未设置单价"}</small></div><div class="resource-actions"><button class="btn ghost" data-provider-default="${e(p.id)}">设为默认</button><button class="btn ghost" data-provider-test="${e(p.id)}">测试连接</button><button class="btn ghost" data-provider-edit="${e(p.id)}">编辑</button><button class="btn ghost" data-provider-delete="${e(p.id)}">删除</button></div></article>`).join("")}</div>`
          : blank("添加模型服务后，可用于提示词评估、优化与待办识别。"),
      );
      qa("[data-provider-edit]", body).forEach(
        (b) =>
          (b.onclick = () =>
            edit(data.providers.find((p) => p.id === b.dataset.providerEdit))),
      );
      qa("[data-provider-default]", body).forEach(
        (b) =>
          (b.onclick = () =>
            action(async () => {
              await call("POST", "/api/control/config", {
                defaultProvider: b.dataset.providerDefault,
              });
              await load();
              draw();
            })),
      );
      qa("[data-provider-test]", body).forEach(
        (b) =>
          (b.onclick = () =>
            action(async () => {
              b.disabled = true;
              try {
                const r = await call("POST", "/api/control/provider/test", {
                  id: b.dataset.providerTest,
                });
                if (!body.isConnected) return;
                showResult(
                  "服务连接成功",
                  r.models.join("\n") || "连接成功，服务未提供模型列表。",
                );
              } finally {
                b.disabled = false;
              }
            })),
      );
      qa("[data-provider-delete]", body).forEach(
        (b) =>
          (b.onclick = () =>
            action(async () => {
              if (!confirm("删除此服务配置与密钥？")) return;
              await call("POST", "/api/control/provider", {
                id: b.dataset.providerDelete,
                delete: true,
              });
              await load();
              draw();
            })),
      );
      qa(".resource-actions button", body).forEach((b) => {
        const handler = b.onclick;
        b.disabled = !!b._wbPending;
        b.onclick = async (event) => {
          if (b._wbPending) return;
          b._wbPending = true;
          b.disabled = true;
          try {
            return await handler(event);
          } finally {
            b._wbPending = false;
            b.disabled = false;
          }
        };
      });
    };
    const edit = (p = {}) =>
      dialog(
        p.id ? "编辑模型服务" : "添加模型服务",
        `<div class="control-form-grid">${field("name", "服务商名称", p.name || "")}${field("model", "模型名称", p.model || "")}${field("baseUrl", "API 地址（至 /v1）", p.baseUrl || "")}${field("apiKey", p.configured ? "API Key（留空保留）" : "API Key", "", "password")}</div><details><summary>设置费用估算单价（每百万 Token）</summary><p class="meta">按你实际套餐填写。未填写时不估算费用。</p><div class="control-form-grid">${field("input", "普通输入", p.rates?.input ?? "", "number")}${field("output", "输出", p.rates?.output ?? "", "number")}${field("cached", "缓存输入", p.rates?.cached ?? "", "number")}<label class="control-field">币种<select name="currency"><option>CNY</option><option ${p.rates?.currency === "USD" ? "selected" : ""}>USD</option></select></label></div></details><label class="control-checkbox"><input name="enabled" type="checkbox" ${p.enabled !== false ? "checked" : ""}>启用服务</label>`,
        async (f) => {
          const rates =
            f.input !== "" && f.output !== "" && f.cached !== ""
              ? {
                  input: Number(f.input),
                  output: Number(f.output),
                  cached: Number(f.cached),
                  currency: f.currency,
                }
              : {};
          await call("POST", "/api/control/provider", {
            ...f,
            id: p.id,
            enabled: f.enabled === "on",
            rates,
          });
          await load();
          draw();
          toast("模型服务已保存", {kind:"success"});
        },
      );
    q("#provider-add", root).onclick = () => edit();
    draw();
  }
  function saveForm(form, save) {
    form.onsubmit = async (event) => {
      event.preventDefault();
      const button = q("button", form);
      if (button.disabled) return;
      button.disabled = true;
      const fields = qa("input,textarea,select", form).map((el) => ({
        el,
        value: el.value,
        checked: el.checked,
      }));
      try {
        await save();
        if (form.isConnected) {
          fields.forEach(({ el, value, checked }) => {
            if (el.value === value && el.checked === checked)
              delete el.dataset.wbDirty;
          });
          toast("设置已保存", {kind:"success"});
        }
      } catch (error) {
        if (form.isConnected && error.name !== "AbortError")
          toast(error.message, {kind:"error"});
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    };
  }
  function shortcuts(root) {
    const body = viewHeader(root, "快捷键", "搜索、侧边栏和设置的组合键。"),
      defaults = { search: "Ctrl+K", sidebar: "Ctrl+B", settings: "Ctrl+," },
      values = { ...defaults, ...data.config.shortcuts };
    body.innerHTML = `<form id="shortcut-form" class="control-section">${Object.entries(
      values,
    )
      .map(([key, value]) =>
        field(
          key,
          {
            search: "搜索与跳转",
            sidebar: "收起 / 展开侧边栏",
            settings: "打开设置",
          }[key],
          value,
        ),
      )
      .join(
        "",
      )}<p class="meta">使用不重复的 Ctrl 或 Meta 组合键。</p><div class="wb-save-state"><span>修改后保存</span><button class="btn">保存快捷键</button></div></form>`;
    saveForm(q("form", body), async () => {
      const next = Object.fromEntries(new FormData(q("form", body)));
      if (
        Object.values(next).some((v) => !/^(Ctrl|Meta)\+[a-zA-Z,]$/.test(v)) ||
        new Set(Object.values(next).map((v) => v.toLowerCase())).size !== 3
      )
        throw new Error("请使用不重复的 Ctrl/Meta 组合键");
      await call("POST", "/api/control/config", { shortcuts: next });
      await load();
    });
  }
  function reveal(root) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    [...root.children].forEach((el, i) => {
      el.getAnimations().forEach((a) => a.cancel());
      el.animate(
        [
          { opacity: 0, transform: "translateY(12px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        {
          duration: 260,
          delay: Math.min(i, 5) * 24,
          easing: "cubic-bezier(.2,.7,.3,1)",
        },
      );
    });
  }
  function usageIcon(id) {
    if (id === "codex")
      return '<span class="brand-knot usage-tab-icon" aria-hidden="true"><img class="brand-knot-light" src="assets/openai-blossom-black.svg" alt=""><img class="brand-knot-dark" src="assets/openai-blossom-white.svg" alt=""></span>';
    return id === "zcode"
      ? '<svg class="usage-tab-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 5h16L4 19h16" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg class="usage-tab-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  async function usage(root) {
    clearInterval(usageTimer);
    let valueCurrency =
      window.wbLayoutStorage.getItem("wb-usage-value-currency") || "USD";
    if (!["USD", "CNY"].includes(valueCurrency)) valueCurrency = "USD";
    let scope = window.wbLayoutStorage.getItem("wb-usage-scope") || "codex",
      connections = [],
      generation = 0,
      paintedKey = "",
      scheduled;
    const cache = new Map(),
      inflight = new Map(),
      controllers = new Map(),
      cacheVersions = new Map(),
      filters = new Map(),
      putCache = (key, value) => {
        const kind = new URLSearchParams(key).get("scope"),
          version = [value.dataVersion, value.valuation?.priceVersion].join(
            ":",
          );
        const priorVersion = (cacheVersions.get(kind) || "")
            .split(":")
            .map(Number),
          nextVersion = version.split(":").map(Number);
        if (
          Number.isFinite(nextVersion[0]) &&
          Number.isFinite(priorVersion[0]) &&
          (nextVersion[0] < priorVersion[0] || nextVersion[1] < priorVersion[1])
        )
          return false;
        if (!value.warming && cacheVersions.get(kind) !== version) {
          for (const old of cache.keys())
            if (new URLSearchParams(old).get("scope") === kind)
              cache.delete(old);
          cacheVersions.set(kind, version);
        }
        cache.delete(key);
        cache.set(key, value);
        while (cache.size > 32) cache.delete(cache.keys().next().value);
      };
    let accountsGeneration = 0;
    if (!["codex", "zcode", "dsh", "api"].includes(scope)) scope = "codex";
    window.usageCharts.track(root, () => {
      generation++;
      accountsGeneration++;
      controllers.forEach((c) => c.abort());
      controllers.clear();
      inflight.clear();
      clearTimeout(scheduled);
      clearInterval(usageTimer);
      usageTimer = null;
    });
    root.classList.add("usage-stable");
    root.innerHTML = `<div class="usage-tabs"><div class="usage-tab-list" role="tablist" aria-label="用量来源">${[
      ["codex", "Codex"],
      ["zcode", "ZCode"],
      ["dsh", "DeepSeek Harness"],
      ["api", "API供应商"],
    ]
      .map(
        ([id, name]) =>
          `<button class="btn ${id === scope ? "" : "ghost"}" role="tab" id="usage-tab-${id}" aria-controls="usage-panel" aria-selected="${id === scope}" data-usage-tab="${id}">${usageIcon(id)}<span>${name}</span></button>`,
      )
      .join(
        "",
      )}</div><button type="button" class="btn ghost usage-manage-button" id="usage-account-add">管理API供应商</button></div><div class="usage-surface" id="usage-panel" role="tabpanel"><div class="usage-account-slot" data-open="false"><div id="usage-accounts"></div></div><div class="usage-toolbar"><label>时间范围<select id="usage-days">${[
      [7, "近 7 天"],
      [30, "近 30 天"],
      [90, "近 90 天"],
      [366, "近一年"],
    ]
      .map(
        ([n, t]) =>
          `<option value="${n}" ${n === 30 ? "selected" : ""}>${t}</option>`,
      )
      .join(
        "",
      )}</select></label><label class="usage-source-slot"><span id="usage-source-label">来源</span><select id="usage-source"><option value="">全部</option></select><span class="usage-account-select" hidden><img class="usage-provider-logo" alt="" hidden><select id="usage-account"><option value="">选择连接</option></select></span></label>${["provider", "project", "model"].map((k) => `<label>${{ provider: "服务商", model: "模型", project: "工作区" }[k]}<select id="usage-${k}"><option value="">全部</option></select></label>`).join("")}</div><div id="usage-body"></div><section class="control-section usage-connect"><label class="control-field">日志目录<input id="codex-path"></label><div class="control-actions">${button("连接日志", "codex-connect", false)}${button("断开", "codex-disconnect")}</div><p id="usage-sync-result" class="meta"></p></section></div>`;
    const body = q("#usage-body", root),
      accounts = q("#usage-accounts", root);
    window.usageView.init(body);
    window.workbenchUI?.sortable(
      q(".usage-tab-list", root),
      "[data-usage-tab]",
      "wb-usage-order",
    );
    const select = (k) => q("#usage-" + k, root);
    const modelFilter = window.usageFilters.models(
      root,
      select("model"),
      () => {
        remember();
        request();
      },
      () => "wb-usage-models:" + scope,
    );
    const dateFilter = window.usageFilters.range(root, () => request()),
      keyFilter = window.usageFilters.keys(root, () => {
        remember();
        request();
      });
    const keySlot = document.createElement("label");
    keySlot.className = "usage-key-slot";
    keySlot.hidden = true;
    keySlot.append(document.createTextNode("APIKey"), keyFilter.shell);
    select("provider").closest("label").after(keySlot);
    const query = () => {
      const params = new URLSearchParams({ scope, ...dateFilter.params() });
      if (scope !== "api") params.set("value_currency", valueCurrency);
      if (scope === "codex") params.set("source", "codex");
      ["source", "provider", "project"].forEach((k) => {
        if (scope === "api" && ["source", "project", "provider"].includes(k))
          return;
        const v = select(k).value;
        if (v && !(scope === "codex" && k === "source")) params.set(k, v);
      });
      modelFilter
        .get()
        .slice()
        .sort()
        .forEach((model) => params.append("models", model));
      if (scope === "api") {
        params.set("supplier", select("account").value);
        if (keyFilter.get().length)
          params.set("connection_ids", keyFilter.get().join(","));
      }
      return params;
    };
    const paint = (result, key) => {
      const bindingStarted = performance.now();
      ["source", "provider", "model", "project"].forEach((k) =>
        window.usageView.options(
          select(k),
          (result.options[k] || []).filter(
            (v) => k !== "source" || v !== "official",
          ),
          "全部",
        ),
      );
      modelFilter.update(result.options.model || []);
      if (
        scope === "codex" &&
        result.dataSource?.kind === "local-logs" &&
        !select("source").value
      )
        select("source").value = "codex";
      remember();
      drawUsage(body, result);
      body.dataset.bindingMs = (performance.now() - bindingStarted).toFixed(3);
      paintedKey = key;
      body.dataset.snapshotKey = key;
      if (key !== query().toString()) request();
    };
    const showCached = () => {
      const key = query().toString(),
        cached = cache.get(key);
      if (cached && paintedKey !== key) paint(cached, key);
    };
    const update = async () => {
      clearTimeout(scheduled);
      const ticket = ++generation,
        key = query().toString();
      showCached();
      if (ticket !== generation) return;
      body.setAttribute("aria-busy", "true");
      try {
        let pending = inflight.get(key);
        if (!pending) {
          const controller = new AbortController();
          controllers.set(key, controller);
          pending = call("GET", "/api/usage?" + key, undefined, {
            signal: controller.signal,
          });
          inflight.set(key, pending);
          const current = pending;
          pending
            .finally(() => {
              if (inflight.get(key) === current) {
                inflight.delete(key);
                controllers.delete(key);
              }
            })
            .catch(() => {});
        }
        const result = await pending;
        if (!body.isConnected) return;
        const previous = cache.get(key);
        if (putCache(key, result) === false) {
          if (ticket === generation)
            scheduled = setTimeout(() => {
              if (body.isConnected) update();
            }, 250);
          return;
        }
        if (ticket !== generation) return;
        if (
          paintedKey !== key ||
          !previous ||
          JSON.stringify({ ...previous, updatedAt: null }) !==
            JSON.stringify({ ...result, updatedAt: null })
        )
          paint(result, key);
        if (result.warming)
          scheduled = setTimeout(() => {
            if (ticket === generation && body.isConnected) update();
          }, 250);
      } catch (err) {
        if (ticket === generation && body.isConnected) toast(err.message, {kind:"error"});
      } finally {
        if (ticket === generation) body.setAttribute("aria-busy", "false");
      }
    };
    const request = () => {
      generation++;
      const next = query().toString();
      for (const [key, controller] of controllers)
        if (key !== next) {
          controller.abort();
          controllers.delete(key);
          inflight.delete(key);
        }
      clearTimeout(scheduled);
      showCached();
      scheduled = setTimeout(() => {
        if (body.isConnected) update();
      }, 0);
    };
    const groupRows = () =>
      connections.filter(
        (c) =>
          c.kind !== "codex" &&
          window.usageFilters.supplierId(c) === select("account").value,
      );
    const refreshAccounts = async (preferred) => {
      const ticket = ++accountsGeneration;
      accounts.dataset.scope = "codex";
      const next =
        (await window.usageAccounts.render(
          accounts,
          "codex",
          data.providers || [],
          refreshAccounts,
          Number(select("days").value) || 30,
        )) || [];
      if (ticket !== accountsGeneration || !body.isConnected)
        return connections;
      connections = next;
      const account = select("account"),
        prior =
          account.value || window.wbLayoutStorage.getItem("wb-usage-supplier"),
        available = connections.filter((c) => c.kind !== "codex"),
        groups = [
          ...new Map(
            available.map((c) => [
              window.usageFilters.supplierId(c),
              {
                id: window.usageFilters.supplierId(c),
                name:
                  c.kind === "deepseek"
                    ? "DeepSeek"
                    : c.kind === "glm"
                      ? "GLM"
                      : c.kind === "lmu"
                        ? "LMU"
                        : window.usageProviders?.[c.kind]?.name ||
                          c.supplierName ||
                          new URL(c.apiUrl).hostname,
              },
            ]),
          ).values(),
        ];
      const signature = JSON.stringify(groups);
      if (account.dataset.optionsKey !== signature) {
        account.innerHTML = groups
          .map((g) => `<option value="${e(g.id)}">${e(g.name)}</option>`)
          .join("");
        account.dataset.optionsKey = signature;
      }
      const preferredRow = available.find((c) => c.id === preferred),
        preferredGroup =
          preferredRow && window.usageFilters.supplierId(preferredRow);
      account.value = groups.some((g) => g.id === preferredGroup)
        ? preferredGroup
        : groups.some((g) => g.id === prior)
          ? prior
          : groups[0]?.id || "";
      if (account.value)
        window.wbLayoutStorage.setItem("wb-usage-supplier", account.value);
      keyFilter.update(groupRows());
      accountLogo();
      await update();
      return connections;
    };
    const accountLogo = () => {
      const img = q(".usage-provider-logo", root),
        kind = groupRows()[0]?.kind,
        src = {
          deepseek: "assets/deepseek-logo.svg",
          glm: "assets/glm-logo.png",
        }[kind];
      img.hidden = !src;
      if (src) {
        img.src = src;
        img.alt = kind === "glm" ? "GLM" : "DeepSeek";
      }
    };
    const sync = async (local) => {
      const result = await call(
        "POST",
        local === "codex" ? "/api/usage/sync" : "/api/usage/" + local + "/sync",
        {},
      );
      if (body.isConnected && scope === local)
        q("#usage-sync-result", root).textContent =
          `${result.imported} 条新增${result.corrected ? " · " + result.corrected + " 条历史重算" : result.updated ? " · " + result.updated + " 条更新" : ""}${result.errors.length ? " · " + result.errors.length + " 个读取问题" : ""}`;
    };
    const configure = () => {
      root.dataset.usageScope = scope;
      body.dataset.usageScope = scope;
      window.usageAccounts.scope?.(accounts);
      const slot = q(".usage-account-slot", root);
      slot.dataset.open = String(scope === "codex");
      slot.inert = scope !== "codex";
      slot.setAttribute("aria-hidden", String(scope !== "codex"));
      q("#usage-panel", root).setAttribute(
        "aria-labelledby",
        "usage-tab-" + scope,
      );
      qa("[data-usage-tab]", root).forEach((b) => {
        const selected = b.dataset.usageTab === scope;
        b.setAttribute("aria-selected", String(selected));
        b.tabIndex = selected ? 0 : -1;
        b.classList.toggle("ghost", !selected);
      });
      select("source").hidden = scope === "api";
      q(".usage-account-select", root).hidden = scope !== "api";
      select("project").closest("label").hidden = scope === "api";
      q(".usage-connect", root).hidden = scope === "api";
      accountLogo();
      q("#usage-source-label", root).textContent =
        scope === "api" ? "供应商" : "来源";
      select("provider").closest("label").hidden = scope === "api";
      keySlot.hidden = scope !== "api";
      select("project").disabled = scope === "api";
      const local = scope === "api" ? "codex" : scope;
      q("#codex-path", root).value =
        data.config[local + "Path"] ||
        data[
          {
            codex: "defaultCodexPath",
            zcode: "defaultZcodePath",
            dsh: "defaultDshPath",
          }[local]
        ] ||
        "";
      q("#codex-path", root).disabled = scope === "api";
      q("#codex-connect", root).textContent = data.config[local + "Enabled"]
        ? "同步日志"
        : "连接日志";
      q("#codex-connect", root).disabled = q(
        "#codex-disconnect",
        root,
      ).disabled = scope === "api";
      q("#usage-sync-result", root).textContent = "";
    };
    const remember = () => {
      filters.set(
        scope,
        Object.fromEntries(
          ["source", "provider", "model", "project", "account"].map((k) => [
            k,
            select(k).value,
          ]),
        ),
      );
      if (scope === "api" && select("account").value)
        window.wbLayoutStorage.setItem(
          "wb-usage-supplier",
          select("account").value,
        );
      filters.get(scope).keys = keyFilter.get();
      filters.get(scope).models = modelFilter.get();
    };
    qa("[data-usage-tab]", root).forEach(
      (tab) =>
        (tab.onclick = () => {
          if (scope === tab.dataset.usageTab) return;
          remember();
          scope = tab.dataset.usageTab;
          window.wbLayoutStorage.setItem("wb-usage-scope", scope);
          const saved = filters.get(scope) || {};
          ["source", "provider", "model", "project"].forEach((k) => {
            const v = saved[k] || "";
            window.usageView.options(select(k), v ? [v] : []);
            select(k).value = v;
          });
          modelFilter.load();
          modelFilter.set(saved.models || modelFilter.get());
          if (
            saved.account &&
            [...select("account").options].some(
              (o) => o.value === saved.account,
            )
          )
            select("account").value = saved.account;
          keyFilter.update(groupRows());
          keyFilter.set(saved.keys || []);
          configure();
          request();
        }),
    );
    q(".usage-tab-list", root).onkeydown = (event) => {
      const tabs = qa("[data-usage-tab]", root),
        index = tabs.indexOf(event.target);
      if (
        index < 0 ||
        !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
      )
        return;
      event.preventDefault();
      const next =
        tabs[
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
                tabs.length
        ];
      next.click();
      next.focus({ preventScroll: true });
    };
    qa(".usage-toolbar select", root).forEach(
      (control) =>
        (control.onchange = () => {
          if (control.id === "usage-account") {
            ["provider", "model"].forEach((k) => (select(k).value = ""));
            keyFilter.update(groupRows());
            keyFilter.set([]);
            accountLogo();
          }
          if (
            scope === "codex" &&
            control.id === "usage-source" &&
            control.value !== "codex"
          ) {
            modelFilter.set([]);
            select("provider").value = "";
            select("project").value = "";
          }
          remember();
          request();
        }),
    );
    q("#codex-connect", root).onclick = () =>
      action(async () => {
        if (scope === "api") return;
        const local = scope,
          b = q("#codex-connect", root);
        b.disabled = true;
        try {
          await call("POST", "/api/control/config", {
            [local + "Enabled"]: true,
            [local + "Path"]: q("#codex-path", root).value,
          });
          await load();
          await sync(local);
          if (scope === local) {
            configure();
            await update();
          }
        } finally {
          b.disabled = scope === "api";
        }
      });
    q("#codex-disconnect", root).onclick = () =>
      action(async () => {
        if (scope === "api") return;
        const local = scope;
        await call("POST", "/api/control/config", {
          [local + "Enabled"]: false,
        });
        await load();
        configure();
      });
    body.addEventListener("usage-value-currency", (event) => {
      if (
        scope === "api" ||
        !["USD", "CNY"].includes(event.detail) ||
        valueCurrency === event.detail
      )
        return;
      valueCurrency = event.detail;
      window.wbLayoutStorage.setItem("wb-usage-value-currency", valueCurrency);
      request();
    });
    body.addEventListener("usage-value-refresh", () => {
      cache.clear();
      request();
    });
    const featureChange = (event) => {
      if (!body.isConnected) return;
      generation++;
      controllers.forEach((c) => c.abort());
      controllers.clear();
      inflight.clear();
      cache.clear();
      cacheVersions.clear();
      paintedKey = "";
      window.usageView.policy(body, event.detail);
      request();
    };
    window.addEventListener("workbench:features", featureChange);
    window.usageCharts.track(root, () =>
      window.removeEventListener("workbench:features", featureChange),
    );
    configure();
    await refreshAccounts();
    if (!body.isConnected) return;
    const warmDates = dateFilter.params(),
      warmAccount = select("account").value;
    ["codex", "zcode", "dsh", "api"]
      .filter((x) => x !== scope)
      .forEach((x) => {
        const params = new URLSearchParams({ scope: x, ...warmDates });
        if (x !== "api") params.set("value_currency", valueCurrency);
        if (x === "codex") params.set("source", "codex");
        if (x === "api" && warmAccount) params.set("supplier", warmAccount);
        const key = params.toString();
        call("GET", "/api/usage?" + key)
          .then((result) => {
            if (!cache.has(key)) putCache(key, result);
          })
          .catch(() => {});
      });
    const timer = setInterval(() => {
      if (!body.isConnected) {
        clearInterval(timer);
        clearTimeout(scheduled);
        return;
      }
      action(async () => {
        const local = scope;
        cache.clear();
        if (local !== "api" && data.config[local + "Enabled"])
          await sync(local);
        if (local === scope) await refreshAccounts();
      });
    }, 30000);
    usageTimer = timer;
  }
  function drawUsage(root, s) {
    window.usageView.update(root, s);
  }
  let profilePopover = null, profileMenuOwner = null;
  function hideProfileMenu(restore = false) {
    const trigger=document.getElementById("control-profile");
    if(profilePopover?.matches(":popover-open"))profilePopover.hidePopover();
    profilePopover?.classList.remove("is-open");
    trigger?.setAttribute("aria-expanded","false");
    if(restore)trigger?.focus({preventScroll:true});
  }
  function positionProfileMenu() {
    const trigger=document.getElementById("control-profile"),side=trigger?.closest(".side");
    if(!trigger||!side||!profilePopover)return;
    const box=trigger.getBoundingClientRect(),column=side.getBoundingClientRect();
    const width=Math.min(Math.max(200,column.width-16),innerWidth-16);
    profilePopover.style.width=width+"px";
    profilePopover.style.left=Math.max(8,Math.min(column.left+8,innerWidth-width-8))+"px";
    profilePopover.style.top=Math.max(8,box.top-profilePopover.offsetHeight-8)+"px";
  }
  function profileMenu() {
    if(!user)return;
    const trigger=document.getElementById("control-profile");
    if(profilePopover?.classList.contains("is-open")){hideProfileMenu(true);return;}
    if(!profilePopover){
      profilePopover=document.createElement("div");profilePopover.id="lingxi-profile-menu";
      profilePopover.className="lingxi-profile-popover";profilePopover.setAttribute("role","menu");
      profilePopover.setAttribute("aria-label","个人资料与工作台");
      if(typeof profilePopover.showPopover==="function")profilePopover.setAttribute("popover","auto");
      document.body.append(profilePopover);
      profilePopover.addEventListener("toggle",event=>{if(event.newState==="closed"){profilePopover.classList.remove("is-open");trigger?.setAttribute("aria-expanded","false");}});
      document.addEventListener("pointerdown",event=>{if(profilePopover?.classList.contains("is-open")&&!profilePopover.contains(event.target)&&!trigger.contains(event.target))hideProfileMenu();});
      document.addEventListener("keydown",event=>{if(!profilePopover?.classList.contains("is-open"))return;if(event.key==="Escape"){event.preventDefault();hideProfileMenu(true);return;}if(["ArrowDown","ArrowUp","Home","End"].includes(event.key)){event.preventDefault();const items=[...profilePopover.querySelectorAll('[role="menuitem"]')],index=items.indexOf(document.activeElement);items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}});
      window.addEventListener("resize",positionProfileMenu);
      window.addEventListener("hashchange",()=>hideProfileMenu());
    }
    profileMenuOwner=user.username;
    const name=state.settings.display_name||user.display_name||"个人资料",avatar=trigger.querySelector("img")?.src||"";
    profilePopover.innerHTML=window.LingxiDesign.profileMenuMarkup(name,avatar);
    profilePopover.querySelector("[data-profile-switch]").onclick=()=>{hideProfileMenu(true);window.LingxiDesign.selectProfile();};
    profilePopover.querySelector("[data-profile-identity]").onclick=()=>{hideProfileMenu(true);location.hash="#/settings/general";};
    profilePopover.querySelectorAll("a").forEach(a=>a.addEventListener("click",()=>hideProfileMenu(true)));
    trigger.setAttribute("aria-haspopup","menu");trigger.setAttribute("aria-controls",profilePopover.id);trigger.setAttribute("aria-expanded","true");
    if(profilePopover.hasAttribute("popover"))profilePopover.showPopover();
    profilePopover.classList.add("is-open");positionProfileMenu();
    profilePopover.querySelector('[role="menuitem"]')?.focus({preventScroll:true});
  }
  window.addEventListener("workbench:state",event=>{if(profileMenuOwner&&event.detail?.user?.username!==profileMenuOwner){hideProfileMenu();profileMenuOwner=null;}});
  window.lingxiProfileMenu = profileMenu;
  function installMenus() {
    const nav = q("#nav");
    if (!nav || q("#usage-nav")) return;
    const items = [
      ["usage", "用量监测"],
      ["prompts", "提示词管理"],
      ["skills", "技能管理"],
    ];
    items.forEach(([view, text]) => {
      const a = document.createElement("a");
      a.id = view + "-nav";
      a.href = "#/" + view;
      a.dataset.view = view;
      a.className = "nav-item";
      a.innerHTML = `<span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8m-8 4h8m-8 4h5"/></svg></span><span>${text}</span>`;
      nav.insertBefore(a, q("[data-view=settings]", nav));
    });
    const foot = q(".side-foot"),
      profile = document.createElement("button");
    profile.id = "control-profile";
    profile.type = "button";
    profile.className = "profile-trigger";
    profile.textContent = "Profile 与设置";
    profile.onclick = () => (location.hash = "#/settings/general");
    foot.prepend(profile);
    const menus = document.createElement("div");
    menus.className = "workbench-menubar";
    menus.innerHTML =
      '<details><summary>文件</summary><div class="workbench-menu"><a href="#/prompts">提示词库</a><a href="#/settings/data">导入 / 导出 / 备份</a></div></details><details><summary>编辑</summary><div class="workbench-menu"><button data-menu="search">搜索与跳转</button><a href="#/skills">本地技能</a></div></details><details><summary>视图</summary><div class="workbench-menu"><button data-menu="sidebar">收起 / 展开侧边栏</button><button data-menu="theme">切换主题</button><button data-menu="zoom-reset">实际大小</button><a href="#/settings/appearance">界面设置</a></div></details><details><summary>帮助</summary><div class="workbench-menu"><a href="#/settings/shortcuts">快捷键</a><a href="preview.html">设计预览</a></div></details>';
    q(".shell-bar").insertBefore(menus, q("#theme-toggle"));
    qa("[data-menu]", menus).forEach(
      (b) =>
        (b.onclick = (event) => {
          if (b.dataset.menu === "search") q("#command-trigger")?.click();
          if (b.dataset.menu === "sidebar") q("#sidebar-toggle").click();
          if (b.dataset.menu === "theme")
            window.workbenchAppearance.setTheme(
              document.documentElement.dataset.theme === "dark"
                ? "light"
                : "dark",
              event,
            );
          if (b.dataset.menu === "zoom-reset") setPageZoom(100);
          qa("details", menus).forEach((d) => (d.open = false));
        }),
    );
    document.addEventListener("click", (event) => {
      if (!menus.contains(event.target))
        qa("details", menus).forEach((d) => (d.open = false));
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape")
        qa("details", menus).forEach((d) => (d.open = false));
    });
  }
  window.controlCenter = {
    dispose: () => {
      clearInterval(usageTimer);
      usageTimer = null;
    },
    sections,
    settings,
    usage: async (root) => {
      await load();
      if (root.isConnected && user) await usage(root);
    },
    profileMenu,
  };
  onReady(() => {
    installMenus();
    setInterval(refreshFooter, 60000);
  });
  window.addEventListener("workbench:state", (event) => {
    const next = event.detail.user?.username;
    if (!next) {
      clearInterval(usageTimer);
      owner = "";
      data = null;
      window.workbenchControlData = null;
      return;
    }
    if (next !== owner)
      action(async () => {
        await load();
        applyMode();
      });
  });
})();
