import {spawn} from 'node:child_process';
/** OS URL association; never launch a browser with a private profile or debugger. */
export function openSystemBrowser(address:string){
  const url=new URL(address);if(!['http:','https:'].includes(url.protocol))throw Error('浏览器地址不正确');
  const executable=process.platform==='win32'?'explorer.exe':process.platform==='darwin'?'open':'xdg-open';
  const child=spawn(executable,[url.href],{windowsHide:true,stdio:'ignore',detached:process.platform!=='win32'});child.on('error',()=>{});child.unref();
}
