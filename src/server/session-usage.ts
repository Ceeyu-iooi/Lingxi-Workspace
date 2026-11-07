import { ExactSum } from "./exact-sum.ts";
import {
  FIELDS,
  dateRange,
  shanghaiDay,
  summarize,
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

/** Exact integer addition that keeps BigInt precision until the safe range ends. */
function addCount(a: any, b: any): number | bigint {
  const total = BigInt(a ?? 0) + BigInt(b ?? 0);
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : total;
}

function countOut(value: number | bigint | null): Count {
  if (value == null) return null;
  return typeof value === "bigint" ? value.toString() : value;
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
  cachedKnown: bigint;
  inputKnown: bigint;
  /** cached sum over rows that also reported input: the only measurable share. */
  rateCached: bigint;
  /** input sum over those same rows, so the ratio has one denominator. */
  rateInput: bigint;
  rateRows: number;
  cachedUnknownRows: number;
  inputUnknownRows: number;
  cachedTotalRows: number;
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
    cachedKnown: 0n,
    inputKnown: 0n,
    rateCached: 0n,
    rateInput: 0n,
    rateRows: 0,
    cachedUnknownRows: 0,
    inputUnknownRows: 0,
    cachedTotalRows: 0,
    failures: 0,
    modelTotals: new Map(),
    costs: new Map(),
    pricedRequests: 0,
    unpricedRequests: 0,
  };
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
  },
): SessionUsageResult {
  const params = options.params || {},
    now = options.now ?? Date.now(),
    currency = options.currency || "CNY",
    limit = clampSessionLimit(options.limit);
  const [start, end] =
    options.range || dateRange(options.days ?? 30, params, undefined, shanghaiDay(now));
  const buckets = new Map<string, Bucket>();
  const dayTotals = new Map<string, { total: bigint | null; requests: number }>();
  // Retained only for the shared `summarize` accumulator, which reads the same rows once;
  // the per-session buckets above are the authoritative page output.
  const rowsBuffer: JsonObject[] = [];
  let rowCount = 0;
  for (const row of rows) {
    if (
      typeof row.local_date !== "string" ||
      row.local_date < start ||
      row.local_date > end
    )
      continue;
    rowCount++;
    rowsBuffer.push(row);
    const rawSession = typeof row.session === "string" ? row.session.trim() : "";
    const session = rawSession.slice(0, 300);
    const b = buckets.get(session) || buckets.set(session, bucket(session)).get(session)!;
    b.observed++;
    b.requests += Number(row.platform_requests ?? 1) || 1;
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
        }),
      );
    modelTotal.requests += Number(row.platform_requests ?? 1) || 1;
    for (const key of ["input", "cached", "total"] as const) {
      const value = row[key];
      if (value != null) modelTotal[key] = addCount(modelTotal[key] ?? 0n, value) as bigint;
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
      b[target] = addCount(b[target] ?? 0n, value) as bigint;
    }
    if (row.cached != null) {
      b.cachedKnown += BigInt(row.cached);
      b.cachedTotalRows++;
    } else b.cachedUnknownRows++;
    if (row.input != null) {
      b.inputKnown += BigInt(row.input);
    } else b.inputUnknownRows++;
    // The cache share is cached/input — input already contains the cache reads, so
    // adding cached again would count them twice. Measure it only on rows that
    // reported both sides; an unknown side stays unknown, never a zero.
    if (row.cached != null && row.input != null) {
      b.rateCached += BigInt(row.cached);
      b.rateInput += BigInt(row.input);
      b.rateRows++;
    }
    if (["error", "failed", "cancelled"].includes(String(row.status))) b.failures++;
    const cost = row.cost;
    if (cost != null) {
      const rowCurrency = String(row.currency || currency).slice(0, 8);
      (b.costs.get(rowCurrency) || b.costs.set(rowCurrency, new ExactSum()).get(rowCurrency)!)
        .add(cost);
      b.pricedRequests++;
    } else b.unpricedRequests++;
    const day = String(row.local_date);
    const dayEntry = dayTotals.get(day) || { total: null as bigint | null, requests: 0 };
    if (row.total != null)
      dayEntry.total = addCount(dayEntry.total ?? 0n, row.total) as bigint;
    dayEntry.requests += Number(row.platform_requests ?? 1) || 1;
    dayTotals.set(day, dayEntry);
  }
  const sessionRows: SessionUsageRow[] = [...buckets.values()]
    .map((b) => {
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
        total: countOut(b.total),
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
            total: countOut(entry.total),
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
      } satisfies SessionUsageRow;
    })
    .sort((a, b) => {
      const at = typeof a.total === "number" ? a.total : Number(a.total ?? 0);
      const bt = typeof b.total === "number" ? b.total : Number(b.total ?? 0);
      if (bt !== at) return bt - at;
      const aLast = a.lastAt || "";
      const bLast = b.lastAt || "";
      if (aLast !== bLast) return bLast.localeCompare(aLast);
      return a.session.localeCompare(b.session);
    });
  const summarySum = summarize(rowsBuffer, currency);
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
      label: row.unknownIdentity
        ? SESSION_UNKNOWN_LABEL
        : row.models[0]
          ? `${row.session.slice(0, 8)} · ${row.models[0]}`
          : row.session.slice(0, 8),
      total: row.total,
      requests: row.requests,
    }));
  const timeline = [...dayTotals]
    .filter(([day]) => day >= start && day <= end)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entry]) => ({
      date,
      total: countOut(entry.total),
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
    if (b.total != null && (peakSession == null || b.total > peakSession)) peakSession = b.total;
  }
  const groupHitRate = groupInput > 0n ? Math.min(1, Number(groupCached) / Number(groupInput)) : null;
  return {
    scope: options.scope,
    range: { start, end },
    timezone: "Asia/Shanghai",
    sessions: sessionRows.slice(0, limit),
    summary: {
      sessions: sessionRows.length,
      requests: summarySum.requestCount ?? 0,
      // `summarize` returns bigint for values above the safe integer range; serialize those
      // exactly like the per-session fields or JSON.stringify throws.
      total: countOut(
        typeof summarySum.total === "bigint" ? summarySum.total : summarySum.total ?? null,
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
    totalSessions: sessionRows.length,
    truncated: sessionRows.length > limit,
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
  },
): SessionUsageResult {
  const params = options.params || {};
  const snapshot = dataset.snapshot({ ...params, include_all: true });
  const rows = (snapshot.events as JsonObject[]) || [];
  const currency = String(params.cost_currency || dataset.currency || "CNY");
  return aggregateSessions(rows, {
    ...options,
    currency,
    days: options.days ?? Number(params.days) ?? 30,
    range: [String(snapshot.range.start), String(snapshot.range.end)],
    dataVersion:
      options.dataVersion || String((snapshot as JsonObject).dataVersion || ""),
  });
}

export { SESSION_LIMITS, FIELDS };
