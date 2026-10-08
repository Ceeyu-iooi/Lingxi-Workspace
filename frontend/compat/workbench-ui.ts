// @ts-nocheck
// Compatibility controller: retain the validated interactions during the React migration.
/* Shell presentation and account-scoped ordering. Business data stays in app.js. */
(() => {
  "use strict";
  const controllers = new Set(),
    installed = new WeakMap();
  const storage = () => window.wbLayoutStorage;
  const identity = (node) =>
    node.dataset.view || node.dataset.usageTab || node.id;
  const readOrder = (key) => {
    try {
      const value = JSON.parse(storage()?.getItem(key) || "[]");
      return Array.isArray(value)
        ? [...new Set(value.filter((id) => typeof id === "string"))]
        : [];
    } catch (_) {
      return [];
    }
  };

  function sortable(container, selector, key) {
    if (!container) return;
    controllers.forEach((controller) => {
      if (!controller.container.isConnected) {
        controller.dispose();
        controllers.delete(controller);
      }
    });
    if (installed.has(container)) {
      installed.get(container).apply();
      return;
    }
    const listeners = new AbortController();
    const listen = (target, type, handler, options = {}) =>
      target.addEventListener(type, handler, {
        ...options,
        signal: listeners.signal,
      });
    const items = () =>
      [...container.children].filter((node) => node.matches(selector));
    const base = items().map(identity);
    const horizontal =
      key === "wb-usage-order" || container.classList.contains("usage-tabs");
    let gesture = null,
      suppressUntil = 0,
      suppressTarget = null,
      appliedSignature = "";
    const signature = () =>
      JSON.stringify([
        typeof user === "undefined" ? null : user?.username || null,
        readOrder(key),
        base,
      ]);
    const reorder = (ordered) => {
      if (items().every((node, index) => node === ordered[index])) return;
      // Keep unrelated children in their original slots.
      const slots = items().map((node) => {
        const marker = document.createComment("sortable-slot");
        container.insertBefore(marker, node);
        return marker;
      });
      ordered.forEach((node, index) => slots[index]?.before(node));
      slots.forEach((marker) => marker.remove());
    };
    const prepare = () =>
      items().forEach((node) => {
        if (!base.includes(identity(node))) base.push(identity(node));
        if (!node.classList.contains("wb-sortable"))
          node.classList.add("wb-sortable");
        if (node.draggable) node.draggable = false;
        if (!node.hasAttribute("tabindex") && !node.matches("a[href],button"))
          node.tabIndex = 0;
        const shortcuts = horizontal
          ? "Alt+ArrowLeft Alt+ArrowRight"
          : "Alt+ArrowUp Alt+ArrowDown";
        if (node.getAttribute("aria-keyshortcuts") !== shortcuts)
          node.setAttribute("aria-keyshortcuts", shortcuts);
      });
    const save = () => {
      const current = items().map(identity),
        remaining = [...current];
      // Unknown saved IDs survive while new or temporarily absent menus are added.
      const merged = readOrder(key).map((id) =>
        current.includes(id) ? remaining.shift() : id,
      );
      storage()?.setItem(key, JSON.stringify([...merged, ...remaining]));
      appliedSignature = signature();
    };
    const finish = (cancelled) => {
      if (!gesture) return;
      const previous = gesture;
      gesture = null;
      clearTimeout(previous.timer);
      previous.item.classList.remove("wb-sort-holding", "wb-sort-dragging");
      if (cancelled && previous.dragged)
        previous.original.forEach((node) => container.appendChild(node));
      if (previous.dragged) {
        suppressUntil = Date.now() + 75;
        suppressTarget = previous.item;
        if (!cancelled) save();
      }
      if (container.hasPointerCapture?.(previous.pointerId))
        container.releasePointerCapture(previous.pointerId);
    };
    const apply = () => {
      prepare();
      const nextSignature = signature();
      if (appliedSignature === nextSignature) return;
      finish(true);
      const nodes = new Map(items().map((node) => [identity(node), node]));
      const ids = [...new Set([...readOrder(key), ...base])];
      const ordered = ids
        .filter((id) => nodes.has(id))
        .map((id) => nodes.get(id));
      if (items().some((node, index) => node !== ordered[index]))
        reorder(ordered);
      appliedSignature = nextSignature;
    };
    const controller = {
      container,
      apply,
      dispose: () => {
        finish(true);
        listeners.abort();
        installed.delete(container);
      },
    };
    controllers.add(controller);
    installed.set(container, controller);
    apply();

    listen(container, "pointerdown", (event) => {
      if (
        gesture ||
        event.button !== 0 ||
        event.isPrimary === false ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey
      )
        return;
      const item = event.target.closest(selector);
      if (!item || item.parentElement !== container) return;
      gesture = {
        item,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        original: [...container.childNodes],
        ready: false,
        dragged: false,
      };
      gesture.timer = setTimeout(() => {
        if (!gesture) return;
        gesture.ready = true;
        gesture.item.classList.add("wb-sort-holding");
      }, 280);
    });
    listen(
      window,
      "pointermove",
      (event) => {
        if (!gesture || event.pointerId !== gesture.pointerId) return;
        const distance = Math.hypot(
          event.clientX - gesture.x,
          event.clientY - gesture.y,
        );
        if (!gesture.ready) {
          if (distance > 8) finish(true);
          return;
        }
        if (!gesture.dragged && distance < 6) return;
        if (!gesture.dragged) {
          gesture.dragged = true;
          gesture.item.classList.add("wb-sort-dragging");
          container.setPointerCapture?.(event.pointerId);
        }
        event.preventDefault();
        const siblings = items().filter((node) => node !== gesture.item);
        const coordinate = horizontal ? event.clientX : event.clientY;
        const target = siblings.find((node) => {
          const box = node.getBoundingClientRect();
          return (
            coordinate <
            (horizontal ? box.left + box.width / 2 : box.top + box.height / 2)
          );
        });
        const ordered = [...siblings];
        ordered.splice(
          target ? siblings.indexOf(target) : siblings.length,
          0,
          gesture.item,
        );
        reorder(ordered);
      },
      { passive: false },
    );
    listen(window, "pointerup", (event) => {
      if (gesture?.pointerId === event.pointerId) finish(false);
    });
    listen(window, "pointercancel", (event) => {
      if (gesture?.pointerId === event.pointerId) finish(true);
    });
    listen(container, "lostpointercapture", () => finish(true));
    listen(window, "blur", () => finish(true));
    listen(
      container,
      "click",
      (event) => {
        if (
          event.detail !== 0 &&
          Date.now() < suppressUntil &&
          (event.target === container || suppressTarget?.contains(event.target))
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          suppressUntil = 0;
        }
      },
      { capture: true },
    );
    listen(container, "dragstart", (event) => {
      if (event.target.closest(selector)) event.preventDefault();
    });
    listen(window, "keydown", (event) => {
      if (event.key === "Escape" && gesture) {
        event.preventDefault();
        finish(true);
      }
    });
    listen(container, "keydown", (event) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
        return;
      const delta = horizontal
        ? { ArrowLeft: -1, ArrowRight: 1 }[event.key]
        : { ArrowUp: -1, ArrowDown: 1 }[event.key];
      const item = event.target.closest(selector),
        ordered = items(),
        index = ordered.indexOf(item);
      if (!delta || index < 0) return;
      event.preventDefault();
      finish(true);
      const next = index + delta;
      if (next < 0 || next >= ordered.length) return;
      [ordered[index], ordered[next]] = [ordered[next], ordered[index]];
      reorder(ordered);
      save();
      item.focus({ preventScroll: true });
    });
  }
  window.workbenchUI = { ...window.workbenchUI, sortable };

  function refreshAccount() {
    const profile = document.getElementById("control-profile");
    if (!profile?.querySelector(".account-avatar")) return;
    const account = typeof user === "undefined" ? null : user;
    const settings = typeof state === "undefined" ? {} : state.settings || {};
    const name = String(
      settings.display_name ||
        account?.display_name ||
        account?.username ||
        "个人资料",
    );
    const words = name.trim().split(/\s+/u);
    const initials =
      words.length > 1
        ? words
            .slice(0, 2)
            .map((word) => Array.from(word)[0])
            .join("")
        : Array.from(name).slice(0, 2).join("");
    const avatar =
        window.workbenchControlData?.uiOwner === account?.username
          ? window.workbenchControlData?.avatar
          : null,
      seat = profile.querySelector(".account-avatar");
    if (avatar?.configured) {
      if (seat.dataset.url !== avatar.url) {
        seat.replaceChildren();
        const image = document.createElement("img");
        image.src = avatar.url;
        image.alt = "";
        seat.append(image);
        seat.dataset.url = avatar.url;
      }
    } else {
      delete seat.dataset.url;
      seat.textContent = account ? initials.toLocaleUpperCase() : "我";
    }
    profile.querySelector(".account-name").textContent = name;
    profile.title = account ? `${name} · 个人资料` : "个人资料";
    profile.setAttribute("aria-label", profile.title);
    controllers.forEach((controller) => {
      if (controller.container.isConnected) controller.apply();
      else {
        controller.dispose();
        controllers.delete(controller);
      }
    });
  }

  function install() {
    const brand = document.getElementById("workbench-brand");
    const toggle = document.getElementById("sidebar-toggle");
    if (brand && toggle) {
      toggle.tabIndex = 0;
      toggle.removeAttribute("aria-hidden");
      brand.onclick = () => toggle.click();
      const sync = () => {
        const expanded =
          !document.documentElement.classList.contains("sidebar-collapsed");
        brand.setAttribute("aria-expanded", String(expanded));
        brand.setAttribute(
          "aria-label",
          `灵犀工作坊，${expanded ? "收起" : "展开"}侧边栏`,
        );
        brand.title = `${expanded ? "收起" : "展开"}侧边栏 · Ctrl+B`;
      };
      new MutationObserver(sync).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
      sync();
    }
    const nav = document.getElementById("nav");
    nav?.querySelector('[data-view="settings"]')?.remove();
    nav?.querySelectorAll(".nav-item").forEach((link) => {
      const label =
        link.querySelector(".nav-label") ||
        [...link.children].find((node) => !node.classList.contains("ico"));
      if (label) {
        label.classList.add("nav-label");
        link.title = label.textContent.trim();
        link.setAttribute("aria-label", link.title);
      }
    });
    const profile = document.getElementById("control-profile");
    if (profile) {
      profile.innerHTML =
        '<span class="account-avatar" aria-hidden="true"></span><span class="account-name"></span>';
      profile.onclick = () => {
        if (typeof user !== "undefined" && user)
          location.hash = "#/settings/general";
        else document.getElementById("lg-user")?.focus();
      };
    }
    sortable(nav, ".nav-item", "wb-nav-order");
    refreshAccount();
  }
  onReady(install);
  window.addEventListener("workbench:state", refreshAccount);
  window.addEventListener("workbench:profile", refreshAccount);
  document.addEventListener("keydown", (event) => {
    if (
      !(event.ctrlKey || event.metaKey) ||
      event.altKey ||
      event.isComposing ||
      event.defaultPrevented
    )
      return;
    const plus = ["+", "="].includes(event.key) || event.code === "NumpadAdd";
    const minus =
      ["-", "_"].includes(event.key) || event.code === "NumpadSubtract";
    const reset = event.key === "0" || event.code === "Numpad0";
    if (!plus && !minus && !reset) return;
    event.preventDefault();
    const zoom =
      Number(storage()?.getItem("wb-page-zoom")) ||
      parseFloat(document.documentElement.style.zoom) ||
      100;
    if (typeof setPageZoom === "function")
      setPageZoom(reset ? 100 : zoom + (plus ? 5 : -5));
  });
})();
