import { existsSync, statSync, realpathSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import {
  Monitor,
  normalizeTokens,
  integer,
  addCount,
  subtractCount,
  canonical,
  iso,
} from "./monitor.ts";
import { hash, parseExact, type JsonObject } from "./profile.ts";
import { records, listFiles } from "./log-readers.ts";

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
export class Codex {
  private scanning: Promise<JsonObject> | null = null;
  constructor(readonly monitor: Monitor) {}
  async parse(file: string) {
    const state: JsonObject = { lineage: {} },
      observations: JsonObject[] = [],
      readerState = { offset: 0 };
    for await (const record of records(file, {
      allowLargeResponse: true,
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
  get running() {
    return !!this.scanning;
  }
  async idle() {
    await this.scanning?.catch(() => {});
  }
  sync(root: string) {
    const previous = this.scanning,
      next = (
        previous ? previous.catch(() => undefined) : Promise.resolve()
      ).then(() => this.scan(root));
    this.scanning = next;
    next
      .finally(() => {
        if (this.scanning === next) this.scanning = null;
      })
      .catch(() => {});
    return next;
  }
  private async scan(root: string) {
    if (!existsSync(root) || !statSync(root).isDirectory())
      throw new Error("Codex sessions 目录不存在");
    const canonicalRoot = realpathSync(root),
      roots = [canonicalRoot],
      sibling = join(
        dirname(canonicalRoot),
        basename(canonicalRoot) === "sessions"
          ? "archived_sessions"
          : "sessions",
      );
    if (
      ["sessions", "archived_sessions"].includes(basename(canonicalRoot)) &&
      existsSync(sibling)
    )
      roots.push(realpathSync(sibling));
    const files = [
        ...new Set(
          (
            await Promise.all(
              roots.map((r) => listFiles(r, (n) => n.endsWith(".jsonl"))),
            )
          ).flat(),
        ),
      ].sort(),
      profile = this.monitor.profile,
      owner = profile.owner,
      db = profile.db,
      cursors = new Map(
        (
          db
            .prepare("SELECT * FROM cursors WHERE owner=?")
            .all(owner) as JsonObject[]
        ).map((r) => [r.path, r]),
      ),
      parsed: JsonObject[] = [],
      errors: JsonObject[] = [];
    let pending = 0;
    for (const file of files) {
      const stat = statSync(file, { bigint: true }),
        prior = cursors.get(file),
        state = prior ? parseExact(prior.state) : {};
      if (
        prior &&
        prior.offset === Number(stat.size) &&
        state.mtime === String(stat.mtimeNs) &&
        state.scannerVersion === 4
      )
        continue;
      if (parsed.length >= 3000) {
        pending++;
        continue;
      }
      try {
        parsed.push(await this.parse(file));
      } catch (error: any) {
        errors.push({
          file: basename(file),
          error: error.message.slice(0, 160),
        });
        db.prepare("INSERT OR REPLACE INTO codex_reads VALUES(?,?,?)").run(
          owner,
          file,
          error.message.slice(0, 160),
        );
      }
    }
    if (owner !== profile.owner) throw new Error("Profile 已切换");
    let imported = 0,
      corrected = 0;
    profile.transaction(() => {
      const pool = [
          ...(
            db
              .prepare(
                "SELECT id,verified,session,at,cumulative,last_usage,lineage FROM codex_evidence WHERE owner=?",
              )
              .all(owner) as JsonObject[]
          ).map((r) => ({
            ...r,
            cumulative: parseExact(r.cumulative),
            last_usage: parseExact(r.last_usage),
            lineage: parseExact(r.lineage),
          })),
          ...parsed.flatMap((r) => r.observations),
        ],
        inherited = new Map<string, string[]>(),
        ancestors = new Map<string, JsonObject>();
      for (const e of pool) {
        const key = canonical([e.session, e.cumulative, e.last_usage]);
        (inherited.get(key) || inherited.set(key, []).get(key)!).push(e.at);
        if (e.lineage?.parent) ancestors.set(e.session, e.lineage);
      }
      const retire = (id: string, reason: string) => {
        const old = db
          .prepare("SELECT * FROM events WHERE owner=? AND id=?")
          .get(owner, id) as JsonObject | undefined;
        if (old) {
          db.prepare(
            "INSERT OR IGNORE INTO codex_retired VALUES(?,?,?,?,?)",
          ).run(owner, id, canonical(old), reason, iso());
          db.prepare("DELETE FROM events WHERE owner=? AND id=?").run(
            owner,
            id,
          );
          corrected++;
        }
      };
      // A newly received parent can prove an unchanged child was inherited.
      // Recheck retained evidence without rereading every unchanged log file.
      for (const e of pool) {
        if (!e.verified || !e.id || !e.lineage?.parent) continue;
        let relation = e.lineage,
          seen = new Set([e.session]);
        while (relation?.parent && !seen.has(relation.parent)) {
          seen.add(relation.parent);
          if (
            (
              inherited.get(
                canonical([relation.parent, e.cumulative, e.last_usage]),
              ) || []
            ).some((at) => at && at <= relation.before)
          ) {
            retire(e.id, "inherited_copy");
            db.prepare(
              "UPDATE codex_evidence SET verified=0,usage='null',reason='inherited_copy' WHERE owner=? AND id=?",
            ).run(owner, e.id);
            break;
          }
          relation = ancestors.get(relation.parent);
        }
      }
      for (const item of parsed) {
        db.prepare("DELETE FROM codex_reads WHERE owner=? AND path=?").run(
          owner,
          item.path,
        );
        for (const e of item.observations as JsonObject[]) {
          let relation = e.lineage,
            seen = new Set([e.session]),
            shared = false;
          while (relation?.parent && !seen.has(relation.parent)) {
            seen.add(relation.parent);
            if (
              (
                inherited.get(
                  canonical([relation.parent, e.cumulative, e.last_usage]),
                ) || []
              ).some((at) => at && at <= relation.before)
            ) {
              shared = true;
              break;
            }
            relation = ancestors.get(relation.parent);
          }
          if (shared) {
            e.usage = null;
            e.verified = 0;
            e.reason = "inherited_copy";
            retire(e.id, "inherited_copy");
          }
          const existing = db
            .prepare("SELECT * FROM codex_evidence WHERE owner=? AND id=?")
            .get(owner, e.id) as JsonObject | undefined;
          if (existing?.verified && e.verified) {
            if (
              existing.usage !== canonical(e.usage) ||
              existing.model !== e.model
            ) {
              e.usage = null;
              e.verified = 0;
              e.reason = "conflicting_evidence";
              retire(e.id, e.reason);
            } else {
              db.prepare("INSERT OR IGNORE INTO codex_links VALUES(?,?,?)").run(
                owner,
                item.path,
                e.id,
              );
              continue;
            }
          } else if (
            existing &&
            e.reason !== "inherited_copy" &&
            (existing.verified ||
              ["conflicting_evidence", "conflicting_snapshot"].includes(
                existing.reason,
              ))
          ) {
            db.prepare("INSERT OR IGNORE INTO codex_links VALUES(?,?,?)").run(
              owner,
              item.path,
              e.id,
            );
            continue;
          }
          if (e.id.startsWith("codex:v4:s:") && e.verified && e.at) {
            const candidates = db
                .prepare(
                  "SELECT id,cumulative,last_usage FROM codex_evidence WHERE owner=? AND session=? AND at=? AND id<>? AND id LIKE 'codex:v4:s:%' AND (verified=1 OR reason='conflicting_snapshot')",
                )
                .all(owner, e.session, e.at, e.id) as JsonObject[],
              end = BigInt(e.cumulative.total),
              start = end - BigInt(e.usage.total);
            let conflicting = false;
            for (const c of candidates) {
              const last = parseExact(c.last_usage);
              if (!last) continue;
              const otherEnd = BigInt(parseExact(c.cumulative).total),
                otherStart = otherEnd - BigInt(last.total);
              if (
                (start > otherStart ? start : otherStart) <
                (end < otherEnd ? end : otherEnd)
              ) {
                retire(c.id, "conflicting_snapshot");
                db.prepare(
                  "UPDATE codex_evidence SET verified=0,reason='conflicting_snapshot' WHERE owner=? AND id=?",
                ).run(owner, c.id);
                conflicting = true;
              }
            }
            if (conflicting) {
              e.usage = null;
              e.verified = 0;
              e.reason = "conflicting_snapshot";
            }
          }
          const columns = [
            "id",
            "session",
            "at",
            "provider",
            "model",
            "cumulative",
            "last_usage",
            "usage",
            "baseline",
            "reason",
            "verified",
            "raw",
            "lineage",
          ];
          db.prepare(
            "INSERT OR REPLACE INTO codex_evidence VALUES(" +
              Array(14).fill("?").join(",") +
              ")",
          ).run(
            owner,
            ...columns.map((k) =>
              [
                "cumulative",
                "last_usage",
                "usage",
                "baseline",
                "raw",
                "lineage",
              ].includes(k)
                ? canonical(e[k])
                : e[k],
            ),
          );
          db.prepare("INSERT OR IGNORE INTO codex_links VALUES(?,?,?)").run(
            owner,
            item.path,
            e.id,
          );
          if (e.verified)
            imported += this.monitor.record(
              null,
              {
                id: e.id,
                at: e.at,
                source: "codex",
                agent: "Codex",
                provider: e.provider,
                model: e.model,
                session: e.session,
                project: e.project,
                auth_mode: "local-log",
              },
              e.usage,
            );
        }
        db.prepare("INSERT OR REPLACE INTO cursors VALUES(?,?,?,?)").run(
          owner,
          item.path,
          item.offset,
          canonical(item.state),
        );
      }
      db.prepare("INSERT OR REPLACE INTO codex_meta VALUES(?,?)").run(owner, 4);
    });
    return {
      imported,
      corrected,
      scanned: parsed.length,
      files: files.length,
      errors,
      truncated: !!pending,
      pending,
      syncedAt: iso(),
    };
  }
  coverage() {
    const db = this.monitor.profile.db,
      owner = this.monitor.profile.owner,
      rows = db
        .prepare(
          "SELECT session,cumulative,baseline,reason FROM codex_evidence WHERE owner=?",
        )
        .all(owner) as JsonObject[],
      known = new Set(rows.map((r) => canonical([r.session, r.cumulative]))),
      issues: JsonObject = {};
    for (const row of rows) {
      if (
        row.reason === "history_gap" &&
        known.has(canonical([row.session, row.baseline]))
      )
        continue;
      if (
        ![
          "verified",
          "context_estimate",
          "empty_snapshot",
          "inherited_copy",
        ].includes(row.reason)
      )
        issues[row.reason] = (issues[row.reason] || 0) + 1;
    }
    const failed = (
      db
        .prepare("SELECT count(*) count FROM codex_reads WHERE owner=?")
        .get(owner) as JsonObject
    ).count;
    if (failed) issues.unreadable_sources = failed;
    return {
      version: 4,
      incomplete: !!Object.keys(issues).length,
      issues,
      message: Object.keys(issues).length
        ? "历史记录不完整，仅统计已核验用量"
        : "",
    };
  }
}
