import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Decimal } from "decimal.js";
import { fetchJSON } from "./control.ts";
import { hash, type JsonObject } from "./profile.ts";

export const PRESETS: Record<string, JsonObject> = {
  openrouter: {
    name: "OpenRouter",
    url: "https://openrouter.ai/api/v1",
    hosts: ["openrouter.ai"],
    currency: "USD",
  },
  newapi: { name: "New API", url: "", currency: "USD" },
  sub2api: { name: "Sub2API", url: "", currency: "USD" },
  custom_balance: { name: "自定义余额", url: "", currency: null },
  siliconflow: {
    name: "硅基流动",
    url: "https://api.siliconflow.cn/v1",
    hosts: ["api.siliconflow.cn"],
    currency: "CNY",
  },
  moonshot: {
    name: "Moonshot",
    url: "https://api.moonshot.cn/v1",
    hosts: ["api.moonshot.cn"],
    currency: "CNY",
  },
  minimax: {
    name: "MiniMax",
    url: "https://api.minimaxi.com/v1",
    hosts: ["api.minimaxi.com", "api.minimax.io", "www.minimax.cn"],
    currency: "CNY",
  },
};
export const RELAY_KINDS = [
  "deepseek",
  "glm",
  "openrouter",
  "newapi",
  "sub2api",
  "siliconflow",
  "moonshot",
  "minimax",
];
function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0 && [0, 2].includes(c)) ||
      (a === 198 && [18, 19, 51].includes(b)) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  const v = address.toLowerCase();
  if (v.startsWith("::ffff:")) return publicAddress(v.slice(7));
  return (
    !["::", "::1"].includes(v) && !/^f[cd]|^fe[89ab]|^ff|^2001:db8/.test(v)
  );
}
export function validateURL(value: string, kind?: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("历史用量接口需为公开 HTTPS 地址");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (
    parsed.protocol !== "https:" ||
    !hostname ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    (parsed.port && !["443"].includes(parsed.port)) ||
    ["localhost", "localhost.localdomain"].includes(hostname.toLowerCase()) ||
    /\.(local|localhost)$/.test(hostname) ||
    (isIP(hostname) && !publicAddress(hostname))
  )
    throw new Error("历史用量接口需为公开 HTTPS 地址，不包含登录凭据或重定向");
  if (/(api_?key|token|secret)=/i.test(parsed.search))
    throw new Error("密钥请填写在密钥栏，不放在 URL 中");
  if (kind && PRESETS[kind]) {
    if (parsed.search) throw new Error("供应商地址不能含查询参数");
    if (
      PRESETS[kind].hosts &&
      (!PRESETS[kind].hosts.includes(hostname) ||
        !["/", "/v1", "/api/v1"].includes(parsed.pathname))
    )
      throw new Error("请使用供应商已配置区域的官方 API 地址");
  }
  return parsed;
}
export async function providerJSON(
  url: string,
  headers: Record<string, string> = {},
  unwrap = false,
) {
  const parsed = validateURL(url),
    addresses = await lookup(parsed.hostname.replace(/^\[|\]$/g, ""), {
      all: true,
    });
  if (addresses.some((r) => !publicAddress(r.address)))
    throw new Error("供应商地址指向内部网络");
  const body = await fetchJSON(
    url,
    { headers: { Accept: "application/json", ...headers } },
    2 * 1024 * 1024,
    15000,
  );
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    body.success === false ||
    body.status === false ||
    body.error
  )
    throw new Error("供应商未返回有效数据");
  return unwrap ? (body.data ?? body) : body;
}
export async function platformJSON(
  url: string,
  authorization: string,
  unwrap = true,
) {
  const parsed = validateURL(url),
    headers: Record<string, string> = {
      Authorization: authorization,
      "Accept-Language": "en-US,en",
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "LingxiWorkbench",
    };
  if (parsed.hostname === "platform.deepseek.com")
    Object.assign(headers, {
      Referer: "https://platform.deepseek.com/usage",
      "x-client-platform": "web",
      "x-client-version": "1.0.0",
      "x-client-locale": "zh_CN",
      "x-client-timezone-offset": "28800",
    });
  const result = await providerJSON(url, headers);
  if (
    String(result.msg || "")
      .toLowerCase()
      .includes("coding plan")
  )
    throw new Error(
      "该密钥所属用户没有 GLM Coding Plan；普通 API 请使用供应商历史用量接口",
    );
  if (
    result.success === false ||
    !["0", "200"].includes(String(result.code ?? 200))
  )
    throw new Error("平台未提供此项用量，请确认 API Key 所属套餐及查询权限");
  return unwrap ? (result.data ?? result) : result;
}
const finite = (v: any) => {
  if (v == null || typeof v === "boolean") return null;
  try {
    const n = new Decimal(String(v));
    return n.isFinite() ? n.toString() : null;
  } catch {
    return null;
  }
};
export async function readPreset(row: JsonObject, key: string, platform = "") {
  const kind = row.kind,
    base = row.apiUrl.replace(/\/+$/, ""),
    parsed = validateURL(base, kind),
    currencyDefault = PRESETS[kind].currency,
    headers = { Authorization: "Bearer " + key },
    unwrap = (d: JsonObject) => d.data ?? d;
  const result: JsonObject = {
    coverage: "余额／额度与 Token 独立；没有历史接口的记录保持未知。",
    unavailable: { tokens: "普通 Key 未提供历史 Token 查询" },
    adapter: kind,
    granularity: "account-snapshot",
    verifiedLive: true,
  };
  let balance: string | null = null,
    spent: string | null = null,
    ref: string | null = null,
    currency = currencyDefault;
  const get = (path: string, auth?: Record<string, string>) =>
    providerJSON(base + path, auth || headers);
  if (kind === "openrouter") {
    const d = unwrap(await get("/key")),
      keySpend = finite(d.usage);
    result.keyFinance = Object.fromEntries(
      ["usage", "usage_daily", "usage_weekly", "usage_monthly", "limit"].map(
        (k) => [k, finite(d[k])],
      ),
    );
    result.quota = {
      metric: "money",
      limit: finite(d.limit),
      used: keySpend,
      currency: "USD",
    };
    try {
      const c = unwrap(await get("/credits")),
        credits = finite(c.total_credits),
        used = finite(c.total_usage);
      if (credits !== null && used !== null) {
        balance = new Decimal(credits).minus(used).toString();
        spent = used;
      }
    } catch {
      result.unavailable.balance = "余额查询需具有 credits 权限的凭据";
    }
  } else if (kind === "siliconflow") {
    const body = await get("/user/info");
    if (![0, 20000].includes(body.code))
      throw new Error("硅基流动未返回有效用户信息");
    const d = unwrap(body);
    balance = finite(d.totalBalance);
    if (d.id != null) ref = String(d.id);
  } else if (kind === "moonshot") {
    const body = await get("/users/me/balance");
    if (body.code !== 0) throw new Error("Moonshot 未返回有效余额");
    balance = finite(unwrap(body).available_balance);
  } else if (kind === "newapi") {
    const origin = base.endsWith("/v1") ? base.slice(0, -3) : base,
      status = unwrap(await providerJSON(origin + "/api/status")),
      unit = finite(status.quota_per_unit);
    if (unit === null || new Decimal(unit).lte(0))
      throw new Error("New API 未返回可核验的金额配额单位");
    const mode = row.credentialMode || "key",
      auth: Record<string, string> = {
        Authorization: "Bearer " + (platform || key),
      };
    if (row.userId) auth["New-Api-User"] = row.userId;
    const d = unwrap(
        await providerJSON(
          origin +
            (mode === "account" ? "/api/user/self" : "/api/usage/token/"),
          auth,
        ),
      ),
      used = finite(d[mode === "account" ? "used_quota" : "total_used"]),
      available = finite(d[mode === "account" ? "quota" : "total_available"]);
    if (available === null) throw new Error("New API 未返回金额配额");
    balance = new Decimal(available).div(unit).toString();
    spent = used !== null ? new Decimal(used).div(unit).toString() : null;
    currency = status.quota_currency || row.quotaCurrency || "USD";
    if (!["USD", "CNY"].includes(currency)) {
      currency = null;
      balance = spent = null;
    }
    result.quota = {
      metric: "money",
      rawUnit: unit,
      currency,
      unlimited: d.unlimited_quota === true,
    };
    if (
      d.unlimited_quota === true ||
      (mode === "account" && available === "-1")
    ) {
      balance = null;
      result.quota.unlimited = true;
    }
    if (mode === "account" && d.id != null) ref = String(d.id);
  } else if (kind === "sub2api") {
    const origin = base.endsWith("/v1") ? base.slice(0, -3) : base,
      auth = { Authorization: "Bearer " + (platform || key) },
      me = await providerJSON(origin + "/api/v1/auth/me", auth);
    if (me.code !== 0) throw new Error("Sub2API 需要有效账户访问凭据");
    const d = unwrap(me);
    balance = finite(d.balance);
    if (d.id != null) ref = String(d.id);
    try {
      const body = await providerJSON(
        origin + "/api/v1/usage/stats?period=month&timezone=Asia%2FShanghai",
        auth,
      );
      if (body.code !== 0) throw new Error();
      const d = unwrap(body);
      result.usageSummary = {
        period: "month",
        granularity: "month",
        tokens: d.total_tokens,
        input: d.total_input_tokens,
        output: d.total_output_tokens,
        requests: d.total_requests,
        actualCost: finite(d.total_actual_cost),
      };
    } catch {
      result.unavailable.usageSummary = "账户月汇总暂不可用";
    }
    try {
      spent = finite(
        unwrap(
          await providerJSON(origin + "/api/v1/usage/dashboard/stats", auth),
        ).total_actual_cost,
      );
    } catch {}
  } else if (kind === "custom_balance") {
    const config = row.balanceMapping || {},
      path = config.endpoint || "/user/balance";
    if (
      typeof path !== "string" ||
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("\\") ||
      path.split("/").some((s: string) => [".", ".."].includes(s)) ||
      /[?#]/.test(path)
    )
      throw new Error("余额端点路径不正确");
    const d = await get(
        path,
        config.authMode === "x-api-key" ? { "x-api-key": key } : headers,
      ),
      mapped = (name: string) => {
        let value: any = d;
        for (const part of String(
          config[name] || (name === "remainingPath" ? "data.balance" : ""),
        ).split(".")) {
          if (
            !part ||
            !value ||
            typeof value !== "object" ||
            ["__proto__", "constructor", "prototype"].includes(part)
          )
            return null;
          value = value[part];
        }
        return finite(value);
      },
      divisor = finite(config.divisor ?? 1);
    currency = config.currency;
    if (
      divisor === null ||
      new Decimal(divisor).lte(0) ||
      !["USD", "CNY"].includes(currency)
    )
      throw new Error("请在余额映射中明确币种与计量单位");
    balance = mapped("remainingPath");
    spent = mapped("usedPath");
    if (balance !== null)
      balance = new Decimal(balance).div(divisor).toString();
    if (spent !== null) spent = new Decimal(spent).div(divisor).toString();
  } else if (kind === "minimax") {
    if (row.credentialMode !== "subscription")
      result.coverage =
        "MiniMax 普通推理 Key：仅采集真实响应；订阅额度需要独立订阅 Key";
    else {
      const body = await providerJSON(
          parsed.origin + "/v1/token_plan/remains",
          headers,
        ),
        d = unwrap(body),
        resp = body.base_resp || d.base_resp || {};
      if ((resp.status_code ?? 0) !== 0)
        throw new Error("MiniMax 订阅凭据无效或权限不足");
      if (!Array.isArray(d.model_remains))
        throw new Error("MiniMax 未返回可识别额度窗口");
      result.platformQuota = {
        windows: d.model_remains.map((w: JsonObject) =>
          Object.fromEntries(
            [
              "model_name",
              "current_interval_total_count",
              "current_interval_usage_count",
              "start_time",
              "end_time",
              "remains_time",
            ].map((k) => [k, w[k] ?? null]),
          ),
        ),
      };
      result.coverage = "MiniMax 订阅额度快照；次数、积分与 Token 分开";
    }
  }
  if (ref !== null) ref = hash(kind + ":" + parsed.host + ":" + ref);
  result.accountFinance = {
    currency,
    balance: balance === null ? null : new Decimal(balance).toNumber(),
    spent: spent === null ? null : new Decimal(spent).toNumber(),
    balanceExact: balance,
    spentExact: spent,
    accountRef: ref,
    scope:
      kind === "newapi" && (row.credentialMode || "key") === "key"
        ? "key"
        : "account",
  };
  return result;
}
