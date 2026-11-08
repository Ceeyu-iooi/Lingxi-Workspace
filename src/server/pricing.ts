import { Decimal } from 'decimal.js';
import { deflateSync, inflateSync } from 'node:zlib';
import {writeCompactValuation,writeCompactValuationBatch,packPendingUsage,compactEventProjection} from './usage-storage.ts';
import { Monitor, canonical, iso } from "./monitor.ts";
import { hash, parseExact, encode, uid, type JsonObject } from "./profile.ts";
import { Control } from "./control.ts";
import { shanghaiDay, addDays } from "./usage-summary.ts";
import {collectMirror,collectCurrentCatalogue,compareMirror,mirrorDigest,REGISTRY,CURRENT_PRICES,type PriceLoader,type PriceSnapshot} from './price-source.ts';
import {
  OFFICIAL_POLICY,
  OFFICIAL_SOURCES,
  collectOfficial,
  officialLinks,
  officialQuoteFor,
  officialRate,
  officialSnapshot,
  shanghaiPeak,
  type OfficialRate,
} from './official-pricing.ts';
import {get as httpsGet,Agent} from 'node:https';
import {HttpsProxyAgent} from 'https-proxy-agent';

/**
 * Bumped because the pricing rules changed, not merely the code: every stored
 * amount that was derived from a mirror catalogue must be re-derived from the
 * official table, and a day that can only be estimated must carry that label.
 * The version is owned by the price table itself, so expanding the table always
 * re-derives the stored amounts instead of keeping older quotes silently.
 */
const VALUATION_POLICY = OFFICIAL_POLICY;

const STRIP_PREFIX = /^chatgpt-web\//;
const FX_URL =
    "https://www.bankofcanada.ca/valet/observations/FXUSDCAD,FXCNYCAD/json",
  SCENARIO = "official-deepseek-peak-offpeak/text";
