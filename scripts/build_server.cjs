'use strict';
const path=require('node:path'),fs=require('node:fs');
const {build}=require('esbuild');
const root=path.resolve(__dirname,'..'),output=path.join(root,'.runtime/server');
fs.mkdirSync(output,{recursive:true});
Promise.all([build({entryPoints:[path.join(root,'src/server/main.ts')],outfile:path.join(output,'main.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',target:'node22',sourcemap:false}),build({entryPoints:[path.join(root,'src/server/maintain.ts')],outfile:path.join(output,'maintenance.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',target:'node22',sourcemap:false}),build({entryPoints:[path.join(root,'src/server/avatar-worker.ts')],outfile:path.join(output,'avatar-worker.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',target:'node24',sourcemap:false})]).then(()=>{fs.writeFileSync(path.join(output,'build.json'),JSON.stringify({version:fs.readFileSync(path.join(root,'VERSION'),'utf8').trim(),backend:'node-typescript',builtAt:new Date().toISOString()},null,2));console.log('Node TypeScript backend built');}).catch(error=>{console.error(error.message);process.exitCode=1;});
