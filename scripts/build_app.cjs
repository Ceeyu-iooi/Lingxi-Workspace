'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),output=path.join(root,'.runtime/web-ui');
const result=spawnSync(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'build','--config',path.join(root,'vite.app.config.mts')],{cwd:root,stdio:'inherit',windowsHide:true});
if(result.status!==0)process.exit(result.status||1);
// Business controllers are bundled in the React application. Keep only the
// licensed integration and page resources, rather than shipping obsolete login.
for(const file of fs.readdirSync(output))if(file.endsWith('.js'))fs.unlinkSync(path.join(output,file));
