import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';
import {openSystemBrowser} from './external-browser.ts';
import type {UsageAccounts} from './usage-accounts.ts';
type Status={id:string;connectionId:string;status:'waiting'|'needs_extension'|'syncing'|'complete'|'failed'|'cancelled';error?:string;expiresAt:number};
/** Explicit, short-lived authorization through the system browser. */
export class DeepseekAuthorization {
  private task:Status|null=null;
  private pairToken='';
  private timeout:ReturnType<typeof setTimeout>|null=null;
  private detection:ReturnType<typeof setTimeout>|null=null;
  constructor(private accounts:UsageAccounts,private origin=()=> 'http://127.0.0.1:8765',private openBrowser=openSystemBrowser){}
  state(){return this.task?{...this.task}:{status:'idle'};}
  start(connectionId:string){
    const row=this.accounts.rows().find(r=>r.id===connectionId&&r.kind==='deepseek');if(!row)throw Error('请先导入 DeepSeek API Key');
    if(this.task&&['waiting','needs_extension','syncing'].includes(this.task.status)){if(this.task.connectionId!==connectionId)throw Error('请先完成或取消当前授权');return this.state();}
    this.close();this.task={id:randomUUID(),connectionId,status:'waiting',expiresAt:Date.now()+180000};const id=this.task.id;
    const existing=this.accounts.control.profile.credentials()['platform:'+connectionId];
    if(existing&&row.keyTrackingId){this.task.status='syncing';void this.accounts.sync(connectionId).then(result=>{if(this.task?.id!==id||this.task.status==='cancelled')return;if(result.ok&&this.historyReady(connectionId)){this.task.status='complete';this.close();}else{this.task.status='waiting';this.open(id);}}).catch(()=>this.fail('历史查询失败，请重试',id));}
    else this.open(id);return this.state();
  }
  private historyReady(id:string){const s=this.accounts.rows().find(r=>r.id===id)?.snapshot;return s?.historyAvailable===true&&!s.unavailable?.tokens;}
  private open(id:string){
    if(this.task?.id!==id||this.task.status!=='waiting')return;
    this.pairToken=randomBytes(32).toString('hex');
    const origin=this.origin(),parsed=new URL(origin);if(parsed.protocol!=='http:'||parsed.hostname!=='127.0.0.1')return this.fail('本机配对地址不正确',id);
    const pairing={origin,id,pairToken:this.pairToken,expiresAt:this.task.expiresAt};
    this.timeout=setTimeout(()=>this.fail('授权等待已超时，请重新获取',id),180000);this.timeout.unref?.();
    this.detection=setTimeout(()=>{if(this.task?.id===id&&this.task.status==='waiting'){this.task.status='needs_extension';this.task.error='请在默认浏览器安装灵犀 DeepSeek 授权桥，然后重新获取。';}},5000);this.detection.unref?.();
    try{this.openBrowser(origin+'/bridge/deepseek#'+encodeURIComponent(JSON.stringify(pairing)));}catch{this.fail('系统默认浏览器未能打开，请重试',id);}
  }
  private validate(id:string,token:string){
    if(!this.task||this.task.id!==id||!['waiting','needs_extension'].includes(this.task.status)||this.task.expiresAt<Date.now()||!/^[a-f0-9]{64}$/.test(token)||this.pairToken.length!==64||!timingSafeEqual(Buffer.from(token),Buffer.from(this.pairToken)))throw Error('授权配对已失效');
    return this.task;
  }
  pairedState(id:string,token:string){this.validate(id,token);return this.state();}
  handshake(id:string,token:string){const task=this.validate(id,token);task.status='waiting';delete task.error;if(this.detection)clearTimeout(this.detection);this.detection=null;return this.state();}
  async receive(id:string,token:string,credential:string){
    const task=this.validate(id,token);if(typeof credential!=='string'||credential.length>4096||!/^\S+$/.test(credential))throw Error('平台授权格式不正确');
    task.status='syncing';delete task.error;const owner=this.accounts.control.profile.owner;
    const active=()=>this.task?.id===id&&this.task.status==='syncing'&&this.accounts.control.profile.owner===owner;
    try{await this.accounts.authorizeDeepseek(task.connectionId,credential,active);if(!active())throw Error('授权已取消');const result=await this.accounts.sync(task.connectionId);if(!active())throw Error('授权已取消');if(!result.ok||!this.historyReady(task.connectionId))throw Error('授权已取得，历史查询暂未完成，请稍后重试');task.status='complete';this.close();}
    catch(error){this.fail(error instanceof Error?error.message:'历史读取失败',id);throw Error('平台账户与 Key 不匹配、授权取消或历史查询失败，请重新获取');}
    return this.state();
  }
  private fail(message:string,id?:string){if(id&&this.task?.id!==id)return;if(this.task&&['waiting','needs_extension','syncing'].includes(this.task.status)){this.task.status='failed';this.task.error=message;}this.close();}
  cancel(){if(this.task&&['waiting','needs_extension','syncing'].includes(this.task.status))this.task.status='cancelled';this.close();return this.state();}
  close(){if(this.timeout)clearTimeout(this.timeout);if(this.detection)clearTimeout(this.detection);this.timeout=null;this.detection=null;this.pairToken='';}
}
