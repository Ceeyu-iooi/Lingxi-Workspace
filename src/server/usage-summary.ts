import { Decimal } from "decimal.js";
import { ExactSum } from "./exact-sum.ts";
import { stamp, type JsonObject } from "./profile.ts";
export const FIELDS = ["input", "output", "cached", "reasoning", "total"];
const shanghaiFormatter=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"});
export const shanghaiDay = (at: string | number | Date) => shanghaiFormatter.format(new Date(at));
const dayTime = (day: string) => Date.parse(day + "T00:00:00Z");
export const addDays = (day: string, n: number) =>
  new Date(dayTime(day) + n * 86400000).toISOString().slice(0, 10);
export function dateRange(
  days = 30,
  params: JsonObject = {},
  earliest?: string,
  today = shanghaiDay(new Date()),
): [string, string] {
  let end = today,
    start: string;
  const period = params.period || "";
  if (period === "all") start = earliest && earliest < today ? earliest : today;
  else if (period === "today") start = today;
  else if (period === "yesterday") start = end = addDays(today, -1);
  else if (period === "month") start = today.slice(0, 7) + "-01";
  else if (period === "last-month") {
    end = addDays(today.slice(0, 7) + "-01", -1);
    start = end.slice(0, 7) + "-01";
  } else if (period === "year") start = today.slice(0, 4) + "-01-01";
  else if (period === "recent-year") {
    const prior = String(Number(today.slice(0, 4)) - 1) + today.slice(4);
    start = addDays(
      new Date(dayTime(prior)).toISOString().slice(0, 10) !== prior
        ? prior.slice(0, 8) + "28"
        : prior,
      1,
    );
  } else if (period === "custom" || params.start_date || params.end_date) {
    start = params.start_date;
    end = params.end_date;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(start || "") ||
      !/^\d{4}-\d{2}-\d{2}$/.test(end || "") ||
      !Number.isFinite(dayTime(start)) ||
      !Number.isFinite(dayTime(end)) ||
      new Date(dayTime(start)).toISOString().slice(0, 10) !== start ||
      new Date(dayTime(end)).toISOString().slice(0, 10) !== end
    )
      throw new Error("请选择起始和终止日期");
  } else if (["", "7", "30", "90", "366"].includes(period))
    start = addDays(
      end,
      -(
        (period
          ? Number(period)
          : Math.max(1, Math.min(366, Math.trunc(days)))) - 1
      ),
    );
  else throw new Error("时间范围不正确");
  if (start > end) throw new Error("起始日期不能晚于终止日期");
  if (end > today) throw new Error("终止日期不能晚于今天");
  if (period !== "all" && (dayTime(end) - dayTime(start)) / 86400000 >= 366)
    throw new Error("时间范围最多 366 天");
  return [start, end];
}
Decimal.set({ precision: 100 });
export function summarize(rows: JsonObject[], currency = "CNY"): JsonObject {
  const result: JsonObject = Object.fromEntries(FIELDS.map((k) => [k, 0])),
    missing: JsonObject = Object.fromEntries(FIELDS.map((k) => [k, 0])),
    totals: Record<string, bigint> = Object.fromEntries(
      FIELDS.map((k) => [k, 0n]),
    ),
    costs: Record<string, ExactSum> = {},
    parts: Record<string, ExactSum> = {},
    issues: JsonObject = {};
  let failures = 0,
    unknown = 0,
    priced = 0,
    costUnknown = 0,
    requests = 0,
    requestsKnown = true,observations=0;
  for (const row of rows) {
    const aggregated=row._aggregate;const count=aggregated?.observations??1;observations+=count;
    if(aggregated){for(const key of FIELDS){totals[key]+=BigInt(row[key]??0);missing[key]+=aggregated.unknownFields[key]||0;}failures+=aggregated.failures;unknown+=aggregated.unknown;priced+=aggregated.pricedRequests;costUnknown+=aggregated.costUnknown;requests+=count;for(const [key,value] of Object.entries(aggregated.valueIssues||{}))issues[key]=(issues[key]||0)+Number(value);if(aggregated.pricedRequests)(costs[row.currency]||(costs[row.currency]=new ExactSum())).add(row.cost);for(const [key,value] of Object.entries(row.valueParts||{}))(parts[key]||(parts[key]=new ExactSum())).add(value);continue;}
    for (const key of FIELDS) {
      if (row[key] == null) missing[key]++;
      else totals[key] += BigInt(row[key]);
    }
    if (["error", "failed", "cancelled"].includes(row.status)) failures++;
    if (row.total == null) unknown++;
    if (row.cost != null) priced++;
    if (row.cost == null || row.currency !== currency) costUnknown++;
    if (row.cost == null && row.valueReason)
      issues[row.valueReason] = (issues[row.valueReason] || 0) + 1;
    if (row.cost != null) {
      const c = row.currency || "CNY";
      (costs[c]||(costs[c]=new ExactSum())).add(row.cost);
    }
    for (const [k, v] of Object.entries(row.valueParts || {}))
      (parts[k]||(parts[k]=new ExactSum())).add(v);
    let n = row.platform_requests;
    if (n == null && (row.granularity || "request") === "request") n = 1;
    if (n == null) requestsKnown = false;
    else requests += Number(n);
  }
  for (const key of FIELDS)
    result[key] = totals[key] <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(totals[key])
      : totals[key];
  return {
    ...result,
    requests: observations,
    observations,
    requestCount: requestsKnown ? requests : null,
    unknown,
    failures,
    unknownFields: missing,
    costExact: Object.fromEntries(
      Object.entries(costs).map(([c, v]) => [c, v.result()]),
    ),
    costs: Object.fromEntries(
      Object.entries(costs).map(([c, v]) => [c, Number(v.result())]),
    ),
    valueParts: Object.fromEntries(
      ["input", "cached", "write", "output"].map((k) => [
        k,
        parts[k]?.result()||"0",
      ]),
    ),
    costUnknown,
    pricedRequests: priced,
    platformRequests: requestsKnown ? requests : null,
    valueIssues: issues,
  };
}
export class Dataset {
  readonly rows: JsonObject[];
  constructor(
    rows: JsonObject[],
    readonly currency = "CNY",
    readonly rangeEarliest?: string,
  ) {
    this.rows = rows.map((r) => ({
      ...r,
      local_date: r.local_date || shanghaiDay(r.at),
    }));
  }
  snapshot(params: JsonObject = {}, days = 30) {
    if (
      params.models !== undefined &&
      (!Array.isArray(params.models) ||
        params.models.some(
          (m: unknown) => typeof m !== "string" || m.length > 300,
        ))
    )
      throw new Error("模型筛选格式不正确");
    const selected = new Set<string>(
        params.models !== undefined
          ? params.models.filter(Boolean)
          : params.model
            ? [params.model]
            : [],
      ),
      match = (r: JsonObject) =>
        ["source", "provider", "project", "connection_id"].every(
          (k) => !params[k] || r[k] === params[k],
        ) &&
        (!selected.size || selected.has(r.model)),
      picked = this.rows.filter(match);
    const earliest = picked.reduce(
        (d, r) => (r.local_date < d ? r.local_date : d),
        shanghaiDay(new Date()),
      ),
      rangeEarliest =
        params.period === "all" &&
        this.rangeEarliest &&
        this.rangeEarliest < earliest
          ? this.rangeEarliest
          : earliest,
      [start, end] = dateRange(days, params, rangeEarliest),
      byDay = new Map<string, JsonObject[]>();
    for (const row of picked)
      (
        byDay.get(row.local_date) ||
        byDay.set(row.local_date, []).get(row.local_date)!
      ).push(row);
    const dayValues = new Map(
        [...byDay].map(([day, rows]) => [day, summarize(rows, this.currency)]),
      ),
      empty = summarize([], this.currency),
      daily: JsonObject[] = [];
    for (let day = start; day <= end; day = addDays(day, 1)) {
      const modelRows = new Map<string, JsonObject[]>();
      for (const row of byDay.get(day) || []) {
        const key = JSON.stringify([row.provider, row.model]);
        (modelRows.get(key) || modelRows.set(key, []).get(key)!).push(row);
      }
      daily.push({
        date: day,
        ...(dayValues.get(day) || empty),
        models: [...modelRows]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, rows]) => {
            const [provider, model] = JSON.parse(key);
            return { provider, model, ...summarize(rows, this.currency) };
          }),
      });
    }
    const activity: JsonObject[] = [],
      activityStart = addDays(end, -365),
      older = summarize(
        picked.filter((r) => r.local_date < activityStart),
        this.currency,
      ),
      running = {
        total: older.total,
        requests: older.requests,
        unknown: older.unknown,
      };
    const money=new ExactSum();money.add(older.costExact[this.currency]||0);
    let
      unknownCost = older.costUnknown;
    for (let i = 0; i < 366; i++) {
      const day = addDays(end, i - 365),
        s = dayValues.get(day) || empty;
      for (const key of ["total", "requests", "unknown"] as const)
        running[key] =
          typeof running[key] === "bigint" || typeof s[key] === "bigint"
            ? BigInt(running[key]) + BigInt(s[key])
            : running[key] + s[key];
      money.add(s.costExact[this.currency] || 0);
      unknownCost += s.costUnknown;
      activity.push({
        date: day,
        ...s,
        cumulativeTotal: running.total,
        cumulativeRequests: running.requests,
        cumulativeUnknown: running.unknown,
        cumulativeCost: Number(money.result()),
        cumulativeCostExact: money.result(),
        cumulativeCostUnknown: unknownCost,
      });
    }
    const active = [...dayValues]
      .filter(([day, value]) => value.total > 0 && day <= end)
      .map(([day]) => day)
      .sort();
    let longest = 0,
      current = 0,
      previous = "";
    for (const day of active) {
      current = previous && addDays(previous, 1) === day ? current + 1 : 1;
      longest = Math.max(longest, current);
      previous = day;
    }
    const streak =
        active.length && [end, addDays(end, -1)].includes(active.at(-1)!)
          ? current
          : 0,
      within = picked.filter(
        (r) => r.local_date >= start && r.local_date <= end,
      ),
      groups = new Map<string, JsonObject[]>();
    for (const row of within) {
      const key = JSON.stringify(
        ["source", "agent", "provider", "model"].map((k) => row[k] || ""),
      );
      (groups.get(key) || groups.set(key, []).get(key)!).push(row);
    }
    return {
      origin: ["codex", "zcode", "dsh"].includes(params.scope)
        ? params.scope
        : "observed",
      summary: summarize(within, this.currency),
      lifetime: {
        ...summarize(picked, this.currency),
        peak: active.reduce(
          (max, day) =>
            dayValues.get(day)!.total > max ? dayValues.get(day)!.total : max,
          0,
        ),
        currentStreak: streak,
        longestStreak: longest,
      },
      budgets: {
        today: (dayValues.get(end) || empty).total,
        month: summarize(
          picked.filter((r) => r.local_date.slice(0, 7) === end.slice(0, 7)),
          this.currency,
        ).total,
      },
      activity,
      daily,
      groups: [...groups]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, rows]) => ({
          ...Object.fromEntries(
            ["source", "agent", "provider", "model"].map((k, i) => [
              k,
              JSON.parse(key)[i],
            ]),
          ),
          ...summarize(rows, this.currency),
          at: rows.reduce((latest, r) => (r.at > latest ? r.at : latest), ""),
        })),
      events: (params.include_all ? within : within.slice(0, 100)).map((r) =>
        Object.fromEntries(Object.entries(r).filter(([k]) => k !== "owner")),
      ),
      options: Object.fromEntries(
        ["source", "provider", "model", "project"].map((k) => [
          k,
          [...new Set(this.rows.map((r) => r[k]).filter(Boolean))].sort(),
        ]),
      ),
      range: { start, end, earliest: rangeEarliest },
      timezone: "Asia/Shanghai",
      updatedAt: stamp(),
    };
  }
}