type Loader = PriceLoader;
/** Every host we may read prices from. Official pages first, mirrors last. */
const PRICE_HOSTS = ["api-docs.deepseek.com", "platform.kimi.com", "docs.anthropic.com", "platform.openai.com", "open.bigmodel.cn", "ai.google.dev", "help.aliyun.com", "www.minimax.io", "www.bankofcanada.ca", "raw.githubusercontent.com", "api.github.com", "ai.cloudprice.net"];
const priceTransport = new Agent({keepAlive:true,maxSockets:4,maxCachedSessions:0});
let priceProxy:HttpsProxyAgent<string>|undefined;
function publicTransport(host:string){
  const proxy=process.env.LINGXI_PRICE_PROXY||process.env.https_proxy||process.env.HTTPS_PROXY;
  const excluded=(process.env.no_proxy||process.env.NO_PROXY||'').split(',').some(rule=>{const name=rule.trim().toLowerCase().replace(/:443$/,'');return name==='*'||name===host||name.startsWith('.')&&host.endsWith(name)||name.startsWith('*.')&&host.endsWith(name.slice(1));});
  return proxy&&!excluded?(priceProxy ||=new HttpsProxyAgent(proxy,{keepAlive:true,maxSockets:4})):priceTransport;
}
export async function loadPrice(url: string, etag = "") {
  if (!PRICE_HOSTS.includes(new URL(url).hostname))
    throw new Error("价格来源不受支持");
  /* Public idempotent GET only. Keep TLS verification and avoid broken resumed
     handshakes seen on some networks. Never retry a model/credential request. */
  const attempt=()=>new Promise<{body:string|null,etag:string}>((resolve,reject)=>{
    const request=httpsGet(url,{agent:publicTransport(new URL(url).hostname),signal:AbortSignal.timeout(20000),headers:{'User-Agent':'Lingxi-Usage','Accept':'text/html,application/json',...(etag?{'If-None-Match':etag}:{})}},response=>{
      if(response.statusCode===304){response.resume();resolve({body:null,etag});return;}
      if(response.statusCode!==200){response.resume();reject(Object.assign(Error('价格网络读取失败'),{status:response.statusCode}));return;}
      const chunks:Buffer[]=[];let bytes=0;
      response.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>12*1024*1024){response.destroy(Error('价格响应过大'));return;}chunks.push(chunk);});
      response.on('end',()=>resolve({body:Buffer.concat(chunks).toString('utf8'),etag:String(response.headers.etag||'')}));
      response.on('error',reject);
    });request.on('error',reject);
  });
  try{return await attempt();}catch(error:any){
    if(error.status){
      // Preserve the status code so callers can distinguish throttling from real failures,
      // and name the host so the message is actionable instead of generic.
      const host = (() => { try { return new URL(url).hostname; } catch { return "价格来源"; } })();
      throw Object.assign(
        Error(
          error.status === 403 || error.status === 429
            ? `公开价格接口限流（${host} HTTP ${error.status}），请稍后刷新；缓存保留`
            : `公开价格接口读取失败（${host} HTTP ${error.status}）；缓存保留`,
        ),
        { status: error.status },
      );
    }
    if(/ECONNRESET|ETIMEDOUT|EPIPE|ABORT_ERR/.test(String(error.code)))try{return await attempt();}catch{}
    throw Error('公开价格网络连接失败，请检查网络后重试；缓存保留');
  }
}
const QUIET_KEYS = new Set(['pricingNotes','aliasNote']);
/** Peak windows are structured fields here, not a note the rule parser has to guess at. */
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
          : r.sourceType === 'official' ? OFFICIAL_SOURCES.deepseekPricing.url : REGISTRY,
      notes = String(r.pricingNotes || "").slice(0, 2000),
      unsupported =
        /阶梯|分时|batch|priority|regional|audio|image|tts|超过|above|tiered|threshold/i.test(
          notes,
        ) ||
        (Array.isArray(r.pricingRules)
          ? r.pricingRules.length > 0
          : r.pricingRules && typeof r.pricingRules === "object"
            ? Object.keys(r.pricingRules).length > 0
            : !!r.pricingRules) ||
        /\b(?:audio|tts|image|sora|video)\b/i.test(r.id);
    models.push({
      model: r.id,
      provider: String(r.provider || ""),
      currency: r.currency ?? null,
      quote,
      source,
      sourceType: r.sourceType ?? null,
      integrityIssue: null,
      dimensions: Array.isArray(r.dimensions)?r.dimensions:[],
      detailId:r.detailId??null,
      currentSource:r.currentSource??null,
      snapshotAt:r.snapshotAt??null,
      referenceBands:Array.isArray(r.referenceBands)?r.referenceBands:null,
      notes,
      // Peak/off-peak is described by structured fields and handled by evaluate();
      // a note that merely mentions 高峰 must not disqualify an official row.
      peakTimezone: r.peakTimezone ?? null,
      peakWindows: Array.isArray(r.peakWindows) ? r.peakWindows : null,
      offPeakFraction: r.offPeakFraction ?? null,
      peakQuote: r.peakInputPricePer1M == null && r.peakOutputPricePer1M == null ? null : {
        input: rate(r.peakInputPricePer1M,'peak'),output: rate(r.peakOutputPricePer1M,'peak'),
        cached: rate(r.peakCacheReadPricePer1M,'peak'),write: rate(r.peakCacheWritePricePer1M,'peak'),
      },
      offPeakQuote: r.offPeakInputPricePer1M == null && r.offPeakOutputPricePer1M == null ? null : {
        input: rate(r.offPeakInputPricePer1M,'off-peak'),output: rate(r.offPeakOutputPricePer1M,'off-peak'),
        cached: rate(r.offPeakCacheReadPricePer1M,'off-peak'),write: rate(r.offPeakCacheWritePricePer1M,'off-peak'),
      },
      estimated: r.estimated === true,
      estimatedFrom: r.estimatedFrom ?? null,
      gapDays: Number.isInteger(r.gapDays) ? r.gapDays : 0,
      tableEffective: r.tableEffective ?? null,
      fetchedAt: r.fetchedAt ?? null,
      fetchedSha256: r.fetchedSha256 ?? null,
      basis: r.basis ?? null,
      aliasRouting: r.aliasRouting ?? null,
      aliasNote: r.aliasNote ?? null,
      aliasUrl: r.aliasUrl ?? null,
      unsupported: unsupported||r.registryComplex===true,
    });
  }
  return { day, models, coverage:data.coverage??null, scope:data.scope??null };
}
function rate(value: unknown, label: string): string | null {
  if (value == null) return null;
  const number = new Decimal(String(value));
  if (!number.isFinite() || number.lt(0) || number.gt(100000)) throw new Error(label + '价格超出范围');
  return number.toString();
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
  private historyCache=new BudgetMap<JsonObject|null>(2*1024*1024,2048);
  /** Only official rows are indexed: a mirror row can never be reached by a lookup. */
  private lookupDay(day:string){
    const cached=this.dayCache.get(day);if(cached)return cached.models;
    const row=this.monitor.profile.db.prepare("SELECT * FROM radar_days WHERE day=?").get(day) as JsonObject|undefined;
    if(!row){const models=new Map<string,JsonObject>();this.dayCache.set(day,{digest:"",bytes:128,models});this.dayBytes+=128;this.trimDays();return models;}
    const old=this.dayCache.get(day);if(old && old.digest===row.digest){this.dayCache.delete(day);this.dayCache.set(day,old);return old.models;}
    // Keep only the native-provider reference fields in the hot index. Detailed
    // dimensions remain in lossless evidence and are loaded by the catalogue.
    const body=this.body(row.body),models=new Map<string,JsonObject>();
    for(const price of validatePrices(body,day).models.filter(p=>p.sourceType==='official')){
      const {dimensions,...compact}=price,value={...compact,day,digest:row.digest,observed:row.observed,snapshotSource:row.source};
      models.set(price.model.toLowerCase(),value);
      const native=price.model.replace(new RegExp('^'+price.provider+'/','i'),'').toLowerCase();
      if(!models.has(native))models.set(native,value);
    }
    if(old)this.dayBytes-=old.bytes;const bytes=Buffer.byteLength(encode([...models]))*2+128;this.dayCache.set(day,{digest:row.digest,bytes,models});this.dayBytes+=bytes;
    this.trimDays();
    return models;
  }
  private trimDays(){while((this.dayBytes>6*1024*1024||this.dayCache.size>512)&&this.dayCache.size){const key=this.dayCache.keys().next().value!;this.dayBytes-=this.dayCache.get(key)!.bytes;this.dayCache.delete(key);}}
  private lookupFx(at:string){const day=shanghaiDay(at);if(this.fxCache.has(day))return this.fxCache.get(day);const result=this.monitor.profile.db.prepare("SELECT * FROM value_fx WHERE day>=? AND day<=? ORDER BY day DESC LIMIT 1").get(addDays(day,-7),day) as JsonObject|undefined;this.fxCache.set(day,result);return result;}
  resources(){return {cacheBytes:this.dayBytes+this.proofBytes+this.fxCache.allocatedBytes+this.formulaCache.allocatedBytes+this.rawCache.allocatedBytes+this.historyCache.allocatedBytes,budgetBytes:16*1024*1024};}
  constructor(readonly monitor: Monitor) {
    monitor.profile.db.exec(
      `CREATE TABLE IF NOT EXISTS registry_file_cache(blob TEXT PRIMARY KEY,body TEXT,source TEXT);CREATE TABLE IF NOT EXISTS radar_days(day TEXT PRIMARY KEY,body TEXT,digest TEXT,source TEXT,observed TEXT);CREATE TABLE IF NOT EXISTS radar_meta(id INTEGER PRIMARY KEY,version INTEGER);INSERT OR IGNORE INTO radar_meta VALUES(1,0);CREATE TABLE IF NOT EXISTS radar_fetches(url TEXT PRIMARY KEY,etag TEXT,attempt REAL,success REAL,failures INTEGER,error TEXT);CREATE TABLE IF NOT EXISTS value_fx(day TEXT PRIMARY KEY,usd_cad TEXT,cny_cad TEXT,source TEXT,observed TEXT,digest TEXT);CREATE TABLE IF NOT EXISTS radar_values(owner TEXT,id TEXT,currency TEXT,fingerprint TEXT,result TEXT,PRIMARY KEY(owner,id,currency));CREATE TABLE IF NOT EXISTS radar_observations(url TEXT,digest TEXT,body TEXT,observed TEXT,PRIMARY KEY(url,digest));CREATE TABLE IF NOT EXISTS evidence_blobs(digest TEXT PRIMARY KEY,codec TEXT NOT NULL,raw_size INTEGER NOT NULL,body BLOB NOT NULL);`,
    );
    const db=monitor.profile.db;db.exec("CREATE TABLE IF NOT EXISTS valuation_dirty(owner TEXT,id TEXT,PRIMARY KEY(owner,id));CREATE TABLE IF NOT EXISTS valuation_rule(owner TEXT PRIMARY KEY,rule TEXT);");
    // 计价队列覆盖所有本地采集来源：codex 依赖账号证据，dsh/zcode 依赖 agent_evidence。
    // 缺证据的行不会静默被跳过，而是由 evaluate() 记下 valueReason。
    for(const op of ['INSERT','UPDATE']){db.exec('DROP TRIGGER IF EXISTS value_event_'+op.toLowerCase());db.exec(`CREATE TRIGGER IF NOT EXISTS value_event_${op.toLowerCase()} AFTER ${op} ON events WHEN NEW.source IN ('codex','zcode','dsh') BEGIN INSERT OR IGNORE INTO valuation_dirty VALUES(NEW.owner,NEW.id); END;`);}
    for(const op of ['INSERT','UPDATE','DELETE'])db.exec('DROP TRIGGER IF EXISTS value_agent_evidence_'+op.toLowerCase());
    for(const table of ['codex_evidence','agent_evidence'])for(const op of ['INSERT','UPDATE','DELETE']){const row=op==='DELETE'?'OLD':'NEW';db.exec(`CREATE TRIGGER IF NOT EXISTS value_${table}_${op.toLowerCase()} AFTER ${op} ON ${table} BEGIN INSERT OR IGNORE INTO valuation_dirty VALUES(${row}.owner,${row}.id); END;`);}
    for(const table of ['radar_days','value_fx'])for(const op of ['INSERT','UPDATE']){
      const condition=table==='radar_days'?"e.at>=NEW.day||'T00:00:00' AND e.at<date(NEW.day,'+2 days')||'T00:00:00'":"e.at>=date(NEW.day,'-1 day')||'T16:00:00' AND e.at<date(NEW.day,'+7 days')||'T16:00:00'";
      const name=`value_${table}_${op.toLowerCase()}`,sql=`CREATE TRIGGER ${name} AFTER ${op} ON ${table} BEGIN INSERT OR IGNORE INTO valuation_dirty SELECT e.owner,e.id FROM usage_versions u CROSS JOIN events e ON e.owner=u.owner WHERE e.source IN ('codex','zcode','dsh') AND ${condition}; END`;
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
      db.prepare("INSERT OR IGNORE INTO valuation_dirty SELECT owner,id FROM events WHERE owner=? AND source IN ('codex','zcode','dsh')").run(monitor.profile.owner);
      db.prepare('INSERT OR REPLACE INTO valuation_rule VALUES(?,?)').run(monitor.profile.owner,VALUATION_POLICY);
    });
  }
  private quarantineCachedPrices(day?: string) {
    const p=this.monitor.profile, db=p.db;
    this.refreshLookups();
    const groups=db.prepare("SELECT DISTINCT substr(e.at,1,10) day,e.model FROM events e WHERE e.owner=? AND e.source='codex' AND EXISTS(SELECT 1 FROM radar_values v WHERE v.owner=e.owner AND v.id=e.id)"+(day?' AND e.at>=? AND e.at<?':'')+' ORDER BY day,e.model').all(...(day?[p.owner,day+'T00:00:00',addDays(day,1)+'T00:00:00']:[p.owner]));
    // Rows whose stored amount must be re-derived by rows(), even when the official
    // row looks fine: a policy upgrade may have changed the rule, not the price.
    // char(0) 而不是 "\0"：后者在 JS 里是真正的 NUL 字节，会把 SQL 字面量截断。
    const dirty=new Set<string>((db.prepare("SELECT owner||char(0)||id AS k FROM valuation_dirty").all() as JsonObject[]).map(row=>String(row.k)));
    const affected:JsonObject[]=[];
    for(const group of groups) {
      const model=String(group.model).replace(STRIP_PREFIX,''), price=this.lookupDay(group.day).get(model.toLowerCase()),
        // A policy upgrade can leave a usable official row behind a stale amount:
        // the stored number belongs to the old rule, so it is re-derived anyway.
        stale=db.prepare("SELECT 1 FROM valuation_dirty WHERE owner=? AND id IN (SELECT id FROM events WHERE owner=? AND source='codex' AND model=?) LIMIT 1").get(p.owner,p.owner,group.model);
      if(!stale && (!price || price.sourceType==='official'&&!price.unsupported&&['USD','CNY'].includes(price.currency)&&price.tableEffective)) continue;
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
        // Re-derive this batch right after it is loaded: the official day cache is
        // replaced per snapshot day, so a deferred row could read a stale lookup.
        for(const row of batch) if(dirty.has(String(row.owner)+'\0'+String(row.id))) affected.push(row);
        const segment=affected.splice(0);
        if(!compact) { if(segment.length)for(const currency of ['USD','CNY']) this.rows(segment,currency); continue; }
        if(!segment.length) continue;
        this.preparedUpdates=new Map();
        try {
          for(const currency of ['USD','CNY']) this.rows(segment,currency);
          const updates=[...this.preparedUpdates.values()];
          writeCompactValuationBatch(db,p.owner,updates);
          const dirty=db.prepare('INSERT OR IGNORE INTO usage_dirty VALUES(?,?,?)');
          for(const row of updates) dirty.run(p.owner,row.source,row.day);
        } finally { this.preparedUpdates=null; }
      }
    }
  }
  /**
   * Write the official snapshot for the given local days when missing and unchanged.
   * Returns the set of days whose stored body actually changed.
   */
  private ensureOfficialDays(days:string[],version=this.version()){
    const p=this.monitor.profile,db=p.db,touched=new Set<string>();
    for(const day of days){
      const snapshot=officialSnapshot(day),prior=db.prepare('SELECT digest FROM radar_days WHERE day=?').get(day) as JsonObject|undefined;
      if(prior?.digest===hash(snapshot.body))continue;
      db.prepare('INSERT OR REPLACE INTO radar_days VALUES(?,?,?,?,?)').run(day,this.store(snapshot.body),hash(snapshot.body),snapshot.source,iso());
      db.prepare('UPDATE radar_meta SET version=version+1 WHERE id=1').run();
      touched.add(day);
    }
    if(touched.size&&version!==this.version())this.lookupVersion=-1;
    return touched;
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
    {
      const prices = new Map<string, JsonObject>(),
        db = this.monitor.profile.db;
      for (const row of db
        .prepare("SELECT * FROM radar_days")
        .all() as JsonObject[]) {
        const parsed = validatePrices(this.body(row.body), row.day);
        for (const p of parsed.models.filter((m) => m.sourceType === 'official'))
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
  /**
   * Catalogue view for the evidence dialog.
   *
   * Only official rows are returned. `compact` drops the per-interval raw
   * `dimensions` block and keeps what the dialog renders; `limit` caps the
   * returned interval count after a stable sort, and the response reports the
   * true total so the UI can say "showing N of M" instead of truncating silently.
   * Two intervals of the same model merge only when the whole quote, including its
   * peak/off-peak block, is unchanged.
   */
  state(
    options: { compact?: boolean; limit?: number; model?: string; provider?: string } = {},
  ) {
    const index = this.index(),
      compact = options.compact === true,
      model = options.model?.trim(),
      provider = options.provider?.trim(),
      intervals: JsonObject[] = [],
      same = (a: JsonObject, b: JsonObject) =>
        ["quote", "currency", "sourceType", "unsupported", "peakQuote", "offPeakQuote", "estimated", "estimatedFrom"].every(
          (k) => canonical(a[k]) === canonical(b[k]),
        );
    for (const price of [...index.prices.values()].sort(
      (a, b) => a.model.localeCompare(b.model) || a.day.localeCompare(b.day),
    )) {
      if (model && price.model !== model) continue;
      if (provider && String(price.provider || "") !== provider) continue;
      const item: JsonObject = {
          ...price,
          id: price.model + ":" + price.day,
          start: price.day + "T00:00:00+00:00",
          end: addDays(price.day, 1) + "T00:00:00+00:00",
        },
        previous = intervals.at(-1);
      if (previous && previous.model === item.model && previous.end === item.start && same(previous, item))
        previous.end = item.end;
      else intervals.push(item);
    }
    const totalIntervals = intervals.length;
    let rows = intervals;
    if (compact) {
      const byModel = new Map<string, JsonObject[]>();
      for (const item of intervals) {
        const list = byModel.get(String(item.model)) || [],
          last = list.at(-1);
        if (last && same(last, item)) {
          last.end = item.end;
          last.digest = item.digest;
          (last as any).observed = item.observed;
          continue;
        }
        const { dimensions, ...rest } = item;
        list.push({ ...rest, dimensionCount: Array.isArray(dimensions) ? dimensions.length : 0 });
        byModel.set(String(item.model), list);
      }
      rows = [...byModel.values()].flat();
    }
    const limit = Number(options.limit);
    if (Number.isFinite(limit) && limit > 0 && rows.length > limit)
      rows = rows.slice(0, Math.trunc(limit));
    return {
      experimental: true,
      mode: SCENARIO,
      source: OFFICIAL_SOURCES.deepseekPricing.url,
      policy: OFFICIAL_POLICY,
      officialOnly: true,
      sources: Object.values(OFFICIAL_SOURCES).map((source) => ({vendor: source.vendor, url: source.url, kind: source.kind, fetchedAt: source.fetchedAt, sha256: source.sha256})),
      links: officialLinks(),
      timezone: 'Asia/Shanghai',
      agentCalculationEnabled:
        process.env.WORKBENCH_AGENT_VALUE_ENABLED === "1",
      prices: rows,
      totalIntervals,
      truncated: rows.length < totalIntervals,
      compact,
      fxDays: index.fx.size,
      historicalAPI: false,
      refreshing: this.refreshing,
      task: { ...this.task },
      version: index.version,
      assumptions: "参考等价值=DeepSeek 官方峰谷价表（北京时间峰段 9:00-12:00、14:00-18:00 的工作日；其余时间为谷时）与官方币种；不是实际账单，也不替代供应商流水。",
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
  /**
   * Build the official snapshots for the days this profile actually used, then
   * read the official pages and the hidden mirrors.
   *
   * The official table is local and deterministic, so a cache hit needs no
   * network. The mirrors are optional: their failure never fails a sync, because
   * no amount depends on them.
   */
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
    if(!rows.length){used.add(start);used.add(end);}
    const observed=iso(),network=options.loader||loadPrice;
    const check=()=>{options.check?.();if(owner!==p.owner)throw Error('Profile 已切换');};
    const evidence=(url:string,body:string)=>{check();p.transaction(()=>db.prepare('INSERT OR IGNORE INTO radar_observations VALUES(?,?,?,?)').run(url,hash(body),this.store(body),observed));};
    const errors:JsonObject[]=[],gaps:JsonObject[]=[];
    options.progress?.({phase:'prices',completed:0,total:2});
    // 1. Official table: transcribed rates, cited page, unreadable pages recorded
    //    as links. A change on the cited page is a review task, not a new price.
    const official=await collectOfficial({loader:options.loader?async(url:string)=>network(url):undefined,evidence,check});
    errors.push(...official.errors);gaps.push(...official.gaps);
    // The official table is a single current transcription: every day the batch
    // needs (including the previous day kept for the previous-rate comparison)
    // and today get a snapshot, so a cached row is re-derived against its own day.
    const snapshotDays=new Set<string>(used);snapshotDays.add(today);
    const officialQuarantine:string[]=[];
    for(const day of [...snapshotDays].sort()){
      check();
      const snapshot=officialSnapshot(day),prior=db.prepare('SELECT * FROM radar_days WHERE day=?').get(day) as JsonObject|undefined;
      if(prior?.digest===hash(snapshot.body))continue;
      db.prepare('INSERT OR REPLACE INTO radar_days VALUES(?,?,?,?,?)').run(day,this.store(snapshot.body),hash(snapshot.body),snapshot.source,observed);
      db.prepare('UPDATE radar_meta SET version=version+1 WHERE id=1').run();
      officialQuarantine.push(day);
    }
    options.progress?.({phase:'prices',completed:1,total:2});
    this.refreshLookups();
    // 2. Hidden mirrors. Compared and stored for evidence only.
    const compared:JsonObject[]=[];
    if(options.loader){
      try{
        const mirror=await collectMirror({days:[...used].filter(day=>day<today).sort().slice(-30),loader:network,evidence,check});
        gaps.push(...mirror.gaps);errors.push(...mirror.errors);
        for(const item of mirror.snapshots){
          check();
          const day=item.day,parsed=validatePrices(item.body,day);
          for(const rate of parsed.models){
            const officialRate=officialRateByModel(rate.model);if(!officialRate)continue;
            const result=compareMirror({id:officialRate.id,model:officialRate.modelName,currency:officialRate.currency,quote:officialRateQuote(officialRate,day)},[rate],'mirror_registry');
            compared.push({day,model:officialRate.model,basis:'mirror_registry',...result});
          }
        }
        const catalogue=await collectCurrentCatalogue({loader:network,evidence,check});
        gaps.push(...catalogue.snapshot?[]:[]);
        if(catalogue.snapshot){
          const parsed=validatePrices(catalogue.snapshot.body,today);
          for(const item of parsed.models){
            const officialRate=officialRateByModel(item.model);if(!officialRate)continue;
            const result=compareMirror({id:officialRate.id,model:officialRate.modelName,currency:officialRate.currency,quote:officialRateQuote(officialRate,today)},[item],'mirror_catalog');
            compared.push({day:today,model:officialRate.model,basis:'mirror_catalog',...result});
          }
        }
      }catch(error:any){
        gaps.push({source:CURRENT_PRICES,error:'mirror_unavailable',message:String(error?.message||'社区对照目录读取失败，不影响官方定价')});
      }
    }
    // Never store a mirror row where a lookup could find it: the comparison runs on
    // the parsed rows and only its verdict is kept.
    this.mirrorComparisons=compared;
    options.progress?.({phase:'prices',completed:2,total:2});
    // 3. Gaps the user should know about: an official table that could not be read,
    //    a page awaiting review, or a day outside the published table.
    const missing=new Set<string>();
    for(const row of rows){
      const day=new Date(row.at).toISOString().slice(0,10),model=String(row.model||'').replace(STRIP_PREFIX,''),key=day+':'+model;
      if(day<start||day>end||missing.has(key))continue;missing.add(key);
      const price=this.lookupDay(day).get(model.toLowerCase()),
        error=!price?'missing_historical_price':price.unsupported?'unsupported_pricing_rules':!price.tableEffective?'official_table_not_published':null;
      if(error)gaps.push({day,model,error});
    }
    check();
    let fxDays = 0;
    try {
      options.check?.();
      const latestFx=db.prepare("SELECT max(day) AS day FROM value_fx WHERE day>=? AND day<=?").get(addDays(start,-10),end) as JsonObject;
      const fxStart=options.force?addDays(start,-10):latestFx.day?addDays(latestFx.day,1):addDays(start,-10);
      if(fxStart>end){options.progress?.({phase:"fx",completed:1,total:1});return {pricesChecked:snapshotDays.size,pricesAdded:snapshotDays.size,errors,gaps,fxDays,observed,mirror:this.mirrorSummary(compared)};}
      options.progress?.({ phase: "fx", completed: 0, total: 1 });
      const { body } = await network(
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
        fxRows.push({day,usd_cad:usd.toString(),cny_cad:cny.toString(),source:FX_URL,observed,digest:hash(body)});
      }
      options.check?.();
      p.transaction(() => {
        for (const row of fxRows) {
          const old = db.prepare("SELECT usd_cad,cny_cad FROM value_fx WHERE day=?").get(row.day) as JsonObject | undefined;
          if (!old || old.usd_cad !== row.usd_cad || old.cny_cad !== row.cny_cad) fxDays++;
          else continue;
          db.prepare("INSERT OR REPLACE INTO value_fx VALUES(?,?,?,?,?,?)").run(row.day,row.usd_cad,row.cny_cad,row.source,row.observed,row.digest);
        }
        if (fxDays) db.prepare("UPDATE radar_meta SET version=version+1 WHERE id=1").run();
      });
      options.progress?.({ phase: "fx", completed: 1, total: 1 });
    } catch {
      options.check?.();
      errors.push({ source: FX_URL, error: "历史汇率读取失败，保留已有数据" });
    }
    // Cached amounts are re-derived only after both the official table and the
    // historical FX rows are in place: a cross-currency row priced before the
    // exchange rate landed would be quarantined by its own missing rate.
    for(const day of officialQuarantine) {
      check();
      this.quarantineCachedPrices(day);
    }
    options.check?.();
    return {
      pricesChecked: snapshotDays.size,
      pricesAdded: snapshotDays.size,
      fxDays,
      errors,
      gaps,
      observed,
      mirror: this.mirrorSummary(compared),
    };
  }
  private mirrorComparisons:JsonObject[]=[];
  private mirrorSummary(compared:JsonObject[]){
    const counts:JsonObject={};
    for(const item of compared)counts[String(item.status)]=(counts[String(item.status)]||0)+1;
    return {total:compared.length,counts,note:'社区目录仅作隐藏对照，不参与计价与展示'};
  }
  /**
   * Value one consumption record.
   *
   * The official table is per calendar day in Asia/Shanghai; the rate that
   * applies depends on the absolute instant, so the peak decision uses
   * `events.at`. A day that can only be estimated is priced and labelled, never
   * silently: `estimated` and `estimatedFrom` travel with the proof.
   */
  /** Days already checked against the current table version by this evaluator. */
  private officialDaysVerified = new Map<string, number>();
  evaluate(row: JsonObject, raw: JsonObject | undefined, currency: string, version=this.version()) {
    this.refreshLookups(version);
    // Pure valuation must not depend on a previous collect(): the official table is
    // local and deterministic, so the day's snapshot is verified, not merely
    // created. A table expansion changes the snapshot digest, so a stale day is
    // replaced here instead of hiding the new rows behind an older lookup.
    const day = shanghaiDay(row.at);
    if (this.officialDaysVerified.get(day) !== version) {
      this.ensureOfficialDays([day], version);
      this.officialDaysVerified.set(day, version);
    }
    const model = String(row.model).replace(STRIP_PREFIX, ""),
      basePrice = this.lookupDay(day).get(model.toLowerCase()),
      fail = (reason: string, proof: JsonObject = {}) => ({
        cost: null,
        currency,
        valueReason: reason,
        valueProof: proof,
        valueParts: {},
        valueVersion: version,
      });
    if ((row.total != null && String(row.total) === "0") ||
        (!basePrice && row.source === "codex" && model.toLowerCase() === "codex-auto-review")) {
      return {cost:"0",currency,valueReason:"priced",
        valueProof:{model,priceDate:day,policy:row.total != null && String(row.total) === "0" ? "zero_usage" : "auto_review_zero_reference"},
        valueParts:{},valueVersion:version};
    }
    if (!basePrice) return fail("missing_historical_price", { model, priceDate: day, official: true });
    const price:JsonObject={...basePrice};
    if (price.unsupported) return fail("unsupported_pricing_rules", { model, priceDate: day, source: price.source, sourceUrl: price.source });
    if (!price.tableEffective || !price.peakQuote || !price.offPeakQuote)
      return fail('official_table_not_published', { model, priceDate: day, source: price.source, tableEffective: price.tableEffective ?? null });
    const peak = price.peakTimezone && Array.isArray(price.peakWindows)
      ? shanghaiPeak(row.at, { timezone: 'Asia/Shanghai', windows: price.peakWindows, holidays: 'off-peak', offPeakFraction: String(price.offPeakFraction || '0.5') })
      : null;
    if (!peak) return fail('official_peak_rule_missing', { model, priceDate: day, source: price.source });
    price.quote = peak.peak ? { ...price.peakQuote } : { ...price.offPeakQuote };
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
    // Sources that omit the prompt total still report total and output, and their
    // total is prompt + output (verified for codex/zcode/dsh), so the prompt total is
    // recoverable exactly. Ambiguity keeps the row unpriced instead of guessing.
    if (incoming == null && total != null && outgoing != null) {
      const recovered = BigInt(total) - BigInt(outgoing);
      if (
        recovered >= 0n &&
        (cached == null || recovered >= BigInt(cached)) &&
        (written == null || recovered >= BigInt(written))
      )
        incoming = recovered;
    }
    if (
      [row.input, row.output, row.cached, row.total].some(
        (expected, i) =>
          [incoming, outgoing, cached, total][i] == null ||
          BigInt(expected) !== BigInt([incoming, outgoing, cached, total][i]),
      )
    )
      return fail("conflicting_usage_evidence");
    if (raw.model && String(raw.model).replace(STRIP_PREFIX, "") !== model)
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
        sourceUrl: price.source,
        snapshotSource: price.snapshotSource,
        priceDate: price.day,
        priceCurrency: price.currency,
        digest: price.digest,
        policy: OFFICIAL_POLICY,
        scenario: SCENARIO,
        basis: price.basis,
        // The row's own identity and the row whose table supplies the numbers, so
        // an aliased id (deepseek-v4.1-flash-1017) never claims a table for itself.
        rateId: price.id || null,
        aliasRouting: price.aliasRouting,
        tableEffective: price.tableEffective,
        estimated: price.estimated === true,
        estimatedFrom: price.estimatedFrom ?? null,
        gapDays: price.gapDays ?? 0,
        peak: peak.peak,
        peakWindow: peak.window,
        timezone: peak.timezone,
        localTime: peak.local,
        weekday: peak.weekday,
        holidayCalendar: peak.holidayCalendar,
        quote: price.quote,
        offPeakFraction: price.offPeakFraction,
        fetchedAt: price.fetchedAt,
        fetchedSha256: price.fetchedSha256,
        assumptions:['北京时间工作日 9:00-12:00、14:00-18:00 为高峰，其余时间为空闲；法定节假日按官方说明属空闲时段，但本机未内置节假日日历，工作日节假日按高峰价估算',...(price.estimated?['该日期早于现行官方价格表的生效日，按最近官方价估计，不是当日实际报价']:[]),'官方页面未公布的模型价格保持未知，不以第三方价格代替',...(reportedWrite==null?['日志未报告缓存写入；按未写入估算，非已核验实际扣费']:[])],
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
      const day=shanghaiDay(row.at),model=String(row.model).replace(STRIP_PREFIX,''),price=this.lookupDay(day).get(model.toLowerCase()),previous=this.lookupDay(addDays(day,-1)).get(model.toLowerCase()),fx=price?.currency===currency?null:this.lookupFx(row.at);
      const rawText=price?.unsupported?undefined:keys?db.prepare('SELECT lingxi_read_payload(p.delta,p.pack,p.ordinal,'+(row.source==='codex'?4:0)+') raw FROM compact_'+(row.source==='codex'?'codex_evidence':'agent_evidence')+' e JOIN usage_payloads p ON p.k=e.payload WHERE e.owner=? AND e.id=? AND e.verified=1').get(keys.owner,keys.id)?.raw:((row.source==='codex'?codex:agent).get(p.owner,row.id) as JsonObject|undefined)?.raw;
      let raw=rawText?this.rawCache.get(rawText):undefined;if(rawText&&!raw){raw=parseExact(rawText);if(rawText.length<8000)this.rawCache.set(rawText,raw!);}
      const signature=canonical([VALUATION_POLICY,row.source,model,row.at,shanghaiDay(row.at),row.input,row.output,row.cached,row.total,raw?[raw.model,raw.last_token_usage&&Object.keys(raw.last_token_usage).length?raw.last_token_usage:raw.usage]:null,price?.digest||null,previous?.digest||null,fx?[fx.day,fx.usd_cad,fx.cny_cad]:null,currency]);
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
  /** 待计价队列里是否还有该来源的行（供后台批量消化判断，不写库）。 */
  hasPending(scope: string) {
    const p = this.monitor.profile, db = p.db;
    const compact = db.usageStorage;
    const ownerKey = compact ? (db.prepare('SELECT k FROM usage_strings WHERE value=?').get(p.owner)?.k ?? null) : null;
    if (compact && ownerKey == null) return false;
    const stmt = compact
      ? db.prepare('SELECT 1 FROM compact_valuation_dirty d CROSS JOIN compact_events e WHERE d.owner=? AND d.id=e.id AND e.owner=d.owner AND e.source=(SELECT k FROM usage_strings WHERE value=?) LIMIT 1')
      : db.prepare('SELECT 1 FROM valuation_dirty d CROSS JOIN events e WHERE d.owner=? AND d.id=e.id AND e.owner=d.owner AND e.source=? LIMIT 1');
    return !!stmt.get(...(compact ? [ownerKey, scope] : [p.owner, scope]));
  }
  /**
   * 把还没有等价值的事件补进计价队列。
   * 紧凑存储迁移时会丢弃 value_* 触发器（触发器无法挂在视图上），所以本地来源
   * （dsh/zcode）没有自动入队的途径，必须显式回填；这里按事件倒序限量，避免一次性扫全库。
   */
  backfillQueue(scope: string, limit = 4000) {
    const p = this.monitor.profile, db = p.db;
    const compact = !!db.usageStorage;
    const ownerKey = compact ? (db.prepare('SELECT k FROM usage_strings WHERE value=?').get(p.owner)?.k ?? null) : null;
    if (compact && ownerKey == null) return 0;
    const source = String(scope);
    const sql = compact
      ? 'INSERT OR IGNORE INTO compact_valuation_dirty(owner,id) SELECT e.owner,e.id FROM compact_events e WHERE e.owner=? AND e.source=(SELECT k FROM usage_strings WHERE value=?) AND NOT EXISTS(SELECT 1 FROM compact_valuations v WHERE v.owner=e.owner AND v.id=e.id) ORDER BY e.at DESC LIMIT ?'
      : 'INSERT OR IGNORE INTO valuation_dirty(owner,id) SELECT e.owner,e.id FROM events e WHERE e.owner=? AND e.source=? AND NOT EXISTS(SELECT 1 FROM radar_values v WHERE v.owner=e.owner AND v.id=e.id) ORDER BY e.at DESC LIMIT ?';
    const before = compact
      ? Number((db.prepare('SELECT count(*) AS n FROM compact_valuation_dirty WHERE owner=?').get(ownerKey) as JsonObject).n)
      : Number((db.prepare('SELECT count(*) AS n FROM valuation_dirty WHERE owner=?').get(p.owner) as JsonObject).n);
    db.prepare(sql).run(...(compact ? [ownerKey, source, limit] : [p.owner, source, limit]));
    const after = compact
      ? Number((db.prepare('SELECT count(*) AS n FROM compact_valuation_dirty WHERE owner=?').get(ownerKey) as JsonObject).n)
      : Number((db.prepare('SELECT count(*) AS n FROM valuation_dirty WHERE owner=?').get(p.owner) as JsonObject).n);
    return after - before;
  }
  /** 后台消化本地来源的待计价队列；返回处理是否仍有剩余。 */
  async settleLocal(scope: string, check: () => void = () => {}) {
    const queued = this.backfillQueue(scope);
    if (!queued && !this.hasPending(scope)) return false;
    await this.prepareRows(scope, check);
    return this.hasPending(scope);
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
      const groups=days.every(group=>{const day=shanghaiDay(group[0].at);return this.dayCache.has(day)&&this.dayCache.has(addDays(day,-1));})?[batch]:days;
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
  /**
   * Detail view for one official row.
   *
   * There is no aggregation API for the official tables we can read, so this returns
   * exactly what the cited page states — both peak windows, the off-peak fraction
   * and the effective dates — instead of proxying a third-party detail endpoint.
   */
  async details(params:JsonObject){
    const date=String(params.date||''),model=String(params.model||'');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('价格日期不正确');
    const price=this.catalog({date,model,limit:1}).items[0];
    if(!price)throw Error('该模型没有官方价格记录');
    const official=officialRateByModel(price.model);
    if(!official)throw Error('该模型只有官方定价页，没有可核验的价格表');
    return {
      date,model:official.model,currency:official.currency,sourceType:'official',source:official.sourceUrl,
      basis:official.basis,alias:official.alias,
      peak:{timezone:official.peak.timezone,windows:official.peak.windows,holidays:official.peak.holidays,offPeakFraction:official.peak.offPeakFraction,quote:official.quote.peak},
      offPeak:{quote:official.quote.offPeak},
      effective:official.history,
      fetchedAt:OFFICIAL_SOURCES.deepseekPricing.fetchedAt,fetchedSha256:OFFICIAL_SOURCES.deepseekPricing.sha256,
      rows:[
        {tier:'peak',...official.quote.peak},{tier:'offPeak',...official.quote.offPeak},
      ],
      notice:'金额按输入（未命中缓存）、缓存命中、缓存写入、输出分别计算；官方页面未公布缓存写入单价时按普通输入计。',
      corroboration:this.mirrorComparisons.filter((item:JsonObject)=>item.model===official.model).slice(0,4),
    };
  }
  catalog(params: JsonObject) {
    const db = this.monitor.profile.db,
      dates = (db.prepare("SELECT day FROM radar_days ORDER BY day DESC").all() as JsonObject[]).map((r) => r.day),
      date = params.date || dates[0] || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("价格日期不正确");
    const snapshot = db.prepare("SELECT * FROM radar_days WHERE day=?").get(date) as JsonObject | undefined,
      parsed = snapshot?validatePrices(this.body(snapshot.body),date):null,
      models = parsed?parsed.models.filter((m) => m.sourceType === 'official').map(
            (m): JsonObject => ({...m,date,snapshotSource:snapshot!.source,digest:snapshot!.digest}),
          ):[],
      q = String(params.q || "").toLowerCase(),
      rows = models.filter(
        (m) =>
          (!params.provider || m.provider === params.provider) &&
          (!params.model || m.model === params.model) &&
          (!q || (m.model + " " + m.provider).toLowerCase().includes(q)),
      ),
      offset = Math.max(0, Math.trunc(Number(params.offset) || 0)),
      limit = Math.min(Math.max(1, Math.trunc(Number(params.limit) || 50)),100);
    const sort=['model','currency','input','cached','write','output','status'].includes(String(params.sort))?String(params.sort):'model',direction=params.direction==='desc'?-1:1;
    // "Complex rules" no longer exists: an official row either has a readable
    // table or it is not priced at all.
    const status=(m:JsonObject)=>m.unsupported?'复杂规则':m.estimated?'官方价估计':'官方价';
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
      providers: [...new Set(models.map((m) => m.provider))].sort(),
      models: [...new Set(models.filter((m) => !params.provider || m.provider === params.provider).map((m) => m.model))].sort(),
      trendModels:models.map(m=>({provider:m.provider,model:m.model,currency:m.currency})),
      missing: !snapshot,
      coverage:parsed?.coverage??null,
      source: OFFICIAL_SOURCES.deepseekPricing.url,
      sources: Object.values(OFFICIAL_SOURCES).filter((source) => source.kind === 'official_table').map((source) => source.url),
      officialPages: Object.values(OFFICIAL_SOURCES).filter((source) => source.kind === 'official_page').map((source) => source.url),
      links: officialLinks(),
      version: this.version(),
    };
  }
  async history(params:JsonObject) {
    const end=String(params.end||new Date().toISOString().slice(0,10)),start=String(params.start||addDays(end,-30));
    const validDay=(day:string)=>/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day))&&new Date(day).toISOString().slice(0,10)===day;
    if(!validDay(start)||!validDay(end)||start>end||end>new Date().toISOString().slice(0,10)||(Date.parse(end)-Date.parse(start))/86400000>1096)throw Error('价格趋势日期范围不正确，最多查询三年');
    const provider=String(params.provider||''),model=String(params.model||''),currency=String(params.currency||'');
    if(!provider||provider.length>180||!model||model.length>300||!['USD','CNY'].includes(currency))throw Error('请选择供应商、模型与原币种');
    const db=this.monitor.profile.db,version=this.version();
    const snapshots=new Map((db.prepare('SELECT day,digest,body,source FROM radar_days WHERE day>=? AND day<=? ORDER BY day').all(start,end) as JsonObject[]).map(row=>[row.day,row]));
    const series:JsonObject[]=[];let knownDays=0;
    for(let date=start;date<=end;date=addDays(date,1)){
      const snapshot=snapshots.get(date);let price:JsonObject|null=null;
      if(snapshot){
        const key=encode([snapshot.digest,provider,model]);
        if(this.historyCache.has(key))price=this.historyCache.get(key)!;
        else{
          // The series reports the peak quote: a day has no single rate any more,
          // and quoting the off-peak number would understate weekday usage.
          const row=validatePrices(this.body(snapshot.body),date).models.find(r=>r.provider===provider&&r.model===model);
          price=row?{quote:row.peakQuote||row.quote,currency:row.currency,sourceType:row.sourceType,unsupported:row.unsupported,source:row.source,snapshotAt:row.snapshotAt,estimated:row.estimated,estimatedFrom:row.estimatedFrom,tableEffective:row.tableEffective,offPeak:row.offPeakQuote}:null;
          this.historyCache.set(key,price);
        }
      }
      const issue=!snapshot?'missing_snapshot':!price?'missing_model':price.currency!==currency?'currency_changed':price.sourceType!=='official'?'unverified_source':!price.tableEffective?'official_table_not_published':!price.quote?'missing_peak_quote':null;
      const quote=issue?{input:null,cached:null,write:null,output:null}:price!.quote;
      if(Object.values(quote).some(value=>value!=null))knownDays++;
      series.push({date,quote,currency,issue,complex:price?.unsupported??false,source:price?.source??null,snapshotAt:price?.snapshotAt??null,
        peak:true,offPeakQuote:issue?null:price?.offPeak??null,estimated:price?.estimated??false,estimatedFrom:price?.estimatedFrom??null,tableEffective:price?.tableEffective??null});
      // Yield while scanning large historical catalogs; only compact model quotes are retained.
      if(series.length%8===0)await new Promise(resolve=>setImmediate(resolve));
    }
    if(version!==this.version())throw Error('价格缓存正在更新，请重新查看趋势');
    return {provider,model,currency,start,end,series,knownDays,totalDays:series.length,version,billingUnit:'per_1m_tokens',
      source:OFFICIAL_SOURCES.deepseekPricing.url,timezone:'Asia/Shanghai',
      note:'曲线为高峰时段官方价；谷时价见 offPeakQuote。官方表生效日前的日期按最近官方价估计并标注 estimated。'};
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
  /** Official table for a model name, or null when the vendor page is link-only. */
  officialDetail(model: string) {
    return officialRate(model);
  }
}
function officialRateByModel(model: string): OfficialRate | null {
  return officialRate(model);
}
/** The quote shown for a day: the table's peak column, labelled as such. */
function officialRateQuote(rate: OfficialRate, day: string) {
  const applicable = officialQuoteFor(rate, day);
  if (applicable.status === 'unknown') return {} as Record<string, string | null>;
  return { input: rate.quote.peak.input, output: rate.quote.peak.output, cached: rate.quote.peak.cached, write: rate.quote.peak.write };
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
      ...history,task:this.status('codex'),notice:'应用运行时按上海日期每天更新一次；关闭后下次启动补查。官方价格表随应用内置，页面变更会提示人工核对。'};
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
    // 计价开关按来源分别记录（codexValuationEnabled、dshValuationEnabled…）。
    // 非 codex 来源的逐条计价不依赖准备任务，但开关名仍需合法，避免写入任意配置键。
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(scope))
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
          throw new Error("官方价格页或汇率网络同步失败；缓存保留，请重试或取消");
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
