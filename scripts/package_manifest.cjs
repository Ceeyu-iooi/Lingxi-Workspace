'use strict';
// 安装包精简清单：所有"哪些文件可以进安装包"的判断集中在此，构建脚本与验收脚本共用。
// 依据 AGENTS.md 第 11 节：可以排除类型声明、源码映射与构建索引/测试/文档，但必须保留运行代码、许可证与真实资料。
const fs = require('node:fs');
const path = require('node:path');

// npm 包内可以安全的删除的文件：源码映射、类型声明、构建索引、测试与文档、纯浏览器用的入口。
const dropFile = (p) => {
  const rel = '/' + p.split(path.sep).join('/');
  if (/\.d\.(?:ts|mts|cts)$|\.tsbuildinfo$|\.map$/.test(rel)) return true;
  if (/\/(?:test|tests|__tests__|benchmark|benchmarks|docs|example|examples|\.github|coverage|fixtures)(?:\/|$)/.test(rel)) return true;
  return /\/(?:README|readme|CHANGELOG|changelog|HISTORY|history|AUTHORS|contributing)(?:\.\w+)?$/.test(rel);
};

// 浏览器/多环境专用入口：Node 运行时会走 package.json 的 exports 指向 lib 实现。
// 逐个用静态导入核验：后端与其依赖从不 require 这些文件（见 verify_desktop_payload.cjs 的入口核验）。
const pngjsBrowser = (p) => /[/\\]browser\.js$/.test(p);

function runtimeFile(p) {
  if (dropFile(p) || pngjsBrowser(p)) return false;
  return !/[/\\](?:test|tests|benchmark|benchmarks|docs|example|examples|\.github|node_modules)(?:[/\\]|$)/.test('/' + p.split(path.sep).join('/'));
}

// 后端（backend/node_modules）：这些包的源码打进 main.mjs 单文件，安装包里不再需要独立的包目录。
// 必须是"纯 JS、无动态 require、无二进制/数据文件"的包，且只能在运行时确实不 require 它们时才可内联。
const backendInline = [
  'fastify',
  'ajv',
  'ajv-formats',
  'fast-json-stringify',
  '@fastify/ajv-compiler',
  '@fastify/fast-json-stringify-compiler',
  '@fastify/error',
  '@fastify/deepmerge',
  '@fastify/merge-json-schemas',
  '@fastify/proxy-addr',
  '@fastify/forwarded',
  'find-my-way',
  'fast-uri',
  'fast-querystring',
  'fast-decode-uri-component',
  'safe-regex2',
  'fast-deep-equal',
  'fastq',
  'reusify',
  'ret',
  'ipaddr.js',
  'light-my-request',
  'cookie',
  'set-cookie-parser',
  'process-warning',
  'avvio',
  'abstract-logging',
  'toad-cache',
  'semver',
  'rfdc',
  'dequal',
  'json-schema-ref-resolver',
  'json-schema-traverse',
  'require-from-string',
  'pino',
  'pino-std-serializers',
  'pino-abstract-transport',
  '@pinojs/redact',
  'sonic-boom',
  'thread-stream',
  'split2',
  'atomic-sleep',
  'on-exit-leak-free',
  'real-require',
  'quick-format-unescaped',
  'safe-stable-stringify',
  'secure-json-parse',
  'debug',
  'ms',
];

// 必须保留为真实目录的包：带 WASM/二进制/数据文件，或按目录结构在运行时读取资源。
const backendExternal = [
  'jieba-wasm',
  '@jsquash/webp',
  'wasm-feature-detect',
  'pngjs',
  'jpeg-js',
  'yaml',
  'yauzl',
  'yazl',
  'buffer-crc32',
  'pend',
  'decimal.js',
  'https-proxy-agent',
  'agent-base',
];

function readManifest(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

module.exports = { dropFile, runtimeFile, backendInline, backendExternal, readManifest };

// 安装包内不再需要的运行时文件（原始字节 / gzip9 实测）：
// - jieba-wasm 同时发布 bundler/deno/web 三份 WASM，后端只加载 pkg/nodejs：-12MB 原始。
// - pngjs 的 browser.js 是 UMD 浏览器包，Node 走 lib 实现：-573KB。
// - @jsquash/webp 的编码器与 SIMD 变体在后端从不加载（avatar-worker 只用 decode.js 的 webp_dec.wasm）：-715KB。
// - 构建脚本 assemble.mjs 与 codec/Makefile.animated.backup 只是打包产物：-3KB。
// - yaml 的 browser/ 与 bin.mjs 只在浏览器构建与命令行里使用，package.json 的 node 条件指向 dist：-281KB。
// 每一条都需要 scripts/verify_backend_bundle.cjs 在静态导入层面证明"从未被引用"。
const backendExcludedFiles = [
  /^\/pkg\/(?:bundler|deno|web)(?:\/|$)/,
  /^\/browser\.js$/,
  /^\/codec\/enc(?:\/|$)/,
  /^\/codec\/Makefile(?:\.animated)?\.backup$/,
  /^\/scripts?\/assemble(?:\.mjs)?$/,
  /^\/browser(?:\/|$)/,
  /^\/bin\.mjs$/,
];

// 只对指定包生效的排除规则（key 是包名，value 是相对包根的规则）。
const backendPackageExcludes = {
  'jieba-wasm': [backendExcludedFiles[0]],
  pngjs: [backendExcludedFiles[1]],
  '@jsquash/webp': [backendExcludedFiles[2], backendExcludedFiles[3], backendExcludedFiles[4]],
  yaml: [backendExcludedFiles[5], backendExcludedFiles[6]],
};

function excludedRuntimeFile(packageNameOfFile, relative) {
  const rules = backendPackageExcludes[packageNameOfFile];
  if (!rules) return false;
  const file = '/' + relative.split(path.sep).join('/');
  return rules.some((rule) => rule.test(file));
}

// 运行时仍然需要、但不来自后端源码静态导入的包（由运行时按需 require/import）。
// debug、ms：https-proxy-agent 的 dist 在需要输出调试信息时才 require。
const runtimeOnly = ['debug', 'ms'];

// 桌面外壳（asar 内 node_modules/electron-updater 及其依赖）里可以安全删除的重复发行文件。
// electron-updater 只用 require('js-yaml').load() 解析 app-update.yml；js-yaml 的 CJS 入口是 index.js -> lib/，
// dist/ 下的 ESM 构建、未压缩 CJS 构建与压缩 CJS 构建是同一份代码的三种产物。
// 实测三者的 load/dump 结果与导出键完全一致，因此只保留压缩 CJS 一份：删 js-yaml.mjs（104,118B）与 js-yaml.js（131,632B）。
function desktopStaticFile(relative) {
  return relative.split(path.sep).join('/') !== 'vendor/bootstrap/bootstrap.min.css';
}

module.exports = { desktopStaticFile, dropFile, runtimeFile, backendInline, backendExternal, readManifest, backendExcludedFiles, backendPackageExcludes, excludedRuntimeFile, runtimeOnly };
