import { Decimal } from "decimal.js";
import { deflateSync, inflateSync } from "node:zlib";
import {writeCompactValuation,writeCompactValuationBatch,packPendingUsage,compactEventProjection} from './usage-storage.ts';
import { Monitor, canonical, iso } from "./monitor.ts";
import { hash, parseExact, encode, uid, type JsonObject } from "./profile.ts";
import { Control } from "./control.ts";
import { shanghaiDay, addDays } from "./usage-summary.ts";

const RADAR = "https://modelradar.cn/data/",
  FX_URL =
    "https://www.bankofcanada.ca/valet/observations/FXUSDCAD,FXCNYCAD/json",
  SCENARIO = "ModelRadar/native-currency/text";
type Loader = (
  url: string,
  etag?: string,
) => Promise<{ body: string | null; etag: string }>;
async function loadPrice(url: string, etag = "") {
  if (!["modelradar.cn", "www.bankofcanada.ca"].includes(new URL(url).hostname))
    throw new Error("价格来源不受支持");
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(12000),
    headers: {
      "User-Agent": "Lingxi-Usage",
      Accept: "application/json",
      ...(etag ? { "If-None-Match": etag } : {}),
    },
  });
  if (response.status === 304) return { body: null, etag };
  if (!response.ok)
    throw Object.assign(new Error("价格网络读取失败"), {
      status: response.status,
    });
  const parts: Uint8Array[] = [],
    reader = response.body!.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4 * 1024 * 1024) throw new Error("价格响应过大");
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }
  return {
    body: Buffer.concat(parts).toString("utf8"),
    etag: response.headers.get("etag") || "",
  };
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
  if (!Array.isArray(data.models) || data.models.length > 10000)
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
          : "https://modelradar.cn/api",
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
      notes,
      unsupported,
    });
  }
  return { day, models };
}
// Bound retained lookup data by encoded size as well as entry count. Empty
// misses consume a budget too; unknown historical dates cannot grow forever.
class BudgetMap<V> extends Map<string,V> {
  private sizes=new Map<string,number>();
  private bytes=0;
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
    const body=this.body(row.body),models=new Map<string,JsonObject>(validatePrices(body,day).models.map(price=>[price.model,{...price,day,digest:row.digest,observed:row.observed,snapshotSource:row.source}]));
    if(old)this.dayBytes-=old.bytes;const bytes=Buffer.byteLength(encode([...models]))*2+128;this.dayCache.set(day,{digest:row.digest,bytes,models});this.dayBytes+=bytes;
    this.trimDays();
    return models;
  }
  private trimDays(){while((this.dayBytes>6*1024*1024||this.dayCache.size>512)&&this.dayCache.size){const key=this.dayCache.keys().next().value!;this.dayBytes-=this.dayCache.get(key)!.bytes;this.dayCache.delete(key);}}
  private lookupFx(at:string){const day=shanghaiDay(at);if(this.fxCache.has(day))return this.fxCache.get(day);const result=this.monitor.profile.db.prepare("SELECT * FROM value_fx WHERE day>=? AND day<=? ORDER BY day DESC LIMIT 1").get(addDays(day,-7),day) as JsonObject|undefined;this.fxCache.set(day,result);return result;}
  constructor(readonly monitor: Monitor) {
    monitor.profile.db.exec(
      `CREATE TABLE IF NOT EXISTS radar_days(day TEXT PRIMARY KEY,body TEXT,digest TEXT,source TEXT,observed TEXT);CREATE TABLE IF NOT EXISTS radar_meta(id INTEGER PRIMARY KEY,version INTEGER);INSERT OR IGNORE INTO radar_meta VALUES(1,0);CREATE TABLE IF NOT EXISTS radar_fetches(url TEXT PRIMARY KEY,etag TEXT,attempt REAL,success REAL,failures INTEGER,error TEXT);CREATE TABLE IF NOT EXISTS value_fx(day TEXT PRIMARY KEY,usd_cad TEXT,cny_cad TEXT,source TEXT,observed TEXT,digest TEXT);CREATE TABLE IF NOT EXISTS radar_values(owner TEXT,id TEXT,currency TEXT,fingerprint TEXT,result TEXT,PRIMARY KEY(owner,id,currency));CREATE TABLE IF NOT EXISTS radar_observations(url TEXT,digest TEXT,body TEXT,observed TEXT,PRIMARY KEY(url,digest));CREATE TABLE IF NOT EXISTS evidence_blobs(digest TEXT PRIMARY KEY,codec TEXT NOT NULL,raw_size INTEGER NOT NULL,body BLOB NOT NULL);`,
    );
    const db=monitor.profile.db;db.exec("CREATE TABLE IF NOT EXISTS valuation_dirty(owner TEXT,id TEXT,PRIMARY KEY(owner,id));CREATE TABLE IF NOT EXISTS valuation_rule(owner TEXT PRIMARY KEY,rule TEXT);");
    for(const op of ['INSERT','UPDATE']){db.exec(`CREATE TRIGGER IF NOT EXISTS value_event_${op.toLowerCase()} AFTER ${op} ON events WHEN NEW.source IN ('codex','zcode','dsh') BEGIN INSERT OR IGNORE INTO valuation_dirty VALUES(NEW.owner,NEW.id); END;`);}
    for(const table of ['codex_evidence','agent_evidence'])for(const op of ['INSERT','UPDATE','DELETE']){const row=op==='DELETE'?'OLD':'NEW';db.exec(`CREATE TRIGGER IF NOT EXISTS value_${table}_${op.toLowerCase()} AFTER ${op} ON ${table} BEGIN INSERT OR IGNORE INTO valuation_dirty VALUES(${row}.owner,${row}.id); END;`);}
    for(const table of ['radar_days','value_fx'])for(const op of ['INSERT','UPDATE']){
      const condition=table==='radar_days'?"e.at>=NEW.day||'T00:00:00' AND e.at<date(NEW.day,'+2 days')||'T00:00:00'":"e.at>=date(NEW.day,'-1 day')||'T16:00:00' AND e.at<date(NEW.day,'+7 days')||'T16:00:00'";
      const name=`value_${table}_${op.toLowerCase()}`,sql=`CREATE TRIGGER ${name} AFTER ${op} ON ${table} BEGIN INSERT OR IGNORE INTO valuation_dirty SELECT e.owner,e.id FROM usage_versions u CROSS JOIN events e ON e.owner=u.owner WHERE e.source IN ('codex','zcode','dsh') AND ${condition}; END`;
      const old=db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?").get(name);
      if(old?.sql!==sql){db.exec('DROP TRIGGER IF EXISTS '+name);db.exec(sql);}
    }
    const rule=db.prepare('SELECT rule FROM valuation_rule WHERE owner=?').get(monitor.profile.owner) as JsonObject|undefined;if(rule?.rule!=='incremental-v2'){db.prepare("INSERT OR IGNORE INTO valuation_dirty SELECT owner,id FROM events WHERE owner=? AND source IN ('codex','zcode','dsh')").run(monitor.profile.owner);db.prepare('INSERT OR REPLACE INTO valuation_rule VALUES(?,?)').run(monitor.profile.owner,'incremental-v2');}
  }
  store(body: string) {
    const cached=this.proofCache.get(body);if(cached)return cached;
    const raw = Buffer.from(body);
    if (raw.length > 4 * 1024 * 1024) throw new Error("证据超过保存限制");
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
      row.raw_size > 4 * 1024 * 1024
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
      source: RADAR + "models.json",
      agentCalculationEnabled:
        process.env.WORKBENCH_AGENT_VALUE_ENABLED === "1",
      prices: intervals,
      fxDays: index.fx.size,
      historicalAPI: true,
      refreshing: this.refreshing,
      task: { ...this.task },
      version: index.version,
      assumptions: "ModelRadar 当日原币文本 Token 参考等价值；不是实际账单",
    };
  }
  sync(
    start: string,
    end: string,
    options: {
      rows?: JsonObject[];
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
    const p = this.monitor.profile,
      owner = p.owner,
      db = p.db,
      rows=options.rows||this.requirements(options.scope),
      used=new Set<string>(),required=new Map<string,Set<string>>(),known=new Map<string,Set<string>|null>(),
      prior = new Map(
        (db.prepare("SELECT * FROM radar_fetches").all() as JsonObject[]).map(
          (r) => [r.url, r],
        ),
      );
    for (const row of rows) {
      const day = new Date(row.at).toISOString().slice(0, 10);
      for (const d of [day, addDays(day, -1)]) {
        if (day >= start && day <= end) used.add(d);
        (required.get(d) || required.set(d, new Set()).get(d)!).add(
          String(row.model).replace(/^chatgpt-web\//, ""),
        );
      }
    }
    const incomplete=(day:string)=>{
      if(!known.has(day)){const row=db.prepare('SELECT body FROM radar_days WHERE day=?').get(day) as JsonObject|undefined;try{known.set(day,row?new Set(validatePrices(this.body(row.body),day).models.filter(m=>required.get(day)?.has(m.model)).map(m=>m.model)):null);}catch{known.set(day,null);}}
      const available=known.get(day);return !available||[...(required.get(day)||[])].some(model=>!available.has(model));
    };
    const urls = [
        RADAR + "models.json",
        RADAR + "changelog.json",
        ...[...used]
          .sort()
          .filter(incomplete)
          .map((day) => RADAR + "history/" + day + ".json"),
      ],
      errors: JsonObject[] = [],
      gaps: JsonObject[] = [],
      observed = iso();
    let checked = 0,
      changed = 0;
    const loader = options.loader || loadPrice;
    let position = 0,
      completed = 0;
    const persist=(response:JsonObject)=>{options.check?.();if(owner!==p.owner)throw Error('Profile 已切换');p.transaction(()=>{const before=changed;
        checked++;
        const old = prior.get(response.url) || {},
          failed = !!response.error;
        db.prepare(
          "INSERT OR REPLACE INTO radar_fetches VALUES(?,?,?,?,?,?)",
        ).run(
          response.url,
          response.etag,
          Date.now() / 1000,
          failed ? old.success || 0 : Date.now() / 1000,
          failed ? (old.failures || 0) + 1 : 0,
          response.error || "",
        );
        if (failed) {
          (String(response.error).startsWith("snapshot_") ? gaps : errors).push(
            { source: response.url, error: response.error },
          );
          return;
        }
        if (response.body === null) return;
        const digest = hash(response.body),
          reference = this.store(response.body);
        db.prepare(
          "INSERT OR IGNORE INTO radar_observations VALUES(?,?,?,?)",
        ).run(response.url, digest, reference, observed);
        if (response.parsed) {
          const day = response.parsed.day,
            previous = db
              .prepare("SELECT digest FROM radar_days WHERE day=?")
              .get(day) as JsonObject | undefined;
          if (!previous || previous.digest !== digest) {
            db.prepare(
              "INSERT OR REPLACE INTO radar_days VALUES(?,?,?,?,?)",
            ).run(day, reference, digest, response.url, observed);
            changed++;
          }
        }
      if(changed>before)db.prepare('UPDATE radar_meta SET version=version+1 WHERE id=1').run();
    });};
    const worker = async () => {
      while (position < urls.length) {
        const url = urls[position++];
        options.check?.();
        const old = prior.get(url) || {},
          delay = old.failures
            ? Math.min(86400, 3600 * 2 ** Math.min(old.failures, 4))
            : 3600;
        if (
          !options.force &&
          !options.loader &&
          Date.now() / 1000 - (old.attempt || 0) < delay
        ) {
          options.progress?.({
            phase: "prices",
            completed: ++completed,
            total: urls.length,
          });
          continue;
        }
        let response: JsonObject;
        try {
          const result = await loader(url, old.etag || ""),
            body = result.body;
          let parsed: ReturnType<typeof validatePrices> | null = null;
          if (body !== null) {
            if (url.endsWith("changelog.json")) {
              if (!Array.isArray(parseExact(body).history))
                throw new Error("变更日志不正确");
            } else
              try {
                parsed = validatePrices(
                  body,
                  url.includes("/history/")
                    ? url.split("/").at(-1)!.slice(0, -5)
                    : undefined,
                );
              } catch (error: any) {
                error.priceValidation = true;
                throw error;
              }
          }
          response = { url, body, etag: result.etag, parsed, error: null };
        } catch (error: any) {
          response = {
            url,
            body: null,
            etag: old.etag || "",
            parsed: null,
            error:
              url.includes("/history/") && error.status === 404
                ? "snapshot_unavailable"
                : url.includes("/history/") && error.priceValidation
                  ? "snapshot_invalid"
                  : error.priceValidation
                    ? "模型目录结构不正确"
                    : "价格读取失败，未回填历史",
          };
        }
        persist(response);
        options.progress?.({
          phase: "prices",
          completed: ++completed,
          total: urls.length,
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, urls.length) }, worker));
    options.check?.();
    if (owner !== p.owner) throw new Error("Profile 已切换");
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
    if(this.lookupVersion!==version){this.lookupVersion=version;this.dayCache.clear();this.dayBytes=0;this.fxCache.clear();this.formulaCache.clear();}
    const day = new Date(row.at).toISOString().slice(0, 10),
      model = String(row.model).replace(/^chatgpt-web\//, ""),
      price = this.lookupDay(day).get(model),
      fail = (reason: string, proof: JsonObject = {}) => ({
        cost: null,
        currency,
        valueReason: reason,
        valueProof: proof,
        valueParts: {},
        valueVersion: version,
      });
    if (!price) return fail("missing_historical_price");
    if (price.sourceType !== "provider") return fail("fallback_price");
    if (price.unsupported || !["USD", "CNY"].includes(price.currency))
      return fail("unsupported_pricing_rules");
    const previous = this.lookupDay(addDays(day,-1)).get(model);
    if (
      previous &&
      canonical([previous.quote, previous.currency]) !==
        canonical([price.quote, price.currency])
    )
      return fail("uncertain_price_transition");
    if (!raw) return fail("missing_usage_evidence");
    const u =
        raw.last_token_usage && Object.keys(raw.last_token_usage).length
          ? raw.last_token_usage
          : raw.usage || {},
      written =
        u.cache_write_input_tokens ??
        u.cache_creation_input_tokens ??
        u.cacheWriteTokens;
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
    const version=this.version();if(this.lookupVersion!==version){this.lookupVersion=version;this.dayCache.clear();this.dayBytes=0;this.fxCache.clear();this.formulaCache.clear();}
    const updates:JsonObject[]=[];
    const result=rows.map(row=>{
      const keys=row._storageKeys,name=currency.toLowerCase();
      const old=keys?db.prepare('SELECT lower(hex('+name+'_fingerprint)) fingerprint,'+name+'_payload payload FROM compact_valuations WHERE owner=? AND id=?').get(keys.owner,keys.id):read.get(p.owner,row.id,currency) as JsonObject|undefined;
      const rawText=keys?db.prepare('SELECT lingxi_read_payload(p.delta,p.pack,p.ordinal,'+(row.source==='codex'?4:0)+') raw FROM compact_'+(row.source==='codex'?'codex_evidence':'agent_evidence')+' e JOIN usage_payloads p ON p.k=e.payload WHERE e.owner=? AND e.id=? AND e.verified=1').get(keys.owner,keys.id)?.raw:((row.source==='codex'?codex:agent).get(p.owner,row.id) as JsonObject|undefined)?.raw;
      let raw=rawText?this.rawCache.get(rawText):undefined;if(rawText&&!raw){raw=parseExact(rawText);if(rawText.length<8000)this.rawCache.set(rawText,raw!);}
      const day=new Date(row.at).toISOString().slice(0,10),model=String(row.model).replace(/^chatgpt-web\//,''),price=this.lookupDay(day).get(model),previous=this.lookupDay(addDays(day,-1)).get(model),fx=price?.currency===currency?null:this.lookupFx(row.at);
      const signature=canonical(['incremental-v2',row.source,model,day,shanghaiDay(row.at),row.input,row.output,row.cached,row.total,raw?[raw.model,raw.last_token_usage&&Object.keys(raw.last_token_usage).length?raw.last_token_usage:raw.usage]:null,price?.digest||null,previous?.digest||null,fx?[fx.day,fx.usd_cad,fx.cny_cad]:null,currency]);
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
    const p=this.monitor.profile,where=scope?' AND source=?':'';return p.db.prepare("SELECT DISTINCT substr(at,1,10) AS day,model FROM events WHERE owner=? AND source IN ('codex','zcode','dsh')"+where+" ORDER BY day").all(...(scope?[p.owner,scope]:[p.owner])).map((row:JsonObject)=>({at:row.day+'T00:00:00Z',model:row.model}));
  }
  async prepareRows(scope:string,check:()=>void=()=>{},progress?:(v:JsonObject)=>void){
    const p=this.monitor.profile,db=p.db,where=scope?' AND e.source=?':'';
    const compact=db.usageStorage,ownerKey=compact?db.prepare('SELECT k FROM usage_strings WHERE value=?').get(p.owner).k:null;
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
      models = snapshot
        ? validatePrices(this.body(snapshot.body), date).models.map(
            (m): JsonObject => ({
              ...m,
              date,
              snapshotSource: snapshot.source,
              digest: snapshot.digest,
            }),
          )
        : [],
      q = String(params.q || "").toLowerCase(),
      rows = models.filter(
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
    return {
      items: rows.slice(offset, offset + limit),
      total: rows.length,
      date,
      dates,
      providers: [...new Set(models.map((m) => m.provider))].sort(),
      models: [
        ...new Set(
          models
            .filter((m) => !params.provider || m.provider === params.provider)
            .map((m) => m.model),
        ),
      ].sort(),
      missing: !snapshot,
      source: "https://modelradar.cn/api",
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
  private flag(scope: string) {
    if (!["codex", "zcode", "dsh"].includes(scope))
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
    if(!background&&current.coverage&&current.versions?.usage===String(this.pricing.monitor.version())&&current.versions?.priceAndFx===this.pricing.version()){this.control.saveConfig({[this.flag(scope)]:true});queueMicrotask(()=>this.start(scope,true));return {...current,status:'complete'};}
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
        await this.syncAgent(scope);
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
          { rows, scope, force: false, progress: update, check },
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
            rule:"incremental-v2",
            priceAndFx: coverage.USD.priceVersion,
            usage: coverage.USD.dataVersion,
          },
          finished: Date.now() / 1000,
        });
        p.transaction(() => {
          this.control.saveConfig({ [this.flag(scope)]: true });
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
