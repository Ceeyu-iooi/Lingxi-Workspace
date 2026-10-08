import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fetchJSON } from "./control.ts";
import { Dataset, FIELDS } from "./usage-summary.ts";
import { iso } from "./monitor.ts";
import type { JsonObject } from "./profile.ts";

export class CodexRPC {
  notify: (method: string, params: JsonObject) => void = () => {};
  process: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private buffer = "";
  private waiting = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  handleServerRequest: ((method: string, params: JsonObject) => Promise<JsonObject>) | null = null;
  constructor(home?: string, ephemeral = false) {
    if (!home) throw new Error("请先在当前 Profile 连接 Codex 账户");
    const req = createRequire(import.meta.url);
    const target = process.platform === "win32" ? `${process.arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc` : process.platform === "darwin" ? `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin` : `${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl`;
    const pkg = req.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`);
    const command = join(dirname(pkg), "vendor", target, "bin", process.platform === "win32" ? "codex.exe" : "codex");
    if (!existsSync(command)) throw new Error("Codex 账户查询运行依赖缺失，请恢复运行依赖");
    const args = ["-c", ephemeral ? 'cli_auth_credentials_store="ephemeral"' : 'cli_auth_credentials_store="file"', "app-server"];
    this.process = spawn(command, args, {
      env: {
        ...process.env,
        CODEX_HOME: home,
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stderr.resume();
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      if (this.buffer.length > 8 * 1024 * 1024) {
        this.close();
        return;
      }
      let split: number;
      while ((split = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, split);
        this.buffer = this.buffer.slice(split + 1);
        try {
          const message = JSON.parse(line),
            request = this.waiting.get(message.id);
          if (message.method && message.id != null) {
            const reply = (payload: JsonObject) => { if (!this.process.stdin.destroyed) this.process.stdin.write(JSON.stringify({id:message.id,...payload})+"\n"); };
            Promise.resolve(this.handleServerRequest?.(message.method,message.params || {})).then(result=>reply(result?{result}:{error:{code:-32601,message:"Unsupported account request"}})).catch(()=>reply({error:{code:-32000,message:"登录凭据未刷新，请在 Codex 中重新登录"}}));
            continue;
          }
          if (message.method && message.id == null) this.notify(message.method, message.params || {});
          if (!request) continue;
          clearTimeout(request.timer);
          this.waiting.delete(message.id);
          if (message.error)
            request.reject(
              new Error(
                message.error.code === -32601
                  ? "当前 Codex 版本不支持此接口，请更新官方 CLI"
                  : "Codex 暂未返回此项数据，请检查 ChatGPT 登录状态后重试",
              ),
            );
          else request.resolve(message.result || {});
        } catch {}
      }
    });
    this.process.stderr.on("data", () => {});
    const fail = () => {
      for (const item of this.waiting.values()) {
        clearTimeout(item.timer);
        item.reject(new Error("Codex 查询进程已退出"));
      }
      this.waiting.clear();
    };
    this.process.once("exit", fail);
    this.process.once("error", fail);
    this.process.stdin.on("error", fail);
  }
  call(method: string, params: JsonObject = {}) {
    const id = ++this.sequence;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error("Codex 查询超时，请稍后重试"));
      }, 12000);
      this.waiting.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  initialized() {
    this.process.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  }
  close() {
    for (const value of this.waiting.values()) {
      clearTimeout(value.timer);
      value.reject(new Error("Codex 查询进程已退出"));
    }
    this.waiting.clear();
    if (this.process.exitCode === null) this.process.kill();
  }
}
export function cachedChatGPTAuth(home: string) {
  try {
    const file=join(home,"auth.json");
    if(statSync(file).size>65536)throw new Error();
    const data=JSON.parse(readFileSync(file,"utf8")),tokens=data.tokens;
    if(typeof tokens?.access_token!=="string"||typeof tokens?.account_id!=="string"||!tokens.access_token||!tokens.account_id)throw new Error();
    return {accessToken:tokens.access_token,chatgptAccountId:tokens.account_id};
  } catch { throw new Error("未找到可复用的 Codex ChatGPT 登录，请在 Codex 中登录或使用连接Codex"); }
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
async function quotaHTTP(home?: string) {
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
        ["used_percent", "limit_window_seconds", "reset_at"].some(
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
        resetsAt: w.reset_at,
      };
    },
    bucket = {
      limitId: "codex",
      primary: window(limits.primary_window),
      secondary: window(limits.secondary_window),
    };
  if (!bucket.primary && !bucket.secondary)
    throw new Error("官方未返回有效额度窗口");
  return {
    planType: data.plan_type,
    quota: { rateLimitsByLimitId: { codex: bucket } },
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
export async function readCodexAccount(home?: string, options: {includeActivity?: boolean} = {}) {
  if(!home)throw new Error("请先选择 Profile");
  const sharedHome=process.env.CODEX_HOME || join(homedir(),".codex");
  const own=existsSync(join(home,"auth.json")),authHome=own?home:sharedHome;
  const cached=cachedChatGPTAuth(authHome);
  mkdirSync(home,{recursive:true});
  let rpc: CodexRPC | undefined,
    result: JsonObject = {
      unavailable: {},
      coverage: "官方账户活动与实时配额；本机日志单独查看",
    };
  try {
    rpc = new CodexRPC(home,!own);
    rpc.handleServerRequest=async(method,params)=>{
      if(method!=="account/chatgptAuthTokens/refresh")throw new Error("Unsupported account request");
      const refreshed=cachedChatGPTAuth(authHome);
      if(params.previousAccountId && params.previousAccountId!==refreshed.chatgptAccountId)throw new Error("Codex账户已切换");
      return refreshed;
    };
    await rpc.call("initialize", {
      clientInfo: { name: "workbench_usage", version: "0.0.34" },
      capabilities: { experimentalApi: true },
    });
    rpc.initialized();
    if(!own)await rpc.call("account/login/start",{type:"chatgptAuthTokens",...cached});
    result.credentialSource=own?"profile":"local-codex-cache";
    const account =
      (await rpc.call("account/read", { refreshToken: false })).account || {};
    if (account.type !== "chatgpt")
      throw new Error(
        "请在 Codex 中使用 ChatGPT 账户登录；API Key 登录无法查询 Plus 用量",
      );
    result.planType = account.planType;
    for (const [method, field] of [
      ["account/rateLimits/read", "quota"],
      ...(options.includeActivity === false ? [] : [["account/usage/read", "tokenActivity"]]),
    ])
      try {
        result[field] = await rpc.call(method);
      } catch (error: any) {
        result.unavailable[field] = error.message;
      }
  } catch (error: any) {
    result.unavailable.quota = error.message;
    result.unavailable.tokenActivity = error.message;
  } finally {
    rpc?.close();
  }
  if (options.includeActivity !== false && !result.tokenActivity)
    try {
      result.tokenActivity = await activityHTTP(authHome);
      result.activitySource = "codex-backend-readonly";
      delete result.unavailable.tokenActivity;
    } catch (error: any) {
      result.unavailable.tokenActivity = error.message;
    }
  if (!result.quota)
    try {
      const fallback = await quotaHTTP(authHome);
      for (const key of ["planType", "quota", "quotaSource"])
        result[key] = (fallback as JsonObject)[key];
      delete result.unavailable.quota;
    } catch (error: any) {
      result.unavailable.quota = error.message;
    }
  if (!result.tokenActivity && !result.quota)
    throw new Error("官方账户活动与额度暂不可用，请检查 Codex 登录状态和网络");
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
