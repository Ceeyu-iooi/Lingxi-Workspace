import { Control, fetchJSON } from "./control.ts";
import { hash, type JsonObject } from "./profile.ts";
import { platformInteger, timestamp, amount } from "./provider-data.ts";
import { shanghaiDay, addDays } from "./usage-summary.ts";

const ORIGIN = "https://api.lmuai.ai/api/v1/";
export class LMU {
  constructor(readonly control: Control) {}
  private async fetch(path: string, token = "", body?: JsonObject) {
    const data = await fetchJSON(
      ORIGIN + path,
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "LingxiWorkbench",
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
      },
      2 * 1024 * 1024,
      25000,
    );
    if (
      data.code !== 0 ||
      !data.data ||
      typeof data.data !== "object" ||
      Array.isArray(data.data)
    )
      throw new Error("LMU 查询失败，请核对登录或查询权限");
    return data.data as JsonObject;
  }
  load() {
    const value = this.control.profile.credentials()["lmu:platform"];
    try {
      return value ? JSON.parse(value) : {};
    } catch {
      return {};
    }
  }
  private store(value: JsonObject) {
    const keys = this.control.profile.credentials();
    keys["lmu:platform"] = JSON.stringify(value);
    this.control.profile.saveCredentials(keys);
  }
  private tokens(data: JsonObject, previous: JsonObject = {}) {
    const token = data.access_token,
      refresh = data.refresh_token || previous.refresh_token || "";
    if (
      typeof token !== "string" ||
      !token ||
      token.length > 8192 ||
      /\s/.test(token)
    )
      throw new Error("LMU 未返回有效登录授权");
    if (
      typeof refresh !== "string" ||
      refresh.length > 8192 ||
      /\s/.test(refresh)
    )
      throw new Error("LMU 续期凭据格式不正确");
    return {
      access_token: token,
      refresh_token: refresh,
      expires_at:
        Date.now() / 1000 +
        Math.min(
          86400,
          Math.max(60, platformInteger(data.expires_in) || 86400),
        ),
    };
  }
  async api(path: string) {
    let credentials = this.load(),
      refreshed = false;
    if (!credentials.access_token)
      throw new Error("请先授权 LMU 平台；APIKey 不能查询历史用量");
    if (
      credentials.expires_at <= Date.now() / 1000 + 60 &&
      credentials.refresh_token
    ) {
      credentials = this.tokens(
        await this.fetch("auth/refresh", "", {
          refresh_token: credentials.refresh_token,
        }),
        credentials,
      );
      this.store(credentials);
      refreshed = true;
    }
    try {
      return await this.fetch(path, credentials.access_token);
    } catch (error: any) {
      if (
        !/凭据无效|401/.test(error.message) ||
        refreshed ||
        !credentials.refresh_token
      )
        throw error;
      credentials = this.tokens(
        await this.fetch("auth/refresh", "", {
          refresh_token: credentials.refresh_token,
        }),
        credentials,
      );
      this.store(credentials);
      return this.fetch(path, credentials.access_token);
    }
  }
  async keyId(key: string, token?: string) {
    const matches: any[] = [];
    let count = 0,
      complete = false;
    for (let page = 1; page <= 100; page++) {
      const path =
          "keys?" +
          new URLSearchParams({ page: String(page), page_size: "200" }),
        data = token ? await this.fetch(path, token) : await this.api(path),
        items = data.items;
      if (!Array.isArray(items)) throw new Error("LMU 未返回 Key 列表");
      count += items.length;
      matches.push(...items.filter((r) => r?.key === key).map((r) => r.id));
      const pages = platformInteger(data.pages),
        total = platformInteger(data.total);
      if (
        (pages !== null && page >= Math.max(1, pages)) ||
        (pages === null && total !== null && count >= total) ||
        (pages === null && total === null && items.length < 200)
      ) {
        complete = true;
        break;
      }
    }
    if (!complete) throw new Error("LMU Key 列表分页未完成");
    if (matches.length !== 1 || !platformInteger(matches[0]))
      throw new Error("LMU 登录账户中未找到唯一对应的 APIKey");
    return matches[0] as number;
  }
  async authorize(body: JsonObject, connections: JsonObject[]) {
    let data: JsonObject;
    const owner = this.control.profile.owner;
    if (body.totpCode) {
      const pending = this.control.profile.credentials()["lmu:pending"];
      if (!pending) throw new Error("请重新登录 LMU");
      data = await this.fetch("auth/login/2fa", "", {
        temp_token: pending,
        totp_code: String(body.totpCode),
      });
    } else if (body.accessToken)
      data = {
        access_token: String(body.accessToken).trim(),
        refresh_token: String(body.refreshToken || "").trim(),
        expires_in: 86400,
      };
    else {
      const email = String(body.email || "").trim(),
        password = body.password;
      if (
        !email ||
        email.length > 254 ||
        typeof password !== "string" ||
        !password ||
        password.length > 4096
      )
        throw new Error("请填写 LMU 邮箱和密码");
      data = await this.fetch("auth/login", "", { email, password });
      if (data.requires_2fa === true) {
        if (
          typeof data.temp_token !== "string" ||
          !data.temp_token ||
          data.temp_token.length > 8192
        )
          throw new Error("LMU 二次验证响应不正确");
        const keys = this.control.profile.credentials();
        keys["lmu:pending"] = data.temp_token;
        this.control.profile.saveCredentials(keys);
        return { requires2FA: true };
      }
    }
    const credentials = this.tokens(data),
      user = await this.fetch("auth/me", credentials.access_token);
    if (!platformInteger(user.id)) throw new Error("LMU 未返回账户标识");
    const keys = this.control.profile.credentials();
    for (const row of connections)
      await this.keyId(keys["usage:" + row.id] || "", credentials.access_token);
    if (owner !== this.control.profile.owner) throw new Error("Profile 已切换");
    this.store(credentials);
    const current = this.control.profile.credentials();
    delete current["lmu:pending"];
    this.control.profile.saveCredentials(current);
    return { ok: true };
  }
  async history(
    connection: JsonObject,
    key: string,
    start = addDays(shanghaiDay(new Date()), -365),
  ) {
    const keyId = await this.keyId(key),
      end = shanghaiDay(new Date()),
      items: JsonObject[] = [];
    let complete = false;
    for (let page = 1; page <= 500; page++) {
      const data = await this.api(
          "usage?" +
            new URLSearchParams({
              page: String(page),
              page_size: "200",
              start_date: start,
              end_date: end,
              timezone: "Asia/Shanghai",
              api_key_id: String(keyId),
              sort_by: "created_at",
              sort_order: "asc",
            }),
        ),
        batch = data.items,
        pages = platformInteger(data.pages),
        total = platformInteger(data.total);
      if (
        !Array.isArray(batch) ||
        pages === null ||
        total === null ||
        pages > 500
      )
        throw new Error("LMU 用量分页不完整或超过查询上限");
      items.push(...batch);
      if (page >= Math.max(1, pages)) {
        if (items.length !== total)
          throw new Error("LMU 分页总量不一致，请重试");
        complete = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!complete) throw new Error("LMU 用量分页未完成");
    const rows: JsonObject[] = [],
      seen = new Set<string>();
    for (const item of items) {
      if (item.api_key_id !== keyId)
        throw new Error("LMU 返回了其他 Key 的用量，已停止导入");
      const at = timestamp(item.created_at),
        model = item.model,
        ident = item.id || item.request_id,
        values = [
          "input_tokens",
          "output_tokens",
          "cache_read_tokens",
          "cache_creation_tokens",
        ].map((k) => platformInteger(item[k]));
      if (
        !at ||
        typeof model !== "string" ||
        !model ||
        model.length > 180 ||
        ident == null ||
        values.some((v) => v === null)
      )
        throw new Error("LMU 用量字段不完整，已停止导入");
      const id = connection.id + ":lmu:" + String(ident).slice(0, 180);
      if (seen.has(id)) throw new Error("LMU 分页返回重复记录，已停止导入");
      seen.add(id);
      const [uncached, output, cached, created] = values as number[],
        input = uncached + cached + created,
        total = platformInteger(input + output);
      if (total === null) throw new Error("LMU Token 数值超出范围");
      rows.push({
        id,
        at,
        source: "official-api",
        agent: "",
        provider: "LMU",
        model,
        project: "",
        session: "",
        connection_id: connection.id,
        requested_model: "",
        auth_mode: "api_key",
        status: "ok",
        input,
        output,
        cached,
        reasoning: null,
        total,
        cost: amount(item.actual_cost)?.toNumber() ?? null,
        currency: "USD",
        duration_ms: platformInteger(item.duration_ms),
        platform_requests: 1,
      });
    }
    const user = await this.api("auth/me"),
      accountId = platformInteger(user.id);
    return {
      historyRows: rows,
      historyAvailable: true,
      historyDays: 366,
      financeVersion: 1,
      accountFinance: {
        currency: "USD",
        balance: amount(user.balance)?.toNumber() ?? null,
        spent: null,
        accountRef: accountId ? hash("LMU:" + accountId) : null,
      },
      coverage: "LMU 官方历史 · 所选 Key",
      unavailable: rows.some((r) => r.cost === null)
        ? { cost: "部分费用未返回" }
        : {},
    };
  }
}
