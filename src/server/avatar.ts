import {Worker} from 'node:worker_threads';import {existsSync} from 'node:fs';import {fileURLToPath} from 'node:url';
let queue:Promise<void>=Promise.resolve();
export function normalizeAvatar(raw:Buffer):Promise<Buffer>{const task=queue.then(()=>run(raw));queue=task.then(()=>undefined,()=>undefined);return task;}
function run(raw:Buffer):Promise<Buffer>{return new Promise((resolve,reject)=>{
 const compiled=new URL('./avatar-worker.mjs',import.meta.url),worker=new Worker(existsSync(compiled)?compiled:new URL('./avatar-worker.ts',import.meta.url),{workerData:raw,resourceLimits:{maxOldGenerationSizeMb:96}});let done=false;const timer=setTimeout(()=>finish(Error('头像处理超时')),15000);const finish=async(error?:Error,png?:Buffer)=>{if(done)return;done=true;clearTimeout(timer);await worker.terminate();error?reject(error):resolve(png!);};worker.once('message',value=>value.png?finish(undefined,Buffer.from(value.png)):finish(Error('请选择静态 PNG、JPEG 或 WebP 图片')));worker.once('error',()=>finish(Error('头像处理失败')));worker.once('exit',code=>{if(!done)finish(Error('头像处理未完成'));});
 });}
