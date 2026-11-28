import { createApp } from "vue";
import GitTimeline from "./GitTimeline.vue";
import "./motion";
import "./surfaces";
import "./overlay";
import { installAppearance } from "virtual:lingxi-appearance";

installAppearance();

const root = document.getElementById("git-timeline-root");
if (root) createApp(GitTimeline).mount(root);

Promise.all([fetch("/api/runtime"), fetch("/api/control")])
  .then(responses => Promise.all(responses.map(response => response.ok ? response.json() : null)))
  .then(([runtime, control]) => {
    if (runtime) (window as any).workbenchRuntime = runtime;
    if (control) (window as any).workbenchAppearance?.config(control.config);
  })
  .catch(() => {});
