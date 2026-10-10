// @ts-nocheck
// Compatibility controller: retain the validated interactions during the React migration.
(() => {
  "use strict";
  const native = window.workbenchDesktop,
    e = (s) =>
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
  let surface = null,
    identity = null,
    config = null,
    step = "agents",
    pending = false,
    generation = 0,
    checkedOwner = null,
    checking = false;
  const active = () =>
    surface?.isConnected &&
    typeof user !== "undefined" &&
    user?.username === identity;
  function close() {
    generation++;
    if (surface) window.usageCharts?.dispose(surface);
    surface
      ?.querySelectorAll("[data-switch]")
      .forEach((host) => window.WorkbenchReact?.unmount?.(host));
    surface?.remove();
    surface = null;
    const app = document.getElementById("app");
    if (app) app.inert = false;
    identity = null;
    pending = false;
  }
  async function save(body) {
    if (!active()) throw new DOMException("账户已切换", "AbortError");
    await api("POST", "/api/control/config", body);
    if (!active()) throw new DOMException("账户已切换", "AbortError");
    Object.assign(config.config, body);
  }
  function draw() {
    if (!active()) return;
    const host = surface.querySelector(".onboarding-stage");
    host.innerHTML = `<div class="onboarding-brand"><img src="assets/lingxi-logo.svg" alt="灵犀"><span>灵犀工作坊</span></div><div class="onboarding-progress" aria-label="${step === "agents" ? "第 1 步，共 3 步" : step === "codex" ? "第 2 步，共 3 步" : "第 3 步，共 3 步"}"><i data-active="true"></i><i data-active="${step !== "agents"}"></i><i data-active="${step === "suppliers"}"></i></div><h1 class="onboarding-heading" tabindex="-1">${step === "agents" ? "把你的 Agent 用量连起来" : "连接你使用的 API 供应商"}</h1><p class="onboarding-subtitle">${step === "agents" ? "选择允许灵犀读取的本机用量日志。每个工具独立开启，也可以稍后在设置中连接。" : "添加用于查询用量和账单的 API Key。不同供应商的查询能力不同，你可以随时在设置中补充。"}</p>${
      step === "agents"
        ? `<div class="onboarding-cards">${[
            ["codex", "Codex", "defaultCodexPath"],
            ["zcode", "ZCode", "defaultZcodePath"],
            ["dsh", "DeepSeek Harness", "defaultDshPath"],
          ]
            .map(
              ([id, label, key]) =>
                `<article class="onboarding-card" data-agent="${id}" data-selected="${!!config.config[id + "Enabled"]}"><div class="onboarding-switch"><h2>${label}</h2><span data-switch="${id}"></span></div><p>读取本机已存在的用量记录</p><label class="onboarding-note">日志位置<input type="text" data-path="${id}" value="${e(config.config[id + "Path"] || config[key] || "")}" aria-label="${label} 日志位置" autocomplete="off"></label></article>`,
            )
            .join("")}</div>`
        : '<div class="onboarding-card"><h2>API 供应商</h2><p data-supplier-summary>正在读取连接…</p><button class="onboarding-action secondary" data-add-supplier>添加或管理供应商</button><div data-supplier-host hidden></div></div>'
    }<p class="onboarding-error" role="alert"></p><div class="onboarding-actions">${step !== "agents" ? '<button class="onboarding-action quiet" data-back>上一步</button>' : ""}<button class="onboarding-action quiet" data-skip>稍后设置</button><button class="onboarding-action" data-next>${step === "agents" ? "继续" : "进入工作台"}</button></div>`;
    host._motionDispose?.();host._motionDispose=window.WorkbenchMotion?.rows(host);
    window.WorkbenchWindow?.mount(surface.querySelector(".onboarding-top"));
    host.querySelector("h1").focus({ preventScroll: true });
    if (step === "codex") {
      host.querySelector("h1").textContent = "连接 Codex 账户";
      host.querySelector(".onboarding-subtitle").textContent = "查询五小时额度、每周额度、Credit 和重置卡，也可稍后连接。";
      const card = host.querySelector(".onboarding-card");
      window.LingxiDesign.login(card);
    } else if (step === "agents")
      host.querySelectorAll("[data-switch]").forEach((slot) => {
        const scope = slot.dataset.switch;
        let checked = !!config.config[scope + "Enabled"];
        const render = () =>
          window.WorkbenchReact.squishSwitch(slot, {
            checked,
            ariaLabel: "监测 " + scope + " 用量",
            onChange: (v) => {
              checked = v;
              slot.dataset.checked = String(v);
              slot.closest(".onboarding-card").dataset.selected = String(v);
              render();
            },
          });
        slot.dataset.checked = String(checked);
        render();
      });
    else {
      api("GET", "/api/usage/connections")
        .then((result) => {
          if (active() && step === "suppliers") {
            const count = result.connections.filter(
              (c) => c.kind !== "codex",
            ).length;
            host.querySelector("[data-supplier-summary]").textContent = count
              ? "已配置 " + count + " 个 Key，可继续添加或直接进入工作台。"
              : "尚未配置。Key 只保存在当前 Profile的资料中。";
          }
        })
        .catch((error) => {
          if (active())
            host.querySelector("[role=alert]").textContent = error.message;
        });
      host.querySelector("[data-add-supplier]").onclick = async () => {
        try {
          const d = await window.usageAccounts.onboardingSuppliers(
            host.querySelector("[data-supplier-host]"),
          );
          d.addEventListener(
            "close",
            () => {
              if (active() && step === "suppliers") draw();
            },
            { once: true },
          );
        } catch (error) {
          if (active())
            host.querySelector("[role=alert]").textContent = error.message;
        }
      };
    }
    const go = async (skip = false) => {
      if (pending || !active()) return;
      pending = true;
      host
        .querySelectorAll(".onboarding-actions button")
        .forEach((b) => (b.disabled = true));
      host.querySelector("[role=alert]").textContent = "";
      try {
        if (step === "agents") {
          const body = { onboardingStep: "codex" };
          if (!skip)
            host.querySelectorAll("[data-switch]").forEach((slot) => {
              const id = slot.dataset.switch;
              body[id + "Enabled"] = slot.dataset.checked === "true";
              body[id + "Path"] = host
                .querySelector("[data-path=" + id + "]")
                .value.trim();
            });
          await save(body);
          step = "codex";
          draw();
        } else if (step === "codex") {
          await save({ onboardingStep: "suppliers" }); step = "suppliers"; draw();
        } else {
          await save({ onboardingStep: "complete" });
          await native?.onboardingComplete();
          close();
        }
      } catch (error) {
        if (active() && error.name !== "AbortError")
          host.querySelector("[role=alert]").textContent = error.message;
      } finally {
        pending = false;
        if (host.isConnected)
          host
            .querySelectorAll(".onboarding-actions button")
            .forEach((b) => (b.disabled = false));
      }
    };
    host.querySelector("[data-next]").onclick = () => go(false);
    host.querySelector("[data-skip]").onclick = () => go(true);
    host.querySelector("[data-back]")?.addEventListener("click", async () => {
      try {
        const previous = step === "suppliers" ? "codex" : "agents";
        await save({ onboardingStep: previous });
        step = previous;
        draw();
      } catch (error) {
        if (active())
          host.querySelector("[role=alert]").textContent = error.message;
      }
    });
  }
  async function open(force = false) {
    if (typeof user === "undefined" || !user || surface) return;
    const owner = user.username,
      ticket = ++generation;
    const [state, result] = await Promise.all([
      native?.onboardingState() || Promise.resolve({ firstRun: true }),
      api("GET", "/api/control"),
    ]);
    if (ticket !== generation || user?.username !== owner) return;
    if (
      !force &&
      (!state.firstRun || result.config.onboardingStep === "complete")
    ) {
      if (state.firstRun && result.config.onboardingStep === "complete")
        await native?.onboardingComplete();
      return;
    }
    if (force) {
      window.settingsCenter?.close(false, true);
      await api("POST", "/api/control/config", { onboardingStep: "agents" });
      result.config.onboardingStep = "agents";
    }
    identity = owner;
    config = result;
    step =
      ["suppliers", "codex"].includes(result.config.onboardingStep) ? result.config.onboardingStep : "agents";
    surface = document.createElement("section");
    surface.className = "lingxi-onboarding";
    surface.setAttribute("role", "dialog");
    surface.setAttribute("aria-modal", "true");
    surface.setAttribute("aria-label", "灵犀首次启动引导");
    surface.innerHTML =
      '<div class="onboarding-top"></div><div class="onboarding-stage"></div>';
    const app = document.getElementById("app");
    if (app) app.inert = true;
    surface.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Tab") {
        const items = [
          ...surface.querySelectorAll('button,input,[tabindex="0"]'),
        ].filter((el) => !el.disabled && el.getClientRects().length);
        const first = items[0],
          last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    });
    document.body.append(surface);
    draw();
  }
  window.addEventListener("workbench:state", (event) => {
    if (!event.detail?.user) {
      checkedOwner = null;
      close();
      return;
    }
    if (identity && identity !== event.detail.user.username) close();
    if (checkedOwner === event.detail.user.username || checking) return;
    checkedOwner = event.detail.user.username;
    checking = true;
    open()
      .catch((error) => {
        if (error.name !== "AbortError") console.warn("首次引导暂不可用");
        checkedOwner = null;
      })
      .finally(() => (checking = false));
  });
  window.lingxiOnboarding = { open: () => open(true) };
  if (native) {
    document.documentElement.classList.add("desktop-shell");
    const sync = () =>
      native
        .frameTheme(document.documentElement.dataset.theme || "light")
        .catch(() => {});
    window.addEventListener("workbench:appearance", sync);
    sync();
  }
})();
