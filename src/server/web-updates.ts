import { mkdirSync, createWriteStream, existsSync, createReadStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const repo="https://api.github.com/repos/Ceeyu-iooi/lingxi-workbench-web";
const valid=(tag:string)=>/^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
const compare=(a:string,b:string)=>{const x=valid(a),y=valid(b);if(!x||!y)return 0;for(let i=1;i<4;i++){const n=Number(x[i])-Number(y[i]);if(n)return n;}return 0;};
async function fetchAsset(url:string,signal:AbortSignal){
 for(let i=0;i<6;i++){
  const parsed=new URL(url);
  if(parsed.protocol!=="https:"||!["api.github.com","github.com","release-assets.githubusercontent.com","objects.githubusercontent.com"].includes(parsed.hostname))throw new Error("更新来源不正确");
  const r=await fetch(url,{signal,redirect:"manual",headers:{"User-Agent":"Lingxi-Updates"}});
  if(r.status>=300&&r.status<400){const next=r.headers.get("location");if(!next)throw new Error("更新地址不可用");url=new URL(next,url).href;continue;}
  if(!r.ok)throw new Error("更新获取失败，请稍后重试");return r;
 }throw new Error("更新重定向次数过多");
}
/** Browser builds can check and retrieve verified installers without an install bridge. */
export class WebUpdates {
 private current:any; private release:any; private controller?:AbortController;
 constructor(private profileRoot:string,private version:string){this.current={status:"idle",version,progress:0,canInstall:false};}
 state(){return {...this.current};}
 async check(){
  if(this.current.status==="downloading")return this.state();
  this.current={...this.current,status:"checking",error:""};
  try{
   const r=await fetchAsset(repo+"/releases?per_page=100",AbortSignal.timeout(20000)),list=await r.json() as any[];
   this.release=list.filter(r=>!r.draft&&valid(r.tag_name)&&r.assets?.some((a:any)=>a.name===`Lingxi-Workbench-${r.tag_name.replace(/^v/,"")}-x64-Setup.exe`)&&r.assets?.some((a:any)=>a.name==="SHA256SUMS.txt")).sort((a,b)=>compare(b.tag_name,a.tag_name))[0];
   if(!this.release)throw new Error("暂未找到完整的发布包");
   const next=this.release.tag_name.replace(/^v/,"");this.current={...this.current,status:compare(next,this.version)>0?"available":"latest",availableVersion:compare(next,this.version)>0?next:null,releaseNotes:String(this.release.body||"").slice(0,12000)};
  }catch(error){this.current={...this.current,status:"error",error:error instanceof Error?error.message:"检查更新失败"};}
  return this.state();
 }
 download(){
  if(this.current.status!=="available")return this.state();
  this.controller=new AbortController();this.current={...this.current,status:"downloading",progress:0,error:""};
  void this.receive(this.controller.signal).catch(error=>{this.current={...this.current,status:"error",error:error instanceof Error?error.message:"下载失败"};});
  return this.state();
 }
 private async receive(signal:AbortSignal){
  const name=`Lingxi-Workbench-${this.current.availableVersion}-x64-Setup.exe`,asset=this.release.assets.find((a:any)=>a.name===name),sumAsset=this.release.assets.find((a:any)=>a.name==="SHA256SUMS.txt");
  const sums=await (await fetchAsset(sumAsset.browser_download_url,signal)).text();
  const expected=sums.split(/\r?\n/).map(s=>s.trim().split(/\s+/)).find(s=>s[1]===name)?.[0];
  if(!expected||! /^[a-f\d]{64}$/i.test(expected))throw new Error("安装包缺少有效校验摘要");
  const directory=join(this.profileRoot,"updates","web");mkdirSync(directory,{recursive:true});const target=join(directory,name),part=target+".part",hash=createHash("sha256");let bytes=0;
  const response=await fetchAsset(asset.browser_download_url,signal);if(!response.body)throw new Error("安装包响应为空");
  const meter=new Transform({transform:(chunk,_,done)=>{bytes+=chunk.length;if(bytes>1024*1024*1024)return done(new Error("安装包超过允许大小"));hash.update(chunk);this.current.progress=Math.min(99,bytes/Math.max(1,asset.size)*100);done(null,chunk);}});
  try{await pipeline(Readable.fromWeb(response.body as any),meter,createWriteStream(part),{signal});if(bytes!==asset.size||hash.digest("hex")!==expected.toLowerCase())throw new Error("安装包完整性校验失败");await rename(part,target);this.current={...this.current,status:"downloaded",progress:100,file:name};}
  catch(error){await unlink(part).catch(()=>{});throw error;}
 }
 file(){if(this.current.status!=="downloaded"||!this.current.file)throw new Error("请先下载并校验安装包");const path=join(this.profileRoot,"updates","web",this.current.file);if(!existsSync(path))throw new Error("安装包已移除，请重新下载");return {name:this.current.file,stream:createReadStream(path)};}
 close(){this.controller?.abort();}
}
