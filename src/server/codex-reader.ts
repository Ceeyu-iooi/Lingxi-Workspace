import {statSync} from "node:fs";
import {normalizeTokens,integer,addCount,subtractCount,canonical,iso} from "./monitor.ts";
import {hash,type JsonObject} from "./profile.ts";
import {records} from "./log-readers.ts";
const FIELDS = ["input", "output", "cached", "reasoning", "total"];
const real = (c: JsonObject | null) =>
  !!(
    c &&
    ["input", "output", "total"].every((k) => c[k] != null) &&
    BigInt(c.input) + BigInt(c.output) === BigInt(c.total) &&
    c.total > 0 &&
    (c.cached == null || c.cached <= c.input) &&
    (c.reasoning == null || c.reasoning <= c.output)
  );
const identical = (a: any, b: any) => canonical(a) === canonical(b);
const identityCounts = (c: JsonObject | null) =>
  c
    ? Object.fromEntries(
        Object.entries(c).map(([k, v]) => [
          k,
          ["cached", "reasoning"].includes(k) && v == null ? 0 : v,
        ]),
      )
    : null;
function decode(raw: any): JsonObject | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const cached = "cached_input_tokens" in raw ? raw.cached_input_tokens : 0,
    written =
      "cache_write_input_tokens" in raw ? raw.cache_write_input_tokens : 0,
    reasoning =
      "reasoning_output_tokens" in raw ? raw.reasoning_output_tokens : 0;
  if (cached == null || written == null || reasoning == null)
    throw new Error("日志 Token 明细不能是 null");
  for (const v of [
    raw.input_tokens,
    raw.output_tokens,
    raw.total_tokens,
    cached,
    written,
    reasoning,
  ])
    if (v != null) integer(v);
  const value = { ...raw },
    input = raw.input_tokens,
    output = raw.output_tokens,
    total = raw.total_tokens;
  if (
    input != null &&
    output != null &&
    total != null &&
    BigInt(total) !== BigInt(input) + BigInt(output) &&
    BigInt(total) ===
      BigInt(input) + BigInt(cached) + BigInt(written) + BigInt(output)
  )
    value.input_tokens = addCount(input, cached, written);
  if (input === 0 && output === 0 && total > 0)
    return {
      input: 0,
      output: 0,
      total,
      cached,
      reasoning: raw.reasoning_output_tokens ?? null,
    };
  return normalizeTokens(value);
}
function difference(current: JsonObject | null, previous: JsonObject | null) {
  if (
    !current ||
    !previous ||
    ["input", "output", "total"].some(
      (k) =>
        current[k] == null || previous[k] == null || current[k] < previous[k],
    )
  )
    return null;
  return Object.fromEntries(
    FIELDS.map((k) => [
      k,
      current[k] != null && previous[k] != null && current[k] >= previous[k]
        ? subtractCount(current[k], previous[k])
        : null,
    ]),
  );
}
export async function parseCodexFile(file: string) {
    const state: JsonObject = { lineage: {} },
      observations: JsonObject[] = [],
      readerState = { offset: 0 };
    for await (const record of records(file, {
      allowLargeResponse: true,
      codexUsageOnly: true,
      state: readerState,
    })) {
      if (!record || typeof record !== "object" || Array.isArray(record))
        continue;
      const payload = record.payload || {};
      if (typeof payload !== "object" || Array.isArray(payload)) continue;
      if (record.type === "session_meta") {
        state.session = String(payload.id || payload.session_id || "");
        state.provider = String(payload.model_provider || "未标注");
        state.project = String(payload.cwd || "");
        state.lineage = {};
        if (
          payload.forked_from_id &&
          payload.timestamp &&
          /([zZ]|[+-]\d{2}:?\d{2})$/.test(String(payload.timestamp))
        )
          try {
            state.lineage = {
              parent: String(payload.forked_from_id),
              before: iso(payload.timestamp),
            };
          } catch {}
      } else if (record.type === "turn_context")
        state.model = String(payload.model || "未识别模型");
      else if (record.type === "event_msg" && payload.type === "token_count") {
        const info = payload.info || {};
        if (typeof info !== "object" || Array.isArray(info))
          throw new Error("用量信息结构不正确");
        const current = decode(info.total_token_usage);
        if (!current || current.total == null) continue;
        const previous = state.counts || null;
        state.counts = current;
        const response =
          payload.response_id || info.response_id || record.response_id;
        if (identical(previous, current) && !response) continue;
        const lastRaw = info.last_token_usage,
          last = decode(lastRaw),
          context = !!(
            last &&
            last.input === 0 &&
            last.output === 0 &&
            last.total > 0
          ),
          delta = difference(current, previous),
          baseline = real(last) ? difference(current, last) : null;
        let usage = real(last)
            ? last
            : lastRaw == null && real(delta)
              ? delta
              : null,
          reason = usage
            ? "verified"
            : current.total === 0
              ? "empty_snapshot"
              : context
                ? "context_estimate"
                : "unverifiable_usage";
        if (context) usage = null;
        else if (
          real(last) &&
          !identical(delta, last) &&
          baseline &&
          Object.values(baseline).some(Boolean)
        )
          reason = "history_gap";
        else if (real(last) && !identical(delta, last) && !baseline)
          reason = "counter_mismatch";
        let at = "";
        try {
          if (
            !record.timestamp ||
            !/([zZ]|[+-]\d{2}:?\d{2})$/.test(String(record.timestamp))
          )
            throw new Error();
          at = iso(record.timestamp);
        } catch {
          reason = "missing_timestamp";
          usage = null;
        }
        if (!state.session) {
          reason = "missing_session";
          usage = null;
        } else if (
          !state.model ||
          ["未识别模型", "未标注"].includes(state.model)
        ) {
          reason = "missing_model";
          usage = null;
        }
        const identity = response
            ? [state.session, "response", String(response)]
            : [
                state.session,
                at || record.timestamp,
                identityCounts(current),
                identityCounts(last),
              ],
          id =
            "codex:v4:" + (response ? "r:" : "s:") + hash(canonical(identity));
        const raw = Object.fromEntries(
          ["total_token_usage", "last_token_usage"].map((kind) => [
            kind,
            Object.fromEntries(
              Object.entries(info[kind] || {}).filter(([k]) =>
                [
                  "input_tokens",
                  "output_tokens",
                  "total_tokens",
                  "cached_input_tokens",
                  "cache_write_input_tokens",
                  "reasoning_output_tokens",
                ].includes(k),
              ),
            ),
          ]),
        );
        observations.push({
          id,
          session: state.session || "",
          at,
          provider: state.provider || "未标注",
          model: state.model || "未识别模型",
          cumulative: current,
          last_usage: last,
          usage,
          baseline,
          reason,
          verified: Number(usage !== null),
          project: state.project || "",
          lineage: { ...state.lineage },
          raw,
        });
      }
    }
    const stat = statSync(file, { bigint: true });
    return {
      path: file,
      offset: readerState.offset,
      state: {
        scannerVersion: 4,
        mtime: String(stat.mtimeNs),
        size: Number(stat.size),
      },
      observations,
    };
  }
