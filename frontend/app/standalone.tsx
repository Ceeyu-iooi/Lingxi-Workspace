import { installStandalone } from "virtual:lingxi-standalone";
import React, { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
function StandaloneController() {
  useLayoutEffect(() => {
    installStandalone();
  }, []);
  return null;
}
const root = document.createElement("div");
document.body.append(root);
createRoot(root).render(<StandaloneController />);
