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
    add({
      label: "搜索与跳转",
      action: () => document.querySelector("#command-trigger")?.click(),
    });
    add({
      label: "设置中心",
      action: () => {
        location.hash = "#/settings";
      },
    });
    add({
      label: "切换主题",
      action: () => document.querySelector("#theme-toggle")?.click(),
    });
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
    const parent = target.closest("dialog[open]"),
      bounds = parent?.getBoundingClientRect() || {
        left: 0,
        top: 0,
        right: innerWidth,
        bottom: innerHeight,
      },
      rect = d.getBoundingClientRect();
    const scale =
        Number(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--page-zoom-scale",
          ),
        ) || 1,
      origin = parent ? bounds : { left: 0, top: 0 };
    d.style.left =
      (Math.max(bounds.left + 8, Math.min(x, bounds.right - rect.width - 8)) -
        origin.left) /
        scale +
      "px";
    d.style.top =
      (Math.max(bounds.top + 8, Math.min(y, bounds.bottom - rect.height - 8)) -
        origin.top) /
        scale +
      "px";
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
