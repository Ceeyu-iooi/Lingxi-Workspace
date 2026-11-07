'use strict';
// 后端单文件打包：把纯 JS 依赖（scripts/package_manifest.cjs 的 backendInline）直接编译进 main.mjs，
// 安装包里只保留带 WASM/二进制/数据的真实包目录。
// 实测约束（改动前请重读）：
// 1. platform 必须是 'node'，否则 esbuild 把内置模块标记为 external 后不会打包任何依赖。
// 2. 内置模块（node: 前缀与 builtinModules 命中）要显式 external，不能落入"未登记包"分支。
// 3. 内联清单里的包被打进 bundle，安装包不再复制它们；一旦有包被运行时 require 又不在清单里，构建即失败。
const path = require('node:path');
const { builtinModules } = require('node:module');
const { build } = require('esbuild');
const { backendInline, backendExternal } = require('./package_manifest.cjs');

const root = path.resolve(__dirname, '..');
const inlined = new Set(backendInline);
const external = new Set(backendExternal);
const builtins = new Set(builtinModules.flatMap((name) => [name, 'node:' + name]));
const isRelative = (value) => value.startsWith('.') || path.isAbsolute(value);

function packageName(specifier) {
  if (specifier.startsWith('node:')) return specifier;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const inlinePlugin = {
  name: 'lingxi-inline-runtime',
  setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) => {
      const specifier = args.path;
      if (isRelative(specifier)) return undefined;
      if (builtins.has(specifier)) return { path: specifier, external: true };
      const name = packageName(specifier);
      if (external.has(name)) return { path: specifier, external: true };
      if (inlined.has(name)) return undefined;
      throw Error('未登记的后端依赖：' + name + '（由 ' + path.relative(root, args.importer) + ' 引入）；请在 scripts/package_manifest.cjs 归类');
    });
  },
};

async function bundleBackend(options = {}) {
  const output = options.output || path.join(root, '.runtime/server/main.mjs');
  const result = await build({
    entryPoints: [path.join(root, 'src/server/main.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    sourcemap: false,
    minify: true,
    metafile: true,
    logLevel: 'silent',
    legalComments: 'none',
    // CJS 依赖里的 require('node:xxx') 必须保留为真实的内置模块加载。
    banner: { js: 'import { createRequire as __lingxiCreateRequire } from "node:module"; const require = __lingxiCreateRequire(import.meta.url);' },
    plugins: [inlinePlugin],
  });
  let inlinedBytes = 0;
  const used = new Set();
  for (const [file, info] of Object.entries(result.metafile.inputs)) {
    const normalized = file.split(path.sep).join('/');
    const marker = normalized.lastIndexOf('node_modules/');
    if (marker < 0) continue;
    inlinedBytes += info.bytes;
    used.add(packageName(normalized.slice(marker + 'node_modules/'.length)));
  }
  const byPackage = [...inlined].filter((name) => !used.has(name));
  return { inlinedBytes, inlinedPackages: [...used].sort(), unusedInlineEntries: byPackage, warnings: result.warnings };
}

// 运行时真正需要的包：各入口文件的静态导入中出现的、不在内联清单里的包，再加上清单登记的外部包。
async function requiredPackages(entries) {
  const required = new Set(backendExternal);
  for (const entryFile of entries) {
    const result = await build({
      entryPoints: [path.join(root, entryFile)],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      target: 'node24',
      metafile: true,
      logLevel: 'silent',
      legalComments: 'none',
    });
    for (const file of Object.keys(result.metafile.inputs)) {
      const normalized = file.split(path.sep).join('/');
      const marker = normalized.lastIndexOf('node_modules/');
      if (marker < 0) continue;
      const name = packageName(normalized.slice(marker + 'node_modules/'.length));
      if (name.startsWith('node:')) continue;
      if (inlined.has(name) || external.has(name)) continue;
      throw Error('后端入口 ' + entryFile + ' 直接依赖未登记的包：' + name);
    }
  }
  return [...required].sort();
}

module.exports = { bundleBackend, requiredPackages, packageName, root };
if (require.main === module) {
  bundleBackend(process.argv[2] ? { output: path.resolve(process.argv[2]) } : {}).then((result) => {
    console.log('backend bundle inlined ' + result.inlinedBytes + ' bytes from ' + result.inlinedPackages.length + ' packages');
    if (result.unusedInlineEntries.length) console.log('inline list entries not referenced: ' + result.unusedInlineEntries.join(', '));
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
