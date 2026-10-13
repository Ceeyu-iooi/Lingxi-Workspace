// @ts-nocheck
// Compatibility controller: retain the validated interactions during the React migration.
/* Business modules can add actions through register() or the extension event. */
(() => {
  const providers = new Set();
  let menu = null,
    returnFocus = null;
  function close(restore = false) {
    const old = menu;
    menu = null;
    if (old) {
      old.close();
      old.remove();
    }
    if (restore && returnFocus?.isConnected)
      returnFocus.focus({ preventScroll: true });
  }
  const allowed = () => typeof user !== "undefined" && !!user;
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制", {kind:"success"});
    } catch {
      toast("复制失败，请使用浏览器复制功能", {kind:"error"});
    }
  }
  function open(event, target, x, y) {
    if (
      event.defaultPrevented ||
      !allowed() ||
      target.closest("input,textarea,[contenteditable=true]")
    )
      return;
    const items = [],
      add = (item) => {
        if (
          item &&
          typeof item.label === "string" &&
          typeof item.action === "function"
        )
          items.push(item);
      };
    const selection = document.getSelection()?.toString() || "",
      link = target.closest("a[href]");
    if (selection)
      add({ label: "复制所选内容", action: () => copy(selection) });
    if (link) add({ label: "复制链接地址", action: () => copy(link.href) });
    for (const provider of providers) {
      try {
        const extra = provider({ target, event });
        if (Array.isArray(extra)) extra.forEach(add);
      } catch {}
    }
    const detail = { target, event, items, add },
      extension = new CustomEvent("workbench:context-menu", {
        detail,
        cancelable: true,
      });
    document.dispatchEvent(extension);
    if (extension.defaultPrevented) {
      event.preventDefault();
      return;
    }
    const data=target.closest('[data-resource-row],.resource-table td,.usage-stat,.usage-value,[data-copy-value]');
    if(data){const value=data.dataset.copyValue||data.textContent.trim();if(value)add({label:'复制当前数据',action:()=>copy(value)});}
    const object=target.closest('[data-project],.project-card,.ob-project,[data-account],.usage-managed-key');
    if(object){const edit=object.querySelector('[data-edit],[data-project-edit]');const sync=object.querySelector('[data-sync]');if(edit&&!edit.disabled)add({label:object.hasAttribute('data-account')?'编辑此Key':'编辑当前项目',action:()=>edit.click()});if(sync&&!sync.disabled)add({label:'同步此Key',action:()=>sync.click()});}
    if(link&&!link.href.startsWith(location.origin+'/#'))add({label:'打开链接',action:()=>link.click()});
    if (!items.length) return;
    event.preventDefault();
    close();
    returnFocus = document.activeElement;
    const d = window.WorkbenchUI.actionMenu(items);
    [...d.querySelectorAll("[data-menu-index]")].forEach((button, index) => {
      button.onclick = async () => {
        close(true);
        try {
          await items[index].action();
        } catch (e) {
          toast(e.message || "操作失败",{kind:"error"});
        }
      };
    });
    (target.closest("dialog[open]") || document.body).append(d);
    menu = d;
    d.show();
    window.WorkbenchOverlay.point(d,x,y,0);
    d.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
    d.onkeydown = (e) => {
      const buttons = [...d.querySelectorAll("button:not(:disabled)")],
        i = buttons.indexOf(document.activeElement);
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        buttons[
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? buttons.length - 1
              : (i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                buttons.length
        ]?.focus();
      }
    };
  }
  document.addEventListener("contextmenu", (e) =>
    open(e, e.target, e.clientX, e.clientY),
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      const target = document.activeElement,
        r = target.getBoundingClientRect();
      open(e, target, r.left + 10, r.bottom);
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (menu && !menu.contains(e.target)) close();
  });
  window.addEventListener("scroll", () => close(), true);
  window.addEventListener("resize", () => close());
  window.addEventListener("hashchange", () => close());
  window.addEventListener("workbench:state", (e) => {
    if (!e.detail?.user) {
      close();
      providers.clear();
    }
  });
  document.addEventListener("focusin", (e) => {
    if (menu && !menu.contains(e.target)) close();
  });
  window.workbenchContextMenu = {
    register(provider) {
      providers.add(provider);
      return () => providers.delete(provider);
    },
    close,
  };
})();
