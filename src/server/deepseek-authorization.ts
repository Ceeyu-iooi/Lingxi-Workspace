import {spawn,type ChildProcess} from 'node:child_process';
import {existsSync,mkdirSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import type {UsageAccounts} from './usage-accounts.ts';

type Status={id:string;connectionId:string;status:'waiting'|'syncing'|'complete'|'failed'|'cancelled';error?:string};
/** Short-lived, same-Profile authorization. No passwords, tokens or page bodies
 * are returned to the application renderer or written to diagnostic logs. */
export class DeepseekAuthorization {
  private task:Status|null=null;
  private child:ChildProcess|null=null;
  private socket:WebSocket|null=null;
  private browserSocket:WebSocket|null=null;
  private timeout:ReturnType<typeof setTimeout>|null=null;
  private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();
  private sequence=0;
  private accepting=false;
  constructor(private accounts:UsageAccounts){}
  state(){return this.task?{...this.task}:{status:'idle'};}
  start(connectionId:string){
    const row=this.accounts.rows().find(r=>r.id===connectionId&&r.kind==='deepseek');
    if(!row)throw Error('请先导入 DeepSeek API Key');
    if(this.task&&['waiting','syncing'].includes(this.task.status)){
      if(this.task.connectionId!==connectionId)throw Error('请先完成或取消当前授权');
      return this.state();
    }
    this.task={id:randomUUID(),connectionId,status:'waiting'};
    const id=this.task.id;
    const existing=this.accounts.control.profile.credentials()['platform:'+connectionId];
    if(existing&&row.keyTrackingId){this.task.status='syncing';void this.accounts.sync(connectionId).then(result=>{if(this.task?.id!==id||this.task.status==='cancelled')return;if(result.ok&&this.historyReady(connectionId)){this.task.status='complete';this.close();}else {this.task.status='waiting';void this.open(id).catch(error=>this.fail(error.message,id));}}).catch(()=>this.fail('历史查询失败，请重试',id));}
    else void this.open(id).catch(error=>this.fail(error.message,id));
    return this.state();
  }
  private send(method:string,params:any={}){
    return new Promise<any>((resolve,reject)=>{if(this.socket?.readyState!==WebSocket.OPEN){reject(Error('授权窗口已关闭'));return;}const id=++this.sequence;this.pending.set(id,{resolve,reject});this.socket.send(JSON.stringify({id,method,params}));});
  }
  private historyReady(id:string){const snapshot=this.accounts.rows().find(row=>row.id===id)?.snapshot;return snapshot?.historyAvailable===true&&!snapshot.unavailable?.tokens;}
  private async open(id:string){
    const active=()=>this.task?.id===id&&this.task.status==='waiting';
    if(!active())return;
    const executable=[join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe'),join(process.env.ProgramFiles||'C:/Program Files','Microsoft/Edge/Application/msedge.exe')].find(existsSync);
    if(!executable)throw Error('未找到 Microsoft Edge，请安装后再获取历史用量');
    const p=this.accounts.control.profile,owner=p.owner;
    const folder=join(p.root,'browser','deepseek-authorization');mkdirSync(folder,{recursive:true});
    try{unlinkSync(join(folder,'DevToolsActivePort'));}catch(error:any){if(error.code!=='ENOENT')throw error;}
    this.child=spawn(executable,['--user-data-dir='+folder,'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--disable-sync','--app=https://platform.deepseek.com/usage'],{windowsHide:true,stdio:'ignore'});
    this.child.once('error',()=>this.fail('无法打开 DeepSeek 官方授权窗口',id));
    this.timeout=setTimeout(()=>this.fail('授权等待已超时，请重新点击获取',id),180000);
    // DevToolsActivePort belongs to our isolated browser directory, never to
    // the user's existing browser. Poll only while this one launch is pending.
    const {readFile}=await import('node:fs/promises');
    let port=0;
    for(let n=0;n<80&&this.task?.id===id&&this.task.status==='waiting';n++){
      try{port=Number((await readFile(join(folder,'DevToolsActivePort'),'utf8')).split('\n')[0]);if(port>0&&port<65536)break;}catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(!active())return;
    if(!port)throw Error('授权窗口未能准备就绪');
    const origin='http://127.0.0.1:'+port;
    const version=await(await fetch(origin+'/json/version',{signal:AbortSignal.timeout(5000)})).json() as any;
    const targets=await(await fetch(origin+'/json/list',{signal:AbortSignal.timeout(5000)})).json() as any[];
    if(!active())return;
    const target=targets.find(t=>{try{return t.type==='page'&&new URL(t.url).hostname==='platform.deepseek.com';}catch{return false;}})||targets.find(t=>{try{return t.type==='page'&&new URL(t.url).hostname.endsWith('.deepseek.com');}catch{return false;}});
    if(!target)throw Error('未找到 DeepSeek 官方授权页面');
    const validateSocket=(url:string)=>{const u=new URL(url);if(u.protocol!=='ws:'||!['localhost','127.0.0.1'].includes(u.hostname)||Number(u.port)!==port)throw Error('授权窗口连接不匹配');return url;};
    this.browserSocket=new WebSocket(validateSocket(version.webSocketDebuggerUrl));
    this.socket=new WebSocket(validateSocket(target.webSocketDebuggerUrl));
    const socket=this.socket;
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>done(Error('授权窗口连接超时')),5000);
      const opened=()=>done(),failed=()=>done(Error('授权窗口连接失败'));
      const done=(error?:Error)=>{clearTimeout(timer);socket.removeEventListener('open',opened);socket.removeEventListener('error',failed);socket.removeEventListener('close',failed);error?reject(error):resolve();};
      socket.addEventListener('open',opened,{once:true});socket.addEventListener('error',failed,{once:true});socket.addEventListener('close',failed,{once:true});
    });
    if(!active())return;
    const requests=new Map<string,string>(),extra=new Map<string,Record<string,unknown>>(),seen=new Set<string>();
    const accept=(headers:Record<string,unknown>)=>{
      const auth=Object.entries(headers).find(([name])=>name.toLowerCase()==='authorization')?.[1];
      if(typeof auth!=='string'||auth.length>4096||!/^Bearer\s+\S+$/i.test(auth)||this.accepting||this.task?.id!==id||this.task.status!=='waiting')return;
      const fingerprint=createHash('sha256').update(auth).digest('hex');if(seen.has(fingerprint))return;seen.add(fingerprint);
      this.accepting=true;this.task.status='syncing';delete this.task.error;
      let bound=false;
      void this.accounts.authorizeDeepseek(this.task.connectionId,auth.replace(/^Bearer\s+/i,''),()=>this.task?.id===id&&this.task.status==='syncing').then(async()=>{
        if(this.task?.id!==id||this.task.status!=='syncing'||p.owner!==owner)return;
        bound=true;
        const result=await this.accounts.sync(this.task.connectionId);
        if(!result.ok||!this.historyReady(this.task.connectionId))throw Error('历史查询失败');
        if(this.task?.id===id&&this.task.status==='syncing'){this.task.status='complete';this.close();}
      }).catch(()=>{if(this.task?.id===id&&this.task.status==='syncing'){if(bound){this.fail('已取得授权，但平台暂未返回历史用量；余额和已有历史已保留，请稍后重试',id);}else {this.task.status='waiting';this.task.error='请在官方窗口登录此 Key 所属账户，授权完成后自动重试';this.accepting=false;}}});
    };
    this.socket.addEventListener('message',event=>{
      let message:any;try{message=JSON.parse(String(event.data));}catch{return;}
      if(message.id){const waiting=this.pending.get(message.id);if(waiting){this.pending.delete(message.id);message.error?waiting.reject(Error('官方页面暂不可用')):waiting.resolve(message.result);}return;}
      if(message.method==='Network.requestWillBeSentExtraInfo'){
        const requestId=message.params?.requestId,headers=message.params?.headers||{};
        if(requests.has(requestId))accept(headers);else {extra.set(requestId,headers);if(extra.size>128)extra.delete(extra.keys().next().value!);}return;
      }
      if(message.method!=='Network.requestWillBeSent')return;
      const request=message.params?.request;
      try{if(new URL(request.url).origin!=='https://platform.deepseek.com'||!new URL(request.url).pathname.startsWith('/api/v0/'))return;}catch{return;}
      const requestId=message.params.requestId;requests.set(requestId,request.url);if(requests.size>128)requests.delete(requests.keys().next().value!);
      accept(request.headers||{});if(extra.has(requestId)){accept(extra.get(requestId)!);extra.delete(requestId);}
    });
    this.socket.addEventListener('close',()=>{if(this.task?.id===id&&this.task.status==='waiting')this.fail('官方授权窗口已关闭，可重新获取',id);});
    await this.send('Network.enable');
    await this.send('Page.reload',{ignoreCache:false});
  }
  private fail(message:string,id?:string){if(id&&this.task?.id!==id)return;if(this.task&&['waiting','syncing'].includes(this.task.status)){this.task.status='failed';this.task.error=message;}this.close();}
  cancel(){if(this.task&&['waiting','syncing'].includes(this.task.status))this.task.status='cancelled';this.close();return this.state();}
  close(){
    if(this.timeout)clearTimeout(this.timeout);this.timeout=null;
    for(const item of this.pending.values())item.reject(Error('授权窗口已关闭'));this.pending.clear();
    this.socket?.close();this.socket=null;
    if(this.browserSocket?.readyState===WebSocket.OPEN)this.browserSocket.send(JSON.stringify({id:1,method:'Browser.close'}));
    else this.child?.kill();
    this.browserSocket?.close();this.browserSocket=null;this.child=null;this.accepting=false;
  }
}
