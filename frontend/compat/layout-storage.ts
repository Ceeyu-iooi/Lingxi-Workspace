// @ts-nocheck
// Compatibility controller: retain the validated interactions during the React migration.
/* Account-scoped layout preferences. SQLite is durable; localStorage is a cache.
   Workspace-scoped UI preference persistence follows ZCode's separation of
   local appearance and durable task/workspace data. */
(() => {
  let owner = "",
    values = {},
    pending = {},
    timer,
    activeFlush = null,
    epoch = 0;
  const cacheKey = () => "wb-layout/" + owner;
  const persist = () => {
    try {
      localStorage.setItem(cacheKey(), JSON.stringify({ values, pending }));
    } catch (_) {}
    window.dispatchEvent(
      new CustomEvent("workbench:preferences", {
        detail: { pending: Object.keys(pending).length },
      }),
    );
  };
  const flush = async (keepalive = false) => {
    if (activeFlush) {
      const succeeded = await activeFlush;
      if (!succeeded) return;
      return flush(keepalive);
    }
    if (!owner || !Object.keys(pending).length) return;
    const batch = { ...pending },
      identity = owner,
      ticket = epoch;
    activeFlush = (async () => {
      try {
        const res = await fetch("/api/preferences", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ changes: batch }),
          keepalive,
        });
        await res.json();
        if (!res.ok) throw new Error("save failed");
        if (owner === identity && ticket === epoch) {
          Object.keys(batch).forEach((key) => {
            if (pending[key] === batch[key]) delete pending[key];
          });
          persist();
        }
        return true;
      } catch (_) {
        return false; /* Keep pending changes in the local cache for the next login. */
      }
    })();
    const succeeded = await activeFlush;
    activeFlush = null;
    if (succeeded && owner === identity && Object.keys(pending).length)
      return flush(keepalive);
  };
  window.wbLayoutStorage = {
    async hydrate(username, { force = false, discardPending = false } = {}) {
      if (owner === username && !force) return;
      const ticket = ++epoch;
      clearTimeout(timer);
      owner = username;
      values = {};
      pending = {};
      try {
        const cached = JSON.parse(localStorage.getItem(cacheKey()) || "{}");
        values = cached.values || {};
        pending = cached.pending || {};
      } catch (_) {}
      if (discardPending) pending = {};
      try {
        const res = await fetch("/api/preferences");
        if (res.ok) {
          const remote = (await res.json()).values;
          if (owner !== username || ticket !== epoch) return;
          if (remote && !Array.isArray(remote)) values = { ...remote };
        }
      } catch (_) {}
      if (owner !== username || ticket !== epoch) return;
      // Adopt pre-migration browser preferences once, never across accounts.
      try {
        if (!localStorage.getItem("wb-layout-legacy-owner")) {
          localStorage.setItem("wb-layout-legacy-owner", owner);
          Object.keys(localStorage)
            .filter((key) =>
              /^wb-(cols-|cardh-|card-order-|page-zoom$|ws-)/.test(key),
            )
            .forEach((key) => {
              if (!(key in values)) pending[key] = localStorage.getItem(key);
            });
        }
      } catch (_) {}
      Object.entries(pending).forEach(([key, value]) => {
        if (value === null) delete values[key];
        else values[key] = value;
      });
      persist();
      await flush();
    },
    getItem(key) {
      return values[key] ?? null;
    },
    setItem(key, value) {
      if (!owner || values[key] === String(value)) return;
      values[key] = String(value);
      pending[key] = String(value);
      persist();
      clearTimeout(timer);
      timer = setTimeout(flush, 150);
    },
    removeItem(key) {
      if (!owner || (!(key in values) && !(key in pending))) return;
      delete values[key];
      pending[key] = null;
      persist();
      clearTimeout(timer);
      timer = setTimeout(flush, 150);
    },
    keys() {
      return Object.keys(values);
    },
    flush,
    resetSession() {
      epoch++;
      clearTimeout(timer);
      owner = "";
      values = {};
      pending = {};
    },
  };
  window.addEventListener("pagehide", () => flush(true));
  window.addEventListener("online", () => flush());
})();
