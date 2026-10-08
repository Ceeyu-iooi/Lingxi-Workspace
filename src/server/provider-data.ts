import { Decimal } from "decimal.js";
import { normalizeTokens, iso } from "./monitor.ts";
import { hash, type JsonObject } from "./profile.ts";

export const platformInteger = (v: any) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
export function amount(v: any): Decimal | null {
  if (v == null || typeof v === "boolean") return null;
  try {
    const value = new Decimal(String(v));
    if (!value.isFinite() || value.lt(0)) throw new Error();
    return value;
  } catch {
    throw new Error("费用数值不正确");
  }
}
export function timestamp(v: any) {
  if (typeof v !== "string") return null;
  try {
    const value = /([zZ]|[+-]\d{2}:?\d{2})$/.test(v)
      ? v
      : /^\d{4}-\d{2}-\d{2}$/.test(v)
        ? v + "T00:00:00+08:00"
        : v + "+08:00";
    return iso(value).replace("+00:00", "Z");
  } catch {
    return null;
  }
}
const base = (connection: JsonObject, at: string, model: string) => ({
  at,
  source: "official-api",
  agent: "",
  provider: connection.name,
  model,
  project: "",
  session: "",
  connection_id: connection.id,
  requested_model: "",
  auth_mode: "api_key",
  status: "ok",
  duration_ms: null,
  granularity: "bucket",
});
export function normalizeGLM(data: any, connection: JsonObject) {
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray(data.x_time) ||
    data.x_time.length > 10000
  )
    return [];
  let series = data.modelDataList;
  if (!Array.isArray(series) || !series.length)
    series = [{ modelName: "平台未区分模型", tokensUsage: data.tokensUsage }];
  if (series.length > 100) return [];
  const rows: JsonObject[] = [],
    seen = new Set<string>();
  for (const item of series) {
    if (
      !item ||
      !Array.isArray(item.tokensUsage) ||
      item.tokensUsage.length !== data.x_time.length ||
      typeof item.modelName !== "string" ||
      !item.modelName ||
      item.modelName.length > 180
    )
      continue;
    for (let i = 0; i < data.x_time.length; i++) {
      const at = timestamp(data.x_time[i]),
        total = platformInteger(item.tokensUsage[i]),
        identity = item.modelName + "\0" + at;
      if (!at || total == null || seen.has(identity)) continue;
      seen.add(identity);
      rows.push({
        ...base(connection, at, item.modelName),
        id: connection.id + ":" + item.modelName + ":" + at,
        provider: "GLM",
        input: null,
        output: null,
        cached: null,
        reasoning: null,
        total,
        cost: null,
        currency: "CNY",
        provenance: { type: "official-history", parserVersion: "usage-v18" },
      });
      if (rows.length > 10000) return [];
    }
  }
  return rows;
}
export function normalizeCalls(data: any) {
  if (
    !data ||
    !Array.isArray(data.x_time) ||
    !Array.isArray(data.modelCallCount) ||
    data.x_time.length !== data.modelCallCount.length ||
    data.x_time.length > 10000
  )
    return [];
  return data.x_time
    .map((date: any, i: number) => ({
      at: timestamp(date),
      count: platformInteger(data.modelCallCount[i]),
    }))
    .filter((r: JsonObject) => r.at && r.count !== null);
}
export function normalizeHistory(
  data: any,
  connection: JsonObject,
  deepseek = false,
) {
  let records: JsonObject[];
  if (deepseek) {
    if (!Array.isArray(data?.series))
      throw new Error("历史用量响应缺少模型时间桶");
    records = [];
    const counter = (v: any) =>
      typeof v === "string" && /^\d{1,16}$/.test(v)
        ? platformInteger(Number(v))
        : platformInteger(v);
    for (const series of data.series) {
      if (series?.api_key?.tracking_id !== connection.keyTrackingId) continue;
      for (const bucket of series.buckets || []) {
        const u = bucket.usage || {},
          hit = counter(u.PROMPT_CACHE_HIT_TOKEN),
          miss = counter(u.PROMPT_CACHE_MISS_TOKEN),
          output = counter(u.RESPONSE_TOKEN);
        if (hit == null || miss == null || output == null)
          throw new Error("历史 Token 数值不正确");
        records.push({
          at: bucket.time,
          model: series.model,
          input: hit + miss,
          output,
          cached: hit,
          total: hit + miss + output,
          requests: counter(u.REQUEST),
        });
      }
    }
  } else {
    let list = Array.isArray(data) ? data : (data?.records ?? data?.data);
    if (list && !Array.isArray(list)) list = list.records;
    if (!Array.isArray(list))
      throw new Error("历史接口需返回 records 或 data 列表");
    records = [];
    for (const record of list) {
      if (!record || typeof record !== "object" || Array.isArray(record))
        throw new Error("历史记录格式不正确");
      if (Array.isArray(record.results))
        records.push(
          ...record.results.map((r: JsonObject) => ({
            ...r,
            at: record.start_time,
            requests: r.num_model_requests,
          })),
        );
      else records.push(record);
    }
  }
  if (records.length > 10000)
    throw new Error("历史记录超过 10000 条，请缩短查询范围");
  const seen = new Set<string>(),
    rows: JsonObject[] = [];
  for (const record of records) {
    let when = record.at ?? record.date ?? record.timestamp;
    if (when == null) throw new Error("历史记录缺少日期");
    if (typeof when === "string" && /^\d{1,13}$/.test(when))
      when = Number(when);
    if (typeof when === "number" && when > 1e12) when /= 1000;
    if (typeof when === "string") when = timestamp(when);
    if (when == null) throw new Error("历史日期不正确");
    const at = iso(when),
      usage = normalizeTokens(record.usage || record);
    if (!usage || usage.total == null)
      throw new Error("历史记录缺少有效 Token 数值");
    if (
      Object.values(usage).some(
        (v) => v !== null && platformInteger(v) === null,
      )
    )
      throw new Error("历史 Token 超出有效范围");
    const model = record.model || "平台未区分模型";
    if (typeof model !== "string" || model.length > 180)
      throw new Error("历史模型名不正确");
    const identity =
      connection.id +
      ":history:" +
      String(
        record.id ||
          hash(
            "[" +
              [at, model, record.api_key_id ?? null]
                .map((v) => JSON.stringify(v))
                .join(", ") +
              "]",
          ),
      ).slice(0, 200);
    if (seen.has(identity)) throw new Error("历史记录存在重复标识");
    seen.add(identity);
    if (!deepseek) {
      const u = record.usage || record;
      if (
        ![
          "cached",
          "cached_input_tokens",
          "prompt_cache_hit_tokens",
          "input_tokens_details",
          "prompt_tokens_details",
        ].some((k) => k in u)
      )
        usage.cached = null;
      if (
        ![
          "reasoning",
          "reasoning_output_tokens",
          "completion_tokens_details",
        ].some((k) => k in u)
      )
        usage.reasoning = null;
    }
    const cost = amount(record.cost);
    rows.push({
      ...base(connection, at, model),
      id: identity,
      provider: deepseek ? "DeepSeek" : connection.name,
      ...usage,
      cost: cost?.toNumber() ?? null,
      currency: record.currency || "CNY",
      platform_requests: platformInteger(record.requests),
    });
  }
  return rows;
}
export function deepseekCosts(data: any, tracking: string) {
  if (
    !data ||
    String(data.biz_code) !== "0" ||
    !Array.isArray(data.biz_data?.data)
  )
    throw new Error("费用响应格式不正确");
  const costs = new Map<string, Decimal>();
  let matched = false;
  for (const currency of data.biz_data.data) {
    if (currency.currency !== "CNY") continue;
    for (const series of currency.series || []) {
      if (series.api_key?.tracking_id !== tracking) continue;
      matched = true;
      for (const bucket of series.buckets || []) {
        const key = JSON.stringify([series.model, bucket.time]),
          value = amount(bucket.cost);
        if (value === null || costs.has(key))
          throw new Error("费用时间记录不正确");
        costs.set(key, value);
      }
    }
  }
  if (!matched) throw new Error("未返回该 Key 的人民币费用");
  return costs;
}
export function glmBills(
  bills: JsonObject[],
  connection: JsonObject,
  key: string,
): JsonObject[] {
  const groups = new Map<string, JsonObject>();
  for (const bill of bills) {
    if (
      ![key, key.split(".")[0]].includes(bill.apiKey) ||
      bill.usageUnit !== "token"
    )
      continue;
    const model = String(bill.modelProductName || "").match(
        /【([^】]+)】/,
      )?.[1],
      at = timestamp(bill.billingDate),
      total = platformInteger(bill.usageCount),
      kind = bill.tokenType;
    if (!model) throw new Error("账单未返回模型名称");
    if (!at) throw new Error("账单日期不正确");
    if (total === null || !["输入", "输出", "缓存命中"].includes(kind))
      throw new Error("账单 Token 类型或数值不正确");
    const cost = bill.currency === "CNY" ? amount(bill.settlementAmount) : null,
      identity = JSON.stringify([at, model]),
      group = groups.get(identity) || {
        input: 0,
        output: 0,
        cached: 0,
        cost: new Decimal(0),
        priced: true,
      };
    group[kind === "输出" ? "output" : "input"] += total;
    if (kind === "缓存命中") group.cached += total;
    group.priced = group.priced && cost !== null;
    if (cost !== null) group.cost = group.cost.plus(cost);
    groups.set(identity, group);
  }
  return normalizeHistory(
    [...groups].map(([id, g]) => {
      const [at, model] = JSON.parse(id);
      return {
        at,
        model,
        input: g.input,
        output: g.output,
        cached: g.cached,
        total: g.input + g.output,
        cost: g.priced ? g.cost.toNumber() : null,
        currency: "CNY",
      };
    }),
    connection,
  ).map((r) => ({ ...r, provider: "GLM" }));
}
