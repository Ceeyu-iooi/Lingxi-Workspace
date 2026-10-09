import { join } from "node:path";
import { Decimal } from "decimal.js";
import { realpathSync, existsSync } from "node:fs";
import { Monitor, canonical, iso } from "./monitor.ts";
import { Control } from "./control.ts";
import { hash, uid, encode, parseExact, type JsonObject } from "./profile.ts";
import {
  PRESETS,
  RELAY_KINDS,
  validateURL,
  providerJSON,
  platformJSON,
  readPreset,
} from "./provider-network.ts";
import {
  normalizeGLM,
  normalizeCalls,
  normalizeHistory,
  deepseekCosts,
  glmBills,
  amount,
} from "./provider-data.ts";
import { readCodexAccount, activitySnapshot } from "./codex-account.ts";
import { LMU } from "./lmu.ts";
import { shanghaiDay, addDays, dateRange } from "./usage-summary.ts";

const validId = (value: any) => {
  const id = String(value || "");
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("资源标识格式不正确");
  return id;
};
export class UsageAccounts {
  private busy = new Set<string>();
  readonly lmu: LMU;
  constructor(
    readonly monitor: Monitor,
    readonly control: Control,
  ) {
    this.lmu = new LMU(control);
    monitor.profile.db.exec(
      "CREATE TABLE IF NOT EXISTS usage_connections(owner TEXT,id TEXT,value TEXT,PRIMARY KEY(owner,id));CREATE TABLE IF NOT EXISTS usage_bindings(resource TEXT PRIMARY KEY,owner TEXT NOT NULL);CREATE TABLE IF NOT EXISTS provider_buckets(owner TEXT,connection_id TEXT,id TEXT,record TEXT,PRIMARY KEY(owner,connection_id,id));CREATE TABLE IF NOT EXISTS provider_call_buckets(owner TEXT,connection_id TEXT,at TEXT,count INTEGER,PRIMARY KEY(owner,connection_id,at));CREATE TABLE IF NOT EXISTS provider_versions(owner TEXT PRIMARY KEY,version INTEGER)",
    );
    for (const table of [
      "usage_connections",
      "provider_buckets",
      "provider_call_buckets",
    ])
      for (const op of ["INSERT", "UPDATE", "DELETE"]) {
        const prefix = op === "DELETE" ? "OLD" : "NEW";
        monitor.profile.db.exec(
          `CREATE TRIGGER IF NOT EXISTS ${table}_${op.toLowerCase()}_version AFTER ${op} ON ${table} BEGIN INSERT INTO provider_versions VALUES(${prefix}.owner,1) ON CONFLICT(owner) DO UPDATE SET version=version+1; END`,
        );
      }
  }
  rows() {
    const p = this.monitor.profile;
    return (
      p.db
        .prepare("SELECT value FROM usage_connections WHERE owner=?")
        .all(p.owner) as JsonObject[]
    ).map((r) => parseExact(r.value));
  }
  write(row: JsonObject) {
    const p = this.monitor.profile;
    p.db
      .prepare("INSERT OR REPLACE INTO usage_connections VALUES(?,?,?)")
      .run(p.owner, row.id, encode(row));
  }
  list() {
    const keys = this.control.profile.credentials();
    return {
      connections: this.rows().map((row) => ({
        ...row,
        configured:
          row.kind === "codex" ||
          !!keys["usage:" + row.id] ||
          !!(keys["platform:" + row.id] && row.keyTrackingId),
        apiConfigured: !!keys["usage:" + row.id],
        platformConfigured:
          row.kind === "lmu"
            ? !!keys["lmu:platform"]
            : !!keys["platform:" + row.id],
        relayConfigured: !!keys["relay:" + row.id],
        stale:
          !!row.lastSuccessAt &&
          Date.now() / 1000 - (row.lastSuccessEpoch || 0) > 600,
      })),
    };
  }
  supplierId(row: JsonObject) {
    return row.kind !== "custom"
      ? row.kind
      : "custom:" + String(row.supplierName || new URL(row.apiUrl).hostname);
  }
  claim(source: string, root?: string) {
    const p = this.monitor.profile,
      resources =
        source === "codex"
          ? [
              "codex-account",
              "codex-logs:" +
                String(
                  root || this.control.public().defaultCodexPath,
                ).toLowerCase(),
            ]
          : [source + "-logs" + (root ? ":" + root.toLowerCase() : "")];
    p.transaction(() => {
      for (const resource of resources) {
        const row = p.db
          .prepare("SELECT owner FROM usage_bindings WHERE resource=?")
          .get(resource) as JsonObject | undefined;
        if (row && row.owner !== p.owner)
          throw new Error("本机来源已绑定其他 Profile");
        p.db
          .prepare("INSERT OR IGNORE INTO usage_bindings VALUES(?,?)")
          .run(resource, p.owner);
      }
    });
  }
  bound() {
    const p = this.monitor.profile,
      row = p.db
        .prepare(
          "SELECT owner FROM usage_bindings WHERE resource='codex-account'",
        )
        .get() as JsonObject | undefined;
    return row?.owner === p.owner;
  }
  private async matchDeepseek(key: string, platform = "") {
    const secrets = this.control.profile.credentials(),
      candidates = [
        ...new Set([
          ...(platform ? [platform] : []),
          ...this.rows()
            .filter((r) => r.kind === "deepseek")
            .map((r) => secrets["platform:" + r.id])
            .filter(Boolean),
        ]),
      ];
    for (const credential of candidates)
      try {
        const data = await platformJSON(
          "https://platform.deepseek.com/api/v0/users/get_api_keys",
          "Bearer " + credential,
        );
        if (String(data.biz_code) !== "0")
          throw new Error("平台登录已过期，请重新导入");
        const matches = (data.biz_data?.api_keys || []).filter(
          (row: JsonObject) => {
            const masked = row.sensitive_id || "";
            if (masked.replaceAll("*", "").length < 8) return false;
            const pattern = masked
              .split("*")
              .map((s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
              .join(".");
            return (
              row.api_key === key || new RegExp("^" + pattern + "$").test(key)
            );
          },
        );
        if (matches.length === 1 && matches[0].tracking_id)
          return {
            platform: credential,
            tracking: String(matches[0].tracking_id),
          };
        if (matches.length > 1)
          throw new Error("无法唯一识别此 Key，请选择对应的 Key 标识");
      } catch (error) {
        if (platform) throw error;
      }
    return { platform: "", tracking: "" };
  }
  async save(body: JsonObject) {
    const p = this.monitor.profile,
      owner = p.owner,
      id = validId(body.id || uid()),
      previous = this.rows().find((r) => r.id === id),
      keys = p.credentials();
    if (body.delete) {
      if (previous?.kind === "deepseek")
        this.control.provider({ id: "usage-agent-" + id, delete: true });
      for (const prefix of ["usage:", "relay:", "platform:"])
        delete keys[prefix + id];
      p.saveCredentials(keys);
      p.transaction(() => {
        for (const table of [
          "usage_connections",
          "provider_buckets",
          "provider_call_buckets",
        ])
          p.db
            .prepare(
              `DELETE FROM ${table} WHERE owner=? AND ${table === "usage_connections" ? "id" : "connection_id"}=?`,
            )
            .run(owner, id);
        if (previous?.kind === "codex") {
          p.db.prepare("DELETE FROM usage_bindings WHERE owner=?").run(owner);
        }
      });
      if (previous?.kind === "codex")
        this.control.saveConfig({ codexEnabled: false });
      return { ok: true };
    }
    if (!previous && this.rows().length >= 20)
      throw new Error("最多添加 20 个用量账户");
    const kind = body.kind || previous?.kind;
    if (
      ![
        "codex",
        "deepseek",
        "glm",
        "custom",
        "lmu",
        ...Object.keys(PRESETS),
      ].includes(kind) ||
      (previous && previous.kind !== kind)
    )
      throw new Error("请选择有效的用量账户");
    const defaults: JsonObject = {
        deepseek: "https://api.deepseek.com",
        glm: "https://open.bigmodel.cn/api/paas/v4",
        lmu: "https://api.lmuai.ai",
        ...Object.fromEntries(
          Object.entries(PRESETS).map(([k, v]) => [k, v.url]),
        ),
      },
      apiUrl = String(
        body.apiUrl ?? previous?.apiUrl ?? defaults[kind] ?? "",
      ).replace(/\/+$/, "");
    if (PRESETS[kind]) validateURL(apiUrl, kind);
    else if (["deepseek", "glm"].includes(kind)) {
      const url = validateURL(apiUrl),
        hosts =
          kind === "deepseek"
            ? ["api.deepseek.com"]
            : ["open.bigmodel.cn", "api.z.ai"],
        paths =
          kind === "deepseek"
            ? ["/", "/v1", "/user/balance"]
            : [
                "/",
                "/api/paas/v4",
                "/api/anthropic",
                "/api/coding/paas/v4",
                "/api/monitor/usage/model-usage",
              ];
      if (
        !hosts.includes(url.host) ||
        !paths.includes(url.pathname) ||
        url.search
      )
        throw new Error(
          "请填写所选平台的官方 HTTPS API URL，不支持代理地址、查询参数或重定向",
        );
    } else if (kind === "lmu" && apiUrl !== "https://api.lmuai.ai")
      throw new Error("LMU 仅支持官方 HTTPS 地址");
    else if (kind === "custom") validateURL(apiUrl);
    const name = String(body.name ?? previous?.name ?? "").trim();
    if (!name || name.length > 80) throw new Error("账户名称需为 1–80 个字符");
    if ("enabled" in body && typeof body.enabled !== "boolean")
      throw new Error("自动同步开关必须为布尔值");
    if (
      kind === "codex" &&
      this.rows().some((r) => r.kind === "codex" && r.id !== id)
    )
      throw new Error("本机 Codex 已连接，请编辑已有连接");
    const linked = String(body.providerId ?? previous?.providerId ?? "");
    if (linked) {
      const provider = this.control
        .state()
        .providers.find((v: JsonObject) => v.id === linked);
      if (
        kind !== "deepseek" ||
        !provider ||
        !["https://api.deepseek.com", "https://api.deepseek.com/v1"].includes(
          provider.baseUrl.replace(/\/+$/, ""),
        )
      )
        throw new Error(
          "只能关联此 Profile 下使用 DeepSeek 官方地址的模型服务",
        );
    }
    const previousKey = keys["usage:" + id],
      previousPlatform = keys["platform:" + id],
      key = String(body.apiKey || "").trim();
    if (key.length > 4096 || /[\r\n]/.test(key))
      throw new Error("API Key 格式不正确");
    let platform = String(body.platformToken || "")
        .trim()
        .replace(/^(?:Bearer\s+)+/i, ""),
      tracking = String(
        body.keyTrackingId ?? previous?.keyTrackingId ?? "",
      ).trim();
    if (body.platformImport) {
      const imported = String(body.platformImport);
      if (
        imported.length > 20000 ||
        !imported.includes("https://platform.deepseek.com/")
      )
        throw new Error("请复制 DeepSeek 官方平台的请求");
      const match = imported.match(/Authorization\s*:\s*Bearer\s+([^\s"']+)/i);
      if (!match) throw new Error("未识别平台登录，请复制完整请求");
      platform = match[1];
    }
    if (platform.length > 8192 || /[\r\n]/.test(platform))
      throw new Error("平台凭据格式不正确");
    if (
      kind === "deepseek" &&
      key &&
      previousKey &&
      key !== previousKey &&
      !("keyTrackingId" in body)
    )
      tracking = "";
    if (
      kind === "deepseek" &&
      (key || previousKey) &&
      !tracking &&
      !body.clearPlatformToken
    ) {
      const matched = await this.matchDeepseek(key || previousKey, platform);
      if (matched.platform) {
        platform = matched.platform;
        tracking = matched.tracking;
      }
    }
    if (tracking && !/^[A-Za-z0-9_-]{1,180}$/.test(tracking))
      throw new Error("Key 标识格式不正确");
    if (kind === "deepseek" && platform && !tracking)
      throw new Error("平台中未找到对应 APIKey，请核对 Key 和登录账户");
    if (owner !== p.owner) throw new Error("Profile 已切换");
    if (kind === "codex")
      this.claim("codex", this.control.public().defaultCodexPath);
    else {
      if (key) keys["usage:" + id] = key;
      else if (!keys["usage:" + id] && linked)
        keys["usage:" + id] = keys[linked] || "";
      if (["deepseek", "sub2api", "newapi"].includes(kind)) {
        if (body.clearPlatformToken) delete keys["platform:" + id];
        else if (platform) keys["platform:" + id] = platform;
      }
      p.saveCredentials(keys);
    }
    const row: JsonObject = {
      ...previous,
      id,
      kind,
      name,
      providerId: linked,
      apiUrl,
      supplierName:
        kind === "custom"
          ? String(body.supplierName ?? previous?.supplierName ?? "")
              .trim()
              .slice(0, 60)
          : "",
      keyTrackingId: kind === "deepseek" ? tracking : "",
      historyEnabled:
        ["custom", "lmu"].includes(kind) ||
        (kind === "deepseek" && !!(keys["platform:" + id] && tracking)),
      capabilities: {
        balance: ["deepseek", "glm", "lmu"].includes(kind),
        accountTokens: kind === "codex",
        quota: ["codex", "glm"].includes(kind),
        modelTokens: ["glm", "deepseek", "custom", "lmu"].includes(kind),
        historyQuery:
          ["glm", "custom", "lmu"].includes(kind) ||
          !!(keys["platform:" + id] && tracking),
        responseTokens: kind === "deepseek",
      },
      enabled: body.enabled !== false,
      revision: uid(),
    };
    if (PRESETS[kind]) {
      const mode =
          body.credentialMode ??
          previous?.credentialMode ??
          (kind === "sub2api" ? "account" : "key"),
        mapping = body.balanceMapping ?? previous?.balanceMapping ?? {};
      if (!["key", "account", "subscription"].includes(mode))
        throw new Error("凭据类型不正确");
      if (
        !mapping ||
        typeof mapping !== "object" ||
        Array.isArray(mapping) ||
        JSON.stringify(mapping).length > 4000 ||
        Object.keys(mapping).some(
          (k) =>
            ![
              "endpoint",
              "remainingPath",
              "usedPath",
              "totalPath",
              "currency",
              "divisor",
              "authMode",
            ].includes(k),
        )
      )
        throw new Error("余额字段映射不正确");
      Object.assign(row, {
        credentialMode: mode,
        balanceMapping: mapping,
        userId: String(body.userId ?? previous?.userId ?? "").slice(0, 100),
        quotaCurrency: body.quotaCurrency ?? previous?.quotaCurrency ?? "USD",
        capabilities: {
          balance: kind !== "minimax",
          quota: ["openrouter", "newapi", "minimax"].includes(kind),
          modelTokens: false,
          historyQuery: false,
          responseTokens: RELAY_KINDS.includes(kind) && mode === "key",
        },
      });
    }
    if (
      previous &&
      ((key && key !== previousKey) ||
        (platform && platform !== previousPlatform) ||
        tracking !== previous.keyTrackingId ||
        row.historyEnabled !== previous.historyEnabled ||
        apiUrl !== previous.apiUrl)
    ) {
      row.error = "密钥已更新，请重新同步账户";
      row.resetOnSuccess = true;
      p.transaction(() => {
        p.db
          .prepare(
            "DELETE FROM provider_buckets WHERE owner=? AND connection_id=?",
          )
          .run(owner, id);
        p.db
          .prepare(
            "DELETE FROM provider_call_buckets WHERE owner=? AND connection_id=?",
          )
          .run(owner, id);
      });
      delete row.lastTokenSuccessAt;
      delete row.snapshot;
    }
    if (kind === "lmu" && !keys["lmu:platform"])
      row.error = "请先授权 LMU 平台以查询历史用量";
    this.write(row);
    if (kind === "deepseek") {
      const linkedAgent = this.control
        .state()
        .providers.find((v: JsonObject) => v.id === "usage-agent-" + id);
      if (linkedAgent) {
        const changed = !!(key && previous && key !== previousKey);
        this.control.provider({
          ...linkedAgent,
          enabled: row.enabled && !changed,
          clearKey: changed,
        });
      }
    }
    return { connection: this.list().connections.find((r) => r.id === id) };
  }
  private async deepseek(key: string) {
    const get = (path: string) =>
        providerJSON("https://api.deepseek.com" + path, {
          Authorization: "Bearer " + key,
        }),
      data = await get("/user/balance");
    if (
      !Array.isArray(data.balance_infos) ||
      typeof data.is_available !== "boolean"
    )
      throw new Error("服务商余额响应格式不正确");
    const balances = data.balance_infos.map((row: JsonObject) => {
      if (!["CNY", "USD"].includes(row.currency))
        throw new Error("服务商余额币种不支持");
      const out: JsonObject = { currency: row.currency };
      for (const field of [
        "total_balance",
        "granted_balance",
        "topped_up_balance",
      ]) {
        let value: Decimal;
        try {
          value = new Decimal(String(row[field]));
          if (!value.isFinite()) throw new Error();
        } catch {
          throw new Error("服务商余额响应格式不正确");
        }
        out[field] = value.toString();
      }
      return out;
    });
    let models: string[] = [];
    try {
      models = (await get("/models")).data
        .filter((r: JsonObject) => r?.id)
        .map((r: JsonObject) => String(r.id).slice(0, 180))
        .slice(0, 100);
    } catch {}
    return {
      balances,
      available: data.is_available,
      models,
      coverage:
        "仅来自 DeepSeek 官方 API；公开余额接口未提供历史 Token、模型用量或请求明细，不读取本机日志。",
      unavailable: { tokens: "DeepSeek 公开 API 尚未提供历史 Token 查询接口" },
    };
  }
  private async glm(row: JsonObject, key: string) {
    const now = new Date(),
      local = new Date(now.getTime() + 8 * 3600000),
      before = new Date(local.getTime() - 86400000),
      fmt = (d: Date, end = false) =>
        d.toISOString().slice(0, 13).replace("T", " ") +
        (end ? ":59:59" : ":00:00"),
      params = new URLSearchParams({
        startTime: fmt(before),
        endTime: fmt(local, true),
      }),
      result: JsonObject = {
        coverage:
          "来自 GLM 官方 Coding Plan 个人套餐用量接口。按官方插件查询近期时间窗口；历史范围依平台实际返回，不代表全账号累计或逐次请求。",
        unavailable: {},
      },
      origin =
        new URL(row.apiUrl).hostname === "api.z.ai"
          ? "https://api.z.ai"
          : "https://open.bigmodel.cn";
    for (const [path, field] of [
      ["model-usage?" + params, "modelUsage"],
      ["quota/limit", "platformQuota"],
    ])
      try {
        result[field] = await platformJSON(
          origin + "/api/monitor/usage/" + path,
          key,
        );
      } catch (error: any) {
        result.unavailable[field] = error.message;
      }
    if (Object.keys(result.unavailable).length === 2)
      throw new Error(result.unavailable.modelUsage);
    return result;
  }
  private async glmFinance(row: JsonObject, key: string) {
    const now = shanghaiDay(new Date()),
      start = addDays(now, -365),
      archived = this.archived(row.id),
      previous = row.snapshot || {};
    let cutoff = start;
    if (
      previous.financeVersion === 1 &&
      row.lastSuccessEpoch &&
      !row.resetOnSuccess
    ) {
      const last = shanghaiDay(row.lastSuccessEpoch * 1000),
        recent = addDays(now, -30);
      cutoff =
        (last < recent ? last : recent) > start
          ? last < recent
            ? last
            : recent
          : start;
      cutoff = cutoff.slice(0, 7) + "-01";
    }
    let month = now.slice(0, 7) + "-01";
    const first = cutoff.slice(0, 7) + "-01",
      bills: JsonObject[] = [];
    while (month >= first) {
      let received = 0;
      const seen = new Set<string>(),
        recordsSeen = new Set<string>();
      for (let page = 1; page <= 101; page++) {
        const params = new URLSearchParams({
            billingMonth: month.slice(0, 7),
            pageNum: String(page),
            pageSize: "100",
            billStatus: "",
            modelProductName: "",
            paymentType: "",
          }),
          raw = await platformJSON(
            "https://bigmodel.cn/api/finance/expenseBill/expenseBillListByDay?" +
              params,
            key,
            false,
          ),
          entries = raw.rows,
          total = raw.total;
        if (!Array.isArray(entries) || !Number.isInteger(total) || total < 0)
          throw new Error("GLM 每日账单响应格式不正确");
        const fingerprint = canonical(entries);
        if (received < total && (!entries.length || seen.has(fingerprint)))
          throw new Error("GLM 账单分页未完成");
        seen.add(fingerprint);
        for (const item of entries) {
          const fingerprint = canonical(item);
          if (recordsSeen.has(fingerprint))
            throw new Error("GLM 账单返回重复记录");
          recordsSeen.add(fingerprint);
        }
        bills.push(...entries);
        received += entries.length;
        if (bills.length > 10000 || page > 100)
          throw new Error("GLM 历史账单超过查询限制");
        if (received >= total) break;
      }
      month = addDays(month, -1).slice(0, 7) + "-01";
    }
    const rows = [
        ...archived.filter(
          (r) => shanghaiDay(r.at) >= start && shanghaiDay(r.at) < cutoff,
        ),
        ...glmBills(bills, row, key).filter(
          (r) => shanghaiDay(r.at) >= start && shanghaiDay(r.at) <= now,
        ),
      ],
      result: JsonObject = {
        historyRows: rows,
        historyAvailable: true,
        historyDays: 366,
        financeVersion: 1,
        coverage: "GLM 官方账单 · 所选 Key",
        unavailable: {},
      };
    try {
      const report = await platformJSON(
          "https://bigmodel.cn/api/biz/account/query-customer-account-report",
          key,
        ),
        ids = new Set(
          bills
            .filter(
              (b) =>
                [key, key.split(".")[0]].includes(b.apiKey) &&
                b.customerId != null,
            )
            .map((b) => String(b.customerId)),
        );
      result.accountFinance = {
        currency: "CNY",
        balance: amount(report.availableBalance)?.toNumber() ?? null,
        spent: amount(report.totalSpendAmount)?.toNumber() ?? null,
        accountRef: ids.size === 1 ? hash("GLM:" + [...ids][0]) : null,
      };
    } catch {
      result.unavailable.balance = "账户余额暂未返回";
    }
    return result;
  }
  archived(id: string) {
    const p = this.monitor.profile;
    return (
      p.db
        .prepare(
          "SELECT record FROM provider_buckets WHERE owner=? AND connection_id=?",
        )
        .all(p.owner, id) as JsonObject[]
    ).map((r) => parseExact(r.record));
  }
  private async history(row: JsonObject, key: string) {
    const now = shanghaiDay(new Date()),
      start = addDays(now, -365),
      previous = row.snapshot || {};
    if (row.kind === "lmu") {
      const cutoff =
          previous.lmuVersion === 1 &&
          row.lastSuccessEpoch &&
          !row.resetOnSuccess
            ? addDays(now, -30)
            : start,
        result = await this.lmu.history(row, key, cutoff);
      return {
        ...result,
        historyRows: [
          ...this.archived(row.id).filter(
            (r) => shanghaiDay(r.at) >= start && shanghaiDay(r.at) < cutoff,
          ),
          ...result.historyRows,
        ],
        lmuVersion: 1,
        historyStart: start,
        historyEnd: now,
      };
    }
    let rows: JsonObject[] = [];
    if (row.kind === "deepseek") {
      const end = Math.floor(
          Date.parse(addDays(now, 1) + "T00:00:00+08:00") / 1000,
        ),
        initial = end - 366 * 86400;
      let queryStart = initial,
        matched = false;
      if (
        previous.historyDays === 366 &&
        previous.historyAvailable &&
        previous.financeVersion === 1 &&
        row.lastSuccessEpoch &&
        !row.resetOnSuccess
      ) {
        const last = Math.floor(
          Date.parse(
            shanghaiDay(row.lastSuccessEpoch * 1000) + "T00:00:00+08:00",
          ) / 1000,
        );
        queryStart = Math.max(initial, Math.min(end - 30 * 86400, last));
        rows = this.archived(row.id).filter(
          (r) =>
            Date.parse(r.at) / 1000 >= initial &&
            Date.parse(r.at) / 1000 < queryStart,
        );
      }
      for (let cursor = end; cursor > queryStart;) {
        const from = Math.max(queryStart, cursor - 30 * 86400),
          params = new URLSearchParams({
            start: String(from),
            end: String(cursor),
            tz: "28800",
            api_key_tracking_id: row.keyTrackingId,
          }),
          url =
            "https://platform.deepseek.com/api/v0/usage/by_api_key/amount?" +
            params,
          data = await platformJSON(
            url,
            "Bearer " + key.replace(/^(?:Bearer\s+)+/i, ""),
          );
        if (
          String(data.biz_code) !== "0" ||
          !data.biz_data ||
          typeof data.biz_data !== "object"
        )
          throw new Error(
            "DeepSeek 平台凭据无效或没有历史查询权限，请更新平台登录凭据",
          );
        const raw = data.biz_data;
        matched =
          matched ||
          (raw.series || []).some(
            (r: JsonObject) => r.api_key?.tracking_id === row.keyTrackingId,
          );
        const batch = normalizeHistory(raw, row, true).filter(
          (r) =>
            Date.parse(r.at) / 1000 >= from && Date.parse(r.at) / 1000 < cursor,
        );
        try {
          const fees = deepseekCosts(
            await platformJSON(
              url.replace("/amount?", "/cost?"),
              "Bearer " + key,
            ),
            row.keyTrackingId,
          );
          for (const r of batch) {
            const value = fees.get(
              JSON.stringify([r.model, Math.floor(Date.parse(r.at) / 1000)]),
            );
            r.cost = value?.toNumber() ?? (r.total === 0 ? 0 : null);
          }
        } catch {}
        rows.push(...batch);
        if (rows.length > 10000)
          throw new Error("历史记录超过 10000 条，请缩短查询范围");
        cursor = from;
      }
      if (!matched)
        throw new Error("平台未返回该 Key 的历史，请核对 Key 标识和查询范围");
      if (new Set(rows.map((r) => r.id)).size !== rows.length)
        throw new Error("历史接口返回重复记录");
      const result: JsonObject = {
        historyRows: rows,
        historyAvailable: true,
        historyDays: 366,
        historyStart: iso(initial),
        historyEnd: iso(end),
        financeVersion: 1,
        coverage: "DeepSeek 平台历史 · 所选 Key",
        unavailable: {},
      };
      if (rows.some((r) => r.cost === null))
        result.unavailable.cost = "部分费用暂未返回";
      try {
        const data = await platformJSON(
          "https://platform.deepseek.com/api/v0/users/get_user_summary",
          "Bearer " + key,
        );
        if (String(data.biz_code) !== "0") throw new Error();
        const report = data.biz_data || {},
          wallets = [
            ...(report.normal_wallets || []),
            ...(report.bonus_wallets || []),
          ].filter((v) => v.currency === "CNY"),
          costs = (report.total_costs || []).filter(
            (v: JsonObject) => v.currency === "CNY",
          ),
          sum = (values: JsonObject[], field: string) =>
            values.length
              ? values
                  .reduce((n, v) => {
                    const a = amount(v[field]);
                    if (a === null) throw new Error();
                    return n.plus(a);
                  }, new Decimal(0))
                  .toNumber()
              : null;
        result.accountFinance = {
          currency: "CNY",
          balance: sum(wallets, "balance"),
          spent: sum(costs, "amount"),
          accountRef: hash("DeepSeek:" + key),
        };
      } catch {
        result.unavailable.balance = "账户余额暂未返回";
      }
      return result;
    }
    const parsed = validateURL(row.apiUrl),
      cursors = new Set<string>();
    let url = parsed.href,
      raw = await platformJSON(url, "Bearer " + key, false);
    rows = normalizeHistory(raw, row);
    while (raw.next_page || raw.nextPage) {
      const cursor = raw.next_page || raw.nextPage;
      if (
        typeof cursor !== "string" ||
        !/^[-A-Za-z0-9_]{1,500}$/.test(cursor) ||
        cursors.has(cursor) ||
        cursors.size >= 20
      )
        throw new Error("历史分页未完成，请缩短查询范围");
      cursors.add(cursor);
      const next = new URL(url);
      next.searchParams.set("page", cursor);
      raw = await platformJSON(next.href, "Bearer " + key, false);
      rows.push(...normalizeHistory(raw, row));
      if (rows.length > 10000) throw new Error("历史记录过多，请缩短查询范围");
    }
    if (new Set(rows.map((r) => r.id)).size !== rows.length)
      throw new Error("历史分页返回重复记录，请检查接口范围");
    return {
      historyRows: rows,
      coverage: "供应商历史接口 · 按已选择的 Key 与实际模型统计",
      unavailable: {},
      historyAvailable: true,
    };
  }
  async sync(id: string, force = true) {
    id = validId(id);
    const row = this.rows().find((r) => r.id === id);
    if (!row) throw new Error("用量连接不存在");
    if (!row.enabled) throw new Error("此连接已暂停，请先启用");
    if (this.busy.has(id)) return { busy: true };
    if (!force && Date.now() / 1000 - (row.lastAttemptEpoch || 0) < 300)
      return { cached: true };
    this.busy.add(id);
    const owner = this.monitor.profile.owner;
    try {
      try {
        let snapshot: JsonObject;
        if (row.kind === "codex") {
          this.claim("codex", this.control.public().defaultCodexPath);
          snapshot = await readCodexAccount(join(this.monitor.profile.root, "data", "credentials", this.monitor.profile.owner, "codex"), {allowLocal:this.monitor.profile.read<JsonObject>("codex-local-authorization",{}).authorized===true});
        } else {
          const keys = this.control.profile.credentials(),
            key = keys["usage:" + id];
          if (PRESETS[row.kind]) {
            if (!key && !keys["platform:" + id])
              throw new Error("查询凭据未配置");
            snapshot = await readPreset(
              row,
              key || "",
              keys["platform:" + id] || "",
            );
          } else if (row.historyEnabled) {
            const credential =
              row.kind === "deepseek" ? keys["platform:" + id] : key;
            if (!credential) throw new Error("历史查询凭据未配置，请编辑连接");
            snapshot = await this.history(row, credential);
          } else {
            if (!key) throw new Error("密钥未配置，请编辑连接");
            if (row.kind === "glm" && !row.apiUrl.includes("api.z.ai"))
              try {
                snapshot = await this.glmFinance(row, key);
              } catch (financeError) {
                try {
                  snapshot = await this.glm(row, key);
                } catch {
                  throw financeError;
                }
              }
            else
              snapshot =
                row.kind === "deepseek"
                  ? await this.deepseek(key)
                  : await this.glm(row, key);
          }
        }
        Object.assign(row, {
          snapshot,
          lastSuccessAt: iso(),
          lastSuccessEpoch: Date.now() / 1000,
          error: "",
          lastAttemptAt: iso(),
          lastAttemptEpoch: Date.now() / 1000,
        });
      } catch (error: any) {
        Object.assign(row, {
          error: error.message,
          lastAttemptAt: iso(),
          lastAttemptEpoch: Date.now() / 1000,
        });
      }
      const current = this.rows().find((r) => r.id === id);
      if (
        owner === this.monitor.profile.owner &&
        current?.revision === row.revision
      ) {
        const p = this.monitor.profile;
        p.transaction(() => {
          if (
            ["glm", "custom", "deepseek", "lmu"].includes(row.kind) &&
            !row.error &&
            (row.snapshot?.modelUsage || row.snapshot?.historyAvailable)
          ) {
            const historical = row.snapshot.historyAvailable,
              buckets = historical
                ? row.snapshot.historyRows || []
                : normalizeGLM(row.snapshot.modelUsage, row),
              calls = historical ? [] : normalizeCalls(row.snapshot.modelUsage);
            delete row.snapshot.historyRows;
            if (buckets.length) row.lastTokenSuccessAt = row.lastSuccessAt;
            if (current.resetOnSuccess || historical) {
              p.db
                .prepare(
                  "DELETE FROM provider_buckets WHERE owner=? AND connection_id=?",
                )
                .run(owner, id);
              p.db
                .prepare(
                  "DELETE FROM provider_call_buckets WHERE owner=? AND connection_id=?",
                )
                .run(owner, id);
            }
            for (const bucket of buckets)
              p.db
                .prepare(
                  "INSERT OR REPLACE INTO provider_buckets VALUES(?,?,?,?)",
                )
                .run(owner, id, bucket.id, encode(bucket));
            for (const bucket of calls)
              p.db
                .prepare(
                  "INSERT OR REPLACE INTO provider_call_buckets VALUES(?,?,?,?)",
                )
                .run(owner, id, bucket.at, bucket.count);
            delete current.resetOnSuccess;
            if (historical) row.snapshot.historyCount = buckets.length;
          }
          for (const key of [
            "snapshot",
            "lastSuccessAt",
            "lastTokenSuccessAt",
            "lastSuccessEpoch",
            "error",
            "lastAttemptAt",
            "lastAttemptEpoch",
          ])
            if (key in row) current[key] = row[key];
          this.write(current);
        });
      }
      return { ok: !row.error, error: row.error || null };
    } finally {
      this.busy.delete(id);
    }
  }
  codexSnapshot(params: JsonObject): JsonObject {
    const source = params.source || "",
      attributed = [
        "model",
        "models",
        "project",
        "provider",
        "connection_id",
      ].some((k) => params[k]);
    if (!["", "official", "codex"].includes(source))
      throw new Error("Codex 来源不受支持");
    if (source === "official" && attributed)
      throw new Error("官方账户没有模型和工作区明细，请选择本机日志后筛选");
    if (source === "codex" || attributed) {
      const result = this.monitor.snapshot({
        ...params,
        scope: "codex",
        source: "codex",
      });
      result.options.source = ["official", "codex"];
      return result;
    }
    const row = this.bound()
        ? this.rows().find((r) => r.kind === "codex") || {}
        : {},
      cached = row.snapshot || {};
    try {
      const result = activitySnapshot(
        cached.tokenActivity,
        params,
        cached.unavailable?.tokenActivity || row.error || "",
        row.lastSuccessAt || "",
      );
      if (result.available && row.error) {
        (result.dataSource as JsonObject).stale = true;
        result.dataSource.message =
          "上次成功的官方活动快照；最新同步失败，请重试 · " +
          result.dataSource.message;
      }
      return result;
    } catch {
      return activitySnapshot(
        null,
        params,
        "官方活动数据未通过结构校验，未使用本机记录补数",
      );
    }
  }
  providerSnapshot(params: JsonObject = {}) {
    const available = this.rows().filter((r) => r.kind !== "codex"),
      identities = new Set<string>(
        String(params.connection_ids || params.connection_id || "")
          .split(",")
          .filter(Boolean),
      ),
      supplier = params.supplier || "",
      secrets = this.control.profile.credentials();
    if (
      identities.size > 20 ||
      [...identities].some((id) => !available.some((c) => c.id === id))
    )
      throw new Error("所选 APIKey 不存在");
    let connections = available.filter(
      (c) =>
        (!identities.size || identities.has(c.id)) &&
        (!supplier || this.supplierId(c) === supplier),
    );
    if (
      supplier &&
      [...identities].some((id) => !connections.some((c) => c.id === id))
    )
      throw new Error("所选 APIKey 不属于当前供应商");
    if (!identities.size && !supplier && connections.length)
      connections = [
        connections.find((c) => c.kind === "glm") || connections[0],
      ];
    const seen = new Set<string>();
    connections = connections
      .sort(
        (a, b) =>
          Number(!!b.snapshot?.historyAvailable) -
            Number(!!a.snapshot?.historyAvailable) ||
          String(b.lastTokenSuccessAt || "").localeCompare(
            a.lastTokenSuccessAt || "",
          ) ||
          (b.lastSuccessEpoch || 0) - (a.lastSuccessEpoch || 0),
      )
      .filter((c) => {
        const credential = secrets["usage:" + c.id],
          identity = canonical(
            credential
              ? [
                  c.kind,
                  c.kind === "glm" ? credential.split(".")[0] : credential,
                ]
              : c.kind === "deepseek" && c.keyTrackingId
                ? [c.kind, secrets["platform:" + c.id], c.keyTrackingId]
                : ["connection", c.id],
          );
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      });
    let rows: JsonObject[] = [];
    const coverage: JsonObject[] = [],
      calls: JsonObject[] = [],
      p = this.monitor.profile;
    for (const c of connections) {
      const snapshot = c.snapshot || {},
        credential = secrets["usage:" + c.id],
        aliases = available
          .filter(
            (a) =>
              a.kind === c.kind &&
              a.apiUrl === c.apiUrl &&
              credential &&
              secrets["usage:" + a.id] === credential,
          )
          .map((a) => a.id);
      if (!aliases.length) aliases.push(c.id);
      const archived = (
        p.db
          .prepare(
            "SELECT record FROM provider_buckets WHERE owner=? AND connection_id IN (" +
              aliases.map(() => "?").join(",") +
              ")",
          )
          .all(p.owner, ...aliases) as JsonObject[]
      )
        .map((r) => parseExact(r.record))
        .filter(
          (r) =>
            r.connection_id === c.id ||
            r.provenance?.type === "captured-response",
        );
      rows.push(
        ...(archived.length
          ? archived
          : c.kind === "glm"
            ? normalizeGLM(snapshot.modelUsage, c)
            : []),
      );
      calls.push(
        ...(p.db
          .prepare(
            "SELECT at,count FROM provider_call_buckets WHERE owner=? AND connection_id=?",
          )
          .all(p.owner, c.id) as JsonObject[]),
      );
      coverage.push({
        id: c.id,
        name: c.name,
        kind: c.kind,
        lastSuccessAt:
          c.lastTokenSuccessAt ||
          (snapshot.modelUsage && rows.length ? c.lastSuccessAt : null),
        message: snapshot.coverage || "尚未配置密钥或同步平台数据",
        unavailable: snapshot.unavailable || {},
      });
    }
    const merged = new Map<string, JsonObject>();
    for (const r of rows) {
      if (r.excludedFromTotals && params.source !== "captured-response")
        continue;
      const identity = r.consumptionId || r.id,
        old = merged.get(identity);
      if (!old) merged.set(identity, r);
      else if (
        ["total", "input", "output", "model"].some((k) => old[k] !== r[k])
      )
        merged.set(identity, {
          ...r,
          total: null,
          input: null,
          output: null,
          cached: null,
          reasoning: null,
          status: "conflicting-evidence",
        });
    }
    rows = [...merged.values()]
      .filter(
        (r) =>
          (!params.source || r.source === params.source) &&
          (!params.project || r.project === params.project),
      )
      .sort((a, b) => b.at.localeCompare(a.at));
    const currencies = new Set(
        connections.map(
          (c) =>
            c.snapshot?.accountFinance?.currency ||
            PRESETS[c.kind]?.currency ||
            (c.kind === "lmu" ? "USD" : "CNY"),
        ),
      ),
      currency = currencies.size === 1 ? [...currencies][0] : "CNY",
      callsEarliest = calls.map((c) => shanghaiDay(c.at)).sort()[0],
      result = this.monitor.snapshot(
        {
          ...params,
          scope: "api",
          connection_id: "",
          cost_currency: currency,
          range_earliest: callsEarliest,
        },
        rows,
      ) as JsonObject;
    result.costCurrency = currency;
    for (const day of [...result.daily, ...result.activity]) {
      day.provided = !!day.requests && day.unknown < day.requests;
      if (
        currency === "USD" &&
        connections.length &&
        connections.every(
          (c) =>
            c.snapshot?.historyAvailable &&
            (c.snapshot.historyStart || "9999") <= day.date &&
            c.snapshot.historyEnd >= day.date,
        )
      )
        day.provided = day.unknown < day.requests || day.requests === 0;
      if (!day.provided) day.total = null;
    }
    const aggregated = rows.length
        ? rows.some((r) => (r.granularity || "bucket") !== "request")
        : !connections.length ||
          connections[0].kind !== "deepseek" ||
          !!connections[0].historyEnabled,
      finance = new Map<string, JsonObject>();
    let unidentified =
      new Set(
        connections
          .filter((c) => c.kind === "deepseek")
          .map((c) => c.snapshot?.accountFinance?.accountRef),
      ).size > 1;
    for (const c of connections.sort(
      (a, b) => (a.lastSuccessEpoch || 0) - (b.lastSuccessEpoch || 0),
    )) {
      const f = c.snapshot?.accountFinance || {},
        ref = f.accountRef;
      if (!ref && connections.length > 1) unidentified = true;
      finance.set(ref || c.id, f);
    }
    const sum = (key: string) =>
      finance.size &&
      !unidentified &&
      [...finance.values()].every((f) => typeof f[key] === "number")
        ? [...finance.values()]
            .reduce((n, f) => n.plus(String(f[key])), new Decimal(0))
            .toNumber()
        : null;
    Object.assign(result, {
      origin: "official-provider-api",
      coverage,
      available:
        rows.some((r) => r.total !== null) ||
        connections.some((c) => c.snapshot?.historyAvailable),
      aggregated,
      requestDetailsAvailable: !aggregated,
      accountFinance: connections.length
        ? {
            currency,
            balance: sum("balance"),
            spent: sum("spent"),
            scope:
              finance.size &&
              [...finance.values()].every((f) => f.scope === "key")
                ? "key"
                : "account",
          }
        : null,
      selectedConnections: connections.map((c) => ({ id: c.id, name: c.name })),
      incomplete: connections.some(
        (c) => !c.snapshot?.historyAvailable && !c.snapshot?.modelUsage,
      ),
      costAvailable:
        rows.some((r) => r.cost !== null && r.currency === currency) ||
        connections.some(
          (c) =>
            c.snapshot?.financeVersion === 1 && !c.snapshot?.unavailable?.cost,
        ),
    });
    const [start, end] = dateRange(
        Number(params.days) || 30,
        params,
        result.range.earliest,
      ),
      scoped = rows.filter(
        (r) =>
          shanghaiDay(r.at) >= start &&
          shanghaiDay(r.at) <= end &&
          (!params.models?.length
            ? !params.model || r.model === params.model
            : params.models.includes(r.model)) &&
          (!params.provider || r.provider === params.provider),
      ),
      knownCalls = calls.filter(
        (r) => shanghaiDay(r.at) >= start && shanghaiDay(r.at) <= end,
      );
    result.platformRequests = !aggregated
      ? result.summary.requests
      : scoped.length && scoped.every((r) => r.platform_requests != null)
        ? scoped.reduce((n, r) => n + r.platform_requests, 0)
        : knownCalls.length &&
            !params.model &&
            !params.models?.length &&
            (!params.provider || params.provider === "GLM")
          ? knownCalls.reduce((n, r) => n + r.count, 0)
          : null;
    if (!aggregated)
      for (const item of coverage)
        item.message =
          "仅统计经过采集地址、由供应商官方响应返回的实际用量；未覆盖其他应用与接入前历史。";
    result.dataVersion = String(
      (
        p.db
          .prepare("SELECT version FROM provider_versions WHERE owner=?")
          .get(p.owner) as JsonObject | undefined
      )?.version || 0,
    );
    return result;
  }
  get running() {
    return !!this.busy.size;
  }
  async idle() {
    while (this.running)
      await new Promise((resolve) => setTimeout(resolve, 25));
  }
  tick() {
    for (const row of this.rows())
      if (
        row.enabled &&
        (row.kind === "codex" ||
          this.control.profile.credentials()["usage:" + row.id]) &&
        Date.now() / 1000 - (row.lastAttemptEpoch || 0) >= 300
      )
        this.sync(row.id, false).catch(() => {});
  }
}
