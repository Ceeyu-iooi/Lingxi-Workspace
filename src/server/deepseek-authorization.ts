import {randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';
import type {UsageAccounts} from './usage-accounts.ts';
type Status={id:string;connectionId:string;status:'waiting'|'syncing'|'complete'|'failed'|'cancelled';error?:string;expiresAt:number};
export class DeepseekAuthorization{
 private task:Status|null=null;private token='';private timeout:ReturnType<typeof setTimeout>|null=null;private owner='';
 constructor(private accounts:UsageAccounts){}
 state(){return this.task?{...this.task}:{status:'idle'};}
 internalState(){return {...this.state(),pairToken:this.token};}
 start(connectionId:string,allowLogin=false){
  const row=this.accounts.rows().find(r=>r.id===connectionId&&r.kind==='deepseek');if(!row)throw Error('请先导入 DeepSeek API Key');
  if(this.task&&['waiting','syncing'].includes(this.task.status)){if(this.task.connectionId!==connectionId)throw Error('请先完成或取消当前授权');return this.state();}
  this.close();const id=randomUUID();this.owner=this.accounts.control.profile.owner;this.task={id,connectionId,status:'waiting',expiresAt:Date.now()+180000};this.token=randomBytes(32).toString('hex');
  this.timeout=setTimeout(()=>this.fail('授权等待已超时，请重试',id),180000);this.timeout.unref?.();
  const existing=this.accounts.control.profile.credentials()['platform:'+connectionId];
  const login=()=>{if(this.task?.id!==id||this.task.status==='cancelled')return;if(allowLogin){this.task.status='waiting';delete this.task.error;}else this.fail('请在桌面版完成 DeepSeek 历史授权；网页可查询余额并复用有效授权',id);};
  if(existing&&row.keyTrackingId){this.task.status='syncing';void this.accounts.sync(connectionId).then(result=>{if(this.task?.id!==id||this.task.status==='cancelled')return;if(result.ok&&this.historyReady(connectionId)){this.task.status='complete';this.close();}else login();}).catch(login);}else login();return this.state();
 }
 private historyReady(id:string){const snapshot=this.accounts.rows().find(r=>r.id===id)?.snapshot;return snapshot?.historyAvailable===true&&!snapshot.unavailable?.tokens;}
 async receive(id:string,token:string,credential:string){
  const task=this.task;if(!task||task.id!==id||task.status!=='waiting'||task.expiresAt<Date.now()||this.accounts.control.profile.owner!==this.owner||!/^[a-f0-9]{64}$/.test(token)||this.token.length!==64||!timingSafeEqual(Buffer.from(token),Buffer.from(this.token)))throw Error('授权任务已失效');
  if(typeof credential!=='string'||credential.length>4096||!/^\S+$/.test(credential))throw Error('平台授权格式不正确');task.status='syncing';
  const active=()=>this.task?.id===id&&this.task.status==='syncing'&&this.accounts.control.profile.owner===this.owner;
  try{await this.accounts.authorizeDeepseek(task.connectionId,credential,active);if(!active())throw Error('授权已取消');const result=await this.accounts.sync(task.connectionId);if(!active())throw Error('授权已取消');if(!result.ok||!this.historyReady(task.connectionId))throw Error('授权已取得，历史暂未完成，请重试');task.status='complete';this.close();}
  catch(error){this.fail(error instanceof Error?error.message:'历史读取失败',id);throw Error('平台账户与 Key 不匹配、授权取消或历史查询失败');}return this.state();
 }
 private fail(message:string,id:string){if(this.task?.id!==id)return;if(['waiting','syncing'].includes(this.task.status)){this.task.status='failed';this.task.error=message;}this.close();}
 cancel(){if(this.task&&['waiting','syncing'].includes(this.task.status))this.task.status='cancelled';this.close();return this.state();}
 close(){if(this.timeout)clearTimeout(this.timeout);this.timeout=null;this.token='';}
}
