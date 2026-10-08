import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { UsageAccounts } from "./usage-accounts.ts";
import { RELAY_KINDS, PRESETS, validateURL } from "./provider-network.ts";
import { normalizeTokens, iso } from "./monitor.ts";
import { hash, uid, encode, parseExact, type JsonObject } from "./profile.ts";

export function inferenceBase(row: JsonObject) {
  let base = row.apiUrl.replace(/\/+$/, "");
  if (row.kind === "deepseek" && base.endsWith("/user/balance"))
    base = base.slice(0, -13);
  if (row.kind === "glm") {
    const u = new URL(base);
    if (["", "/", "/api/monitor/usage/model-usage"].includes(u.pathname))
      base = u.origin + "/api/paas/v4";
    if (u.pathname === "/api/anthropic")
      throw new Error("此地址使用 Messages 协议，不支持 OpenAI 响应采集");
  }
  if (["newapi", "sub2api"].includes(row.kind) && !base.endsWith("/v1"))
    base += "/v1";
  return base;
}
export class Relay {
  constructor(readonly accounts: UsageAccounts) {}
  configure(id: string, revoke = false) {
    const row = this.accounts
      .rows()
      .find((r) => r.id === id && RELAY_KINDS.includes(r.kind));
    if (!row) throw new Error("采集连接不存在");
    if (
      row.credentialMode === "subscription" ||
      (["newapi", "sub2api"].includes(row.kind) &&
        row.credentialMode === "account")
    )
      throw new Error("账户／订阅查询凭据不能作为推理采集 Key");
    const p = this.accounts.control.profile,
      keys = p.credentials();
    let key: string | null = null;
    if (revoke) delete keys["relay:" + id];
    else {
      if (!keys["usage:" + id]) throw new Error("请先填写 API Key");
      key = "wb-relay-" + randomBytes(32).toString("base64url");
      keys["relay:" + id] = key;
    }
    p.saveCredentials(keys);
    return {
      id,
      relayKey: key,
      basePath: "/api/usage/relay/" + id,
      revoked: revoke,
      coverage:
        "仅记录经过此地址的新请求。不能读取其他应用或历史请求；正常模型调用按供应商计费。",
    };
  }
  connectAgent(id: string, model: string) {
    const row = this.accounts
      .rows()
      .find((r) => r.id === id && RELAY_KINDS.includes(r.kind) && r.enabled);
    if (!row) throw new Error("连接不存在或已暂停");
    const key = this.accounts.control.profile.credentials()["usage:" + id];
    if (!key) throw new Error("请先填写 API Key");
    const available = row.snapshot?.models || [];
    if (
      typeof model !== "string" ||
      !model ||
      model.length > 180 ||
      (available.length && !available.includes(model))
    )
      throw new Error("请选择平台返回的模型");
    if (
      row.credentialMode === "subscription" ||
      (["newapi", "sub2api"].includes(row.kind) &&
        row.credentialMode === "account")
    )
      throw new Error("请使用独立的推理 Key");
    const pid = "usage-agent-" + id;
    this.accounts.control.provider({
      id: pid,
      name: ((PRESETS[row.kind]?.name || "DeepSeek") + " · " + row.name).slice(
        0,
        80,
      ),
      baseUrl: inferenceBase(row),
      apiKey: key,
      model,
    });
    this.accounts.control.saveConfig({ defaultProvider: pid });
    return { ok: true, providerId: pid };
  }
  captureAgent(
    cfg: JsonObject,
    response: JsonObject,
    payload: JsonObject,
    requestId: string,
  ) {
    const id = String(cfg.id || "").replace(/^usage-agent-/, ""),
      row = this.accounts
        .rows()
        .find((r) => r.id === id && RELAY_KINDS.includes(r.kind) && r.enabled);
    if (
      !row ||
      cfg.baseUrl.replace(/\/+$/, "") !== inferenceBase(row) ||
      this.accounts.control.profile.credentials()["usage:" + id] !== cfg.apiKey
    )
      return false;
    return this.capture(row, response, payload.model, requestId, true);
  }
  authenticate(id: string, bearer: string) {
    if (!bearer || bearer.length > 200) throw new Error("采集密钥无效");
    const row = this.accounts.rows().find((r) => r.id === id),
      keys = this.accounts.control.profile.credentials(),
      expected = String(keys["relay:" + id] || ""),
      a = Buffer.from(bearer),
      b = Buffer.from(expected);
    if (
      !row ||
      !b.length ||
      a.length !== b.length ||
      !timingSafeEqual(a, b) ||
      !RELAY_KINDS.includes(row.kind) ||
      row.credentialMode === "subscription" ||
      (["newapi", "sub2api"].includes(row.kind) &&
        row.credentialMode === "account") ||
      !row.enabled ||
      !keys["usage:" + id]
    )
      throw new Error("采集密钥无效、连接已暂停或不存在");
    return { row, key: keys["usage:" + id] as string };
  }
  capture(
    row: JsonObject,
    response: JsonObject,
    requested: string,
    requestId: string,
    allowMissing = false,
  ) {
    if (!response || typeof response !== "object") return false;
    if (response.response && typeof response.response === "object")
      response = response.response;
    let usage = response.usage,
      counts: JsonObject | null = null;
    try {
      counts = normalizeTokens(usage);
    } catch {
      return false;
    }
    if (!counts || counts.total == null) {
      if (!allowMissing) return false;
      counts = {
        input: null,
        output: null,
        cached: null,
        reasoning: null,
        total: null,
      };
      usage = {};
    }
    if (
      Object.values(counts).some(
        (v) =>
          v !== null && (typeof v === "bigint" || v > Number.MAX_SAFE_INTEGER),
      )
    )
      return false;
    const model = response.model || "未识别模型";
    if (typeof model !== "string" || !model || model.length > 180) return false;
    usage = usage || {};
    if (
      !["prompt_cache_hit_tokens", "cached_input_tokens", "cached"].some(
        (k) => k in usage,
      ) &&
      !["input_tokens_details", "prompt_tokens_details"].some(
        (k) => usage[k] && "cached_tokens" in usage[k],
      )
    )
      counts.cached = null;
    if (
      !["reasoning_output_tokens", "reasoning"].some((k) => k in usage) &&
      !["output_tokens_details", "completion_tokens_details"].some(
        (k) => usage[k] && "reasoning_tokens" in usage[k],
      )
    )
      counts.reasoning = null;
    let at: string;
    try {
      at = iso(response.created ?? response.created_at);
    } catch {
      at = iso();
    }
    const upstream = response.id || requestId,
      id = row.id + ":response:" + hash(String(upstream)),
      p = this.accounts.monitor.profile,
      current = this.accounts.rows().find((r) => r.id === row.id);
    if (!current || current.revision !== row.revision) return false;
    const key = p.credentials()["usage:" + row.id] || "",
      record: JsonObject = {
        id,
        at,
        source: "captured-response",
        agent: (PRESETS[row.kind]?.name || "DeepSeek") + " 响应采集",
        provider:
          PRESETS[row.kind]?.name || (row.kind === "glm" ? "GLM" : "DeepSeek"),
        model,
        project: "",
        session: "",
        connection_id: row.id,
        requested_model: requested,
        auth_mode: "api_key",
        status: "ok",
        cost: null,
        currency: PRESETS[row.kind]?.currency || "CNY",
        duration_ms: null,
        ...counts,
        granularity: "request",
        consumptionId: hash(
          row.kind + "\0" + row.apiUrl + "\0" + key + "\0" + String(upstream),
        ),
        provenance: {
          type: "captured-response",
          endpoint: row.apiUrl,
          requestId: String(upstream),
          parserVersion: "usage-v18",
        },
      };
    if (current.historyEnabled)
      record.excludedFromTotals = "official-history-overlap";
    const previous = p.db
      .prepare(
        "SELECT record FROM provider_buckets WHERE owner=? AND connection_id=? AND id=?",
      )
      .get(p.owner, row.id, id) as JsonObject | undefined;
    if (
      previous &&
      parseExact(previous.record).total !== null &&
      counts.total === null
    )
      return true;
    p.db
      .prepare("INSERT OR REPLACE INTO provider_buckets VALUES(?,?,?,?)")
      .run(p.owner, row.id, id, encode(record));
    if (counts.total !== null) current.lastTokenSuccessAt = iso();
    this.accounts.write(current);
    return true;
  }
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
    id: string,
    endpoint: string,
    body: JsonObject,
  ) {
    let row: JsonObject, key: string;
    try {
      const result = this.authenticate(
        id,
        String(request.headers.authorization || "").replace(/^Bearer /, ""),
      );
      row = result.row;
      key = result.key;
    } catch {
      return reply
        .code(401)
        .send({
          error: {
            message: "采集密钥无效、连接已暂停或不存在",
            type: "authentication_error",
          },
        });
    }
    if (
      !["chat/completions", "responses"].includes(endpoint) ||
      !body ||
      typeof body.model !== "string" ||
      !body.model ||
      body.model.length > 180 ||
      typeof (body.stream ?? false) !== "boolean" ||
      (endpoint === "chat/completions" && !Array.isArray(body.messages))
    )
      return reply
        .code(400)
        .send({
          error: {
            message: "请指定有效模型、messages 数组与 stream 布尔值",
            type: "provider_error",
          },
        });
    const base = inferenceBase(row);
    validateURL(base, PRESETS[row.kind] ? row.kind : undefined);
    const requestId = uid();
    let upstream: Response;
    try {
      upstream = await fetch(base + "/" + endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(90000),
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
          Accept: body.stream ? "text/event-stream" : "application/json",
        },
        body: encode(body),
      });
      if (!upstream.ok)
        throw new Error("供应商调用失败，请检查密钥、余额、模型及请求参数");
    } catch (error: any) {
      return reply
        .code(502)
        .send({
          error: {
            message: error.message || "供应商暂时无法连接",
            type: "provider_error",
          },
        });
    }
    const reader = upstream.body!.getReader();
    if (!body.stream) {
      const parts: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 16 * 1024 * 1024) throw new Error("平台响应过大");
          parts.push(value);
        }
        const raw = Buffer.concat(parts),
          response = parseExact(raw.toString("utf8"));
        this.capture(row, response, body.model, requestId, true);
        return reply.type("application/json").send(raw);
      } catch (error: any) {
        await reader.cancel();
        return reply
          .code(502)
          .send({
            error: {
              message: error.message || "平台响应格式不正确",
              type: "provider_error",
            },
          });
      }
    }
    if (!upstream.headers.get("content-type")?.includes("text/event-stream")) {
      await reader.cancel();
      return reply
        .code(502)
        .send({
          error: { message: "平台没有返回事件流", type: "provider_error" },
        });
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "close",
    });
    let buffer = "",
      data: string[] = [],
      connected = true,
      last: JsonObject | null = null;
    const decoder = new TextDecoder(),
      inspect = () => {
        if (!data.length) return;
        try {
          const packet = parseExact(data.join("\n"));
          last = packet;
          if (
            endpoint === "chat/completions" ||
            [
              "response.completed",
              "response.incomplete",
              "response.failed",
            ].includes(packet.type)
          )
            this.capture(row, packet, body.model, requestId);
        } catch {}
        data = [];
      };
    reply.raw.on("error", () => {
      connected = false;
    });
    reply.raw.on("close", () => {
      connected = false;
    });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (connected)
          try {
            reply.raw.write(value);
          } catch {
            connected = false;
          }
        buffer += decoder.decode(value, { stream: true });
        if (
          buffer.length + data.reduce((n, s) => n + s.length, 0) >
          4 * 1024 * 1024
        )
          throw new Error("事件流记录过大");
        let split: number;
        while ((split = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, split).replace(/\r$/, "");
          buffer = buffer.slice(split + 1);
          if (!line.trim()) inspect();
          else if (line.startsWith("data:")) {
            const value = line.slice(5).trim();
            if (value !== "[DONE]") data.push(value);
          }
        }
      }
      inspect();
      this.capture(row, last || {}, body.model, requestId, true);
    } catch {
      await reader.cancel().catch(() => {});
      this.capture(row, last || {}, body.model, requestId, true);
    } finally {
      if (!reply.raw.destroyed) reply.raw.end();
    }
  }
}
