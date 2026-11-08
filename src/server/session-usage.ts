import { ExactSum } from "./exact-sum.ts";
import {
  FIELDS,
  dateRange,
  shanghaiDay,
  summaryAccumulator,
  type Dataset,
} from "./usage-summary.ts";
import type { JsonObject } from "./profile.ts";
import {
  SESSION_LIMITS,
  SESSION_UNKNOWN_LABEL,
  clampSessionLimit,
  type Count,
  type SessionUsageCost,
  type SessionUsageResult,
  type SessionUsageRow,
  type SessionUsageUnknown,
} from "../shared/session-usage.ts";

function countOut(value: number | bigint | null): Count {
  if (typeof value !== "bigint") return value;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

const emptyUnknown = (): SessionUsageUnknown => ({
  input: 0,
  output: 0,
  cached: 0,
  reasoning: 0,
  total: 0,
});

type Bucket = {
  session: string;
  unknownIdentity: boolean;
  sources: Set<string>;
  agents: Set<string>;
  models: Set<string>;
  projects: Set<string>;
  providers: Set<string>;
  days: Set<string>;
  firstAt: string;
  lastAt: string;
  requests: number;
  input: bigint | null;
  output: bigint | null;
  cached: bigint | null;
  reasoning: bigint | null;
  total: bigint | null;
  unknown: SessionUsageUnknown;
  observed: number;
  /** cached sum over rows that also reported input: the only measurable share. */
  rateCached: bigint;
  /** input sum over those same rows, so the ratio has one denominator. */
  rateInput: bigint;
  rateRows: number;
  failures: number;
  modelTotals: Map<string, ModelTotal>;
  costs: Map<string, ExactSum>;
  pricedRequests: number;
  unpricedRequests: number;
};

/** Per-model slice of one session. Kept per session so the expanded workspace tree
 * shows real per-model totals instead of distributing a session total by guesswork. */
type ModelTotal = {
  provider: string;
  model: string;
  input: bigint | null;
  cached: bigint | null;
  total: bigint | null;
  requests: number;
  unknownTotal: boolean;
};

function bucket(session: string): Bucket {
  return {
    session,
    unknownIdentity: session === "",
    sources: new Set(),
    agents: new Set(),
    models: new Set(),
    projects: new Set(),
    providers: new Set(),
    days: new Set(),
    firstAt: "",
    lastAt: "",
    requests: 0,
    input: null,
    output: null,
    cached: null,
    reasoning: null,
    total: null,
    unknown: emptyUnknown(),
    observed: 0,
    rateCached: 0n,
    rateInput: 0n,
    rateRows: 0,
    failures: 0,
    modelTotals: new Map(),
    costs: new Map(),
    pricedRequests: 0,
    unpricedRequests: 0,
  };
}

function addRow(b: Bucket, row: JsonObject, currency: string, requests: number) {
    b.observed++;
    b.requests += requests;
    for (const [key, set] of [
      ["source", b.sources],
      ["agent", b.agents],
      ["model", b.models],
      ["project", b.projects],
      ["provider", b.providers],
    ] as const) {
      const value = typeof row[key] === "string" ? row[key] : "";
      if (value) set.add(value);
    }
    const providerName = typeof row.provider === "string" ? row.provider : "",
      modelName = typeof row.model === "string" ? row.model : "",
      modelKey = providerName + "\u0000" + modelName;
    let modelTotal = b.modelTotals.get(modelKey);
    if (!modelTotal)
      b.modelTotals.set(
        modelKey,
        (modelTotal = {
          provider: providerName,
          model: modelName,
          input: null,
          cached: null,
          total: null,
          requests: 0,
          unknownTotal: false,
        }),
      );
    modelTotal.requests += requests;
    for (const key of ["input", "cached", "total"] as const) {
      const value = row[key];
      if (value != null) modelTotal[key] = (modelTotal[key] ?? 0n) + BigInt(value);
      else if (key === "total") modelTotal.unknownTotal = true;
    }
    const at = typeof row.at === "string" ? row.at : "";
    if (at && (!b.firstAt || at < b.firstAt)) b.firstAt = at;
    if (at && at > b.lastAt) b.lastAt = at;
    if (typeof row.local_date === "string") b.days.add(row.local_date);
    // Exact per-field accumulation: null means unknown, never zero.
    for (const [key, target] of [
      ["input", "input"],
      ["output", "output"],
      ["cached", "cached"],
      ["reasoning", "reasoning"],
      ["total", "total"],
    ] as const) {
      const value = row[key];
      if (value == null) {
        b.unknown[target] += 1;
        continue;
      }
      b[target] = (b[target] ?? 0n) + BigInt(value);
    }
    // The cache share is cached/input — input already contains the cache reads, so
    // adding cached again would count them twice. Measure it only on rows that
    // reported both sides; an unknown side stays unknown, never a zero.
    if (row.cached != null && row.input != null) {
      b.rateCached += BigInt(row.cached);
      b.rateInput += BigInt(row.input);
      b.rateRows += requests;
    }
    if (["error", "failed", "cancelled"].includes(String(row.status))) b.failures++;
    const cost = row.cost;
    if (cost != null) {
      const rowCurrency = String(row.currency || currency).slice(0, 8);
      (b.costs.get(rowCurrency) || b.costs.set(rowCurrency, new ExactSum()).get(rowCurrency)!)
        .add(cost);
      b.pricedRequests++;
    } else b.unpricedRequests++;
}

/**
 * Aggregate already-filtered usage rows into request-session buckets.
 *
 * The rows are the same rows the daily dataset uses, so a session total is always the
 * sum of the daily totals for the same filter — there is no second accounting path.
 * Unknown fields stay counted per row (`unknownFields`) rather than being folded into 0.
 */
export function aggregateSessions(
  rows: Iterable<JsonObject>,
  options: {
    scope: string;
    params?: JsonObject;
    limit?: unknown;
    currency?: string;
    days?: number;
    dataVersion?: string;
    now?: number;
    range?: [string, string];
    projectTree?: boolean;
    metadata?: (session: string) => {title?: string; project?: string; parent?: string} | undefined;
  },
): SessionUsageResult {
  const params = options.params || {},
    now = options.now ?? Date.now(),
    currency = options.currency || "CNY",
    limit = clampSessionLimit(options.limit);
  const [start, end] =
    options.range || dateRange(options.days ?? 30, params, undefined, shanghaiDay(now));
  const buckets = new Map<string, Bucket>();
  const dayTotals = new Map<string, { total: bigint | null; unknown: boolean; requests: number }>();
  const summary = summaryAccumulator(currency);
  const projects = new Map<string, Map<string, Bucket>>();
  const parents = new Map<string,string>();
  const rootSession = (session: string) => {
    const cached = parents.get(session);
    if (cached !== undefined) return cached;
    let current = session;
    const visited = new Set([current]);
    while (options.projectTree) {
      const parent = options.metadata?.(current)?.parent;
      if (!parent) break;
      if (visited.has(parent)) return session;
      visited.add(parent);
      current = parent;
    }
    parents.set(session,current);
    return current;
  };
  for (const row of rows) {
    if (typeof row.local_date !== "string" || row.local_date < start || row.local_date > end) continue;
    summary.add(row);
    const session = rootSession(typeof row.session === "string" ? row.session.trim() : "");
    const requests = Number(row.platform_requests ?? 1);
    const b = buckets.get(session) || buckets.set(session, bucket(session)).get(session)!;
    addRow(b, row, currency, requests);
    if (options.projectTree) {
      const project = session ? options.metadata?.(session)?.project || row.project || "" : "";
      const sessions = projects.get(project) || projects.set(project, new Map()).get(project)!;
      const entry = sessions.get(session) || sessions.set(session, bucket(session)).get(session)!;
      addRow(entry, row, currency, requests);
    }
    const day = String(row.local_date);
    const dayEntry = dayTotals.get(day) || { total: null, unknown: false, requests: 0 };
    if (row.total != null)
      dayEntry.total = (dayEntry.total ?? 0n) + BigInt(row.total);
    else dayEntry.unknown = true;
    dayEntry.requests += requests;
    dayTotals.set(day, dayEntry);
  }
  const toRow = (b: Bucket): SessionUsageRow => {
      // `input` is the whole prompt (cache reads included), so the cache share is
      // cached/input, measured on the rows that reported both. `cacheCoverage` says how
      // much of the session that measurement actually covers, so a partial ratio is
      // never presented as complete.
      const cacheHitRate = b.rateInput > 0n ? Math.min(1, Number(b.rateCached) / Number(b.rateInput)) : null;
      const cacheCoverage = b.requests > 0 ? b.rateRows / b.requests : null;
      const costs: SessionUsageCost[] = [...b.costs].map(([code, sum]) => ({
        currency: code,
        amount: sum.result(),
        pricedRequests: b.pricedRequests,
        unpricedRequests: b.unpricedRequests,
      }));
      return {
        session: b.session,
        title: options.metadata?.(b.session)?.title,
        unknownIdentity: b.unknownIdentity,
        sources: [...b.sources].sort(),
        agents: [...b.agents].sort(),
        models: [...b.models].sort(),
        projects: [...b.projects].sort(),
        providers: [...b.providers].sort(),
        firstAt: b.firstAt || null,
        lastAt: b.lastAt || null,
        activeDays: b.days.size,
        requests: b.requests,
        input: countOut(b.input),
        output: countOut(b.output),
        cached: countOut(b.cached),
        reasoning: countOut(b.reasoning),
        total: countOut(b.unknown.total ? null : b.total),
        unknownFields: b.unknown,
        cacheHitRate: cacheHitRate != null && Number.isFinite(cacheHitRate) ? cacheHitRate : null,
        cacheCoverage,
        modelTotals: [...b.modelTotals.values()]
          .map((entry) => ({
            provider: entry.provider,
            model: entry.model,
            requests: entry.requests,
            input: countOut(entry.input),
            cached: countOut(entry.cached),
            total: countOut(entry.unknownTotal ? null : entry.total),
            cacheHitRate:
              entry.input != null && entry.cached != null && entry.input > 0n
                ? Number(entry.cached) / Number(entry.input)
                : null,
          }))
          .sort((a, b) => {
            const left = BigInt(a.total ?? 0),
              right = BigInt(b.total ?? 0);
            return right > left ? 1 : right < left ? -1 : b.requests - a.requests;
          }),
        costs,
        failures: b.failures,
      };
  };
  const compare = (a: SessionUsageRow, b: SessionUsageRow) => {
    if ((a.total == null) !== (b.total == null)) return a.total == null ? 1 : -1;
    const left = BigInt(a.total ?? 0), right = BigInt(b.total ?? 0);
    if (left !== right) return left > right ? -1 : 1;
    return (b.lastAt || "").localeCompare(a.lastAt || "") || a.session.localeCompare(b.session);
  };
  const sessionRows = options.projectTree ? [] : [...buckets.values()].map(toRow).sort(compare);
  const summarySum = summary.result();
  const notes: string[] = [];
  if (buckets.has("")) {
    const bucketRow = buckets.get("")!;
    if (bucketRow.observed)
      notes.push(
        `${bucketRow.observed} 条记录的来源未报告会话标识，已归入“${SESSION_UNKNOWN_LABEL}”，不猜测归属。`,
      );
  }
  const unknownCached = buckets.size
    ? [...buckets.values()].reduce((n, b) => n + b.unknown.cached, 0)
    : 0;
  if (unknownCached) notes.push(`有 ${unknownCached} 条记录未报告缓存 Token，缓存合计仅含已知部分。`);
  const unknownReasoning = buckets.size
    ? [...buckets.values()].reduce((n, b) => n + b.unknown.reasoning, 0)
    : 0;
  if (unknownReasoning) notes.push(`有 ${unknownReasoning} 条记录未报告推理 Token，推理合计仅含已知部分。`);
  const distribution = sessionRows
    .filter((row) => Number(row.total ?? 0) > 0)
    .slice(0, 10)
    .map((row) => ({
      session: row.session,
      label: row.unknownIdentity ? SESSION_UNKNOWN_LABEL : row.title || "未命名会话",
      total: row.total,
      requests: row.requests,
    }));
  const timeline = [...dayTotals]
    .filter(([day]) => day >= start && day <= end)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entry]) => ({
      date,
      total: countOut(entry.unknown ? null : entry.total),
      requests: entry.requests,
    }));
  // Group-level cache share and the busiest single session, both exact sums over the
  // same buckets the table uses.
  let groupCached = 0n,
    groupInput = 0n,
    groupRateRows = 0,
    groupRequests = 0;
  let peakSession: bigint | null = null;
  for (const b of buckets.values()) {
    groupCached += b.rateCached;
    groupInput += b.rateInput;
    groupRateRows += b.rateRows;
    groupRequests += b.requests;
    if (!b.unknown.total && b.total != null && (peakSession == null || b.total > peakSession)) peakSession = b.total;
  }
  const groupHitRate = groupInput > 0n ? Math.min(1, Number(groupCached) / Number(groupInput)) : null;
  return {
    scope: options.scope,
    range: { start, end },
    timezone: "Asia/Shanghai",
    sessions: options.projectTree ? [] : sessionRows.slice(0, limit),
    ...(options.projectTree ? {projects: [...projects].map(([project, group]) => {
      let total = 0n, unknown = false, requests = 0, lastAt = "", input = 0n, cached = 0n, measured = 0;
      for (const b of group.values()) {
        total += b.total ?? 0n;
        unknown ||= b.unknown.total > 0;
        requests += b.requests;
        if (b.lastAt > lastAt) lastAt = b.lastAt;
        input += b.rateInput;
        cached += b.rateCached;
        measured += b.rateRows;
      }
      return {project, total: countOut(unknown ? null : total), requests, lastAt: lastAt || null,
        cacheHitRate: input > 0n ? Math.min(1, Number(cached) / Number(input)) : null,
        cacheCoverage: requests ? measured / requests : null, sessions: [...group.values()].map(toRow).sort(compare).map(row => {
          const {session,title,unknownIdentity,total,requests,cacheHitRate,cacheCoverage,lastAt} = row;
          return {session,title,unknownIdentity,total,requests,cacheHitRate,cacheCoverage,lastAt,
            modelTotals:row.modelTotals.map(({provider,model,total})=>({provider,model,total}))};
        })};
    })} : {}),
    summary: {
      sessions: buckets.size,
      requests: summarySum.requestCount ?? 0,
      // `summarize` returns bigint for values above the safe integer range; serialize those
      // exactly like the per-session fields or JSON.stringify throws.
      total: countOut(
        summarySum.unknownFields.total ? null : summarySum.total ?? null,
      ),
      cached: countOut(
        typeof summarySum.cached === "bigint" ? summarySum.cached : summarySum.cached ?? null,
      ),
      activeDays: dayTotals.size,
      cacheHitRate: groupHitRate,
      cacheCoverage: groupRequests ? groupRateRows / groupRequests : null,
      peakSession: countOut(peakSession),
    },
    distribution,
    timeline,
    totalSessions: buckets.size,
    truncated: !options.projectTree && sessionRows.length > limit,
    updatedAt: new Date(now).toISOString(),
    dataVersion: options.dataVersion || "",
    notes,
  };
}

/**
 * Dataset-backed entry point used by the HTTP route and the taskbar bridge.
 *
 * Reads through `Dataset.snapshot` so the same filter rules (source/provider/project/
 * connection/model plus the date range) resolve sessions. `events` carries the raw rows
 * because session identity lives on the event, not on the daily aggregate.
 */
export function sessionUsage(
  dataset: Dataset,
  options: {
    scope: string;
    params?: JsonObject;
    limit?: unknown;
    days?: number;
    dataVersion?: string;
    now?: number;
    projectTree?: boolean;
    metadata?: (session: string) => {title?: string; project?: string; parent?: string} | undefined;
  },
): SessionUsageResult {
  const params = options.params || {};
  const earliest = dataset.rows.reduce((day, row) => row.local_date < day ? row.local_date : day, shanghaiDay(options.now ?? Date.now()));
  return aggregateSessions(dataset.rows, {
    ...options,
    currency: String(params.cost_currency || dataset.currency || "CNY"),
    range: dateRange(options.days ?? 30, params, earliest, shanghaiDay(options.now ?? Date.now())),
  });
}

export { SESSION_LIMITS, FIELDS };
