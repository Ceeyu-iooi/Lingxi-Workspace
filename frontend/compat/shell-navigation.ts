// @ts-nocheck
// Compatibility controller: retain the validated interactions during the React migration.
/* Shared browser/desktop navigation; native window buttons remain Electron's. */
(() => {
  const bar = document.querySelector(".shell-bar"),
    heading = bar?.querySelector(".shell-heading");
  if (!bar || !heading) return;
  document.querySelector(".layout").prepend(bar);
  const icon = (path) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const back = document.createElement("button"),
    forward = document.createElement("button");
  for (const [button, label, path] of [
    [back, "后退", '<path d="m14 5-7 7 7 7M7 12h14"/>'],
    [forward, "前进", '<path d="m10 5 7 7-7 7M17 12H3"/>'],
  ]) {
    button.type = "button";
    button.className = "shell-history";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = icon(path);
  }
  heading.prepend(back, forward);
  const toggle = document.getElementById("sidebar-toggle");
  toggle.innerHTML = icon(
    '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  );
  let entries = [location.hash || "#/overview"],
    position = 0,
    pending = 0;
  const refresh = () => {
    back.disabled = position === 0;
    forward.disabled = position === entries.length - 1;
  };
  back.onclick = () => {
    if (position > 0) {
      pending = -1;
      history.back();
    }
  };
  forward.onclick = () => {
    if (position < entries.length - 1) {
      pending = 1;
      history.forward();
    }
  };
  window.addEventListener("hashchange", () => {
    if (pending) {
      position = Math.max(0, Math.min(entries.length - 1, position + pending));
      pending = 0;
    } else if (entries[position] !== location.hash) {
      entries = entries.slice(0, position + 1);
      entries.push(location.hash);
      position++;
    }
    refresh();
  });
  window.addEventListener("keydown", (event) => {
    if (
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      ["ArrowLeft", "ArrowRight"].includes(event.key)
    ) {
      event.preventDefault();
      (event.key === "ArrowLeft" ? back : forward).click();
    }
  });
  refresh();
})();
