import {createHash} from 'node:crypto';
import {parseExact,encode,type JsonObject} from './profile.ts';

/**
 * Community mirrors. These are *never* priced from and never shown as a source
 * of truth: they exist so a stored official rate can be cross-checked later and
 * so a mirror's own layout errors stay discoverable. Official rates live in
 * official-pricing.ts.
 */
export const REGISTRY='https://github.com/Portkey-AI/models';
export const CURRENT_PRICES='https://ai.cloudprice.net/api/v1/litellm_model_prices.json';
const API='https://api.github.com/repos/Portkey-AI/models';
const CURRENT_LIMIT=20000000,REVISION_LIMIT=40;
export const MIRROR_TYPES=['mirror_registry','mirror_catalog'] as const;
export type MirrorType=(typeof MIRROR_TYPES)[number];
export type PriceSnapshot={day:string,body:string,source:string};
export type PriceLoader=(url:string,etag?:string)=>Promise<{body:string|null,etag:string}>;
/** Mirror units are USD per token; every comparison converts to per-1M first. */
export const MIRROR_QUOTE_FIELDS:Record<string,string>={input_cost_per_token:'input',output_cost_per_token:'output',cache_read_input_token_cost:'cached',cache_creation_input_token_cost:'write'};
const today=()=>new Date().toISOString().slice(0,10);
function scalar(value:unknown):string|null{
  if(value==null||typeof value==='boolean'||typeof value==='object')return null;
  const number=Number(String(value));
  if(!Number.isFinite(number)||number<0||number>100000)throw Error('对照价格数值无效');
  return String(number*1000000);
}
/**
 * Normalize one mirror file. `default` is a family table covering several
 * models at once: it cannot be attributed to one model name without guessing, so
 * it is dropped. Rows that disagree with each other keep both values, which is
 * exactly the layout ambiguity this comparison exists to expose.
 */
export function normalizeMirror(provider:string,raw:string,source:string,day:string,sourceType:MirrorType){
  const data=parseExact(raw),models:JsonObject[]=[];
  if(!data||typeof data!=='object'||Array.isArray(data))throw Error('对照目录结构无效');
  for(const [name,value]of Object.entries(data) as [string,JsonObject][]){
    if(name==='default'||!value||typeof value!=='object'||Array.isArray(value))continue;
    const perMillion:JsonObject={},columns:JsonObject[]=[],conflicts:JsonObject[]=[];
    const take=(unit:JsonObject,label:string)=>{
      for(const [field,target]of Object.entries(MIRROR_QUOTE_FIELDS)){
        const rate=scalar(unit[field]?.price??unit[field]);
        if(rate==null)continue;
        columns.push({tier:label,field,target,rate});
        if(perMillion[target]==null)perMillion[target]=rate;
        else if(perMillion[target]!==rate)conflicts.push({tier:label,field,target});
      }
    };
    take(value,'flat');
    for(const [tier,units]of Object.entries(value))if(units&&typeof units==='object'&&!Array.isArray(units))take(units as JsonObject,tier);
    if(!columns.length)continue;
    models.push({name,provider,currency:value.currency??data.default?.currency??null,perMillion,columns,conflicts,source,day,sourceType});
  }
  if(!models.length)throw Error('对照目录没有可用模型');
  return models;
}
/**
 * Latest mirror revision at or before a day. Files change layout as well as
 * rates, so each snapshot records the revision that was read.
 */
export async function collectMirror(options:{days:string[],loader:PriceLoader,evidence:(url:string,body:string)=>void,check?:()=>void}){
  const {loader,evidence,check}=options,errors:JsonObject[]=[],gaps:JsonObject[]=[],snapshots:PriceSnapshot[]=[],
    days=[...new Set(options.days)].filter(day=>day<=today()).sort();
  for(const day of days.slice(-REVISION_LIMIT)){
    check?.();
    try{
      const revisions=await loader(`${API}/commits?path=pricing/deepseek.json&until=${day}T23:59:59Z&per_page=1`);
      if(!revisions.body)throw Error('对照目录没有历史版本');
      const head=parseExact(revisions.body)?.[0];
      if(!/^[a-f0-9]{40}$/.test(head?.sha||''))throw Error('对照目录版本无效');
      const url=`https://raw.githubusercontent.com/Portkey-AI/models/${head.sha}/pricing/deepseek.json`,file=await loader(url);
      if(!file.body)throw Error('对照目录文件为空');
      check?.();evidence(url,file.body);
      const models=normalizeMirror('deepseek',file.body,url,day,'mirror_registry');
      snapshots.push({day,source:url,body:encode({schemaVersion:1,billingUnit:'per_1m_tokens',effectiveDate:day,generatedAt:day+'T00:00:00Z',scope:'provider_mirror',coverage:{revision:head.sha,committedAt:head.commit?.committer?.date??null},models})});
    }catch(error:any){
      if(error?.status===403||error?.status===429)gaps.push({day,error:'mirror_api_rate_limited',message:'社区对照目录接口限流，本次不比对（不影响官方定价）'});
      else errors.push({day,error:'mirror_catalog_unavailable',message:'社区对照目录读取失败，本次不比对（不影响官方定价）'});
    }
  }
  return {snapshots,gaps,errors,loaded:snapshots.length,truncated:days.length>REVISION_LIMIT};
}
/**
 * Current catalogue. It names far more models than the versioned mirror and is
 * read only to compare today's official table. Bounded hard: it is a public
 * third-party feed with no size guarantee.
 */
