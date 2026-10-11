import {Worker} from 'node:worker_threads';
import {existsSync,statSync} from 'node:fs';
import {basename} from 'node:path';
import {parseCodexFile} from './codex-reader.ts';
type Parsed={path:string;item?:any;error?:{file:string;error:string}};
// Only large first acquisitions need CPU parallelism. Two short-lived readers
// never open Profile/credentials or write the database; commit order stays fixed.
export async function parseCodexBatch(files:string[]):Promise<Parsed[]>{
  const compiled=new URL('./codex-reader-worker.mjs',import.meta.url);
  const sizes=files.map(path=>({path,size:Number(statSync(path).size)}));
  if(files.length<4||sizes.reduce((sum,file)=>sum+file.size,0)<32*1024*1024||!existsSync(compiled)){
    const rows:Parsed[]=[];
    for(const path of files)try{rows.push({path,item:await parseCodexFile(path)});}catch(error:any){rows.push({path,error:{file:basename(path),error:String(error.message).slice(0,160)}});}
    return rows;
  }
  const groups:[string[],string[]]=[[],[]],bytes=[0,0];
  for(const file of sizes.sort((a,b)=>b.size-a.size)){const i=bytes[0]<=bytes[1]?0:1;groups[i].push(file.path);bytes[i]+=file.size;}
  const run=(paths:string[])=>new Promise<Parsed[]>((resolve,reject)=>{
    const worker=new Worker(compiled,{workerData:paths,resourceLimits:{maxOldGenerationSizeMb:128}});
    let done=false;
    worker.once('message',(rows:Parsed[])=>{done=true;resolve(rows);});
    worker.once('error',reject);
    worker.once('exit',code=>{if(!done)reject(Error('Codex只读解析未完成（'+code+'）'));});
  });
  const rows=(await Promise.all(groups.map(run))).flat(),order=new Map(files.map((file,i)=>[file,i]));
  return rows.sort((a,b)=>order.get(a.path)!-order.get(b.path)!);
}
