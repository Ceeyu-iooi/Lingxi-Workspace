import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const root = process.cwd();
export default defineConfig({
  define: {
    __LINGXI_VERSION__: JSON.stringify(
      readFileSync(resolve(root, "VERSION"), "utf8").trim(),
    ),
  },
  root: resolve(root, "frontend/app"),
  publicDir: resolve(root, "static"),
  plugins: [
    react(),
    {
      name: "lingxi-interaction-runtime",
      resolveId(id) {
        if (id === "virtual:lingxi-runtime") return "\0lingxi-runtime";
        if (id === "virtual:lingxi-standalone") return "\0lingxi-standalone";
      },
      load(id) {
        if (!["\0lingxi-runtime", "\0lingxi-standalone"].includes(id)) return;
        const standalone = id === "\0lingxi-standalone",
          order = standalone
            ? [
                "theme.ts",
                "ui-core.ts",
                "usage-charts.ts",
                "rounded-selects.ts",
                "standalone-ui.ts",
              ]
            : (JSON.parse(
                readFileSync(
                  resolve(root, "frontend/app/controller-order.json"),
                  "utf8",
                ),
              ) as string[]),
          source = order
            .map((file) =>
              readFileSync(
                resolve(root, "frontend/compat", file),
                "utf8",
              ).replace(/^\/\/ @ts-nocheck\s*/, "").replace(/^import .*?;\s*$/gm, ""),
            )
            .join("\n;\n");
        return `import {marked} from "marked"; import DOMPurify from "dompurify"; export function ${standalone ? "installStandalone" : "installRuntime"}(){\nfunction onReady(callback){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',callback,{once:true});else queueMicrotask(()=>callback(new Event('DOMContentLoaded')));}\n${source}\n${standalone ? "" : "return appReady.then(()=>({render,refresh,getUser:()=>user}));"}\n}`;
      },
    },
  ],
  build: {
    outDir: resolve(root, ".runtime/web-ui"),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    rolldownOptions: {
      input: {
        app: resolve(root, "frontend/app/index.html"),
        kit: resolve(root, "frontend/app/ui-kit.html"),
        preview: resolve(root, "frontend/app/preview.html"),
        previewDark: resolve(root, "frontend/app/preview-dark.html"),
        prices: resolve(root, "frontend/app/prices.html"),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": { target: process.env.WORKBENCH_DEV_API || `http://127.0.0.1:${process.env.WORKBENCH_PORT || "8765"}`, changeOrigin: true } },
  },
});