export async function collectCurrentCatalogue(options:{loader:PriceLoader,evidence:(url:string,body:string)=>void,check?:()=>void}){
  const {loader,evidence,check}=options,day=today();
  check?.();
  const result=await loader(CURRENT_PRICES);
  if(!result.body)throw Error('当日对照目录为空');
  if(Buffer.byteLength(result.body)>CURRENT_LIMIT)throw Error('当日对照目录超过体积上限');
  const data=parseExact(result.body),models:JsonObject[]=[];
  if(data?._cloudprice?.updated_at!==day)throw Error('当日对照目录不是所选日期快照');
  for(const [name,value]of Object.entries(data) as [string,JsonObject][]){
    if(name.startsWith('_')||!value?.litellm_provider||!/deepseek/i.test(name))continue;
    const perMillion:JsonObject={},columns:JsonObject[]=[];
    for(const [field,target]of Object.entries(MIRROR_QUOTE_FIELDS)){
      const rate=scalar(value[field]);
      if(rate==null)continue;
      perMillion[target]=rate;columns.push({tier:'flat',field,target,rate});
    }
    if(!columns.length)continue;
    models.push({name,provider:'deepseek',currency:'USD',perMillion,columns,conflicts:[],source:CURRENT_PRICES,day,sourceType:'mirror_catalog',detailId:value.cloudprice_model_id||null});
  }
  if(models.length>2000)throw Error('当日对照目录条目过多');
  check?.();evidence(CURRENT_PRICES,result.body);
  return {snapshot:{day,source:CURRENT_PRICES,body:encode({schemaVersion:1,billingUnit:'per_1m_tokens',effectiveDate:day,generatedAt:day+'T00:00:00Z',scope:'provider_mirror',coverage:{updatedAt:day},models})} as PriceSnapshot,models:models.length};
}
export type MirrorComparison={status:'agrees'|'differs'|'absent'|'not_comparable';reason:string|null;values:JsonObject;details?:JsonObject[]};
/**
 * Compare a stored official table with a mirror, hidden from users.
 *
 * Official DeepSeek rates are CNY per 1M tokens; the mirrors are USD per token.
 * Without an official USD table no mirror row can confirm an official number, so
 * a currency mismatch is reported as `not_comparable` instead of being converted
 * (a conversion would quietly invent a rate). What the comparison *can* prove is
 * that the mirror itself is unsound: a column where cache reads cost more than
 * input, or a per-token figure that is per-million-sized in disguise (an off-by-
 * 1E6 unit bug), or one file disagreeing with itself about the same model.
 * Nothing is ever written back into the price table.
 */
export function compareMirror(official:{id:string,model:string,currency:string,quote:Record<string,string|null>},models:JsonObject[],kind:MirrorType):MirrorComparison{
  const bare=official.model.replace(/^.*\//,'').toLowerCase(),
    exact=models.find(model=>String(model.name).toLowerCase()===bare)||
      models.find(model=>String(model.name).toLowerCase().replace(/^deepseek-/,'')===bare.replace(/^deepseek-/,''));
  if(!exact)return {status:'absent',reason:'mirror_missing_model',values:{}};
  const values:JsonObject={...(exact.perMillion as JsonObject)},details:JsonObject[]=[];
  if(Array.isArray(exact.conflicts)&&exact.conflicts.length)details.push({problem:'mirror_rows_disagree',rows:exact.conflicts});
  const input=Number(values.input),cached=Number(values.cached);
  if(Number.isFinite(input)&&Number.isFinite(cached)&&cached>input)details.push({problem:'mirror_cached_exceeds_input',cached:values.cached,input:values.input});
  const mirrorCurrency=exact.currency?String(exact.currency).toUpperCase():null;
  if(mirrorCurrency&&official.currency&&mirrorCurrency!==official.currency.toUpperCase()){
    for(const [field,value]of Object.entries(values)){
      const expected=official.quote[field];if(expected==null)continue;
      const ratio=Number(value)/(Number(expected)*1000); // sanity: expected CNY/1M vs USD/token
      if(Number.isFinite(ratio)&&(ratio>500||ratio<1/500))details.push({problem:'mirror_unit_implausible',field,value,official:expected});
    }
    return {status:'not_comparable',reason:'mirror_currency_differs',values,details};
  }
  if(details.length)return {status:'not_comparable',reason:'mirror_unit_or_layout_mismatch',values,details};
  // Same currency and a sane unit: only now may a value difference be reported.
  const differing=Object.entries(values)
    .filter(([field,value])=>official.quote[field]!=null&&String(official.quote[field])!==String(value))
    .map(([field,value])=>({problem:'rate_differs',field,mirror:value,official:official.quote[field]}));
  return {status:differing.length?'differs':'agrees',reason:null,values,details:[...differing,...(differing.length?[]:[{problem:'none',kind}])]};
}
export function mirrorDigest(body:string){return createHash('sha256').update(body).digest('hex');}
