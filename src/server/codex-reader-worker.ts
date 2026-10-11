import {parentPort,workerData} from 'node:worker_threads';
import {basename} from 'node:path';
import {parseCodexFile} from './codex-reader.ts';
const result=[];
for(const file of workerData as string[]){
  try{result.push({path:file,item:await parseCodexFile(file)});}
  catch(error:any){result.push({path:file,error:{file:basename(file),error:String(error.message).slice(0,160)}});}
}
parentPort!.postMessage(result);
