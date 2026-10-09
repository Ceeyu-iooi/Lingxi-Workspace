import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fetchJSON } from "./control.ts";
import { iso } from "./monitor.ts";
import { Dataset, FIELDS } from "./usage-summary.ts";
import type { JsonObject } from "./profile.ts";

export function cachedChatGPTAuth(home: string) {
  try {
    const file=join(home,"auth.json");
    if(statSync(file).size>65536)throw new Error();
    const data=JSON.parse(readFileSync(file,"utf8")),tokens=data.tokens;
    if(typeof tokens?.access_token!=="string"||typeof tokens?.account_id!=="string"||!tokens.access_token||!tokens.account_id)throw new Error();
    return {accessToken:tokens.access_token,chatgptAccountId:tokens.account_id};
  } catch { throw new Error("未找到可复用的 Codex ChatGPT 登录，请在 Codex 中登录后重新授权读取"); }
}
function auth(home?: string) {
  if(!home)throw new Error("请连接 Codex 账户");
  const tokens=cachedChatGPTAuth(home);
  return {Authorization:"Bearer "+tokens.accessToken,"ChatGPT-Account-Id":tokens.chatgptAccountId,"User-Agent":"workbench-usage/1.0"};
}
const count = (v: any) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
export function normalizeActivity(value: any) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value.summary && typeof value.summary !== "object")
  )
    throw new Error("官方账户活动结构不正确");
  const summary = value.summary || {},
    result: JsonObject = {
      summary: Object.fromEntries(
        [
          "lifetimeTokens",
          "peakDailyTokens",
          "longestRunningTurnSec",
          "currentStreakDays",
          "longestStreakDays",
        ].map((k) => [k, count(summary[k])]),
      ),
      dailyUsageBuckets: null,
    };
  if (value.dailyUsageBuckets != null) {
    if (
      !Array.isArray(value.dailyUsageBuckets) ||
      value.dailyUsageBuckets.length > 10000
    )
      throw new Error("官方日期桶结构不正确");
    const seen = new Set<string>();
    result.dailyUsageBuckets = value.dailyUsageBuckets
      .map((row: JsonObject) => {
        const day = row.startDate,
          tokens = count(row.tokens);
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
          Number.isNaN(Date.parse(day)) ||
          new Date(day).toISOString().slice(0, 10) !== day ||
          tokens === null ||
          seen.has(day)
        )
          throw new Error("官方日期桶重复或数量无效");
        seen.add(day);
        return { startDate: day, tokens };
      })
      .sort((a: JsonObject, b: JsonObject) =>
        a.startDate.localeCompare(b.startDate),
      );
  }
  return result;
}
export async function quotaHTTP(home?: string) {
  const data = await fetchJSON(
      "https://chatgpt.com/backend-api/wham/usage",
      { headers: auth(home) },
      1024 * 1024,
      15000,
    ),
    limits = data.rate_limit || {},
    window = (w: JsonObject) => {
      if (
        !w ||
        ["used_percent", "limit_window_seconds"].some(
          (k) => typeof w[k] !== "number" || !Number.isFinite(w[k]),
        ) ||
        w.used_percent < 0 ||
        w.used_percent > 100 ||
        w.limit_window_seconds <= 0
      )
        return null;
      return {
        usedPercent: w.used_percent,
        windowDurationMins: w.limit_window_seconds / 60,
        resetsAt: Number.isFinite(w.reset_at)?w.reset_at:null,
      };
    },
    bucket = {
      limitId: "codex",
      credits:data.credits?{balance:data.credits.balance??null,unlimited:data.credits.unlimited===true,hasCredits:data.credits.has_credits===true}:null,
      primary: window(limits.primary_window),
      secondary: window(limits.secondary_window),
    };
  if (!bucket.primary && !bucket.secondary)
    throw new Error("官方未返回有效额度窗口");
  return {
    planType: data.plan_type,
    quota: { rateLimitsByLimitId: { codex: bucket }, credits: bucket.credits, rateLimitResetCredits: normalizeResetCredits(data.rate_limit_reset_credits ?? data.rateLimitResetCredits) },
    quotaSource: "codex-backend-readonly",
    coverage: "官方实时配额；Token 与按模型明细见下方本机采集",
    unavailable: {
      tokenActivity:
        "官方账户 Token 汇总暂不可用；下方本机统计正常，不影响实时额度",
    },
  };
}
async function activityHTTP(home?: string) {
  const data = await fetchJSON(
      "https://chatgpt.com/backend-api/wham/profiles/me",
      { headers: { ...auth(home), Accept: "application/json" } },
      2 * 1024 * 1024,
      10000,
    ),
    stats = data.stats;
  if (!stats || typeof stats !== "object")
    throw new Error("官方账户活动暂不可用或结构不受支持，不使用本机日志替代");
  const mapping: JsonObject = {
    lifetimeTokens: "lifetime_tokens",
    peakDailyTokens: "peak_daily_tokens",
    longestRunningTurnSec: "longest_running_turn_sec",
    currentStreakDays: "current_streak_days",
    longestStreakDays: "longest_streak_days",
  };
  return normalizeActivity({
    summary: Object.fromEntries(
      Object.entries(mapping).map(([key, field]) => [
        key,
        stats[field as string],
      ]),
    ),
    dailyUsageBuckets:
      stats.daily_usage_buckets == null
        ? null
        : stats.daily_usage_buckets.map((r: JsonObject) => ({
            startDate: r.start_date,
            tokens: r.tokens,
          })),
  });
}
export function normalizeResetCredits(value: any) {
  if (!value || typeof value !== 'object') return null;
  const count=value.available_count ?? value.availableCount;
  const time=(value:any)=>typeof value==="number"&&Number.isFinite(value)?(value>1e12?value/1000:value):typeof value==="string"&&Number.isFinite(Date.parse(value))?Date.parse(value)/1000:null;
  return {availableCount:Number.isSafeInteger(count)&&count>=0&&count<=1000?count:null,credits:Array.isArray(value.credits)?value.credits.map((card:any)=>({id:typeof card.id==='string'?card.id:'',grantedAt:time(card.granted_at ?? card.grantedAt),expiresAt:time(card.expires_at ?? card.expiresAt)})):null};
}
export async function readCodexAccount(home?: string, options: {includeActivity?: boolean; allowLocal?: boolean} = {}) {
  if(!home)throw new Error('请先选择 Profile');
  const own=existsSync(join(home,'auth.json'));
  if(!own && !options.allowLocal)throw new Error('请先授权读取本机 Codex 登录凭据');
  const authHome=own?home:process.env.CODEX_HOME || join(homedir(),'.codex');
  const result:JsonObject=await quotaHTTP(authHome);
  result.credentialSource=own?'profile':'local-codex-cache';
  if(options.includeActivity!==false)try{result.tokenActivity=await activityHTTP(authHome);delete result.unavailable.tokenActivity;}catch{result.unavailable.tokenActivity='官方账户活动暂不可用，本机统计不受影响';}
  return result;
}
export function activitySnapshot(
  value: any,
  params: JsonObject = {},
  error = "",
  observed = "",
) {
  value = value
    ? normalizeActivity(value)
    : { summary: {}, dailyUsageBuckets: null };
  const rows = (value.dailyUsageBuckets || []).map((r: JsonObject) => ({
      id: "account-day:" + r.startDate,
      at: r.startDate + "T00:00:00Z",
      local_date: r.startDate,
      source: "official",
      agent: "Codex",
      provider: "",
      model: "",
      project: "",
      connection_id: "",
      granularity: "day",
      total: r.tokens,
      input: null,
      output: null,
      cached: null,
      reasoning: null,
      cost: null,
      status: "aggregate",
    })),
    allowed = Object.fromEntries(
      Object.entries(params).filter(([k]) =>
        ["period", "start_date", "end_date", "include_all"].includes(k),
      ),
    ),
    result = new Dataset(rows, "CNY").snapshot(
      { ...allowed, scope: "codex" },
      Number(params.days) || 30,
    ) as JsonObject,
    buckets = new Map<string, number>(
      (value.dailyUsageBuckets || []).map((r: JsonObject) => [
        r.startDate,
        r.tokens,
      ]),
    );
  for (const item of [
    result.summary,
    result.lifetime,
    ...result.daily,
    ...result.activity,
  ]) {
    for (const field of FIELDS) if (field !== "total") item[field] = null;
    Object.assign(item, {
      requests: null,
      requestCount: null,
      platformRequests: null,
    });
    if ("date" in item) {
      item.total = buckets.get(item.date) ?? null;
      item.provided = buckets.has(item.date);
      item.unknown = Number(!item.provided);
      item.cumulativeTotal = null;
      item.cumulativeUnknown = 1;
    }
  }
  if (value.dailyUsageBuckets === null) result.summary.total = null;
  const s = value.summary;
  Object.assign(result.lifetime, {
    total: s.lifetimeTokens ?? null,
    peak: s.peakDailyTokens ?? null,
    currentStreak: s.currentStreakDays ?? null,
    longestStreak: s.longestStreakDays ?? null,
    longestRunningTurnSec: s.longestRunningTurnSec ?? null,
  });
  const available = Object.values(s).some((v) => v !== null) || !!buckets.size,
    message = available
      ? "官方账户活动；按接口原始日期桶展示，无模型、工作区和请求明细；未返回的日期不补零"
      : error ||
        "官方账户活动尚未返回，请同步 Codex 账户；可切换本机日志查看独立统计";
  return {
    ...result,
    origin: "official-codex-account",
    available,
    aggregated: true,
    platformRequests: null,
    groups: [],
    events: [],
    timezone: "official-date-buckets",
    pricing: { enabled: false },
    dataVersion: observed || "official-unavailable",
    options: {
      source: ["official", "codex"],
      provider: [],
      project: [],
      model: [],
    },
    accounting: { incomplete: !available, message },
    dataSource: {
      kind: "official-account",
      label: "官方账户汇总",
      method: "account/usage/read",
      message,
    },
    updatedAt: observed || iso(),
  };
}
