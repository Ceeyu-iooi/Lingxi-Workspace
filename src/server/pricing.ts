import { Decimal } from "decimal.js";
import { deflateSync, inflateSync } from "node:zlib";
import {writeCompactValuation,writeCompactValuationBatch,packPendingUsage,compactEventProjection} from './usage-storage.ts';
import { Monitor, canonical, iso } from "./monitor.ts";
import { hash, parseExact, encode, uid, type JsonObject } from "./profile.ts";
import { Control } from "./control.ts";
import { shanghaiDay, addDays } from "./usage-summary.ts";
import { priceIntegrityIssue } from './price-integrity.ts';
import {collectRegistry,REGISTRY,MAIN_PROVIDERS,mainstreamModel} from './price-source.ts';
import {Agent as HttpsAgent, get as httpsGet} from 'node:https';
import {HttpsProxyAgent} from 'https-proxy-agent';

const VALUATION_POLICY = 'incremental-codex-v6-reference-scenario';

const RADAR = REGISTRY + "/",
  FX_URL =
    "https://www.bankofcanada.ca/valet/observations/FXUSDCAD,FXCNYCAD/json",
  SCENARIO = "Portkey/versioned-registry/text";
type Loader = (
  url: string,
  etag?: string,
) => Promise<{ body: string | null; etag: string }>;
const priceTransport = new HttpsAgent({keepAlive:true,maxSockets:4,maxCachedSessions:0});
let priceProxy:HttpsProxyAgent<string>|undefined;
function publicTransport(host:string){
  const proxy=process.env.LINGXI_PRICE_PROXY||process.env.https_proxy||process.env.HTTPS_PROXY;
  const excluded=(process.env.no_proxy||process.env.NO_PROXY||'').split(',').some(rule=>{const name=rule.trim().toLowerCase().replace(/:443$/,'');return name==='*'||name===host||name.startsWith('.')&&host.endsWith(name)||name.startsWith('*.')&&host.endsWith(name.slice(1));});
  return proxy&&!excluded?(priceProxy ||=new HttpsProxyAgent(proxy,{keepAlive:true,maxSockets:4})):priceTransport;
}
export async function loadPrice(url: string, etag = "") {
  if (!["raw.githubusercontent.com", "api.github.com", "configs.portkey.ai", "ai.cloudprice.net", "www.bankofcanada.ca"].includes(new URL(url).hostname))
    throw new Error("价格来源不受支持");
  /* Public idempotent GET only. Keep TLS verification and avoid broken resumed
     handshakes seen on some networks. Never retry a model/credential request. */
  const attempt=()=>new Promise<{body:string|null,etag:string}>((resolve,reject)=>{
    const request=httpsGet(url,{agent:publicTransport(new URL(url).hostname),signal:AbortSignal.timeout(20000),headers:{'User-Agent':'Lingxi-Usage',Accept:'application/json',...(etag?{'If-None-Match':etag}:{})}},response=>{
      if(response.statusCode===304){response.resume();resolve({body:null,etag});return;}
      if(response.statusCode!==200){response.resume();reject(Object.assign(Error('价格网络读取失败'),{status:response.statusCode}));return;}
      const chunks:Buffer[]=[];let bytes=0;
      response.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>12*1024*1024){response.destroy(Error('价格响应过大'));return;}chunks.push(chunk);});
      response.on('end',()=>resolve({body:Buffer.concat(chunks).toString('utf8'),etag:String(response.headers.etag||'')}));
      response.on('error',reject);
    });request.on('error',reject);
  });
  try{return await attempt();}catch(error:any){
    if(error.status)throw Error(error.status===429?'公开价格接口限流，请稍后刷新；缓存保留':'公开价格接口读取失败；缓存保留');
    if(/ECONNRESET|ETIMEDOUT|EPIPE|ABORT_ERR/.test(String(error.code)))try{return await attempt();}catch{}
    throw Error('公开价格网络连接失败，请检查网络后重试；缓存保留');
  }
}
export function validatePrices(body: string, expected?: string) {
  const data = parseExact(body),
    day = data.effectiveDate,
    generated = data.generatedAt;
  if (
    !data ||
    typeof data !== "object" ||
    ![1, "1", "1.0.0"].includes(data.schemaVersion) ||
    data.billingUnit !== "per_1m_tokens"
  )
    throw new Error("价格结构版本或单位不受支持");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day || "") ||
    Number.isNaN(Date.parse(day)) ||
    new Date(day).toISOString().slice(0, 10) !== day ||
    typeof generated !== "string" ||
    !/([zZ]|[+-]\d{2}:?\d{2})$/.test(generated) ||
    Number.isNaN(Date.parse(generated)) ||
    generated.slice(0, 10) !== day ||
    day > new Date().toISOString().slice(0, 10) ||
    (expected && expected !== day)
  )
    throw new Error("价格日期不正确");
  if (!Array.isArray(data.models) || data.models.length > 20000)
    throw new Error("模型目录不正确");
  const seen = new Set<string>(),
    models: JsonObject[] = [];
  for (const r of data.models) {
    if (
      !r ||
      typeof r.id !== "string" ||
      !r.id ||
      r.id.length > 300 ||
      seen.has(r.id)
    )
      throw new Error("模型身份不正确或重复");
    seen.add(r.id);
    const quote: JsonObject = {};
    for (const [key, field] of [
      ["input", "inputPricePer1M"],
      ["output", "outputPricePer1M"],
      ["cached", "cacheReadPricePer1M"],
      ["write", "cacheWritePricePer1M"],
    ]) {
      const value = r[field];
      if (value == null) {
        quote[key] = null;
        continue;
      }
      if (typeof value === "boolean") throw new Error("价格不是有效数值");
      let number: Decimal;
      try {
        number = new Decimal(String(value));
      } catch {
        throw new Error("价格不是有效数值");
      }
      if (!number.isFinite() || number.lt(0) || number.gt(100000))
        throw new Error("价格超出范围");
      quote[key] = number.toString();
    }
    const source =
        typeof r.sourceUrl === "string" && r.sourceUrl.startsWith("https://")
          ? r.sourceUrl
          : REGISTRY,
      notes = String(r.pricingNotes || "").slice(0, 2000),
      unsupported =
        /阶梯|分时|高峰|低峰|batch|priority|regional|audio|image|tts|超过|above|tiered|threshold/i.test(
          notes,
        ) ||
        (Array.isArray(r.pricingRules)
          ? r.pricingRules.length > 0
          : r.pricingRules && typeof r.pricingRules === "object"
            ? Object.keys(r.pricingRules).length > 0
            : !!r.pricingRules) ||
        /audio|tts|image|sora|video/i.test(r.id);
    models.push({
      model: r.id,
      provider: String(r.provider || ""),
      currency: r.currency ?? null,
      quote,
      source,
      sourceType: r.sourceType ?? null,
      integrityIssue: priceIntegrityIssue(r, quote),
      dimensions: Array.isArray(r.dimensions)?r.dimensions:[],
      detailId:r.detailId??null,
      currentSource:r.currentSource??null,
      snapshotAt:r.snapshotAt??null,
      referenceBands:Array.isArray(r.referenceBands)?r.referenceBands:null,
      notes,
      unsupported:unsupported||r.registryComplex===true,
    });
  }
  return { day, models, coverage:data.coverage??null, scope:data.scope??null };
}
// Bound retained lookup data by encoded size as well as entry count. Empty
// misses consume a budget too; unknown historical dates cannot grow forever.
class BudgetMap<V> extends Map<string,V> {
  private sizes=new Map<string,number>();
  private bytes=0;
  get allocatedBytes(){return this.bytes;}
  constructor(private budget:number,private limit=512){super();}
  override set(key:string,value:V){
    this.delete(key);
    const bytes=(Buffer.byteLength(key)+Buffer.byteLength(encode(value)??''))*2+128;
    if(bytes>this.budget)return this;
    super.set(key,value);this.sizes.set(key,bytes);this.bytes+=bytes;
    while(this.bytes>this.budget||this.size>this.limit)this.delete(this.keys().next().value!);
    return this;
  }
  override delete(key:string){this.bytes-=this.sizes.get(key)??0;this.sizes.delete(key);return super.delete(key);}
  override clear(){super.clear();this.sizes.clear();this.bytes=0;}
}
export class Pricing {
  private preparedUpdates:Map<string,JsonObject>|null=null;
  refreshing = false;
  task: JsonObject = { status: "idle", errors: [] };
  private syncJob: Promise<JsonObject> | null = null;
  private dayCache=new Map<string,{digest:string,bytes:number,models:Map<string,JsonObject>}>();
  private dayBytes=0;
  private lookupVersion=-1;
  private fxCache=new BudgetMap<JsonObject|undefined>(512*1024);
  private proofCache=new Map<string,string>();
  private proofBytes=0;
  private formulaCache=new BudgetMap<{fingerprint:string,value:JsonObject}>(2*1024*1024);
  private rawCache=new BudgetMap<JsonObject>(1024*1024,512);
  private lookupDay(day:string){
    const cached=this.dayCache.get(day);if(cached)return cached.models;
    const row=this.monitor.profile.db.prepare("SELECT * FROM radar_days WHERE day=?").get(day) as JsonObject|undefined;
    if(!row){const models=new Map<string,JsonObject>();this.dayCache.set(day,{digest:"",bytes:128,models});this.dayBytes+=128;this.trimDays();return models;}
    const old=this.dayCache.get(day);if(old && old.digest===row.digest){this.dayCache.delete(day);this.dayCache.set(day,old);return old.models;}
    // Keep only the native-provider reference fields in the hot index. Detailed
    // dimensions remain in lossless evidence and are loaded by the catalogue.
    const body=this.body(row.body),models=new Map<string,JsonObject>();
    for(const price of validatePrices(body,day).models.filter(p=>p.sourceType==='registry'&&MAIN_PROVIDERS.includes(p.provider.toLowerCase()))){
      const {dimensions,...compact}=price,value={...compact,day,digest:row.digest,observed:row.observed,snapshotSource:row.source};
      models.set(price.model.toLowerCase(),value);
      const native=price.model.replace(new RegExp('^'+price.provider+'/'),'').toLowerCase();
      if(!models.has(native))models.set(native,value);
    }
    if(old)this.dayBytes-=old.bytes;const bytes=Buffer.byteLength(encode([...models]))*2+128;this.dayCache.set(day,{digest:row.digest,bytes,models});this.dayBytes+=bytes;
    this.trimDays();
    return models;
  }
  private trimDays(){while((this.dayBytes>6*1024*1024||this.dayCache.size>512)&&this.dayCache.size){const key=this.dayCache.keys().next().value!;this.dayBytes-=this.dayCache.get(key)!.bytes;this.dayCache.delete(key);}}
  private lookupFx(at:string){const day=shanghaiDay(at);if(this.fxCache.has(day))return this.fxCache.get(day);const result=this.monitor.profile.db.prepare("SELECT * FROM value_fx WHERE day>=? AND day<=? ORDER BY day DESC LIMIT 1").get(addDays(day,-7),day) as JsonObject|undefined;this.fxCache.set(day,result);return result;}
  resources(){return {cacheBytes:this.dayBytes+this.proofBytes+this.fxCache.allocatedBytes+this.formulaCache.allocatedBytes+this.rawCache.allocatedBytes,budgetBytes:16*1024*1024};}
  constructor(readonly monitor: Monitor) {
    monitor.profile.db.exec(
      `CREATE TABLE IF NOT EXISTS registry_file_cache(blob TEXT PRIMARY KEY,body TEXT,source TEXT);CREATE TABLE IF NOT EXISTS radar_days(day TEXT PRIMARY KEY,body TEXT,digest TEXT,source TEXT,observed TEXT);CREATE TABLE IF NOT EXISTS radar_meta(id INTEGER PRIMARY KEY,version INTEGER);INSERT OR IGNORE INTO radar_meta VALUES(1,0);CREATE TABLE IF NOT EXISTS radar_fetches(url TEXT PRIMARY KEY,etag TEXT,attempt REAL,success REAL,failures INTEGER,error TEXT);CREATE TABLE IF NOT EXISTS value_fx(day TEXT PRIMARY KEY,usd_cad TEXT,cny_cad TEXT,source TEXT,observed TEXT,digest TEXT);CREATE TABLE IF NOT EXISTS radar_values(owner TEXT,id TEXT,currency TEXT,fingerprint TEXT,result TEXT,PRIMARY KEY(owner,id,currency));CREATE TABLE IF NOT EXISTS radar_observations(url TEXT,digest TEXT,body TEXT,observed TEXT,PRIMARY KEY(url,digest));CREATE TABLE IF NOT EXISTS evidence_blobs(digest TEXT PRIMARY KEY,codec TEXT NOT NULL,raw_size INTEGER NOT NULL,body BLOB NOT NULL);`,
    );
    const db=monitor.profile.db;db.exec("CREATE TABLE IF NOT EXISTS valuation_dirty(owner TEXT,id TEXT,PRIMARY KEY(owner,id));CREATE TABLE IF NOT EXISTS valuation_rule(owner TEXT PRIMARY KEY,rule TEXT);");
    for(const op of ['INSERT','UPDATE']){db.exec('DROP TRIGGER IF EXISTS value_event_'+op.toLowerCase());db.exec(`CREATE TRIGGER IF NOT EXISTS value_event_${op.toLowerCase()} AFTER ${op} ON events WHEN NEW.source IN ('codex') BEGIN INSERT OR IGNORE INTO valuation_dirty VALUES(NEW.owner,NEW.id); END;`);}
    for(const op of ['INSERT','UPDATE','DELETE'])db.exec('DROP TRIGGER IF EXISTS value_agent_evidence_'+op.toLowerCase());
    for(const table of ['codex_evidence'])for(const op of ['INSERT','UPDATE','DELETE']){const row=op==='DELETE'?'OLD':'NEW';db.exec(`CREATE TRIGGER IF NOT EXISTS value_${table}_${op.toLowerCase()} AFTER ${op} ON ${table} BEGIN INSERT OR IGNORE INTO valuation_dirty VALUES(${row}.owner,${row}.id); END;`);}
    for(const table of ['radar_days','value_fx'])for(const op of ['INSERT','UPDATE']){
      const condition=table==='radar_days'?"e.at>=NEW.day||'T00:00:00' AND e.at<date(NEW.day,'+2 days')||'T00:00:00'":"e.at>=date(NEW.day,'-1 day')||'T16:00:00' AND e.at<date(NEW.day,'+7 days')||'T16:00:00'";
      const name=`value_${table}_${op.toLowerCase()}`,sql=`CREATE TRIGGER ${name} AFTER ${op} ON ${table} BEGIN INSERT OR IGNORE INTO valuation_dirty SELECT e.owner,e.id FROM usage_versions u CROSS JOIN events e ON e.owner=u.owner WHERE e.source IN ('codex') AND ${condition}; END`;
      const old=db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?").get(name);
      if(old?.sql!==sql){db.exec('DROP TRIGGER IF EXISTS '+name);db.exec(sql);}
    }
    const rule=db.prepare('SELECT rule FROM valuation_rule WHERE owner=?').get(monitor.profile.owner) as JsonObject|undefined;
    if(rule?.rule!==VALUATION_POLICY) monitor.profile.transaction(()=>{
      db.prepare("DELETE FROM radar_values WHERE owner=? AND id IN (SELECT id FROM events WHERE owner=? AND source IN ('zcode','dsh'))").run(monitor.profile.owner,monitor.profile.owner);
      db.prepare("DELETE FROM valuation_dirty WHERE owner=? AND id IN (SELECT id FROM events WHERE owner=? AND source IN ('zcode','dsh'))").run(monitor.profile.owner,monitor.profile.owner);
      // Existing daily cubes must not serve poisoned cached amounts until the
      // next explicit network refresh. Invalidate only affected local results.
      this.quarantineCachedPrices();
      db.prepare("INSERT OR IGNORE INTO valuation_dirty SELECT owner,id FROM events WHERE owner=? AND source='codex'").run(monitor.profile.owner);
      db.prepare('INSERT OR REPLACE INTO valuation_rule VALUES(?,?)').run(monitor.profile.owner,VALUATION_POLICY);
    });
  }
  private quarantineCachedPrices(day?: string) {
    const p=this.monitor.profile, db=p.db;
    this.refreshLookups();
    const groups=db.prepare("SELECT DISTINCT substr(e.at,1,10) day,e.model FROM events e WHERE e.owner=? AND e.source='codex' AND EXISTS(SELECT 1 FROM radar_values v WHERE v.owner=e.owner AND v.id=e.id)"+(day?' AND e.at>=? AND e.at<?':'')+' ORDER BY day,e.model').all(...(day?[p.owner,day+'T00:00:00',addDays(day,1)+'T00:00:00']:[p.owner]));
    for(const group of groups) {
      const model=String(group.model).replace(/^chatgpt-web\//,''), price=this.lookupDay(group.day).get(model.toLowerCase());
      if(!price || price.sourceType==='registry'&&!price.integrityIssue&&!price.unsupported&&['USD','CNY'].includes(price.currency)) continue;
      const compact=db.usageStorage;
      const select=compact?
        'SELECT '+compactEventProjection()+',e.owner storage_owner,e.id storage_id FROM compact_events e WHERE e.owner=(SELECT k FROM usage_strings WHERE value=?) AND e.source=(SELECT k FROM usage_strings WHERE value=\'codex\') AND e.model=(SELECT k FROM usage_strings WHERE value=?) AND e.at>=? AND e.at<? AND EXISTS(SELECT 1 FROM compact_valuations v WHERE v.owner=e.owner AND v.id=e.id) ORDER BY e.at':
        "SELECT e.* FROM events e WHERE e.owner=? AND e.source='codex' AND e.model=? AND e.at>=? AND e.at<? AND EXISTS(SELECT 1 FROM radar_values v WHERE v.owner=e.owner AND v.id=e.id) ORDER BY e.at";
      let cursor:{at:string;id:any}|undefined;
      while(true) {
        const sql=select.replace(' ORDER BY e.at', (cursor?' AND (e.at>? OR (e.at=? AND e.id>?))':'')+' ORDER BY e.at,e.id LIMIT 256');
        const rows=db.prepare(sql).safeIntegers().all(p.owner,group.model,group.day+'T00:00:00',addDays(group.day,1)+'T00:00:00',...(cursor?[cursor.at,cursor.at,cursor.id]:[]));
        if(!rows.length) break;
        const last=rows.at(-1)!;cursor={at:last.at,id:compact?last.storage_id:last.id};
        const batch=rows.map(row=>compact?{...row,_storageKeys:{owner:row.storage_owner,id:row.storage_id}}:row);
        if(!compact) { for(const currency of ['USD','CNY']) this.rows(batch,currency); continue; }
        this.preparedUpdates=new Map();
        try {
          for(const currency of ['USD','CNY']) this.rows(batch,currency);
          const updates=[...this.preparedUpdates.values()];
          writeCompactValuationBatch(db,p.owner,updates);
          const dirty=db.prepare('INSERT OR IGNORE INTO usage_dirty VALUES(?,?,?)');
          for(const row of updates) dirty.run(p.owner,row.source,row.day);
        } finally { this.preparedUpdates=null; }
      }
    }
  }
  private refreshLookups(version=this.version()) {
    if(this.lookupVersion!==version){this.lookupVersion=version;this.dayCache.clear();this.dayBytes=0;this.fxCache.clear();this.formulaCache.clear();}
  }
  store(body: string) {
    const cached=this.proofCache.get(body);if(cached)return cached;
    const raw = Buffer.from(body);
    if (raw.length > 12 * 1024 * 1024) throw new Error("证据超过保存限制");
    const digest = hash(raw);
    if(!this.monitor.profile.db.prepare('SELECT 1 FROM evidence_blobs WHERE digest=?').get(digest))this.monitor.profile.db
      .prepare("INSERT OR IGNORE INTO evidence_blobs VALUES(?,?,?,?)")
      .run(digest, "zlib", raw.length, deflateSync(raw, { level: 6 }));
    const reference="@blob:"+digest;this.proofCache.set(body,reference);this.proofBytes+=raw.length*2;while(this.proofBytes>2*1024*1024||this.proofCache.size>128){const first=this.proofCache.keys().next().value!;this.proofBytes-=Buffer.byteLength(first)*2;this.proofCache.delete(first);}return reference;
  }
  body(value: string) {
    if (!value.startsWith("@blob:")) return value;
    const digest = value.slice(6),
      row = this.monitor.profile.db
        .prepare("SELECT * FROM evidence_blobs WHERE digest=?")
        .get(digest) as JsonObject | undefined;
    if (
      !row ||
      row.codec !== "zlib" ||
      row.raw_size < 0 ||
      row.raw_size > 12 * 1024 * 1024
    )
      throw new Error("压缩证据不存在或结构错误");
    let raw: Buffer;
    try {
      raw = inflateSync(row.body, { maxOutputLength: row.raw_size + 1 });
    } catch {
      throw new Error("压缩证据损坏");
    }
    if (raw.length !== row.raw_size || hash(raw) !== digest)
      throw new Error("压缩证据摘要校验失败");
    return raw.toString("utf8");
  }
  version() {
    return (
      this.monitor.profile.db
        .prepare("SELECT version FROM radar_meta WHERE id=1")
        .get() as JsonObject
    ).version;
  }
  index() {
    const version = this.version();
    // The full price catalogue belongs to this response, not a second
    // permanently retained copy alongside bounded day lookups.
    {
      const prices = new Map<string, JsonObject>(),
        db = this.monitor.profile.db;
      for (const row of db
        .prepare("SELECT * FROM radar_days")
        .all() as JsonObject[]) {
        const parsed = validatePrices(this.body(row.body), row.day);
        for (const p of parsed.models)
          prices.set(row.day + "\0" + p.model, {
            ...p,
            day: row.day,
            digest: row.digest,
            observed: row.observed,
            snapshotSource: row.source,
          });
      }
      const fx = new Map(
        (db.prepare("SELECT * FROM value_fx").all() as JsonObject[]).map(
          (r) => [r.day, r],
        ),
      );
      return {prices,fx,version};
    }
  }
  state() {
    const index = this.index(),
      intervals: JsonObject[] = [];
    for (const price of [...index.prices.values()].sort(
      (a, b) => a.model.localeCompare(b.model) || a.day.localeCompare(b.day),
    )) {
      const item: JsonObject = {
          ...price,
          id: price.model + ":" + price.day,
          start: price.day + "T00:00:00+00:00",
          end: addDays(price.day, 1) + "T00:00:00+00:00",
        },
        previous = intervals.at(-1);
      if (
        previous &&
        previous.model === item.model &&
        previous.end === item.start &&
        ["quote", "currency", "sourceType", "unsupported"].every(
          (k) => canonical(previous[k]) === canonical(item[k]),
        )
      )
        previous.end = item.end;
      else intervals.push(item);
    }
    return {
      experimental: true,
      mode: SCENARIO,
      source: REGISTRY,
      agentCalculationEnabled:
        process.env.WORKBENCH_AGENT_VALUE_ENABLED === "1",
      prices: intervals,
      fxDays: index.fx.size,
      historicalAPI: true,
      refreshing: this.refreshing,
      task: { ...this.task },
      version: index.version,
      assumptions: "Portkey 公开目录的版本化快照参考等价值；不是实际账单或官方完整历史",
    };
  }
  sync(
    start: string,
    end: string,
    options: {
      rows?: JsonObject[];
      catalogDate?: string;
      scope?: string;
      loader?: Loader;
      force?: boolean;
      progress?: (v: JsonObject) => void;
      check?: () => void;
    } = {},
  ): Promise<JsonObject> {
    const previous = this.syncJob,
      next = (
        previous ? previous.catch(() => undefined) : Promise.resolve()
      ).then(() => this.collect(start, end, options));
    this.syncJob = next;
    next
      .finally(() => {
        if (this.syncJob === next) this.syncJob = null;
      })
      .catch(() => {});
    return next;
  }
  private async collect(
    start: string,
    end: string,
    options: {
      rows?: JsonObject[];
      catalogDate?: string;
      scope?: string;
      loader?: Loader;
      force?: boolean;
      progress?: (v: JsonObject) => void;
      check?: () => void;
    },
  ) {
    const today = new Date().toISOString().slice(0, 10);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(end) ||
      start > end ||
      end > today ||
      (!options.rows && (Date.parse(end) - Date.parse(start)) / 86400000 > 1096)
    )
      throw new Error("价格日期范围不正确，不能查询未来");
    const p=this.monitor.profile,owner=p.owner,db=p.db,rows=options.catalogDate?[]:options.rows||this.requirements(options.scope);
    const used=new Set<string>();
    for(const row of rows){const day=new Date(row.at).toISOString().slice(0,10);if(day>=start&&day<=end){used.add(day);used.add(addDays(day,-1));}}
    // Catalogue sync without consumption still supports an explicitly selected date.
    if(!rows.length){used.add(start);used.add(end);}
    const observed=iso(),network=options.loader||loadPrice;
    const loader:Loader=async(url,etag)=>{
      if(/^https:\/\/raw\.githubusercontent\.com\/Portkey-AI\/models\/[a-f0-9]{40}\//.test(url)){
        const cached=db.prepare('SELECT body FROM radar_observations WHERE url=? ORDER BY observed DESC LIMIT 1').get(url) as JsonObject|undefined;
        if(cached)return {body:this.body(cached.body),etag:''};
      }
      return network(url,etag);
    };
    const check=()=>{options.check?.();if(owner!==p.owner)throw Error('Profile 已切换');};
    const evidence=(url:string,body:string)=>{check();p.transaction(()=>db.prepare('INSERT OR IGNORE INTO radar_observations VALUES(?,?,?,?)').run(url,hash(body),this.store(body),observed));};
    const registry=await collectRegistry({days:[...used],loader,evidence,check,progress:options.progress,catalogDate:options.catalogDate,
      cacheRead:blob=>{const r=db.prepare('SELECT * FROM registry_file_cache WHERE blob=?').get(blob) as JsonObject|undefined;return r?{raw:this.body(r.body),source:r.source}:null;},
      cacheWrite:(blob,raw,source)=>{check();db.prepare('INSERT OR REPLACE INTO registry_file_cache VALUES(?,?,?)').run(blob,this.store(raw),source);}});
    const errors=registry.errors,gaps=registry.gaps;
    let checked=registry.snapshots.length,changed=0;
    for(const snapshot of registry.snapshots){
      check();validatePrices(snapshot.body,snapshot.day);
      const prior=db.prepare('SELECT * FROM radar_days WHERE day=?').get(snapshot.day) as JsonObject|undefined;
      if(prior){
        const incoming=parseExact(snapshot.body),stored=parseExact(this.body(prior.body));
        if(incoming.scope==='codex_openai'&&stored.scope==='provider_catalog'){
          stored.models=[...stored.models.filter((r:JsonObject)=>r.provider!=='openai'),...incoming.models].sort((a:JsonObject,b:JsonObject)=>String(a.id).localeCompare(String(b.id),'en'));
          snapshot.body=encode(stored);snapshot.source=prior.source;
        }else if(incoming.scope==='provider_catalog'&&incoming.coverage?.gaps?.length){
          const failed=new Set(incoming.coverage.gaps.map((g:JsonObject)=>g.provider).filter(Boolean));
          const cloudFailed=incoming.coverage.gaps.some((g:JsonObject)=>g.error==='current_catalog_unavailable'),ids=new Set(incoming.models.map((r:JsonObject)=>r.id));
          const retained=stored.models.filter((r:JsonObject)=>!ids.has(r.id)&&(failed.has(r.provider)||cloudFailed&&r.sourceType==='current_catalog'));
          incoming.models.push(...retained.map((r:JsonObject)=>({...r,registryComplex:true,pricingNotes:String(r.pricingNotes||'')+' 本次来源读取失败，保留此前同日证据，仅供查询。'})));
          incoming.models.sort((a:JsonObject,b:JsonObject)=>String(a.id).localeCompare(String(b.id),'en'));
          incoming.coverage.retainedModels=retained.length;snapshot.body=encode(incoming);
        }
      }
      const digest=hash(snapshot.body);
      if(prior?.digest===digest)continue;
      p.transaction(()=>{check();db.prepare('INSERT OR REPLACE INTO radar_days VALUES(?,?,?,?,?)').run(snapshot.day,this.store(snapshot.body),digest,snapshot.source,observed);db.prepare('UPDATE radar_meta SET version=version+1 WHERE id=1').run();this.quarantineCachedPrices(snapshot.day);});
      changed++;
    }
    this.refreshLookups();
    const missing=new Set<string>();
    for(const row of rows){
      const day=new Date(row.at).toISOString().slice(0,10),model=String(row.model||'').replace(/^chatgpt-web\//,''),key=day+':'+model;
      if(day<start||day>end||missing.has(key))continue;missing.add(key);
      const price=this.lookupDay(day).get(model.toLowerCase()),error=!price?'missing_historical_price':price.integrityIssue?'unverified_price_columns':price.unsupported?'unsupported_pricing_rules':null;
      if(error)gaps.push({day,model,error});
    }
    check();
    let fxDays = 0;
    try {
      options.check?.();
      const latestFx=db.prepare("SELECT max(day) AS day FROM value_fx WHERE day>=? AND day<=?").get(addDays(start,-10),end) as JsonObject;
      const fxStart=options.force?addDays(start,-10):latestFx.day?addDays(latestFx.day,1):addDays(start,-10);
      if(fxStart>end){options.progress?.({phase:"fx",completed:1,total:1});return {pricesChecked:checked,pricesAdded:changed,errors,gaps,fxDays,observed};}
      options.progress?.({ phase: "fx", completed: 0, total: 1 });
      const { body } = await loader(
        FX_URL + "?start_date=" + fxStart + "&end_date=" + end,
      );
      if (!body) throw new Error();
      const response = parseExact(body);
      if (!Array.isArray(response.observations)) throw new Error();
      const fxRows: JsonObject[] = [];
      let last = "";
      for (const r of response.observations) {
        const day = r.d,
          usd = new Decimal(String(r.FXUSDCAD.v)),
          cny = new Decimal(String(r.FXCNYCAD.v));
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
          day < addDays(start, -10) ||
          day > end ||
          (last && day <= last) ||
          [usd, cny].some((n) => !n.isFinite() || n.lte(".001") || n.gte(100))
        )
          throw new Error();
        last = day;
        fxRows.push({
          day,
          usd_cad: usd.toString(),
          cny_cad: cny.toString(),
          source: FX_URL,
          observed,
          digest: hash(body),
        });
      }
      options.check?.();
      p.transaction(() => {
        for (const row of fxRows) {
          const old = db
            .prepare("SELECT usd_cad,cny_cad FROM value_fx WHERE day=?")
            .get(row.day) as JsonObject | undefined;
          if (
            !old ||
            old.usd_cad !== row.usd_cad ||
            old.cny_cad !== row.cny_cad
          )
            fxDays++;
          else continue;
          db.prepare("INSERT OR REPLACE INTO value_fx VALUES(?,?,?,?,?,?)").run(
            row.day,
            row.usd_cad,
            row.cny_cad,
            row.source,
            row.observed,
            row.digest,
          );
        }
        if (fxDays)
          db.prepare(
            "UPDATE radar_meta SET version=version+1 WHERE id=1",
          ).run();
      });
      options.progress?.({ phase: "fx", completed: 1, total: 1 });
    } catch {
      options.check?.();
      errors.push({ source: FX_URL, error: "历史汇率读取失败，保留已有数据" });
    }
    options.check?.();
    return {
      pricesChecked: checked,
      pricesAdded: changed,
      fxDays,
      errors,
      gaps,
      observed,
    };
  }
  evaluate(row: JsonObject, raw: JsonObject | undefined, currency: string, version=this.version()) {
    this.refreshLookups(version);
    const day = new Date(row.at).toISOString().slice(0, 10),
      model = String(row.model).replace(/^chatgpt-web\//, ""),
      basePrice = this.lookupDay(day).get(model.toLowerCase()),
      fail = (reason: string, proof: JsonObject = {}) => ({
        cost: null,
        currency,
        valueReason: reason,
        valueProof: proof,
        valueParts: {},
        valueVersion: version,
      });
    if (!basePrice) return fail("missing_historical_price");
    const price:JsonObject={...basePrice,quote:{...basePrice.quote}};
    const band=price.referenceBands?.filter((b:JsonObject)=>BigInt(row.input??0)>BigInt(b.aboveTokens)||b.aboveTokens==='0').at(-1);
    if(band)price.quote={input:band.inputPricePer1M,output:band.outputPricePer1M,cached:band.cacheReadPricePer1M,write:band.cacheWritePricePer1M};
    if (price.integrityIssue) return fail('unverified_price_columns', {
      model, priceDate: day, digest: price.digest, source: price.source,
      snapshotSource: price.snapshotSource, quote: price.quote,
      integrityIssue: price.integrityIssue,
    });
    if (price.sourceType !== "registry") return fail("fallback_price");
    if (price.unsupported || !["USD", "CNY"].includes(price.currency))
      return fail("unsupported_pricing_rules");
    const previous = this.lookupDay(addDays(day,-1)).get(model.toLowerCase());
    if (
      previous && !previous.integrityIssue &&
      canonical([previous.quote, previous.currency,previous.referenceBands]) !==
        canonical([basePrice.quote, price.currency,price.referenceBands])
    )
      return fail("uncertain_price_transition");
    if (!raw) return fail("missing_usage_evidence");
    const u =
        raw.last_token_usage && Object.keys(raw.last_token_usage).length
          ? raw.last_token_usage
          : raw.usage || {},
      reportedWrite =
        u.cache_write_input_tokens ??
        u.cache_creation_input_tokens ??
        u.cacheWriteTokens ?? u.input_tokens_details?.cache_write_tokens,
      written = reportedWrite ?? 0;
    if ([row.input, row.output, row.cached, written].some((v) => v == null))
      return fail("missing_usage_details");
    if (
      (typeof written !== "number" && typeof written !== "bigint") ||
      (typeof written === "number" && !Number.isInteger(written)) ||
      written < 0 ||
      BigInt(row.cached) + BigInt(written) > BigInt(row.input)
    )
      return fail("conflicting_usage_evidence");
    let incoming = u.input_tokens ?? u.input ?? u.inputTokens;
    const outgoing = u.output_tokens ?? u.output ?? u.outputTokens,
      cached = u.cached_input_tokens ?? u.cached ?? u.cacheReadTokens,
      total = u.total_tokens ?? u.total ?? u.totalTokens;
    if (
      "inputTokens" in u &&
      [incoming, cached, written].every((v) => v != null)
    )
      incoming = BigInt(incoming) + BigInt(cached) + BigInt(written);
    else if (
      [incoming, outgoing, total, cached, written].every((v) => v != null) &&
      BigInt(incoming) + BigInt(outgoing) !== BigInt(total) &&
      BigInt(incoming) + BigInt(cached) + BigInt(written) + BigInt(outgoing) ===
        BigInt(total)
    )
      incoming = BigInt(incoming) + BigInt(cached) + BigInt(written);
    if (
      [row.input, row.output, row.cached, row.total].some(
        (expected, i) =>
          [incoming, outgoing, cached, total][i] == null ||
          BigInt(expected) !== BigInt([incoming, outgoing, cached, total][i]),
      )
    )
      return fail("conflicting_usage_evidence");
    if (raw.model && String(raw.model).replace(/^chatgpt-web\//, "") !== model)
      return fail("conflicting_model_evidence");
    const quantities: JsonObject = {
      input: BigInt(row.input) - BigInt(row.cached) - BigInt(written),
      cached: row.cached,
      write: written,
      output: row.output,
    };
    if (
      Object.entries(quantities).some(
        ([k, v]) => BigInt(v) !== 0n && price.quote[k] === null,
      )
    )
      return fail("missing_component_price");
    const proof: JsonObject = {
        model,
        source: price.source,
        snapshotSource: price.snapshotSource,
        priceDate: price.day,
        priceCurrency: price.currency,
        digest: price.digest,
        scenario: SCENARIO,
        assumptions:['原供应商全球标准文本档，工具及附加服务费用不在此估算内',...(reportedWrite==null?['日志未报告缓存写入；基准情景按未写入估算，非已核验实际扣费']:[])],
        contextBand:band?.aboveTokens??null,
        estimated: true,
      },
      parts: Record<string, Decimal> = Object.fromEntries(
        Object.entries(quantities).map(([k, v]) => [
          k,
          new Decimal(String(v)).times(price.quote[k] || "0").div(1000000),
        ]),
      );
    if (currency !== price.currency) {
      const usageDate = shanghaiDay(row.at);
      const rate=this.lookupFx(row.at);
      if (!rate) return fail("missing_historical_fx", proof);
      const ratio = new Decimal(rate.usd_cad).div(rate.cny_cad);
      for (const k of Object.keys(parts))
        parts[k] =
          price.currency === "USD"
            ? parts[k].times(ratio)
            : parts[k].div(ratio);
      proof.fx = {
        rate: ratio.toString(),
        rateDate: rate.day,
        usageDate,
        carried: rate.day !== usageDate,
        source: rate.source,
        digest: rate.digest,
      };
    }
    return {
      cost: Object.values(parts)
        .reduce((n, v) => n.plus(v), new Decimal(0))
        .toString(),
      currency,
      valueReason: "priced",
      valueProof: proof,
      valueParts: Object.fromEntries(
        Object.entries(parts).map(([k, v]) => [k, v.toString()]),
      ),
      valueVersion: version,
    };
  }
  rows(rows: JsonObject[], currency = 'USD', readonly = false, includeProof = false) {
    if(!['USD','CNY'].includes(currency))throw new Error('等价值币种须为 USD 或 CNY');
    const p=this.monitor.profile,db=p.db,read=db.prepare('SELECT fingerprint,result FROM radar_values WHERE owner=? AND id=? AND currency=?'),codex=db.prepare('SELECT raw FROM codex_evidence WHERE owner=? AND id=? AND verified=1'),agent=db.prepare('SELECT raw FROM agent_evidence WHERE owner=? AND id=? AND verified=1'),save=db.prepare('INSERT OR REPLACE INTO radar_values VALUES(?,?,?,?,?)');
    const version=this.version();this.refreshLookups(version);
    const updates:JsonObject[]=[];
    const result=rows.map(row=>{
      const keys=row._storageKeys,name=currency.toLowerCase();
      const old=keys?db.prepare('SELECT lower(hex('+name+'_fingerprint)) fingerprint,'+name+'_payload payload FROM compact_valuations WHERE owner=? AND id=?').get(keys.owner,keys.id):read.get(p.owner,row.id,currency) as JsonObject|undefined;
      const day=new Date(row.at).toISOString().slice(0,10),model=String(row.model).replace(/^chatgpt-web\//,''),price=this.lookupDay(day).get(model.toLowerCase()),previous=this.lookupDay(addDays(day,-1)).get(model.toLowerCase()),fx=price?.currency===currency?null:this.lookupFx(row.at);
      const rawText=price?.integrityIssue?undefined:keys?db.prepare('SELECT lingxi_read_payload(p.delta,p.pack,p.ordinal,'+(row.source==='codex'?4:0)+') raw FROM compact_'+(row.source==='codex'?'codex_evidence':'agent_evidence')+' e JOIN usage_payloads p ON p.k=e.payload WHERE e.owner=? AND e.id=? AND e.verified=1').get(keys.owner,keys.id)?.raw:((row.source==='codex'?codex:agent).get(p.owner,row.id) as JsonObject|undefined)?.raw;
      let raw=rawText?this.rawCache.get(rawText):undefined;if(rawText&&!raw){raw=parseExact(rawText);if(rawText.length<8000)this.rawCache.set(rawText,raw!);}
      const signature=canonical([VALUATION_POLICY,row.source,model,day,shanghaiDay(row.at),row.input,row.output,row.cached,row.total,raw?[raw.model,raw.last_token_usage&&Object.keys(raw.last_token_usage).length?raw.last_token_usage:raw.usage]:null,price?.digest||null,previous?.digest||null,fx?[fx.day,fx.usd_cad,fx.cny_cad]:null,currency]);
      let memo=this.formulaCache.get(signature);const fingerprint=memo?.fingerprint||hash(signature);let value:JsonObject;
      // Preparation only needs changed results. A matching persisted fingerprint
      // must not decompress the old result just to throw it away afterwards.
      if(this.preparedUpdates&&old?.fingerprint===fingerprint)return row;
      if(old?.fingerprint===fingerprint)value=parseExact(keys?db.prepare('SELECT lingxi_read_payload(delta,pack,ordinal,0) result FROM usage_payloads WHERE k=?').get(old.payload).result:old.result);
      else{if(!memo){const evaluated=this.evaluate(row,raw,currency,version),{valueProof,valueVersion,currency:unusedCurrency,...rest}=evaluated;const compact:JsonObject=rest;compact._proof=this.store(encode(valueProof||{}));memo={fingerprint,value:compact};this.formulaCache.set(signature,memo);while(this.formulaCache.size>512)this.formulaCache.delete(this.formulaCache.keys().next().value!);}value=memo.value;updates.push({id:row.id,fingerprint,value,keys:row._storageKeys,source:row.source,day:shanghaiDay(row.at)});}
      value={...value,currency,valueVersion:version};
      if(includeProof&&value._proof){value={...value,valueProof:parseExact(this.body(value._proof))};delete value._proof;}
      return {...row,...value};
    });
    if(updates.length&&this.preparedUpdates){for(const row of updates){const saved=this.preparedUpdates.get(row.id)||{id:row.id,keys:row.keys,source:row.source,day:row.day};saved[currency.toLowerCase()]=row;this.preparedUpdates.set(row.id,saved);}}else if(updates.length)p.transaction(()=>{db.exec("CREATE TABLE IF NOT EXISTS usage_dirty(owner TEXT,source TEXT,day TEXT,PRIMARY KEY(owner,source,day))");const dirty=db.prepare("INSERT OR IGNORE INTO usage_dirty VALUES(?,?,?)");for(const r of updates){if(db.usageStorage)writeCompactValuation(db,p.owner,r.id,currency,r.fingerprint,r.value,r.keys);else save.run(p.owner,r.id,currency,r.fingerprint,encode(r.value));dirty.run(p.owner,r.source,r.day);}});
    if(updates.length)this.monitor.responseCache.clear();
    return result;
  }
  requirements(scope='') {
    const p=this.monitor.profile,where=scope?' AND source=?':'';return p.db.prepare("SELECT DISTINCT substr(at,1,10) AS day,model FROM events WHERE owner=? AND source IN ('codex')"+where+" ORDER BY day").all(...(scope?[p.owner,scope]:[p.owner])).map((row:JsonObject)=>({at:row.day+'T00:00:00Z',model:row.model}));
  }
  async prepareRows(scope:string,check:()=>void=()=>{},progress?:(v:JsonObject)=>void){
    const p=this.monitor.profile,db=p.db,where=scope?' AND e.source=?':'';
    const compact=db.usageStorage,ownerKey=compact?db.prepare('SELECT k FROM usage_strings WHERE value=?').get(p.owner)?.k:null;
    if(compact&&ownerKey==null){check();progress?.({phase:'valuation',completed:0,total:0});return;}
    if(compact)db.exec('CREATE TABLE IF NOT EXISTS usage_dirty(owner TEXT,source TEXT,day TEXT,PRIMARY KEY(owner,source,day))');
    const stmt=db.prepare(compact?'SELECT '+compactEventProjection()+',d.owner AS storage_owner,d.id AS storage_id FROM compact_valuation_dirty d CROSS JOIN compact_events e WHERE e.owner=d.owner AND e.id=d.id AND d.owner=?'+(scope?' AND e.source=(SELECT k FROM usage_strings WHERE value=?)':'')+' LIMIT 256':'SELECT e.* FROM valuation_dirty d CROSS JOIN events e WHERE d.owner=? AND e.owner=d.owner AND e.id=d.id'+where+' LIMIT 256').safeIntegers();
    const args=[compact?ownerKey:p.owner,...(scope?[scope]:[])];
    const preferred=compact&&scope==='codex'?db.prepare('SELECT '+compactEventProjection()+',d.owner AS storage_owner,d.id AS storage_id,x.payload AS proof_payload FROM compact_codex_evidence x INDEXED BY compact_codex_payload_scan CROSS JOIN compact_valuation_dirty d CROSS JOIN compact_events e WHERE x.owner=? AND x.payload>? AND d.owner=x.owner AND d.id=x.id AND e.owner=d.owner AND e.id=d.id AND e.source=(SELECT k FROM usage_strings WHERE value=?) ORDER BY x.payload LIMIT 256').safeIntegers():null;
    let proofCursor:number|bigint=0;
    let completed=0;const total=progress?Number((db.prepare("SELECT count(*) AS n FROM valuation_dirty d JOIN events e ON e.owner=d.owner AND e.id=d.id WHERE d.owner=?"+(scope?" AND e.source=?":"")).get(...(scope?[p.owner,scope]:[p.owner])) as JsonObject).n):0;
    while(true){
      let savedRows:JsonObject[]=preferred?.all(ownerKey,proofCursor,scope)||[];
      if(savedRows.length)proofCursor=savedRows.at(-1)!.proof_payload;else savedRows=stmt.all(...args);
      const batch=savedRows.map((saved:JsonObject)=>{
        const {storage_owner,storage_id,proof_payload,...values}=saved;
        const row=Object.fromEntries(Object.entries(values).map(([key,value])=>[key,typeof value==='bigint'&&value<=BigInt(Number.MAX_SAFE_INTEGER)?Number(value):value]));
        if(compact)Object.defineProperty(row,'_storageKeys',{value:{owner:storage_owner,id:storage_id}});
        return row;
      });
      if(!batch.length)break;check();
      batch.sort((a:JsonObject,b:JsonObject)=>String(a.at).localeCompare(String(b.at)));
      const days:JsonObject[][]=[];for(const row of batch){const group=days.at(-1);if(group&&String(group[0].at).slice(0,10)===String(row.at).slice(0,10))group.push(row);else days.push([row]);}
      const groups=days.every(group=>{const day=String(group[0].at).slice(0,10);return this.dayCache.has(day)&&this.dayCache.has(addDays(day,-1));})?[batch]:days;
      // One durable commit per bounded batch: both currencies, queue removal
      // and evidence sealing succeed together, without weakening WAL durability.
      try{p.transaction(()=>{if(compact)this.preparedUpdates=new Map();try{for(const group of groups)for(const currency of ['USD','CNY'])this.rows(group,currency);if(this.preparedUpdates){const dirty=db.prepare('INSERT OR IGNORE INTO usage_dirty VALUES(?,?,?)');writeCompactValuationBatch(db,p.owner,[...this.preparedUpdates.values()]);for(const row of this.preparedUpdates.values())dirty.run(p.owner,row.source,row.day);}}finally{this.preparedUpdates=null;}const remove=db.prepare(compact?'DELETE FROM compact_valuation_dirty WHERE owner=? AND id=?':'DELETE FROM valuation_dirty WHERE owner=? AND id=?');for(const row of batch){if(compact)remove.run(ownerKey,row._storageKeys.id);else remove.run(p.owner,row.id);}packPendingUsage(db,1000);check();});}
      catch(error){
        // Proofs and formula results created in this transaction may refer to
        // rolled-back rows. A retry must rebuild them from persistent data.
        this.proofCache.clear();this.proofBytes=0;this.formulaCache.clear();
        throw error;
      }
      completed+=batch.length;progress?.({phase:"valuation",completed,total:Math.max(completed,total)});await new Promise(resolve=>setImmediate(resolve));
    }
    return completed;
  }
  async details(params:JsonObject){
    const date=String(params.date||''),model=String(params.model||'');
    if(date!==new Date().toISOString().slice(0,10))throw Error('详细接口只提供当前报价；历史请查看已归档快照');
    const price=this.catalog({date,model,limit:1}).items[0],id=price?.detailId;
    if(typeof id!=='string'||!/^[a-zA-Z0-9._-]{1,180}$/.test(id))throw Error('该模型没有详细价格接口');
    const url='https://ai.cloudprice.net/api/v1/models/'+encodeURIComponent(id)+'/pricing';
    const prior=this.monitor.profile.db.prepare('SELECT body,observed FROM radar_observations WHERE url=? ORDER BY observed DESC LIMIT 1').get(url) as JsonObject|undefined;
    let body=prior?.observed?.slice(0,10)===date?this.body(prior.body):null;
    if(!body){body=(await loadPrice(url)).body;if(!body)throw Error('详细价格读取失败');this.monitor.profile.db.prepare('INSERT OR IGNORE INTO radar_observations VALUES(?,?,?,?)').run(url,hash(body),this.store(body),iso());}
    const data=parseExact(body).data;
    if(!data||data.currency!=='USD'||data.ingestion_date!==date||!Array.isArray(data.providers))throw Error('详细价格日期或结构无效');
    const rows:JsonObject[]=[];
    for(const provider of data.providers)for(const tier of provider.tiers||[])for(const region of tier.regions||[])for(const rule of region.prices||[]){
      rows.push({provider:provider.provider_id,tier:tier.tier,region:region.region,...rule});if(rows.length>10000)throw Error('详细价格条目过多');
    }
    return {date,model,source:url,digest:hash(body),rows,notice:'聚合报价须核对供应商原文。DeepSeek 的 batch 标签与官方谷时定义不一致，不用于自动估值；上下文阈值、地域、缓存时长及服务档位分别保留。'};
  }
  catalog(params: JsonObject) {
    const db = this.monitor.profile.db,
      dates = (
        db
          .prepare("SELECT day FROM radar_days ORDER BY day DESC")
          .all() as JsonObject[]
      ).map((r) => r.day),
      date = params.date || dates[0] || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("价格日期不正确");
    const snapshot = db
        .prepare("SELECT * FROM radar_days WHERE day=?")
        .get(date) as JsonObject | undefined,
      parsed = snapshot?validatePrices(this.body(snapshot.body),date):null,
      models = parsed
        ? parsed.models.map(
            (m): JsonObject => ({
              ...m,
              date,
              snapshotSource: snapshot!.source,
              digest: snapshot!.digest,
            }),
          )
        : [],
      nativeIds=new Set(models.map(m=>m.provider+'\0'+m.model.toLowerCase())),
      visible = models.filter(m=>mainstreamModel(m.provider,m.model)&&(!/-\d{4}-\d{2}-\d{2}$/.test(m.model)||!nativeIds.has(m.provider+'\0'+m.model.toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/,'')))),
      q = String(params.q || "").toLowerCase(),
      rows = visible.filter(
        (m) =>
          (!params.provider || m.provider === params.provider) &&
          (!params.model || m.model === params.model) &&
          (!q || (m.model + " " + m.provider).toLowerCase().includes(q)),
      ),
      offset = Math.max(0, Math.trunc(Number(params.offset) || 0)),
      limit = Math.min(
        100,
        Math.max(1, Math.trunc(Number(params.limit) || 50)),
      );
    const sort=['model','currency','input','cached','write','output','status'].includes(params.sort)?params.sort:'model',direction=params.direction==='desc'?-1:1;
    const status=(m:JsonObject)=>m.integrityIssue?'报价冲突':m.unsupported?'复杂规则':m.sourceType==='registry'?'公开目录':'当日目录';
    rows.sort((a,b)=>{
      let order=0;
      if(['input','cached','write','output'].includes(sort)){
        const x=a.quote[sort],y=b.quote[sort];
        if(x==null||y==null)return x==null?(y==null?a.model.localeCompare(b.model):1):-1;
        order=new Decimal(x).cmp(y);
      }else order=String(sort==='status'?status(a):a[sort]??'').localeCompare(String(sort==='status'?status(b):b[sort]??''),'zh-CN',{numeric:true});
      return order*direction||a.model.localeCompare(b.model)||a.provider.localeCompare(b.provider);
    });
    return {
      items: rows.slice(offset, offset + limit),
      total: rows.length,
      date,
      dates,
      sort,direction:direction===1?'asc':'desc',
      providers: [...new Set(visible.map((m) => m.provider))].sort(),
      models: [
        ...new Set(
          visible
            .filter((m) => !params.provider || m.provider === params.provider)
            .map((m) => m.model),
        ),
      ].sort(),
      missing: !snapshot,
      coverage:parsed?.coverage??null,
      source: REGISTRY,
      version: this.version(),
    };
  }
  fxSeries(params: JsonObject) {
    const end = params.end || shanghaiDay(new Date()),
      start = params.start || addDays(end, -30),
      chosen = params.date || end;
    if (
      start > end ||
      chosen > shanghaiDay(new Date()) ||
      end > shanghaiDay(new Date()) ||
      (Date.parse(end) - Date.parse(start)) / 86400000 > 1096
    )
      throw new Error("汇率日期范围不正确");
    let card: JsonObject | null = null;
    const series: JsonObject[] = [];
    for (const row of this.monitor.profile.db
      .prepare("SELECT * FROM value_fx WHERE day>=? AND day<=? ORDER BY day")
      .all(
        addDays(start < chosen ? start : chosen, -7),
        end > chosen ? end : chosen,
      ) as JsonObject[]) {
      const rate = new Decimal(row.usd_cad).div(row.cny_cad),
        item = {
          date: row.day,
          usdCny: rate.toString(),
          cnyUsd: new Decimal(1).div(rate).toString(),
          source: row.source,
        };
      if (row.day >= start && row.day <= end) series.push(item);
      if (
        row.day <= chosen &&
        (Date.parse(chosen) - Date.parse(row.day)) / 86400000 <= 7
      )
        card = { ...item, requestedDate: chosen, carried: row.day !== chosen };
    }
    return {
      series,
      card,
      start,
      end,
      source: "https://www.bankofcanada.ca/valet/",
    };
  }
}
export class ValuationTasks {
  private live = new Set<string>();
  async idle() {
    while (this.running)
      await new Promise((resolve) => setTimeout(resolve, 25));
  }
  constructor(
    readonly pricing: Pricing,
    readonly control: Control,
    readonly syncAgent: (scope: string) => Promise<unknown>,
  ) {}
  autoStatus(){
    const p=this.control.profile,history=p.read<JsonObject>('pricing-auto-update',{});
    return {enabled:this.control.state().config.codexPricingAutoUpdate===true,timezone:'Asia/Shanghai',
      ...history,task:this.status('codex'),notice:'应用运行时按上海日期每天更新一次；关闭后下次启动补查。'};
  }
  setAuto(enabled:unknown){
    if(typeof enabled!=='boolean')throw Error('自动更新设置必须为布尔值');
    this.control.saveConfig({codexPricingAutoUpdate:enabled});
    if(enabled)this.tickAuto();
    return this.autoStatus();
  }
  tickAuto(){
    if(this.running||this.control.state().config.codexPricingAutoUpdate!==true)return;
    const p=this.control.profile,day=shanghaiDay(new Date()),state=p.read<JsonObject>('pricing-auto-update',{});
    if(state.lastAttemptDay===day)return;
    p.write('pricing-auto-update',{lastAttemptDay:day,attemptedAt:iso()});
    this.start('codex',true);
  }
  private flag(scope: string) {
    if (scope !== "codex")
      throw new Error("计价工具不正确");
    return scope + "ValuationEnabled";
  }
  status(scope: string) {
    this.flag(scope);
    const p = this.control.profile,
      state = p.read<JsonObject>("valuation-" + scope, {
        status: "idle",
        scope,
      });
    if (state.status === "running" && !this.live.has(state.id)) {
      Object.assign(state, {
        status: "failed",
        error: "后台重启，准备尚未完成；请重试或取消",
      });
      p.write("valuation-" + scope, state);
    }
    if(state.coverage&&state.versions?.rule!==VALUATION_POLICY){
      delete state.coverage;delete state.versions;
      if(state.status==='complete')state.status='stale';
      p.write('valuation-'+scope,state);
    }
    return state;
  }
  disable(scope: string) {
    const p = this.control.profile,
      state = this.status(scope);
    if(state.status!=="complete")Object.assign(state, { status: "cancelled", finished: Date.now() / 1000 });
    p.transaction(() => {
      p.write("valuation-" + scope, state);
      this.control.saveConfig({ [this.flag(scope)]: false });
    });
    return {
      features: Object.fromEntries(
        Object.entries(this.control.state().config).filter(
          ([k]) =>
            k.endsWith("ValuationEnabled") ||
            ["promptAutosave", "promptAIEnabled"].includes(k),
        ),
      ),
      task: state,
    };
  }
  start(scope: string, background = false) {
    const current = this.status(scope);
    if (current.status === "running") return current;
    const p = this.control.profile;
    if(!background && current.coverage){this.control.saveConfig({[this.flag(scope)]:true});return {...current,status:'complete'};}
    const id = uid(),
      owner = p.owner,
      state: JsonObject = {
        background,
        ...(background?{coverage:current.coverage,versions:current.versions}:{}),
        id,
        scope,
        status: "running",
        phase: "usage",
        completed: 0,
        total: 1,
        created: Date.now() / 1000,
        deadline: Date.now() / 1000 + 300,
      };
    this.live.add(id);
    if(!background)this.control.saveConfig({ [this.flag(scope)]: false });
    const enableAfter = !background || this.control.state().config[this.flag(scope)] === true;
    p.write("valuation-" + scope, state);
    const check = () => {
        const saved = p.read<JsonObject>("valuation-" + scope, {});
        if (owner !== p.owner || saved.id !== id || saved.status !== "running")
          throw new Error("计价准备已取消");
        if (Date.now() / 1000 >= state.deadline)
          throw new Error("准备超过五分钟，请重试或取消");
      },
      update = (values: JsonObject) => {
        check();
        Object.assign(state, values);
        p.write("valuation-" + scope, state);
      };
    Promise.resolve()
      .then(async () => {
        check();
        const rows = this.pricing.requirements(scope),
          dates = rows
            .map((r) => new Date(r.at).toISOString().slice(0, 10))
            .sort(),
          today = new Date().toISOString().slice(0, 10);
        update({ phase: "prices", completed: 0, total: new Set(dates).size });
        const result = await this.pricing.sync(
          dates[0] || today,
          dates.at(-1) || today,
          { rows, scope, force: background, progress: update, check },
        );
        if (result.errors.length)
          throw new Error("价格或汇率网络同步失败；缓存保留，请重试或取消");
        update({ phase: "valuation", completed: 0, total: 2 });
        const coverage: JsonObject = {};
        let stable = false;
        while (!stable) {
          await this.pricing.prepareRows(scope,check,update);
          for (const [n, currency] of ["USD", "CNY"].entries()) {
            check();
            const snapshot = this.pricing.monitor.snapshot({
              scope,
              source: scope,
              period: "all",
              value_currency: currency,
              valuation_enabled: true,
            });
            this.pricing.monitor.snapshot({
              scope,
              source: scope === "codex" ? scope : "",
              period: "30",
              value_currency: currency,
              valuation_enabled: true,
            });
            coverage[currency] = {
              summary: snapshot.valuation?.summary,
              issues: snapshot.valuation?.issues || {},
              priceVersion: this.pricing.version(),
              dataVersion: snapshot.dataVersion,
            };
            update({ phase: "valuation", completed: n + 1, total: 2 });
          }
          stable = ["dataVersion", "priceVersion"].every(
            (k) => coverage.USD[k] === coverage.CNY[k],
          );
          if (!stable) update({ phase: "valuation", completed: 0, total: 2 });
        }
        check();
        Object.assign(state, {
          status: "complete",
          phase: "ready",
          coverage,
          versions: {
            rule:VALUATION_POLICY,
            priceAndFx: coverage.USD.priceVersion,
            usage: coverage.USD.dataVersion,
          },
          finished: Date.now() / 1000,
        });
        p.transaction(() => {
          this.control.saveConfig({ [this.flag(scope)]: enableAfter });
          p.write("valuation-" + scope, state);
        });
      })
      .catch((error) => {
        const saved = p.read<JsonObject>("valuation-" + scope, {});
        if (saved.id === id && saved.status === "running") {
          Object.assign(saved, {
            status: "failed",
            error:
              error.message?.slice(0, 400) ||
              "准备失败，缓存保留；请重试或取消",
            finished: Date.now() / 1000,
          });
          p.write("valuation-" + scope, saved);
        }
      })
      .finally(() => this.live.delete(id));
    return { ...state };
  }
  get running() {
    return !!this.live.size;
  }
}
