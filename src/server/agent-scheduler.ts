type Scope='codex'|'zcode'|'dsh';
/** Each source owns one incremental collection job; UI and timer share it. */
export class AgentScheduler{
 private jobs=new Map<Scope,Promise<any>>();private stopped=false;private generation=0;
 private states=new Map<Scope,any>();
 constructor(private enabled:(scope:Scope)=>boolean,private collect:(scope:Scope)=>Promise<any>,private identity:(scope:Scope)=>string=scope=>scope){}
 state(){return Object.fromEntries(this.states);}
 run(scope:Scope){if(this.stopped||!this.enabled(scope))return Promise.resolve({disabled:true});const old=this.jobs.get(scope);if(old)return old;const generation=this.generation,began=performance.now();this.states.set(scope,{status:'collecting',startedAt:new Date().toISOString()});
  const job=Promise.resolve().then(async()=>{let result:any;for(;;){if(this.stopped||!this.enabled(scope))return {disabled:true};const identity=this.identity(scope);result=await this.collect(scope);if(generation!==this.generation)return result;
    const changing=identity!==this.identity(scope);const pending=Number(result.pending)||0;
    const stalled=pending>0&&!changing&&!Number(result.scanned||result.imported||result.corrected);
    this.states.set(scope,{status:stalled?'error':pending||changing?'collecting':'ready',syncedAt:result.syncedAt||new Date().toISOString(),elapsedMs:Math.round(performance.now()-began),pending,error:stalled?'部分日志暂未读完，将在下次自动采集重试':result.errors?.length?'部分日志读取失败，已保留读取成功的数据':undefined});
    if(!changing&&(!pending||!Number(result.scanned||result.imported||result.corrected)))break;
    await new Promise(r=>setTimeout(r,50));
   }return result;}).catch(error=>{if(generation===this.generation)this.states.set(scope,{status:this.enabled(scope)?'error':'disabled',error:this.enabled(scope)?(error instanceof Error?error.message:'采集失败'):undefined});throw error;}).finally(()=>{if(this.jobs.get(scope)===job)this.jobs.delete(scope);});this.jobs.set(scope,job);return job;
 }
 trigger(){if(this.stopped)return;for(const scope of ['codex','zcode','dsh'] as Scope[])if(this.enabled(scope))void this.run(scope).catch(()=>{});else this.states.set(scope,{status:'disabled'});}
 close(){this.stopped=true;this.generation++;this.states.clear();}
}
