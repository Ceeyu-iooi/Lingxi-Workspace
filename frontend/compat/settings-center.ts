// @ts-nocheck
// Compatibility controller: retain the validated interactions during the React migration.
/* Keep the current module mounted while its account-scoped settings are open. */
(() => {
  let dialog = null,
    baseHash = "#/overview",
    focus = null,
    identity = null;
  const content = () => dialog?.querySelector(".settings-center-content");
  const dirty = () =>
    !!content()?.querySelector("#settings-panel")?._wbUnsaved?.();
  function close(restore = true, force = false) {
    if (!dialog) return true;
    if (!force && dirty() && !confirm("设置修改尚未保存，关闭窗口？"))
      return false;
    const d = dialog;
    dialog = null;
    window.workbenchDesign?.dispose(contentFor(d));
    window.usageCharts?.dispose(d);
    d._settingsAbort?.abort();
    d.close();
    d.remove();
    if (restore && location.hash.startsWith("#/settings"))
      history.replaceState(null, "", baseHash);
    if (focus?.isConnected) focus.focus({ preventScroll: true });
    identity = null;
    return true;
  }
  const contentFor = (d) => d.querySelector(".settings-center-content");
  function open(renderer, returnHash) {
    if (typeof user === "undefined" || !user) return Promise.resolve();
    if (dialog && identity !== user.username) close(false, true);
    if (
      dialog &&
      dialog.dataset.settingsRoute !== location.hash &&
      dirty() &&
      !confirm("设置修改尚未保存，切换设置页？")
    ) {
      history.replaceState(null, "", dialog.dataset.settingsRoute);
      return Promise.resolve();
    }
    if (!dialog) {
      identity = user.username;
      baseHash =
        returnHash && !returnHash.startsWith("#/settings")
          ? returnHash
          : "#/overview";
      focus = document.activeElement;
      const d = document.createElement("dialog");
      d.className = "control-dialog wb-redesign settings-center-modal";
      d.id = "settings-center-dialog";
      d.setAttribute("aria-label", "设置中心");
      d.innerHTML =
        '<header class="settings-center-head"><h2>设置中心</h2><button type="button" class="btn ghost" aria-label="关闭设置中心">×</button></header><div class="settings-center-content module-surface wb-redesign"></div>';
      d._settingsAbort = new AbortController();
      contentFor(d)._wbAbort = d._settingsAbort;
      d.addEventListener("input", (e) => {
        if (e.target.matches("input,textarea,select"))
          e.target.dataset.wbDirty = "true";
      });
      d.addEventListener("change", (e) => {
        if (e.target.matches("input,textarea,select"))
          e.target.dataset.wbDirty = "true";
      });
      d.querySelector("header button").onclick = () => close();
      d.addEventListener("cancel", (e) => {
        e.preventDefault();
        close();
      });
      d.addEventListener("click", (e) => {
        if (e.target !== d) return;
        const r = d.getBoundingClientRect();
        if (
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom
        )
          close();
      });
      document.body.append(d);
      dialog = d;
      d.showModal();
      d.querySelector("header button").focus();
    }
    dialog.dataset.settingsRoute = location.hash;
    return renderer(content());
  }
  window.addEventListener("workbench:state", (e) => {
    if (!e.detail?.user || (identity && e.detail.user.username !== identity))
      close(false, true);
  });
  window.settingsCenter = {
    open,
    close,
    dirty,
    isOpen: () => !!dialog,
    baseHash: () => baseHash,
  };
})();
