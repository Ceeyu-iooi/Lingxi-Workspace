'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),output=process.env.LINGXI_WEB_OUT?path.resolve(process.env.LINGXI_WEB_OUT):path.join(root,'.runtime/web-ui');
const result=spawnSync(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'build','--config',path.join(root,'vite.app.config.mts'),...(process.env.LINGXI_WEB_OUT?['--outDir',process.env.LINGXI_WEB_OUT]:[])],{cwd:root,stdio:'inherit',windowsHide:true});
if(result.status!==0)process.exit(result.status||1);
fs.writeFileSync(path.join(output,'build.json'),JSON.stringify({version:fs.readFileSync(path.join(root,'VERSION'),'utf8').trim(),frontend:'react-typescript-vite',builtAt:new Date().toISOString()},null,2));
// Business controllers are bundled in the React application. Keep only the
// licensed integration and page resources, rather than shipping obsolete login.
for(const file of fs.readdirSync(output))if(file.endsWith('.js'))fs.unlinkSync(path.join(output,file));
