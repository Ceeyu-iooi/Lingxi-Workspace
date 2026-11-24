import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtraAgentSource } from "../shared/local-agent-sources.ts";
import { addCount, canonical, integer, iso, normalizeTokens } from "./monitor.ts";
import { hash, parseExact, type JsonObject } from "./profile.ts";
import { records } from "./log-readers.ts";

const text = (value: unknown) => typeof value === "string" ? value.trim().slice(0, 512) : "";
const exact = (value: unknown) => integer(typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : value);
const sum = (...values: unknown[]) => values.every(value => value != null)
  ? addCount(...values.map(exact)) : null;

export async function readLocalAgent(source: ExtraAgentSource, file: string) {
  const found = new Map<string, JsonObject>();
  const conflict = new Set<string>();
  let missing = 0;
  const add = (identity: string, session: string, model: string, provider: string,
    time: string | number, project: string, fields: JsonObject) => {
    if (!identity || !session || !time || (typeof time === "string" && !/(Z|[+-]\d\d:\d\d)$/i.test(time))) { missing++; return; }
    const at = iso(typeof time === "number" ? time / 1000 : time);
    const usage = normalizeTokens(fields);
    if (!usage) { missing++; return; }
    const id = source + ":v1:" + hash(canonical(source === "claude" ? [identity] : [session, identity]));
    const evidence = { identity, session, model: model || "未识别模型", at, provider: provider || "未标注", project, usage };
    const previous = found.get(id);
    if (previous && canonical(previous.usage) !== canonical(usage)) conflict.add(id);
    if (!previous || at < previous.at)
      found.set(id, { id, source, agent: source, at, session, project, model: evidence.model, provider: evidence.provider, usage,
        evidence: { ...evidence, at: undefined } });
  };
  const openCode = (row: JsonObject, session?: string, id?: string, project?: string, v2 = false) => {
    const message = row.info || row;
    if ((message.type ?? message.role) !== "assistant" || !message.tokens || !message.time?.completed) return;
    const t = message.tokens;
    add(id || text(message.id), session || text(message.sessionID), text(message.model?.modelID || message.modelID), text(message.model?.providerID || message.providerID),
      Number(message.time.completed), project || text(message.path?.cwd), {
        input: sum(t.input, t.cache?.read, t.cache?.write), output: v2 ? sum(t.output, t.reasoning) : t.output,
        cached: t.cache?.read, cache_write_input_tokens: t.cache?.write, reasoning: t.reasoning,
      });
  };
  const span = (item: JsonObject, otlp = false) => {
    const attrs = Array.isArray(item.attributes)
      ? Object.fromEntries(item.attributes.filter((a: JsonObject) => typeof a.key === "string")
        .map((a: JsonObject) => [a.key, a.value?.stringValue ?? a.value?.intValue]))
      : item.attributes || {};
    if (attrs["gen_ai.operation.name"] !== "chat" || ![2, "2", "CLIENT", "SPAN_KIND_CLIENT"].includes(item.kind)) return;
    const nanos = item.endTimeUnixNano;
    const end = item.endTime;
    const at = /^\d+$/.test(String(nanos || "")) ? Number(BigInt(nanos) / 1000000n)
      : Array.isArray(end) ? Number(end[0]) * 1000 + Math.floor(Number(end[1]) / 1e6) : 0;
    const trace = item.traceId || item.spanContext?.traceId;
    const spanId = item.spanId || item.spanContext?.spanId;
    const request = trace && spanId && (otlp || typeof item.name === "string") ? trace + ":" + spanId : "";
    add(request, text(attrs["gen_ai.conversation.id"]), text(attrs["gen_ai.response.model"] || attrs["gen_ai.request.model"]), text(attrs["gen_ai.provider.name"]), at, "", {
      input: exact(attrs["gen_ai.usage.input_tokens"]), output: exact(attrs["gen_ai.usage.output_tokens"]),
      cached: exact(attrs["gen_ai.usage.cache_read.input_tokens"]), cache_write_input_tokens: exact(attrs["gen_ai.usage.cache_write.input_tokens"]),
      reasoning: exact(attrs["gen_ai.usage.reasoning.output_tokens"]),
    });
  };
  const consume = (row: JsonObject) => {
    if (!row || typeof row !== "object") return;
    if (source === "claude") {
      const m = row.message;
      if (row.type !== "assistant" || m?.type !== "message" || !m.usage || m.model === "<synthetic>") return;
      const u = m.usage;
      add(text(m.id), text(row.sessionId), text(m.model), "anthropic", text(row.timestamp), text(row.cwd), {
        input: sum(u.input_tokens, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0),
        output: u.output_tokens, cached: u.cache_read_input_tokens, cache_write_input_tokens: u.cache_creation_input_tokens,
      });
    } else if (source === "opencode") openCode(row);
    else if (source === "copilot") {
      if (Array.isArray(row.resourceSpans)) {
        for (const resource of row.resourceSpans)
          for (const scope of resource.scopeSpans || [])
            for (const item of scope.spans || []) span(item, true);
      } else span(row);
    } else {
      const step = row.step_update;
      if (row.event !== "step_update" || step?.state !== "DONE" || !step.usage || !Number.isSafeInteger(step.step_index)) return;
      const u = step.usage;
      add(String(step.step_index), text(step.conversation_id), text(step.model?.id || step.model || row.model), "google",
        text(row.timestamp || step.timestamp), "", {
          input: u.input_tokens, output: u.output_tokens, cached: u.cache_read_tokens,
          reasoning: u.thinking_tokens, total: u.total_tokens,
        });
    }
  };
  const extension = extname(file).toLowerCase();
  if ((source === "opencode" || source === "copilot") && [".db", ".sqlite"].includes(extension)) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
      if (source === "copilot") {
        if (!tables.has("assistant_usage_events") || !tables.has("sessions")) throw Error("未找到 Copilot 请求用量表，请选择 session-store.db");
        for (const row of db.prepare("SELECT a.id,a.session_id,a.model,a.input_tokens,a.output_tokens,a.cache_read_tokens,a.cache_write_tokens,a.reasoning_tokens,a.created_at,s.cwd FROM assistant_usage_events a LEFT JOIN sessions s ON s.id=a.session_id").iterate())
          add("event:" + row.id, text(row.session_id), text(row.model), "github", text(row.created_at), text(row.cwd), {
            input: row.input_tokens, output: row.output_tokens, cached: row.cache_read_tokens,
            cache_write_input_tokens: row.cache_write_tokens, reasoning: row.reasoning_tokens,
          });
      } else if (tables.has("session_message") && tables.has("session_v2")) {
        // Fork projections may copy parent messages. Skip copied/ambiguous prefixes.
        for (const row of db.prepare("SELECT m.id,m.session_id,m.data,s.directory,s.fork_session_id FROM session_message m JOIN session_v2 s ON s.id=m.session_id WHERE m.type='assistant'").iterate()) {
          if (row.fork_session_id) { missing++; continue; }
          openCode({...parseExact(String(row.data)),type:"assistant"},String(row.session_id),String(row.id),text(row.directory),true);
        }
      } else {
        if (!tables.has("message") || !tables.has("session")) throw new Error("未找到可识别的 OpenCode 消息表");
        for (const row of db.prepare("SELECT m.id,m.session_id,m.data,s.directory FROM message m JOIN session s ON s.id=m.session_id WHERE json_extract(m.data,'$.role')='assistant'").iterate())
          openCode(parseExact(String(row.data)), String(row.session_id), String(row.id), text(row.directory));
      }
    } finally { db.close(); }
  } else if (extension === ".json") {
    if (statSync(file).size > 32 * 1024 * 1024) throw new Error("JSON 导出超过 32 MiB，请分批导出");
    const value = parseExact(readFileSync(file, "utf8"));
    for (const row of Array.isArray(value) ? value : Array.isArray(value?.messages) ? value.messages : [value]) consume(row);
  } else {
    for await (const row of records(file, { maxBytes: 256 * 1024 * 1024 })) consume(row);
  }
  return {
    records: [...found.values()].filter(row => !conflict.has(row.id)),
    gaps: conflict.size + missing,
  };
}
