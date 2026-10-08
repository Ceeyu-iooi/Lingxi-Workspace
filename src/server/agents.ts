import {
  existsSync,
  statSync,
  realpathSync,
  copyFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join, basename, extname } from "node:path";
import Database from "better-sqlite3";
import {
  Monitor,
  normalizeTokens,
  integer,
  addCount,
  canonical,
  iso,
} from "./monitor.ts";
import { hash, parseExact, uid, type JsonObject } from "./profile.ts";
import { records, listFiles } from "./log-readers.ts";

type ReadState = [string, JsonObject];
export class Agents {
  private tasks = new Map<string, Promise<JsonObject>>();
  constructor(readonly monitor: Monitor) {}
  private store(source: string, items: JsonObject[], reads: ReadState[]) {
    const p = this.monitor.profile,
      db = p.db,
      owner = p.owner;
    let imported = 0,
      updated = 0;
    p.transaction(() => {
      for (const record of items) {
        const raw = canonical(record.evidence),
          reason = record.reason || "verified",
          verified = reason === "verified",
          id = record.id,
          prior = db
            .prepare("SELECT * FROM agent_evidence WHERE owner=? AND id=?")
            .get(owner, id) as JsonObject | undefined;
        if (
          prior &&
          source === "zcode" &&
          parseExact(prior.raw).origin === "database" &&
          record.evidence.origin !== "database"
        )
          continue;
        if (prior && prior.raw === raw && prior.reason === reason) continue;
        const old = db
          .prepare("SELECT * FROM events WHERE owner=? AND id=?")
          .get(owner, id) as JsonObject | undefined;
        if (old) {
          db.prepare(
            "INSERT OR REPLACE INTO agent_retired VALUES(?,?,?,?)",
          ).run(owner, id, canonical(old), "corrected_evidence");
          db.prepare("DELETE FROM events WHERE owner=? AND id=?").run(
            owner,
            id,
          );
          updated++;
        }
        db.prepare(
          "INSERT OR REPLACE INTO agent_evidence VALUES(?,?,?,?,?,?,?,?)",
        ).run(
          owner,
          id,
          source,
          raw,
          hash(raw),
          "usage-v18",
          Number(verified),
          reason,
        );
        if (verified) {
          const meta = Object.fromEntries(
            Object.entries(record).filter(
              ([k]) => !["evidence", "reason", "usage"].includes(k),
            ),
          );
          const added = this.monitor.record(null, meta, record.usage);
          if (!old) imported += added;
        }
      }
      for (const [path, state] of reads)
        db.prepare("INSERT OR REPLACE INTO agent_reads VALUES(?,?,?,?)").run(
          owner,
          source,
          path,
          canonical(state),
        );
    });
    return { imported, updated };
  }
  coverage(source: string) {
    const p = this.monitor.profile,
      rows = p.db
        .prepare(
          "SELECT reason,count(*) count FROM agent_evidence WHERE owner=? AND source=? GROUP BY reason",
        )
        .all(p.owner, source) as JsonObject[],
      reasons = Object.fromEntries(rows.map((r) => [r.reason, r.count])),
      reads = p.db
        .prepare("SELECT state FROM agent_reads WHERE owner=? AND source=?")
        .all(p.owner, source) as JsonObject[],
      readErrors = reads.filter((r) => parseExact(r.state).error).length;
    return {
      incomplete:
        !!readErrors ||
        rows.some((r) => r.reason !== "verified" && r.count > 0),
      reasons,
      readErrors,
      unverifiedLegacy: 0,
      message: "仅统计已核验的本机消费证据；缺失与冲突记录未补数",
      source,
      parserVersion: "usage-v18",
    };
  }
  get running() {
    return !!this.tasks.size;
  }
  async idle() {
    await Promise.allSettled(this.tasks.values());
  }
  sync(source: string, root: string) {
    const old = this.tasks.get(source),
      task = (old ? old.catch(() => undefined) : Promise.resolve()).then(() =>
        source === "dsh"
          ? this.scanDSH(root)
          : source === "zcode"
            ? this.scanZcode(root)
            : Promise.reject(new Error("来源不正确")),
      );
    this.tasks.set(source, task);
    task
      .finally(() => {
        if (this.tasks.get(source) === task) this.tasks.delete(source);
      })
      .catch(() => {});
    return task;
  }
  async parseDSH(file: string) {
    const rows: JsonObject[] = [];
    for await (const row of records(file, {
      compressed: true,
      maxBytes: 256 * 1024 * 1024,
    }))
      if (row && typeof row === "object" && !Array.isArray(row)) rows.push(row);
    const header = rows.find((r) => r.type === "session") || {},
      sid = header.id,
      version = header.version ?? null;
    if (typeof sid !== "string" || !sid || ![null, 2, 3, 4].includes(version))
      throw new Error("Harness 会话头或版本不受支持");
    const seeded = header.isSeeded === true || header.seedLength != null,
      cuts = rows
        .filter(
          (r) =>
            r.type === "session/end-seed" &&
            r.data?.inherited === true &&
            Number.isInteger(r.seq),
        )
        .map((r) => r.seq),
      cut = Number.isInteger(header.seedLength)
        ? header.seedLength
        : (cuts.at(-1) ?? null);
    if (seeded && cut === null)
      throw new Error("Harness 继承会话缺少可核验的边界");
    let model: any = null,
      provider: any = null;
    const settlements = new Map<string, JsonObject>(),
      retry = new Map<string, number>();
    for (const r of rows) {
      const kind = r.type,
        d = r.data || {};
      if (kind === "request/header") {
        model = d.header?.config?.model ?? null;
        provider = d.header?.config?.provider ?? null;
        continue;
      }
      const slot = [d.turn ?? null, d.step ?? null],
        slotKey = canonical(slot);
      if (kind === "llm/retry-started") {
        retry.set(slotKey, (retry.get(slotKey) || 0) + 1);
        continue;
      }
      if (
        ![
          "assistant/message",
          "assistant/attempt",
          "compaction/summary",
        ].includes(kind)
      )
        continue;
      if (seeded && (!Number.isInteger(r.seq) || r.seq < cut)) continue;
      const message = d.message || {},
        source = message.source || d.source || {},
        served =
          source.replayState?.response?.responseModel || source.model || model,
        routed = source.provider || provider;
      let usage = kind !== "assistant/attempt" ? d.usage : null;
      if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
        const chunks = (d.stream || [])
          .filter(
            (x: JsonObject) => x.type === "chunk" && x.chunk?.type === "usage",
          )
          .map((x: JsonObject) => x.chunk.usage);
        usage = chunks
          .reverse()
          .find((x: any) => x && typeof x === "object" && !Array.isArray(x));
      }
      if (!usage) continue;
      const attempt = retry.get(slotKey) || 0;
      let identity =
        kind === "assistant/attempt"
          ? d.attemptId || d.retryId || null
          : message.id || d.compactionId || null;
      if (kind === "compaction/summary" && !identity)
        identity = ["summary", r.seq ?? null, r.time ?? null];
      const stable = [
          sid,
          kind === "compaction/summary" ? kind : "settlement",
          slot,
          attempt,
          slot.every((x) => x === null) || kind === "compaction/summary"
            ? identity
            : null,
        ],
        id = "dsh:" + hash(canonical(stable));
      usage = Object.fromEntries(
        Object.entries(usage).filter(([k]) =>
          [
            "inputTokens",
            "outputTokens",
            "cacheReadTokens",
            "cacheWriteTokens",
            "reasoningTokens",
            "totalTokens",
          ].includes(k),
        ),
      );
      let reason = "verified",
        normalized: JsonObject | null = null,
        at = "";
      const evidence = {
        kind,
        session: sid,
        version,
        time: r.time ?? null,
        seq: r.seq ?? null,
        turn: slot[0],
        step: slot[1],
        attempt,
        identity,
        model: served,
        provider: routed,
        usage,
        seedCut: cut,
      };
      try {
        if (typeof r.time !== "number" || r.time <= 0)
          throw new Error("missing_timestamp");
        at = iso(r.time / 1000);
        if (typeof served !== "string" || !served)
          throw new Error("missing_model");
        for (const value of Object.values(usage)) {
          try {
            if (value === null) throw new Error();
            integer(value);
          } catch {
            throw new Error("invalid_usage");
          }
        }
        const input = usage.inputTokens,
          cached = usage.cacheReadTokens,
          written = usage.cacheWriteTokens,
          complete = [input, cached, written].some((v) => v == null)
            ? null
            : addCount(input, cached, written);
        normalized = normalizeTokens({
          input_tokens: complete,
          output_tokens: usage.outputTokens,
          total_tokens: usage.totalTokens,
          cached_input_tokens: cached,
          cache_write_input_tokens: written,
          reasoning_output_tokens: usage.reasoningTokens,
        });
        if (!normalized || normalized.total == null)
          throw new Error("missing_usage");
      } catch (error: any) {
        reason = [
          "missing_timestamp",
          "missing_model",
          "invalid_usage",
          "missing_usage",
        ].includes(error.message)
          ? error.message
          : "conflicting_usage";
        at = iso(0);
      }
      settlements.set(id, {
        id,
        at,
        source: "dsh",
        agent: "DeepSeek Harness",
        provider: routed || "未标注",
        model: served || "未识别模型",
        session: sid,
        project: String(header.cwd || ""),
        status: "success",
        auth_mode: "unconfirmed",
        usage: normalized,
        evidence,
        reason,
      });
    }
    return [...settlements.values()];
  }
  private async scanDSH(root: string) {
    if (!existsSync(root) || !statSync(root).isDirectory())
      throw new Error("Harness sessions 目录不存在");
    root = realpathSync(root);
    const p = this.monitor.profile,
      owner = p.owner,
      known = new Map(
        (
          p.db
            .prepare(
              "SELECT path,state FROM agent_reads WHERE owner=? AND source='dsh'",
            )
            .all(owner) as JsonObject[]
        ).map((r) => [r.path, parseExact(r.state)]),
      ),
      files = await listFiles(root, (n) => /^session.*\.jsonl/.test(n)),
      items: JsonObject[] = [],
      reads: ReadState[] = [],
      errors: JsonObject[] = [];
    let scanned = 0,
      pending = 0;
    for (const file of files) {
      const stat = statSync(file, { bigint: true }),
        fingerprint: JsonObject = {
          size: Number(stat.size),
          mtime: String(stat.mtimeNs),
        },
        prior = known.get(file) || {};
      if (
        prior.size === fingerprint.size &&
        prior.mtime === fingerprint.mtime &&
        !prior.error
      )
        continue;
      if (reads.length >= 3000) {
        pending++;
        continue;
      }
      try {
        if (fingerprint.size > 128 * 1024 * 1024)
          throw new Error("Harness 文件超过单次读取限制");
        items.push(...(await this.parseDSH(file)));
        scanned++;
        const after = statSync(file, { bigint: true });
        if (after.size !== stat.size || after.mtimeNs !== stat.mtimeNs)
          fingerprint.error = "文件正在写入，将继续采集";
      } catch (error: any) {
        fingerprint.error =
          "Harness 证据读取失败：" + error.message.slice(0, 100);
        errors.push({ file: basename(file), error: fingerprint.error });
      }
      reads.push([file, fingerprint]);
    }
    if (owner !== p.owner) throw new Error("Profile 已切换");
    return {
      files: files.length,
      scanned,
      ...this.store("dsh", items, reads),
      errors: errors.slice(0, 100),
      truncated: !!pending,
      pending,
      syncedAt: iso(),
      coverage:
        "Harness 本机真实用量；未含无 usage 的标题、搜索等调用，不自动归属 API Key",
    };
  }
  private async scanZcode(root: string) {
    if (!existsSync(root)) throw new Error("ZCode 用量目录不存在");
    root = realpathSync(root);
    const p = this.monitor.profile,
      owner = p.owner,
      known = new Map(
        (
          p.db
            .prepare(
              "SELECT path,state FROM agent_reads WHERE owner=? AND source='zcode'",
            )
            .all(owner) as JsonObject[]
        ).map((r) => [r.path, parseExact(r.state)]),
      ),
      database =
        statSync(root).isFile() && [".sqlite", ".db"].includes(extname(root))
          ? root
          : existsSync(join(root, "db", "db.sqlite"))
            ? join(root, "db", "db.sqlite")
            : join(root, "db.sqlite"),
      items = new Map<string, JsonObject>(),
      reads: ReadState[] = [],
      errors: JsonObject[] = [];
    let files = 0,
      scanned = 0,
      pending = 0,
      databaseIdentity = known.get(database)?.identity || false;
    const normalize = (u: JsonObject) => {
      const input = u.input_tokens,
        out = u.output_tokens,
        cached = u.cached_input_tokens,
        written = u.cache_write_input_tokens,
        total = u.total_tokens;
      if (
        [input, out, cached, written, total].every((v) => v != null) &&
        BigInt(total) !== BigInt(input) + BigInt(out)
      ) {
        if (
          BigInt(total) ===
          BigInt(input) + BigInt(cached) + BigInt(written) + BigInt(out)
        )
          u = { ...u, input_tokens: addCount(input, cached, written) };
        else throw new Error("ZCode 完整输入、缓存与总 Token 冲突");
      }
      return normalizeTokens(u);
    };
    const accept = (r: JsonObject, origin: string) => {
      scanned++;
      const id =
          "zcode:" +
          hash(String(r.session_id || "") + ":" + String(r.request_id)),
        u = r.usage;
      let reason = "verified",
        counts: JsonObject | null = null,
        at = "";
      try {
        if (r.stamp == null) throw new Error();
        at = iso(r.stamp);
        counts = normalize(u);
        if (!counts || counts.total == null || !r.model_id) throw new Error();
      } catch {
        reason = "conflicting_or_missing_usage";
        at = iso(0);
        counts = null;
      }
      if (origin === "model_io" && existsSync(database) && !databaseIdentity)
        reason = "unverified_source_overlap";
      const evidence = {
          usage: Object.fromEntries(
            [
              "input_tokens",
              "output_tokens",
              "total_tokens",
              "cached_input_tokens",
              "cache_write_input_tokens",
              "reasoning_output_tokens",
            ].map((k) => [k, u[k] ?? null]),
          ),
          request: r.request_id,
          model: r.model_id ?? null,
          provider: r.provider_id ?? null,
          timestamp: r.stamp ?? null,
          origin,
        },
        record = {
          id,
          at,
          source: "zcode",
          agent: r.agent || "ZCode",
          provider: r.provider_id || "未标注",
          model: r.model_id || "未识别模型",
          session: r.session_id || "",
          project: r.project || "",
          status: r.status || "success",
          duration_ms: r.duration_ms || null,
          auth_mode: "unconfirmed",
          usage: counts,
          evidence,
          reason,
        };
      if (!items.has(id) || origin === "database") items.set(id, record);
    };
    if (existsSync(database)) {
      files++;
      const paths = [database, database + "-wal"],
        stats = () =>
          paths.map((file) =>
            existsSync(file)
              ? [
                  String(statSync(file, { bigint: true }).size),
                  String(statSync(file, { bigint: true }).mtimeNs),
                ]
              : null,
          ),
        state: JsonObject = { files: stats() },
        prior = known.get(database) || {};
      if (canonical(prior.files) !== canonical(state.files) || prior.error) {
        const temp = join(p.root, "runtime", "zcode-read-" + uid());
        mkdirSync(temp, { recursive: true });
        try {
          const target = join(temp, "db.sqlite");
          let stable = false;
          for (let i = 0; i < 3; i++) {
            const before = stats();
            for (let j = 0; j < paths.length; j++) {
              const destination = target + (j ? "-wal" : "");
              if (existsSync(paths[j])) copyFileSync(paths[j], destination);
              else if (existsSync(destination)) rmSync(destination);
            }
            const after = stats();
            if (canonical(before) === canonical(after)) {
              stable = true;
              state.files = after;
              break;
            }
          }
          if (!stable) throw new Error("ZCode 正在写入，请稍后同步");
          const db = new Database(target);
          try {
            const columns = new Set(
              (
                db
                  .prepare("PRAGMA table_info(model_usage)")
                  .all() as JsonObject[]
              ).map((r) => r.name),
            );
            databaseIdentity = columns.has("logical_request_id");
            state.identity = databaseIdentity;
            if (
              [
                "id",
                "model_id",
                "started_at",
                "input_tokens",
                "output_tokens",
                "computed_total_tokens",
              ].some((k) => !columns.has(k))
            )
              throw new Error("数据库缺少受支持的 model_usage 表");
            const names = [
              "id",
              "logical_request_id",
              "attempt_index",
              "session_id",
              "model_id",
              "provider_id",
              "agent",
              "status",
              "started_at",
              "duration_ms",
              "input_tokens",
              "output_tokens",
              "reasoning_tokens",
              "cache_read_input_tokens",
              "cache_creation_input_tokens",
              "provider_total_tokens",
              "computed_total_tokens",
            ].filter((k) => columns.has(k));
            for (const raw of db
              .prepare(
                "SELECT " +
                  names.join(",") +
                  " FROM model_usage ORDER BY started_at,id",
              )
              .safeIntegers()
              .iterate() as Iterable<JsonObject>) {
              const r = Object.fromEntries(
                Object.entries(raw).map(([k, v]) => [
                  k,
                  typeof v === "bigint" && v <= BigInt(Number.MAX_SAFE_INTEGER)
                    ? Number(v)
                    : v,
                ]),
              );
              accept(
                {
                  ...r,
                  usage: {
                    input_tokens: r.input_tokens,
                    output_tokens: r.output_tokens,
                    total_tokens:
                      r.provider_total_tokens ?? r.computed_total_tokens,
                    cached_input_tokens: r.cache_read_input_tokens ?? null,
                    cache_write_input_tokens:
                      r.cache_creation_input_tokens ?? null,
                    reasoning_output_tokens: r.reasoning_tokens ?? null,
                  },
                  request_id:
                    String(r.logical_request_id || r.id) +
                    ":" +
                    String(r.attempt_index || 0),
                  stamp:
                    typeof r.started_at === "number"
                      ? r.started_at / 1000
                      : null,
                },
                "database",
              );
            }
          } finally {
            db.close();
          }
        } catch (error: any) {
          state.error = "ZCode 证据读取失败：" + error.message.slice(0, 100);
          errors.push({ file: basename(database), error: state.error });
        } finally {
          rmSync(temp, { recursive: true, force: true });
        }
        reads.push([database, state]);
      }
    }
    for (const file of statSync(root).isDirectory()
      ? await listFiles(root, (n) => /^model-io-.*\.jsonl$/.test(n))
      : []) {
      files++;
      const stat = statSync(file, { bigint: true }),
        state: JsonObject = {
          size: Number(stat.size),
          mtime: String(stat.mtimeNs),
          databaseMode: existsSync(database) ? databaseIdentity : null,
        };
      if (canonical(known.get(file)) === canonical(state)) continue;
      if (reads.length >= 3000) {
        pending++;
        continue;
      }
      const readState = { offset: 0 };
      try {
        for await (const x of records(file, { state: readState })) {
          if (x.type !== "model_io") continue;
          if (!("requestId" in x)) throw new Error();
          const response = x.response || {},
            u = response.usage || {},
            model = x.model || {};
          accept(
            {
              request_id: String(x.requestId) + ":" + String(x.attempt || 0),
              stamp:
                typeof x.startedAt === "number"
                  ? x.startedAt / 1000
                  : x.startedAt,
              session_id: x.sessionId || "",
              model_id: response.modelId || model.modelId,
              provider_id: model.providerId,
              status: x.error ? "error" : "success",
              duration_ms: x.durationMs,
              usage: {
                input_tokens: u.inputTokens,
                output_tokens: u.outputTokens,
                total_tokens: u.totalTokens,
                cached_input_tokens: u.cacheReadTokens,
                cache_write_input_tokens:
                  u.cacheWriteTokens ?? u.cacheCreationTokens,
                reasoning_output_tokens: u.reasoningTokens,
              },
            },
            "model_io",
          );
        }
        if (readState.offset < Number(stat.size)) state.error = "尾行尚未完成";
      } catch {
        state.error = "ZCode JSONL 证据读取失败";
        errors.push({ file: basename(file), error: state.error });
      }
      reads.push([file, state]);
    }
    if (owner !== p.owner) throw new Error("Profile 已切换");
    return {
      files,
      scanned,
      ...this.store("zcode", [...items.values()], reads),
      errors: errors.slice(0, 100),
      truncated: !!pending,
      pending,
      syncedAt: iso(),
      coverage: "ZCode 数据库／响应日志；同一请求只计一次，缺失或冲突未补数",
    };
  }
}
