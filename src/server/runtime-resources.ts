import {randomUUID} from 'node:crypto';
import {cpus,totalmem,freemem} from 'node:os';
import {lstat,readdir,statfs,unlink} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,sep,parse} from 'node:path';
import {channel} from 'node:diagnostics_channel';
import type {ProfileStore} from './profile.ts';

const LIMIT=2*1024*1024;
export function redactResourceUrl(input:string){
  try{const u=new URL(input);u.username='';u.password='';u.hash='';u.pathname=u.pathname.split('/').map(s=>s.length>40||/^(sk-|eyJ)/.test(s)?'[redacted]':s).join('/');for(const k of [...u.searchParams.keys()])u.searchParams.set(k,'[redacted]');return u.href.slice(0,2048);}catch{return '地址未提供';}
}
type Entry={id:string;at:string;source:string;pid:number|null;method:string;url:string;status:number|null;elapsedMs:number|null};
type File={path:string;bytes:number;mtime:number;category:string};
const within=(root:string,target:string)=>{const rel=relative(resolve(root),resolve(target));return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);};
export class RuntimeResources{
  private lease='';private leaseUntil=0;private owner='';private entries:Entry[]=[];private bytes=0;private dropped=0;private leaseTimer:ReturnType<typeof setTimeout>|null=null;
  private disposers:(()=>void)[]=[];private pending=new WeakMap<object,Entry>();
  private previousCpu=process.cpuUsage();private previousAt=performance.now();private previousHost=cpus();
  private scan:{id:string;status:string;startedAt:string;finishedAt?:string;files:number;bytes:number;categories:any[];disks:any[];error?:string}|null=null;
  private directories:{path:string;mtime:number}[]=[];private directoryCursor=0;private fileCursor=0;private lastCheck=0;private lastScan=0;private checking=false;
  private files:File[]=[];private fileBytes=0;private scanAbort:AbortController|null=null;private cleaning=false;
  constructor(private profile:ProfileStore,private programRoot:string,private pendingUpdate=()=>false){
    const subscribe=(name:string,fn:(value:any)=>void)=>{const c=channel(name);c.subscribe(fn);this.disposers.push(()=>c.unsubscribe(fn));};
    subscribe('undici:request:create',({request})=>{if(!this.active())return;this.pending.set(request,{id:randomUUID(),at:new Date().toISOString(),source:'后台请求',pid:process.pid,method:String(request.method),url:redactResourceUrl(request.origin+request.path),status:null,elapsedMs:-performance.now()});});
    subscribe('undici:request:headers',({request,response})=>this.finishRequest(request,response.statusCode));
    subscribe('undici:request:error',({request})=>this.finishRequest(request,null));
  }
  private active(){if(!this.lease)return false;if(this.leaseUntil<=Date.now()||this.owner!==this.profile.owner){this.stop();return false;}return true;}
  private renew(){this.leaseUntil=Date.now()+7000;if(this.leaseTimer)clearTimeout(this.leaseTimer);this.leaseTimer=setTimeout(()=>this.stop(),7000);this.leaseTimer.unref?.();}
  session(active:boolean,id?:string){if(!active){if(id===this.lease)this.stop();return {id:null};}if(!id||id!==this.lease||this.owner!==this.profile.owner){this.stop();this.lease=randomUUID();this.owner=this.profile.owner;}this.renew();return {id:this.lease};}
  touch(id:string){if(!this.active()||id!==this.lease)throw Error('资源采样会话已关闭');this.renew();}
  stop(){if(this.leaseTimer)clearTimeout(this.leaseTimer);this.leaseTimer=null;this.lease='';this.leaseUntil=0;this.entries=[];this.bytes=0;this.dropped=0;this.pending=new WeakMap();this.cancelScan();this.files=[];this.fileBytes=0;this.scan=null;this.directories=[];}
  record(value:Omit<Entry,'id'|'at'>){if(!this.active())return;this.add({id:randomUUID(),at:new Date().toISOString(),...value,url:redactResourceUrl(value.url)});}
  private finishRequest(request:object,status:number|null){const row=this.pending.get(request);this.pending.delete(request);if(row&&this.active()){row.status=status;row.elapsedMs=Math.max(0,Math.round(performance.now()+Number(row.elapsedMs)));this.add(row);}}
  private add(row:Entry){const size=Buffer.byteLength(JSON.stringify(row));this.entries.push(row);this.bytes+=size;while(this.entries.length>1000||this.bytes>LIMIT){this.bytes-=Buffer.byteLength(JSON.stringify(this.entries.shift()));this.dropped++;}}
  network(id:string,filter='',page=1){this.touch(id);const rows=this.entries.filter(e=>(e.url+' '+e.source+' '+e.pid+' '+e.method).toLowerCase().includes(filter.toLowerCase().slice(0,256)));const pages=Math.max(1,Math.ceil(rows.length/50));page=Math.max(1,Math.min(pages,Math.floor(page)||1));return {entries:rows.slice().reverse().slice((page-1)*50,page*50),total:rows.length,page,pages,dropped:this.dropped,bytes:this.bytes};}
  clearNetwork(id:string){this.touch(id);this.entries=[];this.bytes=0;this.dropped=0;return {ok:true};}
  snapshot(){
    const now=performance.now(),elapsed=Math.max(1,now-this.previousAt),current=process.cpuUsage(),cores=Math.max(1,cpus().length),host=cpus();
    const cpu=Math.min(100,Math.max(0,((current.user-this.previousCpu.user)+(current.system-this.previousCpu.system))/1000/elapsed/cores*100));
    let ticks=0,idle=0;host.forEach((c,i)=>{const old=this.previousHost[i]?.times;if(!old)return;for(const k of ['user','nice','sys','idle','irq'] as const)ticks+=c.times[k]-old[k];idle+=c.times.idle-old.idle;});
    this.previousCpu=current;this.previousAt=now;this.previousHost=host;const memory=process.memoryUsage();
    return {sampledAt:new Date().toISOString(),system:{cpuPercent:ticks?Math.max(0,(1-idle/ticks)*100):null,memoryBytes:totalmem()-freemem(),totalMemoryBytes:totalmem(),logicalCpus:cores},processes:[{name:'后台服务',group:'基础服务',pid:process.pid,cpuPercent:cpu,memoryBytes:memory.rss,privateBytes:null,heapBytes:memory.heapUsed}]};
  }
  async refreshStorage(){
    if(this.scan?.status==='complete'&&!this.checking&&Date.now()-this.lastCheck>=1000){
      this.checking=true;this.lastCheck=Date.now();try{let changed=false;const batch=this.directories.slice(this.directoryCursor,this.directoryCursor+32);this.directoryCursor=(this.directoryCursor+32)%Math.max(1,this.directories.length);for(const directory of batch){const current=await lstat(directory.path).catch(()=>null);if(!current||current.mtimeMs!==directory.mtime)changed=true;}const files=this.files.slice(this.fileCursor,this.fileCursor+32);this.fileCursor=(this.fileCursor+32)%Math.max(1,this.files.length);for(const file of files){const current=await lstat(file.path).catch(()=>null);if(!current||current.size!==file.bytes||current.mtimeMs!==file.mtime)changed=true;}if(changed&&Date.now()-this.lastScan>10000)this.startScan();}finally{this.checking=false;}
    }return this.storage();
  }
  storage(){return this.scan?{...this.scan,categories:this.scan.categories.map(c=>({...c}))}:{status:'idle',categories:[],disks:[]};}
  cancelScan(){this.scanAbort?.abort();if(this.scan?.status==='scanning')this.scan.status='cancelled';this.scanAbort=null;return this.storage();}
  startScan(){if(this.cleaning)throw Error('清理进行中');if(this.scan?.status==='scanning')return this.storage();this.scanAbort=new AbortController();const signal=this.scanAbort.signal,id=randomUUID(),owner=this.profile.owner;const previous=this.scan;this.lastScan=Date.now();this.directories=[];this.directoryCursor=0;this.files=[];this.fileBytes=0;this.scan={id,status:'scanning',startedAt:new Date().toISOString(),files:0,bytes:0,categories:previous?.categories||[],disks:previous?.disks||[]};void this.scanFiles(id,owner,signal);return this.storage();}
  private async scanFiles(id:string,owner:string,signal:AbortSignal){
    const categories=[{id:'program',name:'程序与运行时',root:resolve(this.programRoot),cleanable:false},{id:'data',name:'真实用量、证据与工作资料',root:join(this.profile.root,'data'),cleanable:false},{id:'config',name:'配置与凭据',root:join(this.profile.root,'config'),cleanable:false},{id:'cache',name:'可重建缓存',root:join(this.profile.root,'cache'),cleanable:true},{id:'updates',name:'更新包',root:join(this.profile.root,'updates'),cleanable:true},{id:'logs',name:'轮转日志',root:join(this.profile.root,'logs'),cleanable:true},{id:'browser',name:'应用界面存储',root:join(this.profile.root,'browser'),cleanable:false},{id:'other',name:'其他 Profile 文件',root:this.profile.root,cleanable:false}].map(c=>({...c,bytes:0,files:0}));
    const active=()=>!signal.aborted&&this.scan?.id===id&&this.profile.owner===owner;
    const indexed=new Map<string,number>();
    const unreadable=new Map<string,number>();const roots=new Set(categories.filter(c=>c.id!=='other').map(c=>resolve(c.root)));
    try{for(const c of categories){const stack=[c.root];while(stack.length){if(!active())return;const path=stack.pop()!;if(c.id==='other'&&path!==c.root&&roots.has(resolve(path)))continue;if(c.id==='program'&&within(this.profile.root,path))continue;if(c.id==='program'&&/[/\\](node_modules|\.runtime|\.git)$/.test(path)&&!process.env.WORKBENCH_DESKTOP)continue;
      let stat;try{stat=await lstat(path);}catch(error:any){if(error.code!=='ENOENT')unreadable.set(c.id,(unreadable.get(c.id)||0)+1);continue;}if(stat.isSymbolicLink())continue;
      if(stat.isDirectory()){if(this.directories.length<4096)this.directories.push({path,mtime:stat.mtimeMs});const names=await readdir(path);for(const n of names)stack.push(join(path,n));}
      else if(stat.isFile()){c.bytes+=stat.size;c.files++;this.scan!.bytes+=stat.size;this.scan!.files++;const cost=Buffer.byteLength(path)+96;if(this.fileBytes+cost<=LIMIT&&(indexed.get(c.id)||0)+cost<=LIMIT/categories.length){indexed.set(c.id,(indexed.get(c.id)||0)+cost);this.files.push({path,bytes:stat.size,mtime:stat.mtimeMs,category:c.id});this.fileBytes+=cost;}}
      if(this.scan!.files%128===0){this.scan!.categories=categories.map(x=>({...x}));await new Promise(resolve=>setImmediate(resolve));}
    }}if(!active())return;const disks:any[]=[];for(const path of [...new Set([this.profile.root,this.programRoot])]){const volume=parse(resolve(path)).root;const prior=disks.find(d=>d.path===volume);if(prior){prior.paths.push(path);continue;}try{const s=await statfs(path);disks.push({path:volume,paths:[path],categories:categories.filter(c=>parse(resolve(c.root)).root===volume).map(c=>({id:c.id,name:c.name,bytes:c.bytes})),totalBytes:Number(s.blocks)*Number(s.bsize),freeBytes:Number(s.bavail)*Number(s.bsize)});}catch{}}
    this.scan!.categories=categories.map(x=>({...x,unreadable:unreadable.get(x.id)||0}));this.scan!.disks=disks;this.scan!.status='complete';this.scan!.finishedAt=new Date().toISOString();
    }catch(error){if(active()){this.scan!.status='failed';this.scan!.error=error instanceof Error?error.message:'扫描失败';}}
  }
  details(id:string,category:string,page=1){if(this.scan?.id!==id)throw Error('存储扫描已过期');const items=this.files.filter(f=>f.category===category);page=Math.max(1,Math.floor(page)||1);return {items:items.slice((page-1)*50,page*50).map(f=>({name:relative(category==='program'?this.programRoot:this.profile.root,f.path),bytes:f.bytes})),total:items.length,scannedTotal:this.scan.categories.find(c=>c.id===category)?.files||0,page};}
  private eligible(file:File){const age=Date.now()-file.mtime;if(file.category==='cache')return age>86400000;if(file.category==='logs')return age>7*86400000&&/\.(?:log\.\d+|log\.gz|old)$/i.test(file.path);if(file.category==='updates')return !this.pendingUpdate()&&age>86400000&&!/[/\\]pending[/\\]/i.test(file.path);return false;}
  preview(id:string,category:string){if(this.scan?.id!==id||this.scan.status!=='complete')throw Error('请先完成最新存储扫描');if(!['cache','updates','logs'].includes(category))throw Error('该资料不能清理');const files=this.files.filter(f=>f.category===category&&this.eligible(f));return {scanId:id,category,files:files.length,bytes:files.reduce((n,f)=>n+f.bytes,0),scope:'只删除已索引的过期可重建文件；保留真实资料、近期文件和待安装更新。明细索引最多2MiB，较大目录可分次清理'};}
  async clean(id:string,category:string){if(this.cleaning)throw Error('清理进行中');const preview=this.preview(id,category),owner=this.profile.owner;this.cleaning=true;let removed=0,bytes=0;const failed:string[]=[];
    try{for(const file of this.files.filter(f=>f.category===category&&this.eligible(f))){if(this.profile.owner!==owner||this.scan?.id!==id)throw Error('资料身份已改变，停止清理');try{if(!within(this.profile.root,file.path)||!within(join(this.profile.root,category),file.path))throw Error('路径越界');let cursor=file.path;while(cursor!==resolve(this.profile.root)){if((await lstat(cursor)).isSymbolicLink())throw Error('路径包含链接');cursor=resolve(cursor,'..');}const st=await lstat(file.path);if(!st.isFile()||st.size!==file.bytes||st.mtimeMs!==file.mtime||!this.eligible(file))throw Error('文件已变化');await unlink(file.path);removed++;bytes+=file.bytes;}catch{failed.push(relative(this.profile.root,file.path));}}return {...preview,removed,removedBytes:bytes,failed};}finally{this.cleaning=false;this.scan=null;this.files=[];}}
  close(){this.stop();this.disposers.forEach(f=>f());this.disposers=[];this.files=[];}
}
