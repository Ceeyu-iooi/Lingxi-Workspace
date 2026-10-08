import { Decimal } from "decimal.js";
import {
  ProfileStore,
  encode,
  parseExact,
  uid,
  hash,
  stamp,
  type JsonObject,
} from "./profile.ts";
import { Dataset, FIELDS, shanghaiDay } from "./usage-summary.ts";
import { ResponseCache } from "./response-cache.ts";

export function canonical(value: any): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  return encode(value);
}
const pick = (value: JsonObject, keys: string[], fallback: any = null) => {
  for (const key of keys) if (key in value) return value[key];
  return fallback;
};
export function integer(value: any): number | bigint | null {
  if (value == null) return null;
  if (typeof value === "bigint") {
    if (value < 0n || value > 9223372036854775807n)
      throw new Error("Token 必须是有效范围内的非负整数");
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 9223372036854775807
  )
    throw new Error("Token 必须是有效范围内的非负整数");
  return value;
}
export const addCount = (...values: any[]) => {
  const total = values.reduce((n: bigint, v: any) => n + BigInt(v), 0n);
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : total;
};
export const subtractCount = (a: any, b: any) => {
  const value = BigInt(a) - BigInt(b);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
};
export function normalizeTokens(usage: any): JsonObject | null {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const input = integer(
      pick(usage, ["input_tokens", "prompt_tokens", "input"]),
    ),
    output = integer(
      pick(usage, ["output_tokens", "completion_tokens", "output"]),
    );
  let total = integer(pick(usage, ["total_tokens", "total"]));
  if (input == null && output == null && total == null) return null;
  const incoming =
      pick(usage, ["input_tokens_details", "prompt_tokens_details"], {}) || {},
    outgoing =
      pick(usage, ["output_tokens_details", "completion_tokens_details"], {}) ||
      {};
  if (
    typeof incoming !== "object" ||
    Array.isArray(incoming) ||
    typeof outgoing !== "object" ||
    Array.isArray(outgoing)
  )
    throw new Error("Token 明细必须是对象");
  const cached = integer(
      pick(
        usage,
        ["cached_input_tokens", "prompt_cache_hit_tokens", "cached"],
        incoming.cached_tokens,
      ),
    ),
    reasoning = integer(
      pick(
        usage,
        ["reasoning_output_tokens", "reasoning"],
        outgoing.reasoning_tokens,
      ),
    ),
    written = integer(
      pick(usage, [
        "cache_write_input_tokens",
        "cache_creation_input_tokens",
        "cacheWriteTokens",
      ]),
    );
  if (total == null && input != null && output != null)
    total = integer(addCount(input, output));
  if (
    input != null &&
    output != null &&
    total != null &&
    BigInt(input) + BigInt(output) !== BigInt(total)
  )
    throw new Error("输入和输出与总 Token 冲突");
  if (input != null && cached != null && cached > input)
    throw new Error("缓存读取超过完整输入");
  if (
    input != null &&
    cached != null &&
    written != null &&
    BigInt(cached) + BigInt(written) > BigInt(input)
  )
    throw new Error("缓存分项超过完整输入");
  if (output != null && reasoning != null && reasoning > output)
    throw new Error("推理超过完整输出");
  return { input, output, cached, reasoning, total };
}
export function iso(value?: any) {
  if (value == null) return stamp().replace(/\.(\d{3})Z$/, ".$1000+00:00");
  if (typeof value === "boolean") throw new Error("用量时间格式不正确");
  const numeric = typeof value === "number",
    raw = numeric ? value * 1000 : String(value),
    aware = numeric
      ? raw
      : /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw as string)
        ? raw
        : String(raw) + "Z";
  const date = new Date(aware);
  if (Number.isNaN(date.getTime())) throw new Error("用量时间格式不正确");
  const base = date.toISOString().slice(0, 19);
  const micros = numeric
    ? String(Math.round((value - Math.floor(value)) * 1e6)).padStart(6, "0")
    : (String(raw).match(/\.(\d+)/)?.[1] || "").slice(0, 6).padEnd(6, "0");
  return base + (Number(micros) ? "." + micros : "") + "+00:00";
}
export class Monitor {
  readonly profile: ProfileStore;
  valuation?: (rows: JsonObject[], currency: string) => JsonObject[];
  accounting?: (scope: string) => JsonObject;
  priceVersion?: () => number;
  readonly responseCache = new ResponseCache();
  private datasets = new Map<string, Dataset>();
  constructor(profile: ProfileStore) {
    this.profile = profile;
    profile.db
      .exec(`CREATE TABLE IF NOT EXISTS events(owner TEXT NOT NULL,id TEXT NOT NULL,at TEXT NOT NULL,source TEXT NOT NULL,agent TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,session TEXT NOT NULL,project TEXT NOT NULL,status TEXT NOT NULL,input INTEGER,output INTEGER,cached INTEGER,reasoning INTEGER,total INTEGER,duration_ms INTEGER,cost REAL,currency TEXT,connection_id TEXT NOT NULL DEFAULT '',requested_model TEXT NOT NULL DEFAULT '',auth_mode TEXT NOT NULL DEFAULT '',PRIMARY KEY(owner,id));
    CREATE INDEX IF NOT EXISTS events_owner_time ON events(owner,at);CREATE INDEX IF NOT EXISTS events_scope_time ON events(owner,source,at);
    CREATE TABLE IF NOT EXISTS cursors(owner TEXT,path TEXT,offset INTEGER,state TEXT,PRIMARY KEY(owner,path));
    CREATE TABLE IF NOT EXISTS usage_versions(owner TEXT PRIMARY KEY,version INTEGER);
    CREATE TABLE IF NOT EXISTS codex_meta(owner TEXT PRIMARY KEY,version INTEGER);
    CREATE TABLE IF NOT EXISTS codex_evidence(owner TEXT,id TEXT,session TEXT,at TEXT,provider TEXT,model TEXT,cumulative TEXT,last_usage TEXT,usage TEXT,baseline TEXT,reason TEXT,verified INTEGER,raw TEXT NOT NULL DEFAULT '{}',lineage TEXT NOT NULL DEFAULT '{}',PRIMARY KEY(owner,id));
    CREATE INDEX IF NOT EXISTS codex_evidence_origin ON codex_evidence(owner,session,at);
    CREATE TABLE IF NOT EXISTS codex_links(owner TEXT,path TEXT,id TEXT,PRIMARY KEY(owner,path,id));CREATE TABLE IF NOT EXISTS codex_retired(owner TEXT,id TEXT,record TEXT,reason TEXT,at TEXT,PRIMARY KEY(owner,id));CREATE TABLE IF NOT EXISTS codex_reads(owner TEXT,path TEXT,error TEXT,PRIMARY KEY(owner,path));
    CREATE TABLE IF NOT EXISTS agent_evidence(owner TEXT,id TEXT,source TEXT,raw TEXT,digest TEXT,version INTEGER,verified INTEGER,reason TEXT,PRIMARY KEY(owner,id));CREATE TABLE IF NOT EXISTS agent_reads(owner TEXT,source TEXT,path TEXT,state TEXT,PRIMARY KEY(owner,source,path));CREATE TABLE IF NOT EXISTS agent_retired(owner TEXT,id TEXT,record TEXT,reason TEXT,PRIMARY KEY(owner,id));`);
    for (const op of ["INSERT", "UPDATE", "DELETE"]) {
      const owner = op === "DELETE" ? "OLD.owner" : "NEW.owner";
      profile.db.exec(
        `CREATE TRIGGER IF NOT EXISTS events_${op.toLowerCase()}_version AFTER ${op} ON events BEGIN INSERT INTO usage_versions VALUES(${owner},1) ON CONFLICT(owner) DO UPDATE SET version=version+1; END`,
      );
    }
    for (const table of [
      "agent_evidence",
      "agent_reads",
      "codex_evidence",
      "codex_reads",
    ])
      for (const op of ["INSERT", "UPDATE", "DELETE"]) {
        const owner = op === "DELETE" ? "OLD.owner" : "NEW.owner";
        profile.db.exec(
          `CREATE TRIGGER IF NOT EXISTS ${table}_${op.toLowerCase()}_version AFTER ${op} ON ${table} BEGIN INSERT INTO usage_versions VALUES(${owner},1) ON CONFLICT(owner) DO UPDATE SET version=version+1; END`,
        );
      }
  }
  record(
    usage: any = null,
    meta: JsonObject = {},
    countsOverride?: JsonObject | null,
  ) {
    const counts =
        countsOverride === undefined ? normalizeTokens(usage) : countsOverride,
      rates = meta.rates || {};
    let cost: number | null = null;
    if (
      counts &&
      counts.input != null &&
      counts.output != null &&
      counts.cached != null &&
      ["input", "output", "cached"].every(
        (k) =>
          typeof rates[k] === "number" &&
          rates[k] >= 0 &&
          Number.isFinite(rates[k]),
      )
    )
      cost = new Decimal(String(counts.input))
        .minus(String(counts.cached))
        .times(rates.input)
        .plus(new Decimal(String(counts.cached)).times(rates.cached))
        .plus(new Decimal(String(counts.output)).times(rates.output))
        .div(1000000)
        .toNumber();
    const row: JsonObject = {
      owner: this.profile.owner,
      id: String(meta.id || uid()).slice(0, 250),
      at: iso(meta.at),
    };
    for (const [key, value] of Object.entries({
      source: "api",
      agent: "工作台",
      provider: "未标注",
      model: "未标注",
      session: "",
      project: "",
      status: "success",
    }))
      row[key] = String(meta[key] ?? value).slice(0, 300);
    for (const key of FIELDS) row[key] = counts?.[key] ?? null;
    for (const key of ["connection_id", "requested_model", "auth_mode"])
      row[key] = String(meta[key] || "").slice(0, 300);
    row.duration_ms = Math.max(0, Math.trunc(Number(meta.duration_ms) || 0));
    row.cost = "imported_cost" in meta ? meta.imported_cost : cost;
    row.currency = String(meta.currency || rates.currency || "CNY").slice(0, 8);
    const fields = Object.keys(row),
      result = this.profile.db
        .prepare(
          `INSERT OR IGNORE INTO events(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")})`,
        )
        .run(...Object.values(row));
    return result.changes;
  }
  events() {
    return (
      this.profile.db
        .prepare("SELECT * FROM events WHERE owner=? ORDER BY at DESC")
        .safeIntegers()
        .all(this.profile.owner) as JsonObject[]
    ).map((r) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [
          k,
          typeof v === "bigint" && v <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(v)
            : v,
        ]),
      ),
    );
  }
  version() {
    return (
      (
        this.profile.db
          .prepare("SELECT version FROM usage_versions WHERE owner=?")
          .get(this.profile.owner) as JsonObject | undefined
      )?.version || 0
    );
  }
  snapshot(params: JsonObject = {}, rowsOverride?: JsonObject[]) {
    const version = this.version(),
      key = canonical([
        this.profile.owner,
        version,
        this.priceVersion?.() || 0,
        shanghaiDay(new Date()),
        params,
        rowsOverride ? hash(canonical(rowsOverride)) : null,
      ]),
      cached = this.responseCache.get(key);
    if (cached) return cached as JsonObject;
    let rows = rowsOverride || this.events();
    rows = rows.filter(
      (r) =>
        !["codex-cumulative", "unverified"].includes(r.source) &&
        !(
          r.source === "codex" &&
          r.id.startsWith("codex:") &&
          !r.id.startsWith("codex:v4:")
        ),
    );
    const scope = params.scope || "",
      enabled = params.valuation_enabled === true;
    if (["codex", "zcode", "dsh"].includes(scope))
      rows = rows.filter((r) => r.source === scope);
    else if (scope === "api" && !rowsOverride)
      rows = rows.filter((r) => !["codex", "zcode", "dsh"].includes(r.source));
    const datasetKey = canonical([
      this.profile.owner,
      version,
      scope,
      params.cost_currency || "CNY",
      params.range_earliest || null,
    ]);
    let dataset = !rowsOverride ? this.datasets.get(datasetKey) : undefined;
    if (!dataset) {
      dataset = new Dataset(
        rows,
        params.cost_currency || "CNY",
        params.range_earliest,
      );
      if (!rowsOverride) {
        this.datasets.set(datasetKey, dataset);
        while (this.datasets.size > 8)
          this.datasets.delete(this.datasets.keys().next().value!);
      }
    }
    const data = dataset.snapshot(
      params,
      Number(params.days) || 30,
    ) as JsonObject;
    data.dataVersion = String(version);
    const accounting = this.accounting?.(scope);
    if (accounting) data.accounting = accounting;
    if (enabled && this.valuation) {
      const currency = params.value_currency || "USD",
        valued = this.valuation(rows, currency);
      data.valuation = {
        ...new Dataset(valued, currency, params.range_earliest).snapshot(
          params,
          Number(params.days) || 30,
        ),
        costCurrency: currency,
        experimental: true,
      };
    }
    data.pricing = { enabled };
    this.responseCache.put(key, data);
    return data;
  }
  importRecords(records: any[], preview = false) {
    if (!Array.isArray(records) || records.length > 100000)
      throw new Error("用量记录格式不正确或数量过多");
    const clean = records.map((r) => {
      if (!r || typeof r !== "object") throw new Error("用量记录格式不正确");
      const counts = normalizeTokens(r.usage || r),
        at = iso(r.at || r.timestamp),
        source = String(r.source || "import");
      if (
        ["codex", "zcode", "dsh"].includes(source) &&
        (!r.model || r.model === "未识别模型")
      )
        throw new Error("导入缺少真实模型");
      if (
        r.cost != null &&
        (typeof r.cost !== "number" || !Number.isFinite(r.cost) || r.cost < 0)
      )
        throw new Error("导入金额不正确");
      return {
        counts,
        meta: {
          ...r,
          at,
          source,
          id:
            r.id ||
            "import:" +
              hash(canonical([at, source, r.session, r.model, counts])),
          ...("cost" in r ? { imported_cost: r.cost } : {}),
        },
      };
    });
    if (preview)
      return {
        valid: clean.length,
        records: clean.map((r) => ({ ...r.meta, ...r.counts })),
      };
    let imported = 0;
    this.profile.transaction(() => {
      for (const r of clean) {
        const added = this.record(null, r.meta, r.counts);
        imported += added;
        if (added && ["codex", "zcode", "dsh"].includes(r.meta.source)) {
          const original = r.meta.usage || r.meta,
            raw = canonical({
              origin: "user-import",
              model: r.meta.model,
              usage: {
                input: r.counts?.input,
                output: r.counts?.output,
                total: r.counts?.total,
                cached: r.counts?.cached,
                reasoning: r.counts?.reasoning,
                cache_write_input_tokens:
                  original.cache_write_input_tokens ??
                  original.cache_creation_input_tokens ??
                  original.cacheWriteTokens ??
                  null,
              },
            });
          this.profile.db
            .prepare(
              "INSERT OR REPLACE INTO agent_evidence VALUES(?,?,?,?,?,?,?,?)",
            )
            .run(
              this.profile.owner,
              r.meta.id,
              r.meta.source,
              raw,
              hash(raw),
              "user-import-v1",
              1,
              "verified",
            );
        }
      }
    });
    return { imported, duplicates: clean.length - imported };
  }
}
