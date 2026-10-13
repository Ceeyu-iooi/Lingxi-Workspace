// @ts-nocheck
// Compatibility controller: retain the validated interactions during the React migration.
/* Apply the saved appearance before styles paint, including on the login screen. */
import {themePresets,presetPalette} from '../../src/shared/theme-presets';
import {accentColors} from '../../src/shared/accent-colors';
(() => {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  let preference = "zai-light",
    theme = "light",
    transition = null;
  let preset='mist',accent='preset',lastDetails={};
  try{preset=localStorage.getItem('wb-theme-preset')||'mist';}catch{}
  const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('lingxi-appearance'):null;
  let receiving=false;
  let modePending=false;
  function palette(){
    const p=presetPalette(preset,theme),root=document.documentElement;
    root.dataset.themePreset=preset;
    root.dataset.accent=theme==='dark'?'preset':accent;
    const chosen=theme==='dark'?p.accent:({blue:'#3976f6',violet:'#8157ad',teal:'#397666',orange:'#b36632'}[accent]||p.accent);
    ['--canvas','--bg','--color-background','--color-surface','--lingxi-body','--surface','--surface-2','--lingxi-shell','--ink','--color-text','--ink-2','--muted','--line','--accent-soft'].forEach(key=>root.style.removeProperty(key));
    const colors=accentColors(chosen,theme),independent=accentColors(presetPalette('mist',theme).accent,theme);
    const properties={'--lingxi-sidebar':p.sidebar,'--lingxi-shell':p.sidebar,'--shell-edge':p.sidebar,'--accent':colors.strong,'--primary':colors.strong,'--accent-soft':colors.soft,'--accent-text':colors.text,'--accent-foreground':colors.foreground,'--color-accent':colors.soft,'--independent-accent-soft':independent.soft,'--independent-accent-text':independent.text,'--independent-accent-foreground':independent.foreground};
    Object.entries(properties).forEach(([key,value])=>root.style.setProperty(key,value));
  }
  function publish(saved=false){if(!receiving)channel?.postMessage({profileId:window.workbenchRuntime?.profileId,value:{...lastDetails,theme:preference,themePreset:preset,accent},saved});}
  try {
    const saved =
      localStorage.getItem("zcode-theme") || localStorage.getItem("wb-theme");
    if (["light", "dark", "zai-light", "zai-dark", "system"].includes(saved))
      preference = saved;
  } catch (_) {}
  function apply(value, origin) {
    const previous = theme;
    preference =
      value === "light" ? "zai-light" : value === "dark" ? "zai-dark" : value;
    theme =
      preference === "system"
        ? media.matches
          ? "dark"
          : "light"
        : preference === "zai-dark"
          ? "dark"
          : "light";
    const next = theme;
    const paint = () => {
      document.documentElement.classList.toggle(
        "theme-zai-light",
        next === "light",
      );
      document.documentElement.classList.toggle(
        "theme-zai-dark",
        next === "dark",
      );
      document.documentElement.classList.toggle("dark", next === "dark");
      document.documentElement.dataset.theme = next;
      document.documentElement.style.colorScheme = next;
      palette();
      const button = document.getElementById("theme-toggle");
      if (button) {
        button.setAttribute("aria-pressed", String(next === "dark"));
        button.setAttribute(
          "aria-label",
          next === "dark" ? "切换为浅色模式" : "切换为深色模式",
        );
        const label = document.getElementById("theme-label");
        if (label)
          label.textContent = next === "dark" ? "浅色模式" : "深色模式";
      }
      window.dispatchEvent(new Event("workbench:appearance"));
      publish();
    };
    transition?.skipTransition();
    const reduced =
      matchMedia("(prefers-reduced-motion: reduce)").matches ||
      document.documentElement.dataset.motion === "reduced";
    if (
      !origin ||
      previous === next ||
      reduced ||
      !document.startViewTransition
    ) {
      paint();
      return;
    }
    const rect = (
      origin instanceof Element
        ? origin
        : document.getElementById("theme-toggle")
    )?.getBoundingClientRect();
    const x =
      Number.isFinite(origin.clientX) && origin.clientX > 0
        ? origin.clientX
        : rect
          ? rect.left + rect.width / 2
          : innerWidth / 2;
    const y =
      Number.isFinite(origin.clientY) && origin.clientY > 0
        ? origin.clientY
        : rect
          ? rect.top + rect.height / 2
          : innerHeight / 2;
    const radius = Math.hypot(
      Math.max(x, innerWidth - x),
      Math.max(y, innerHeight - y),
    );
    const current = (transition = document.startViewTransition(paint));
    current.ready
      .then(() => {
        if (transition !== current) return;
        document.documentElement.animate(
          {
            clipPath: [
              `circle(0px at ${x}px ${y}px)`,
              `circle(${radius}px at ${x}px ${y}px)`,
            ],
          },
          {
            duration: 650,
            easing: "cubic-bezier(.22,.61,.36,1)",
            pseudoElement: "::view-transition-new(root)",
          },
        );
      })
      .catch(() => {});
    current.finished
      .finally(() => {
        if (transition === current) transition = null;
      })
      .catch(() => {});
  }
  window.workbenchAppearance = {
    get preset(){return preset;},
    presets:themePresets,
    previewPreset(value,origin){if(!themePresets.some(p=>p.id===value))return;preset=value;accent='preset';apply(preference,origin);},
    get theme() {
      return preference;
    },
    previewTheme(value, origin) {
      if (!["system", "light", "dark", "zai-light", "zai-dark"].includes(value))
        return;
      apply(value, origin);
    },
    previewFontSize(size) {
      const value = Math.max(12, Math.min(18, Number(size) || 14));
      document.documentElement.style.setProperty(
        "--ui-font-size",
        value + "px",
      );
    },
    setTheme(value, origin) {
      if (!["system", "light", "dark", "zai-light", "zai-dark"].includes(value))
        return;
      apply(value, origin);
      try {
        localStorage.setItem("zcode-theme", preference);
        localStorage.setItem("wb-theme", theme);
      } catch (_) {}
    },
    async commitTheme(value, origin) {
      if(modePending)return;
      const previous=preference,owner=window.workbenchRuntime?.profileId;
      modePending=true;
      this.setTheme(value,origin);
      try {
        if(!owner)return;
        const response=await fetch('/api/control/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({theme:value})});
        if(!response.ok)throw Error('模式保存失败');
        if(window.workbenchRuntime?.profileId===owner){lastDetails.theme=value;publish(true);}
      } catch(error) {
        if(window.workbenchRuntime?.profileId===owner){this.setTheme(previous);window.workbenchNotify?.('模式保存失败，已恢复原设置',{kind:'error'});}
      } finally {modePending=false;}
    },
    setFontSize(size) {
      const value = Math.max(12, Math.min(18, Number(size) || 14));
      document.documentElement.style.setProperty(
        "--ui-font-size",
        value + "px",
      );
      try {
        localStorage.setItem("wb-ui-font-size", String(value));
      } catch (_) {}
    },
    details(value = {}) {
      lastDetails={...lastDetails,...value};
      value=lastDetails;
      if(value.themePreset&&themePresets.some(p=>p.id===value.themePreset))preset=value.themePreset;
      accent=value.accent||'preset';
      document.documentElement.dataset.motion = value.reduceMotion
        ? "reduced"
        : "normal";
      document.documentElement.style.setProperty(
        "--wb-brightness",
        String((value.brightness || 100) / 100),
      );
      palette();publish();window.dispatchEvent(new Event('workbench:appearance'));
    },
    config(value = {}) {
      if (value.theme) this.setTheme(value.theme);
      if (value.uiFontSize) this.setFontSize(value.uiFontSize);
      this.details(value);
      palette();
      try{localStorage.setItem('wb-theme-preset',preset);}catch{}
      publish(true);
    },
  };
  apply(preference);
  channel?.addEventListener('message',event=>{if(!event.data.profileId||event.data.profileId!==window.workbenchRuntime?.profileId)return;receiving=true;try{if(event.data.saved)window.workbenchAppearance.config(event.data.value);else {window.workbenchAppearance.previewTheme(event.data.value.theme);window.workbenchAppearance.previewFontSize(event.data.value.uiFontSize||14);window.workbenchAppearance.details(event.data.value);palette();}}finally{receiving=false;}});
  try {
    window.workbenchAppearance.setFontSize(
      localStorage.getItem("wb-ui-font-size") || 14,
    );
  } catch (_) {}
  media.addEventListener("change", () => {
    if (preference === "system") apply("system");
  });
  let sidebarCollapsed = false,
    sidebarWidth = 240;
  try {
    // A cold launch starts expanded; overlays and routes retain this live state.
    sidebarCollapsed = false;
    localStorage.removeItem("wb-sidebar-width");
    localStorage.removeItem("wb-sidebar-collapsed");
  } catch (_) {}
  function applySidebar() {
    const narrow=innerWidth/(Number(document.documentElement.dataset.uiScale||100)/100)<960;
    const collapsed=sidebarCollapsed||narrow;
    document.documentElement.classList.toggle(
      "sidebar-collapsed",
      sidebarCollapsed || narrow,
    );
    document.documentElement.style.setProperty(
      "--sidebar-width",
      sidebarWidth + "px",
    );
    const toggle = document.getElementById("sidebar-toggle");
    if (toggle) {
      toggle.setAttribute("aria-expanded", String(!(sidebarCollapsed || narrow)));
      toggle.setAttribute(
        "aria-label",
        collapsed ? "展开侧边栏" : "收起侧边栏",
      );
      toggle.title = collapsed ? "展开侧边栏" : "收起侧边栏";
    }
  }
  applySidebar();
  let resizeFrame=0;
  const resizeSidebar=()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(applySidebar);};
  window.addEventListener('resize',resizeSidebar);
  window.addEventListener('workbench:zoom',resizeSidebar);
  window.addEventListener('workbench:state',event=>{if(event.detail?.user&&!document.documentElement.dataset.shellReady)requestAnimationFrame(()=>requestAnimationFrame(()=>document.documentElement.dataset.shellReady='true'));});
  onReady(() => {
    apply(preference);
    applySidebar();
    if (!document.querySelector(".side")) return;
    document.querySelectorAll(".side .nav-item").forEach((link) => {
      if (link.querySelector(".nav-label")) return;
      const label = document.createElement("span");
      label.className = "nav-label";
      label.textContent = link.textContent.trim();
      link.title = label.textContent;
      link.setAttribute("aria-label", label.textContent);
      [...link.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .forEach((node) => node.remove());
      link.appendChild(label);
    });
    document.getElementById("sidebar-toggle").onclick = () => {
      sidebarCollapsed = !sidebarCollapsed;
      applySidebar();
    };
    document.querySelectorAll(".sidebar-resize").forEach(node=>node.remove());
    const icons = {
      home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><path d="M9 21v-8h6v8"/>',
      list: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
      book: '<path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15"/>',
      fire: '<path d="M13 3c1 5-5 6-4 10-2-1-3-3-3-3-5 7 0 12 6 12 7 0 11-8 4-14 0 4-2 5-2 5 1-5-1-10-1-10Z"/>',
      finance:
        '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 9h18M15 14h3M7 3v2"/>',
      ai: '<rect x="5" y="6" width="14" height="14" rx="3"/><path d="M12 3v3M2 11h3M19 11h3M9 16h6"/><path d="M9 11h.01M15 11h.01"/>',
      gear: '<path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 3-1 2 3h3l1-3 3-1 2-3-2-2 1-3-3-2-3 1-2-3Z"/><circle cx="12" cy="11" r="3"/>',
    };
    document.querySelectorAll(".ico").forEach((el) => {
      const name = Object.keys(icons).find((key) =>
        el.classList.contains("ico-" + key),
      );
      if (name)
        el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
    });
  });
  window.addEventListener("storage", (event) => {
    if (event.key === "zcode-theme") apply(event.newValue || "zai-light");
  });
})();
