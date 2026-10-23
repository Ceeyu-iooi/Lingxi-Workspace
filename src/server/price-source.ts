import {Decimal} from 'decimal.js';
import {parseExact,encode,type JsonObject} from './profile.ts';
import {createHash} from 'node:crypto';

export const REGISTRY='https://github.com/Portkey-AI/models';
export const CURRENT_PRICES='https://ai.cloudprice.net/api/v1/litellm_model_prices.json';
const API='https://api.github.com/repos/Portkey-AI/models';
export type PriceLoader=(url:string,etag?:string)=>Promise<{body:string|null,etag:string}>;
export type PriceSnapshot={day:string,body:string,source:string};
const FIELDS:Record<string,string>={request_token:'inputPricePer1M',response_token:'outputPricePer1M',cache_read_input_token:'cacheReadPricePer1M',cache_write_input_token:'cacheWritePricePer1M'};
const date=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(value).toISOString().slice(0,10)===value;
function scalar(value:unknown):string|null {
  if(value==null||typeof value==='boolean'||typeof value==='object')return null;
  const number=new Decimal(String(value));
  if(!number.isFinite()||number.lt(0)||number.gt(100000))throw Error('公开价格数值无效');
  return number.times(10000).toString(); // Portkey: cents/token -> USD/1M tokens.
}
export function normalizeRegistry(provider:string,raw:string,source:string,snapshotAt:string){
  const data=parseExact(raw),models:JsonObject[]=[];
  if(!data||typeof data!=='object'||Array.isArray(data))throw Error('价格目录结构无效');
  for(const [id,value]of Object.entries(data) as [string,JsonObject][]){
    if(id==='default'||!value?.pricing_config)continue;
    const cfg=value.pricing_config,standard=cfg.pay_as_you_go||{},dimensions:JsonObject[]=[];
    for(const [tier,units]of Object.entries(cfg)){
      if(!units||typeof units!=='object'||Array.isArray(units))continue;
      for(const [dimension,rule]of Object.entries(units as JsonObject)){
        if(!rule||typeof rule!=='object')continue;
        dimensions.push({tier,dimension,unit:'cents_per_declared_unit',rule});
      }
    }
    const row:JsonObject={id:provider==='openai'?id:provider+'/'+id,provider,currency:value.currency??cfg.currency??data.default?.currency??data.default?.pricing_config?.currency??null,
      sourceUrl:source,sourceType:'registry',snapshotAt,dimensions,
      pricingNotes:'Portkey 公开社区目录；历史为仓库截至日期快照，并非官方生效时刻或实际账单。'};
    let complex=!!value.custom_pricing;
    if(value.custom_pricing)dimensions.push({dimension:'custom_pricing',unit:'source_declared_rules',rule:value.custom_pricing});
    if(value.calculate)dimensions.push({dimension:'calculate',unit:'source_declared_rules',rule:value.calculate});
    for(const [field,target]of Object.entries(FIELDS)){
      const rule=standard[field];row[target]=scalar(rule?.price);
      if(rule&&Object.keys(rule).some(k=>k!=='price'&&k!=='description'))complex=true;
      if(rule&&row[target]==null)complex=true;
    }
    row.registryComplex=complex;
    models.push(row);
  }
  if(!models.length)throw Error('公开价格目录没有可用模型');
  return models;
}
export function normalizeCurrent(raw:string,day:string){
  const data=parseExact(raw),models:JsonObject[]=[];
  if(data?._cloudprice?.updated_at!==day)throw Error('当前价格接口不是所选日期快照');
  for(const [id,value]of Object.entries(data) as [string,JsonObject][]){
    if(id.startsWith('_')||!value?.litellm_provider)continue;
    const dimensions=Object.entries(value).filter(([key])=>/cost|price/.test(key)&&key!=='cloudprice_model_id').map(([dimension,price])=>({dimension,unit:dimension.includes('per_token')||dimension.includes('input_token_cost')?'USD_per_token':'source_declared_unit',price}));
    if(!dimensions.length)continue;
    const rate=(key:string)=>value[key]==null?null:new Decimal(String(value[key])).times(1000000).toString();
    models.push({id,provider:'CloudPrice · '+(id.includes('/')?id.split('/')[0]:'未标明供应商'),adapter:value.litellm_provider,currency:'USD',sourceType:'current_catalog',sourceUrl:CURRENT_PRICES,snapshotAt:day,
      inputPricePer1M:rate('input_cost_per_token'),outputPricePer1M:rate('output_cost_per_token'),cacheReadPricePer1M:rate('cache_read_input_token_cost'),cacheWritePricePer1M:rate('cache_creation_input_token_cost'),
      dimensions,detailId:value.cloudprice_model_id||null,registryComplex:true,
      pricingNotes:'CloudPrice 当日采集目录；分组为源命名空间，适配器 '+value.litellm_provider+' 不等于实际供应商。请以详细接口的供应商、地域、档位为准；未验证条目不参与自动估值。'});
  }
  if(!models.length||models.length>15000)throw Error('当前价格目录无效');
  return models;
}
export async function collectRegistry(options:{days:string[],loader:PriceLoader,
  evidence:(url:string,body:string)=>void,check?:()=>void,progress?:(value:JsonObject)=>void,catalogDate?:string,
  cacheRead?:(blob:string)=>{raw:string,source:string}|null,cacheWrite?:(blob:string,raw:string,source:string)=>void}){
  const {loader,evidence,check}=options;
  const errors:JsonObject[]=[],gaps:JsonObject[]=[],snapshots:PriceSnapshot[]=[];
  const today=new Date().toISOString().slice(0,10),headDay=options.catalogDate||today,days=[...new Set(options.catalogDate?[headDay]:[...options.days,today])].sort();
  if(days.some(d=>!date(d)||d>today))throw Error('价格快照日期无效');
  let completed=0,total=1;
  const progress=()=>options.progress?.({phase:'prices',completed,total});
  const read=async(url:string)=>{
    check?.();const result=await loader(url);if(result.body==null)throw Error('首次读取不能使用空的价格响应');
    evidence(url,result.body);check?.();return parseExact(result.body);
  };
  const revisions=await read(API+'/commits?path=pricing&per_page=1&until='+headDay+'T23:59:59Z');
  const head=revisions?.[0];
  if(!/^[a-f0-9]{40}$/.test(head?.sha||''))throw Error('价格仓库版本无效');
  const manifest=await read(API+'/contents/pricing?ref='+head.sha);
  if(!Array.isArray(manifest))throw Error('供应商价格清单无效');
  const providers=manifest.filter((r:JsonObject)=>r.type==='file'&&/^[a-z0-9-]+\.json$/.test(r.name||'')).map((r:JsonObject)=>r.name.slice(0,-5));
  if(!providers.includes('openai')||providers.length>100)throw Error('供应商价格目录不完整');
  total=providers.length+1;completed=1;progress();
  const current:JsonObject[]=[];
  const memo=new Map<string,Promise<{raw:string,source:string}>>();
  function getFile(provider:string,sha:string,blob?:string){
    const key=provider+':'+sha;
    if(!memo.has(key))memo.set(key,(async()=>{
      if(blob){const cached=options.cacheRead?.(blob);if(cached&&createHash('sha1').update('blob '+Buffer.byteLength(cached.raw)+'\0').update(cached.raw).digest('hex')===blob)return cached;}
      const verify=(raw:string,source:string)=>{
        if(blob&&createHash('sha1').update('blob '+Buffer.byteLength(raw)+'\0').update(raw).digest('hex')!==blob)throw Error('价格内容与仓库摘要不一致');
        if(blob)options.cacheWrite?.(blob,raw,source);
        return {raw,source};
      };
      // CDN and immutable repository content carry the same documented schema.
      // Do not forward any provider/API credentials to either public source.
      const rawUrl=`https://raw.githubusercontent.com/Portkey-AI/models/${sha}/pricing/${provider}.json`;
      try{const r=await loader(rawUrl);if(!r.body)throw Error();evidence(rawUrl,r.body);return verify(r.body,rawUrl);}
      catch{
        const source=`${API}/contents/pricing/${provider}.json?ref=${sha}`,r=await read(source);
        if(r.encoding!=='base64'||typeof r.content!=='string'||r.size>3*1024*1024)throw Error('版本化价格文件无效');
        const raw=Buffer.from(r.content,'base64').toString('utf8');
        if(Buffer.byteLength(raw)!==r.size)throw Error('价格文件长度不一致');
        evidence(rawUrl,raw);return verify(raw,rawUrl);
      }
    })());
    return memo.get(key)!;
  }
  let cursor=0;
  await Promise.all(Array.from({length:4},async()=>{
    while(cursor<providers.length){const provider=providers[cursor++];check?.();
      try{const f=await getFile(provider,head.sha,manifest.find((r:JsonObject)=>r.name===provider+'.json')?.sha);current.push(...normalizeRegistry(provider,f.raw,f.source,head.commit.committer.date));}
      catch{gaps.push({provider,error:'provider_catalog_unavailable',source:REGISTRY});}
      completed++;progress();
    }
  }));
  if(!current.length)throw Error('公开价格目录读取失败，保留现有证据');
  let currentProviders=0,currentModels=0;
  if(headDay===today){
    try{
      const r=await loader(CURRENT_PRICES);if(!r.body)throw Error();evidence(CURRENT_PRICES,r.body);
      const extra=normalizeCurrent(r.body,today),byId=new Map(current.map(row=>[row.id,row]));
      currentProviders=new Set(extra.map(r=>r.provider)).size;currentModels=extra.length;
      for(const row of extra){const prior=byId.get(row.id);if(prior){prior.dimensions.push(...row.dimensions);prior.detailId=row.detailId;prior.currentSource=CURRENT_PRICES;}else byId.set(row.id,row);}
      current.splice(0,current.length,...byId.values());
    }catch{gaps.push({source:CURRENT_PRICES,error:'current_catalog_unavailable'});}
  }
  current.sort((a,b)=>String(a.id).localeCompare(String(b.id),'en'));
  snapshots.push({day:headDay,body:encode({schemaVersion:1,billingUnit:'per_1m_tokens',effectiveDate:headDay,generatedAt:headDay+'T00:00:00Z',scope:'provider_catalog',coverage:{expectedProviders:providers.length,loadedProviders:providers.length-gaps.filter(g=>g.provider).length,currentProviders,currentModels,gaps},models:current}),source:REGISTRY+'/tree/'+head.sha});
  // Only Codex currently uses reference valuation. Historical OpenAI revisions
  // are fetched once per change, then reused for all required consumption dates.
  const historical=options.catalogDate?[]:days.filter(d=>d<today);
  if(historical.length){
    const commits:JsonObject[]=[];
    for(let page=1;page<=10;page++){
      check?.();
      try{
        const batch=await read(`${API}/commits?path=pricing/openai.json&per_page=100&page=${page}`);
        if(!Array.isArray(batch))throw Error();
        commits.push(...batch);
        if(batch.length<100||batch.at(-1)?.commit?.committer?.date?.slice(0,10)<=historical[0])break;
      }catch{errors.push({source:REGISTRY,error:'historical_index_unavailable'});break;}
    }
    total+=historical.length;progress();
    for(const day of historical){check?.();
      const revision=commits.find(r=>r.commit?.committer?.date<=day+'T23:59:59Z');
      try{
        if(!revision)throw Error();
        const f=await getFile('openai',revision.sha),models=normalizeRegistry('openai',f.raw,f.source,revision.commit.committer.date);
        snapshots.push({day,body:encode({schemaVersion:1,billingUnit:'per_1m_tokens',effectiveDate:day,generatedAt:day+'T00:00:00Z',scope:'codex_openai',coverage:{expectedProviders:1,loadedProviders:1},models}),source:REGISTRY+'/tree/'+revision.sha});
      }catch{gaps.push({day,error:'historical_snapshot_unavailable',source:REGISTRY});}
      completed++;progress();
    }
  }
  return {snapshots,errors,gaps,providers:providers.length,providersLoaded:new Set(current.map(r=>r.provider)).size};
}
