/**
 * Shared, serializable contract for per-session usage aggregation.
 *
 * Accounting rules (see TOKEN_ACCOUNTING.md):
 * - Counts are exact integers; values above Number.MAX_SAFE_INTEGER are serialized as
 *   decimal strings and must be formatted losslessly by the caller.
 * - `null` means "not reported by the source"; `0` means a verified zero. They are never
 *   collapsed into each other, and an unknown field is never counted as zero.
 * - `cached`/`reasoning` are subsets of `input`/`output`; they are never added into
 *   `total` a second time.
 */
export type Count = number | string | null;

export interface SessionUsageUnknown {
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  total: number;
}

export interface SessionUsageCost {
  currency: string;
  /** Known amount only; `null` when no row inside the session could be priced. */
  amount: Count;
  pricedRequests: number;
  unpricedRequests: number;
}

export interface SessionUsageRow {
  /** Stable request-session identity from the source log. Empty sessions are grouped
   *  under a single "未识别会话" bucket instead of being dropped. */
  session: string;
  /** True when `session` is the placeholder bucket, not a real log session id. */
  unknownIdentity: boolean;
  sources: string[];
  agents: string[];
  models: string[];
  projects: string[];
  providers: string[];
  firstAt: string | null;
  lastAt: string | null;
  /** Distinct Shanghai calendar days the session touched. */
  activeDays: number;
  requests: number;
  input: Count;
  output: Count;
  cached: Count;
  /** `null` when the source never reports reasoning, otherwise the known sum. */
  reasoning: Count;
  total: Count;
  unknownFields: SessionUsageUnknown;
  /** Fraction of `input + cached` that hit the cache, 0..1. `null` when every row
   *  reports unknown cache counts (never assume 0). */
  cacheHitRate: number | null;
  costs: SessionUsageCost[];
  /** Verified failures (error/failed/cancelled) inside the session. */
  failures: number;
}

export interface SessionUsageGroupSummary {
  sessions: number;
  requests: number;
  total: Count;
  cached: Count;
  activeDays: number;
}

export interface SessionUsageResult {
  scope: string;
  range: { start: string; end: string };
  timezone: string;
  /** Sorted newest activity first; the page size is decided by the caller. */
  sessions: SessionUsageRow[];
  /** Aggregate over all sessions in range, before any UI-side page limit. */
  summary: SessionUsageGroupSummary;
  /** Distribution buckets used by the chart, already sorted by usage desc. */
  distribution: { session: string; label: string; total: Count; requests: number }[];
  /** Per-day activity for the selected sessions, for the sparkline. */
  timeline: { date: string; total: Count; requests: number }[];
  /** Total session buckets before paging, so the UI can say "showing N of M". */
  totalSessions: number;
  truncated: boolean;
  updatedAt: string;
  dataVersion: string;
  /** Chinese note explaining any limitation that was actually observed. */
  notes: string[];
}

export const SESSION_UNKNOWN_LABEL = "未识别会话";
export const SESSION_LIMITS = { maxSessions: 200, defaultLimit: 30 } as const;

export function clampSessionLimit(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return SESSION_LIMITS.defaultLimit;
  return Math.max(1, Math.min(SESSION_LIMITS.maxSessions, Math.trunc(n)));
}

/** Lossless formatter for exact integer counts held as number|string|null. */
export function formatCount(value: Count): string {
  if (value == null) return "—";
  if (typeof value === "number")
    return Number.isFinite(value) ? value.toLocaleString("zh-CN") : "—";
  return /^\d+$/.test(value) ? BigInt(value).toLocaleString("zh-CN") : value;
}

/** Compact Chinese magnitude label; never rounds a value up into a wrong magnitude. */
export function compactCount(value: Count): string {
  if (value == null) return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e8) return (n / 1e8).toFixed(2) + " 亿";
  if (abs >= 1e4) return (n / 1e4).toFixed(2) + " 万";
  return n.toLocaleString("zh-CN");
}

export function formatRate(rate: number | null): string {
  return rate == null ? "—" : (rate * 100).toFixed(1) + "%";
}
