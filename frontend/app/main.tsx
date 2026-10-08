import React, { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { installRuntime } from "virtual:lingxi-runtime";
import type { ProfileSession, RuntimeInfo } from "../../src/shared/contracts";

interface Runtime {
  render(): void;
  refresh(): Promise<unknown>;
  getUser(): ProfileSession["user"];
}
declare global {
  interface Window {
    workbenchRuntime?: RuntimeInfo;
    workbenchDesktop?: { applicationReady?: () => Promise<void> };
    lingxiRuntime?: Runtime;
    workbenchAppearance?: { setTheme: (value: string, origin?: Event) => void };
    workbenchNotify?: (message: string) => void;
  }
}
const routes = [
  ["overview", "总览", "home"],
  ["projects", "项目与待办", "list"],
  ["summary", "总结", "book"],
  ["news", "热点", "fire"],
  ["finance", "记账", "finance"],
  ["usage", "用量监测", "list"],
  ["prompts", "提示词管理", "book"],
  ["skills", "技能管理", "list"],
] as const;
const subscribe = (notify: () => void) => {
  window.addEventListener("hashchange", notify);
  return () => window.removeEventListener("hashchange", notify);
};
const readRoute = () =>
  location.hash.replace(/^#\//, "").split("/")[0] || "overview";
const readHash = () => location.hash || "#/overview";

/* Each page owns a stable host for the existing chart/editor/interaction adapters.
 * React controls application navigation; adapters preserve focus and DOM state. */
function Page({ route, ready }: { route: string; ready: boolean }) {
  const hash = useSyncExternalStore(subscribe, readHash);
  useLayoutEffect(() => {
    if (ready) {
      window.lingxiRuntime?.render();
      if (
        window.workbenchRuntime?.version === __LINGXI_VERSION__ &&
        (window.lingxiRuntime?.getUser() ||
          document.getElementById("profile-create-form"))
      )
        window.workbenchDesktop?.applicationReady?.().catch(() => {});
    }
  }, [route, hash, ready]);
  return null;
}
function OverviewPage({ ready }: { ready: boolean }) {
  return <Page route="overview" ready={ready} />;
}
function ProjectsPage({ ready }: { ready: boolean }) {
  return <Page route="projects" ready={ready} />;
}
function SummaryPage({ ready }: { ready: boolean }) {
  return <Page route="summary" ready={ready} />;
}
function NewsPage({ ready }: { ready: boolean }) {
  return <Page route="news" ready={ready} />;
}
function FinancePage({ ready }: { ready: boolean }) {
  return <Page route="finance" ready={ready} />;
}
function UsagePage({ ready }: { ready: boolean }) {
  return <Page route="usage" ready={ready} />;
}
function PromptsPage({ ready }: { ready: boolean }) {
  return <Page route="prompts" ready={ready} />;
}
function SkillsPage({ ready }: { ready: boolean }) {
  return <Page route="skills" ready={ready} />;
}
function SettingsPage({ ready }: { ready: boolean }) {
  return <Page route="settings" ready={ready} />;
}
const pages: Record<string, React.ComponentType<{ ready: boolean }>> = {
  overview: OverviewPage,
  projects: ProjectsPage,
  summary: SummaryPage,
  news: NewsPage,
  finance: FinancePage,
  usage: UsagePage,
  prompts: PromptsPage,
  skills: SkillsPage,
  settings: SettingsPage,
};

function Menus() {
  const action = (value: string, event: React.MouseEvent) => {
    if (value === "search") document.getElementById("command-trigger")?.click();
    if (value === "sidebar") document.getElementById("sidebar-toggle")?.click();
    if (value === "theme")
      window.workbenchAppearance?.setTheme(
        document.documentElement.dataset.theme === "dark" ? "light" : "dark",
        event.nativeEvent,
      );
    if (value === "zoom-reset") {
      document.documentElement.style.removeProperty("zoom");
  document.documentElement.style.setProperty("--ui-scale", "1");
      document.documentElement.style.setProperty("--page-zoom-scale", "1");
    }
    event.currentTarget.closest("details")?.removeAttribute("open");
  };
  return (
    <div className="workbench-menubar">
      <details>
        <summary>文件</summary>
        <div className="workbench-menu">
          <a href="#/prompts">提示词库</a>
          <a href="#/settings/data">导入 / 导出 / 备份</a>
        </div>
      </details>
      <details>
        <summary>编辑</summary>
        <div className="workbench-menu">
          <button data-menu="search" onClick={(e) => action("search", e)}>
            搜索与跳转
          </button>
          <a href="#/skills">本地技能</a>
        </div>
      </details>
      <details>
        <summary>视图</summary>
        <div className="workbench-menu">
          <button onClick={(e) => action("sidebar", e)}>
            收起 / 展开侧边栏
          </button>
          <button onClick={(e) => action("theme", e)}>切换主题</button>
          <button onClick={(e) => action("zoom-reset", e)}>实际大小</button>
          <a href="#/settings/appearance">界面设置</a>
        </div>
      </details>
      <details>
        <summary>帮助</summary>
        <div className="workbench-menu">
          <a href="#/settings/shortcuts">快捷键</a>
          <a href="preview.html">设计预览</a>
        </div>
      </details>
    </div>
  );
}
function App() {
  const route = useSyncExternalStore(subscribe, readRoute),
    [ready, setReady] = useState(false),
    PageView = pages[route] || OverviewPage;
  useLayoutEffect(() => {
    let alive = true;
    installRuntime()
      .then((runtime) => {
        window.lingxiRuntime = runtime;
        if (alive) setReady(true);
      })
      .catch((error) => {
        const host = document.getElementById("main");
        if (host) {
          const note = document.createElement("p");
          note.className = "wb-inline-error";
          note.textContent = "界面载入失败：" + error.message;
          host.replaceChildren(note);
        }
      });
    const closeMenus = (event: MouseEvent) => {
      if (!(event.target as Element)?.closest(".workbench-menubar"))
        document
          .querySelectorAll(".workbench-menubar details[open]")
          .forEach((d) => d.removeAttribute("open"));
    };
    document.addEventListener("click", closeMenus);
    return () => {
      alive = false;
      document.removeEventListener("click", closeMenus);
    };
  }, []);
  return (
    <div id="app" className="layout">
      <header className="shell-bar">
        <div className="shell-heading">
          <button
            id="sidebar-toggle"
            type="button"
            aria-label="收起侧边栏"
            aria-expanded="true"
            title="收起侧边栏"
          >
            ☰
          </button>
          <span className="shell-label">
            个人工作空间 <span className="shell-divider">/</span>{" "}
            <span id="shell-page">总览</span>
          </span>
        </div>
        <Menus />
        <button
          id="theme-toggle"
          className="theme-toggle"
          type="button"
          aria-pressed="false"
        >
          <span className="theme-symbol" aria-hidden="true">
            ◐
          </span>
          <span id="theme-label">深色模式</span>
        </button>
      </header>
      <aside className="side">
        <button
          className="brand workbench-brand"
          id="workbench-brand"
          type="button"
          aria-label="灵犀工作坊，收起侧边栏"
          aria-expanded="true"
          title="收起侧边栏 · Ctrl+B"
        >
          <span className="brand-knot" aria-hidden="true">
            <img
              className="brand-knot-light"
              src="assets/lingxi-logo.svg"
              alt=""
            />
            <img
              className="brand-knot-dark"
              src="assets/lingxi-logo.svg"
              alt=""
            />
          </span>
          <span className="brand-name" aria-hidden="true">
            <span>灵犀</span>
            <span className="brand-suffix">工作坊</span>
          </span>
        </button>
        <div className="hello" id="side-hello">
          专注今天
        </div>
        <nav id="nav">
          {routes.map(([view, label, icon]) => (
            <a
              id={
                ["usage", "prompts", "skills"].includes(view)
                  ? view + "-nav"
                  : undefined
              }
              href={"#/" + view}
              data-view={view}
              className={"nav-item" + (route === view ? " on active" : "")}
              key={view}
            >
              <span className={"ico ico-" + icon} />
              <span className="nav-label">{label}</span>
            </a>
          ))}
        </nav>
        <div className="side-foot">
          <button
            id="control-profile"
            className="profile-trigger"
            type="button"
            aria-label="个人资料与设置"
          />
          <span className="footer-status" hidden />
        </div>
      </aside>
      <div className="main-shell">
        <main id="main">
          <PageView ready={ready} />
        </main>
      </div>
      <nav className="tabbar" id="tabbar">
        {routes.map(([view, label, icon]) => (
          <a
            href={"#/" + view}
            data-view={view}
            className={"ph-tab" + (route === view ? " on" : "")}
            key={view}
          >
            <span className={"ico ico-" + icon} />
            {view === "projects" ? "项目" : label}
          </a>
        ))}
        <a href="#/settings" data-view="settings" className="ph-tab">
          <span className="ico ico-gear" />
          我的
        </a>
      </nav>
      <div id="toast" className="toast" role="status" aria-live="polite" />
    </div>
  );
}
createRoot(document.getElementById("react-root")!).render(<App />);
