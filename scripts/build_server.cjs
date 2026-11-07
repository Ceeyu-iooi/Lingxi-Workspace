'use strict';
const path=require('node:path'),fs=require('node:fs');
const {build}=require('esbuild');
const {bundleBackend}=require('./bundle_backend.cjs');
const root=path.resolve(__dirname,'..'),output=process.env.LINGXI_SERVER_OUT?path.resolve(process.env.LINGXI_SERVER_OUT):path.join(root,'.runtime/server');
fs.mkdirSync(output,{recursive:true});
// 工作线程与维护入口各自保持单文件，运行时依赖与主进程相同（见 scripts/package_manifest.cjs）。
const bundleWorker=(entry,name)=>build({entryPoints:[path.join(root,entry)],outfile:path.join(output,name),bundle:true,platform:'node',format:'esm',packages:'external',target:'node24',sourcemap:false,minify:true,legalComments:'none'});
Promise.all([
  bundleBackend({output:path.join(output,'main.mjs')}),
  bundleWorker('src/server/codex-reader-worker.ts','codex-reader-worker.mjs'),
  bundleWorker('src/server/maintain.ts','maintenance.mjs'),
  bundleWorker('src/server/avatar-worker.ts','avatar-worker.mjs'),
]).then(([main])=>{
  fs.writeFileSync(path.join(output,'build.json'),JSON.stringify({version:fs.readFileSync(path.join(root,'VERSION'),'utf8').trim(),backend:'node-typescript',builtAt:new Date().toISOString(),inlinedBytes:main.inlinedBytes,inlinedPackages:main.inlinedPackages},null,2));
  console.log('Node TypeScript backend built ('+main.inlinedPackages.length+' packages inlined)');
}).catch(error=>{console.error(error.message);process.exitCode=1;});
