import "./motion";
import "./surfaces";
import { installStandalone } from "virtual:lingxi-standalone";
import React, { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
function StandaloneController() {
  useLayoutEffect(() => {
    installStandalone();
    let alive=true;
    Promise.all([fetch('/api/runtime').then(r=>r.json()),fetch('/api/control').then(r=>r.json())]).then(([runtime,control])=>{if(!alive)return;(window as any).workbenchRuntime=runtime;(window as any).workbenchAppearance?.config(control.config);}).catch(()=>{});
    return ()=>{alive=false;};
  }, []);
  return null;
}
const root = document.createElement("div");
document.body.append(root);
createRoot(root).render(<StandaloneController />);
