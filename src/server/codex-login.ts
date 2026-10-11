import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readCodexAccount, cachedChatGPTAuth } from './codex-account.ts';
import { hash, type ProfileStore, type JsonObject } from './profile.ts';
/** Shared credentials are read only after explicit Profile-scoped consent. */
export class CodexLogin {
  private cached?: JsonObject;
  private requested=0;
  private fingerprint='';
  private generation=0;
  private job?:Promise<JsonObject>;
  constructor(private profile:ProfileStore,private reader=readCodexAccount) {}
  get home(){return join(this.profile.root,'data','credentials',this.profile.owner,'codex');}
  state(){return {authorized:this.profile.read<JsonObject>('codex-local-authorization',{}).authorized===true,credentialSource:existsSync(join(this.home,'auth.json'))?'profile':'local-codex-cache'};}
  async authorize(authorized:boolean){this.close();this.profile.write('codex-local-authorization',{authorized,updatedAt:new Date().toISOString()});return authorized?this.account():this.state();}
  close(){this.generation++;this.cached=undefined;this.job=undefined;this.fingerprint='';this.requested=0;}
  async account(){
    const own=existsSync(join(this.home,'auth.json')),consent=this.state().authorized;
    const unavailable=(authorization:string,message:string)=>({authorization,observedAt:new Date().toISOString(),unavailable:{quota:message},quota:null});
    if(this.profile.read<JsonObject>("codex-local-authorization",{}).authorized===false||!own&&!consent)return unavailable('missing','请授权读取本机 Codex 登录凭据');
    let fingerprint:string,accountIdentity:string;
    try{const home=own?this.home:process.env.CODEX_HOME||join(homedir(),'.codex');const tokens=cachedChatGPTAuth(home);accountIdentity=hash(tokens.chatgptAccountId);fingerprint=hash(tokens.chatgptAccountId+'\0'+tokens.accessToken+statSync(join(home,'auth.json')).mtimeMs);}catch{return unavailable('missing','未找到本机 Codex ChatGPT 登录，请先在 Codex 中登录');}
    if(this.fingerprint!==fingerprint){this.close();this.fingerprint=fingerprint;}
    if(!this.cached){const saved=this.profile.read<JsonObject>('codex-quota-cache',{});if(saved.accountIdentity===accountIdentity&&saved.snapshot?.quota&&Date.now()-Date.parse(saved.snapshot.observedAt)<86400000)this.cached={...saved.snapshot,stale:true};}
    if(this.cached&&!this.job&&Date.now()-this.requested<30000)return this.cached;
    if(!this.job){const ticket=this.generation;this.requested=Date.now();this.job=this.reader(this.home,{includeActivity:false,allowLocal:consent}).then(result=>{
      const value={...result,accountIdentity:accountIdentity!,authorization:'chatgpt',observedAt:new Date().toISOString()};if(ticket===this.generation){this.cached=value;this.profile.write('codex-quota-cache',{accountIdentity,snapshot:value});}return ticket===this.generation?value:unavailable('missing','账户已切换，请重新读取');
    }).catch(()=>{if(ticket!==this.generation)return unavailable('missing','账户已切换，请重新读取');if(!this.cached)return unavailable('expired','账户查询失败，请在 Codex 中检查登录后重试');return this.cached={...this.cached,stale:true,unavailable:{...this.cached.unavailable,refresh:'账户刷新失败，请检查本机登录和网络'}};}).finally(()=>{if(ticket===this.generation)this.job=undefined;});}
    if(this.cached)return {...this.cached,refreshing:true};
    // Bound first-paint latency without labelling missing data as zero or success.
    let timer:ReturnType<typeof setTimeout>;
    try{return await Promise.race([this.job,new Promise<JsonObject>(resolve=>{timer=setTimeout(()=>resolve({...unavailable('chatgpt','正在读取账户…'),pending:true}),2500);})]);}
    finally{clearTimeout(timer!);}
  }
}
