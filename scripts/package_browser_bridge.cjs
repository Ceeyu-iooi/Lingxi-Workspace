'use strict';
const fs=require('node:fs'),path=require('node:path'),{ZipFile}=require('yazl');
const root=path.resolve(__dirname,'..'),source=path.join(root,'browser-extension/deepseek'),target=path.join(root,'static/extensions');
fs.mkdirSync(target,{recursive:true});const zip=new ZipFile();
for(const name of ['manifest.json','background.js','pair.js','capture.js','official.js','README.md'])zip.addFile(path.join(source,name),'deepseek/'+name);
const output=fs.createWriteStream(path.join(target,'deepseek-bridge.zip'));zip.outputStream.pipe(output);zip.end();output.on('error',error=>{console.error(error.message);process.exitCode=1;});
