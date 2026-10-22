import type {ProfileStore,JsonObject} from './profile.ts';
import {summaryAccumulator,FIELDS,shanghaiDay,dateRange,addDays} from './usage-summary.ts';
import {supportsHourly,type HourTrend,type HourPoint} from '../shared/usage-trend.ts';

const wire=(n:any):any=>typeof n==='bigint'?n<=BigInt(Number.MAX_SAFE_INTEGER)?Number(n):String(n):n;
/** Stream the indexed single-day event set; retain only 24 counters and model counters. */
export function hourlyTrend(profile:ProfileStore,params:JsonObject,accounting:JsonObject,collection:JsonObject={},now=Date.now()):HourTrend{
 const scope=String(params.scope||'codex'),date=String(params.date||'');
 if(!supportsHourly(scope))throw Error('此来源暂无逐次小时趋势，请使用按日视图');
 if(params.timezone&&params.timezone!=='Asia/Shanghai')throw Error('小时趋势目前使用上海时区');
 if(params.metric&&params.metric!=='tokens')throw Error('小时趋势目前展示Token，费用请使用按日视图');
 dateRange(1,{period:'custom',start_date:date,end_date:date},undefined,shanghaiDay(now));
 const models=params.models??(params.model?[params.model]:[]);
 if(!Array.isArray(models)||models.length>100||models.some(m=>typeof m!=='string'||m.length>300))throw Error('模型筛选格式不正确');
 const start=addDays(date,-1)+'T16:00:00.000Z',end=date+'T16:00:00.000Z';
 const startTime=Date.parse(start);
 const where=['owner=?','source=?','at>=?','at<?',"NOT(source='codex' AND id LIKE 'codex:%' AND id NOT LIKE 'codex:v4:%')"],args:any[]=[profile.owner,scope,start.slice(0,-5),end.slice(0,-5)];
 for(const key of ['source','provider','project','connection_id'])if(params[key]){where.push(key+'=?');args.push(params[key]);}
 if(models.length){where.push('model IN ('+models.map(()=>'?').join(',')+')');args.push(...models);}
 const buckets=Array.from({length:24},()=>({sum:summaryAccumulator(),models:new Map<string,{provider:string;model:string;sum:ReturnType<typeof summaryAccumulator>}>()})),all=summaryAccumulator();
 // Only hot event columns: never decode or retain transcript/evidence payloads.
 const query=profile.db.prepare('SELECT at,provider,model,status,input,output,cached,reasoning,total FROM events WHERE '+where.join(' AND ')+' ORDER BY at').safeIntegers();
 for(const row of query.iterate(...args)){
  const time=Date.parse(row.at),hour=Math.floor((time-startTime)/3600000);if(!Number.isFinite(time)||hour<0||hour>23)throw Error('消费时间不可核验');
  const b=buckets[hour],key=JSON.stringify([row.provider||'',row.model||'未识别模型']);
  const model=b.models.get(key)||{provider:row.provider||'',model:row.model||'未识别模型',sum:summaryAccumulator()};
  b.sum.add(row);model.sum.add(row);b.models.set(key,model);all.add(row);
 }
 const complete=collection.status==='ready'&&!collection.error&&!accounting.incomplete;
 const coverage:HourTrend['coverage']={status:complete?'complete':collection.status==='ready'||accounting.incomplete?'partial':'unverified',timeBasis:'source-event',collection:collection.status||'unverified',message:complete?'已登记日志范围 · 来源记录时间':collection.error||accounting.message||'采集尚未完成，仅显示已核验记录'};
 const series=buckets.map((bucket,hour):HourPoint=>{
  const s=bucket.sum.result(),future=startTime+hour*3600000>now,observed=s.observations>0;
  const state=!observed?(future?'future':complete?'zero':'unobserved'):s.unknownFields.total?'unknown':complete&&!future?'known':'partial';
  const value=state==='future'||state==='unobserved'||state==='unknown'?null:wire(s.total);
  return {date:new Date(startTime+hour*3600000).toISOString(),label:String(hour).padStart(2,'0')+':00',caption:date+' '+String(hour).padStart(2,'0')+':00–'+String(hour+1).padStart(2,'0')+':00 · 上海',total:value,knownTotal:wire(s.total),...Object.fromEntries(FIELDS.filter(k=>k!=='total').map(k=>[k,wire(s[k])])) as Pick<HourPoint,'input'|'output'|'cached'|'reasoning'>,requestCount:s.requestCount,state,provided:state==='known'||state==='zero',unknownFields:s.unknownFields,models:[...bucket.models.values()].map(m=>{const ms=m.sum.result();return {provider:m.provider,model:m.model,total:ms.unknownFields.total?null:wire(ms.total)}})};
 });
 return {granularity:'hour',timezone:'Asia/Shanghai',date,series,metric:'tokens',dataVersion:'',observedAt:new Date(now).toISOString(),coverage,summary:Object.fromEntries(Object.entries(all.result()).map(([k,v])=>[k,wire(v)]))};
}
