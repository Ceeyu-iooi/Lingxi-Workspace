import { existsSync, statSync, realpathSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { Monitor, canonical, iso } from "./monitor.ts";
import { parseExact, type JsonObject } from "./profile.ts";
import { listFiles } from "./log-readers.ts";
import { parseCodexFile } from "./codex-reader.ts";
import { parseCodexBatch } from "./codex-reader-pool.ts";
import { CompactCodexWriter } from "./usage-storage.ts";

export class Codex {
  private scanning: Promise<JsonObject> | null = null;
  private rootJobs = new Map<string,Promise<JsonObject>>();
  constructor(readonly monitor: Monitor) {}
  parse(file:string){return parseCodexFile(file);}
  get running() {
    return !!this.scanning;
  }
  async idle() {
    await this.scanning?.catch(() => {});
  }
  sync(root: string) {
    const active=this.rootJobs.get(root);
    if(active)return active;
    const previous = this.scanning,
      next = (
        previous ? previous.catch(() => undefined) : Promise.resolve()
      ).then(() => this.scan(root));
    this.scanning = next;
    this.rootJobs.set(root,next);
    next
      .finally(() => {
        if (this.scanning === next) this.scanning = null;
        if(this.rootJobs.get(root)===next)this.rootJobs.delete(root);
      })
      .catch(() => {});
    return next;
  }
  private async scan(root: string) {
    const begun=performance.now();
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
    const discovered=performance.now();
    const changed:string[]=[];
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
      if (changed.length >= 3000) {
        pending++;
        continue;
      }
      changed.push(file);
    }
    for(const result of await parseCodexBatch(changed)){
      if(result.item)parsed.push(result.item);
      else if(result.error){
        errors.push(result.error);
        db.prepare("INSERT OR REPLACE INTO codex_reads VALUES(?,?,?)").run(
          owner,
          result.path,
          result.error.error,
        );
      }
    }
    if (owner !== profile.owner) throw new Error("Profile 已切换");
    const parsedAt=performance.now();
    // Nothing changed: previously reconciled evidence cannot acquire a new
    // ancestor or conflict. Avoid decoding the entire retained history again.
    if (!parsed.length) return {imported:0,corrected:0,scanned:0,files:files.length,errors,truncated:!!pending,pending,syncedAt:iso()};
    let imported = 0,
      corrected = 0;
    profile.transaction(() => {
      const writer=db.usageStorage?new CompactCodexWriter(db,owner):null;
      const retained: JsonObject[] = (
            db
              .prepare(
                "SELECT id,verified,session,at,cumulative,last_usage,lineage,usage,model,reason FROM codex_evidence WHERE owner=?",
              )
              .all(owner) as JsonObject[]
          ).map((r) => ({
            ...r,
            cumulative: parseExact(r.cumulative),
            last_usage: parseExact(r.last_usage),
            lineage: parseExact(r.lineage),
          })),
        pool = [...retained, ...parsed.flatMap((r) => r.observations)],
        existingById = new Map<string, JsonObject>(retained.map(e=>[e.id,e])),
        snapshots = new Map<string, Map<string, JsonObject>>(),
        inherited = new Map<string, string[]>(),
        ancestors = new Map<string, JsonObject>();
      const rememberSnapshot = (e:JsonObject) => {
        if(!e.id.startsWith('codex:v4:s:'))return;
        const key=canonical([e.session,e.at]);
        let bucket=snapshots.get(key);
        if(!bucket)snapshots.set(key,bucket=new Map());
        bucket.set(e.id,e);
      };
      retained.forEach(rememberSnapshot);
      for (const e of pool) {
        const key = canonical([e.session, e.cumulative, e.last_usage]);
        (inherited.get(key) || inherited.set(key, []).get(key)!).push(e.at);
        if (e.lineage?.parent) ancestors.set(e.session, e.lineage);
      }
      const retire = (id: string, reason: string) => {
        if(writer)imported+=writer.flush();
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
            e.verified=0;e.reason='inherited_copy';e.usage='null';
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
          const existing = existingById.get(e.id);
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
            // The compatibility view's ordering made this query scan all of
            // the owner's evidence for every snapshot. The transaction already
            // owns this exact evidence set; index only the same session/time.
            const candidates = [...(snapshots.get(canonical([e.session,e.at]))?.values()||[])]
                .filter(c=>c.id!==e.id&&(c.verified||c.reason==='conflicting_snapshot')),
              end = BigInt(e.cumulative.total),
              start = end - BigInt(e.usage.total);
            let conflicting = false;
            for (const c of candidates) {
              const last = c.last_usage;
              if (!last) continue;
              const otherEnd = BigInt(c.cumulative.total),
                otherStart = otherEnd - BigInt(last.total);
              if (
                (start > otherStart ? start : otherStart) <
                (end < otherEnd ? end : otherEnd)
              ) {
                retire(c.id, "conflicting_snapshot");
                db.prepare(
                  "UPDATE codex_evidence SET verified=0,reason='conflicting_snapshot' WHERE owner=? AND id=?",
                ).run(owner, c.id);
                c.verified=0;c.reason='conflicting_snapshot';
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
          const encoded=Object.fromEntries(columns.map(k=>[k,
            ['cumulative','last_usage','usage','baseline','raw','lineage'].includes(k)?canonical(e[k]):e[k]]));
          const meta={id:e.id,at:e.at,source:'codex',agent:'Codex',provider:e.provider,model:e.model,session:e.session,project:e.project,auth_mode:'local-log'};
          if(writer)imported+=writer.add({...encoded,owner},e.verified?this.monitor.formatEvent(null,meta,e.usage):null,item.path);
          else {
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
          const stored={...e,usage:canonical(e.usage)};
          existingById.set(e.id,stored);
          rememberSnapshot(stored);
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
          existingById.set(e.id,{...e,usage:canonical(e.usage)});
          rememberSnapshot(existingById.get(e.id)!);
        }
        db.prepare("INSERT OR REPLACE INTO cursors VALUES(?,?,?,?)").run(
          owner,
          item.path,
          item.offset,
          canonical(item.state),
        );
      }
      if(writer)imported+=writer.flush();
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
      timings:{discoverMs:discovered-begun,parseMs:parsedAt-discovered,commitMs:performance.now()-parsedAt},
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
