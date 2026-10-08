import {
  readdirSync,
  statSync,
  lstatSync,
  existsSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  copyFileSync,
  renameSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { resolve, join, relative, dirname, isAbsolute, sep } from "node:path";
import Database from "better-sqlite3";
import {
  ProfileStore,
  readJson,
  atomicJson,
  safePath,
  hash,
  uid,
  type JsonObject,
} from "./profile.ts";
import { Monitor } from "./monitor.ts";
import { Pricing, ValuationTasks } from "./pricing.ts";

export function validateTarget(target: string, source?: string) {
  if (typeof target !== "string" || !isAbsolute(target) || !target.trim())
    throw new Error("请选择绝对资料路径");
  const normalized = resolve(target);
  safePath(normalized, ".profile.json");
  if (source) {
    const current = resolve(source),
      a = relative(current, normalized),
      b = relative(normalized, current);
    if (
      !a ||
      (!a.startsWith(".." + sep) && a !== ".." && !isAbsolute(a)) ||
      (!b.startsWith(".." + sep) && b !== ".." && !isAbsolute(b))
    )
      throw new Error("资料目录不能相同或相互包含");
  }
  return normalized;
}
function walk(root: string, fn: (file: string, relativePath: string) => void) {
  if (!existsSync(root)) return;
  const visit = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("资料目录不能包含链接");
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
    } else if (stat.isFile()) fn(path, relative(root, path));
  };
  visit(root);
}
export function preflight(source: string, target: string) {
  source = realpathSync(source);
  target = validateTarget(target, source);
  if (existsSync(target) && readdirSync(target).length)
    throw new Error("请选择空的目标目录");
  mkdirSync(target, { recursive: true });
  const probe = join(target, ".writable-" + uid());
  try {
    writeFileSync(probe, "", { flag: "wx" });
  } catch {
    throw new Error("资料目录不可写，请选择其他位置");
  } finally {
    if (existsSync(probe)) unlinkSync(probe);
  }
  let bytes = 0;
  walk(source, (file) => {
    bytes += statSync(file).size;
  });
  return { source, target, bytes };
}
export function profileStorage(profile: ProfileStore, monitor: Monitor) {
  const rows = [
      ["databases", "数据库"],
      ["backups", "备份"],
      ["browser", "浏览器资料"],
      ["updates", "更新安装包"],
      ["logs", "日志与崩溃记录"],
      ["other", "其他资料"],
    ].map(([id, label]) => ({ id, label, bytes: 0 })),
    totals = Object.fromEntries(rows.map((r) => [r.id, r]));
  let incomplete = false;
  const visit = (directory: string) => {
    let children: ReturnType<typeof readdirSync>;
    try {
      children = readdirSync(directory, { withFileTypes: true }) as any;
    } catch {
      incomplete = true;
      return;
    }
    for (const child of children as any[]) {
      const file = join(directory, child.name);
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) {
        visit(file);
        continue;
      }
      if (!child.isFile()) continue;
      try {
        const rel = relative(profile.root, file).split(sep),
          kind =
            rel[0] === "backups" ||
            rel.slice(0, 3).join("/") === "data/storage/recovery"
              ? "backups"
              : rel[0] === "browser"
                ? "browser"
                : rel[0] === "updates"
                  ? "updates"
                  : rel[0] === "logs" ||
                      rel.slice(0, 2).join("/") === "runtime/crashes"
                    ? "logs"
                    : /\.(db|sqlite|sqlite3)(-wal|-shm)?$/i.test(child.name)
                      ? "databases"
                      : "other";
        totals[kind].bytes += statSync(file).size;
      } catch {
        incomplete = true;
      }
    }
  };
  visit(profile.root);
  const size = (path: string) => {
      let n = 0;
      try {
        walk(path, (file) => {
          n += statSync(file).size;
        });
      } catch {
        incomplete = true;
      }
      return n;
    },
    db = profile.db,
    blobs = db
      .prepare(
        "SELECT coalesce(sum(length(body)),0) compressed,coalesce(sum(raw_size),0) raw FROM evidence_blobs",
      )
      .get() as JsonObject,
    derived = db
      .prepare(
        "SELECT coalesce(sum(length(cast(result as blob))),0) bytes FROM radar_values",
      )
      .get() as JsonObject;
  return {
    totalBytes: rows.reduce((n, r) => n + r.bytes, 0),
    categories: rows,
    incomplete,
    databaseBytes: totals.databases.bytes,
    businessBytes: size(join(profile.root, "data")),
    priceEvidenceCompressedBytes: blobs.compressed,
    priceEvidenceRawBytes: blobs.raw,
    valuationPayloadBytes: derived.bytes,
    backupsBytes: totals.backups.bytes,
    browserCacheBytes: ["Cache", "Code Cache", "GPUCache"].reduce(
      (n, p) => n + size(join(profile.root, "browser", p)),
      0,
    ),
    responseCacheBytes: monitor.responseCache.bytes,
    responseCacheBudget: monitor.responseCache.budget,
    compression: { status: "complete" },
  };
}
export function clearDerived(
  profile: ProfileStore,
  monitor: Monitor,
  valuation: ValuationTasks,
) {
  if (valuation.running) throw new Error("请先取消正在进行的计价准备");
  for (const scope of ["codex", "zcode", "dsh"]) valuation.disable(scope);
  profile.db
    .prepare("DELETE FROM radar_values WHERE owner=?")
    .run(profile.owner);
  monitor.responseCache.clear();
  return { ok: true, evidenceRetained: true };
}
/* Called only after the launcher has stopped its owned service process. */
export function moveProfile(source: string, target: string, locator: string) {
  const plan = preflight(source, target),
    lock = new ProfileStore(plan.source),
    stage = join(dirname(plan.target), ".lingxi-move-" + uid());
  safePath(dirname(plan.target), relative(dirname(plan.target), stage));
  mkdirSync(stage, { recursive: true });
  if (lock.database) lock.db.pragma("wal_checkpoint(TRUNCATE)");
  const manifest: JsonObject[] = [];
  try {
    walk(plan.source, (file, rel) => {
      if (
        rel === join("runtime", ".writer.lock") ||
        rel === join("data", ".maintenance-request.json") ||
        /-wal$|-shm$/.test(file)
      )
        return;
      const dest = safePath(stage, rel);
      mkdirSync(dirname(dest), { recursive: true });
      if (/\.(sqlite|sqlite3|db)$/i.test(file)) {
        const owned =
          rel === join("data", "storage", "workbench.sqlite")
            ? lock.db
            : new Database(file, { readonly: true });
        try {
          owned.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
        } finally {
          if (owned !== lock.db) owned.close();
        }
      } else copyFileSync(file, dest);
      const bytes = statSync(dest).size;
      manifest.push({
        path: rel,
        bytes,
        digest: hash(requireBytes(dest)),
        sourceDigest: hash(requireBytes(file)),
      });
    });
    const db = new Database(join(stage, "data/storage/workbench.sqlite"), {
      readonly: true,
    });
    try {
      if (db.pragma("integrity_check", { simple: true }) !== "ok")
        throw new Error("目标数据库完整性检查失败");
    } finally {
      db.close();
    }
    const metadata = readJson<JsonObject>(join(stage, ".profile.json"), {});
    if (metadata.profileId !== lock.owner) throw new Error("资料身份核验失败");
    for (const item of manifest)
      if (hash(requireBytes(safePath(stage, item.path))) !== item.digest)
        throw new Error("资料复制校验失败");
    atomicJson(join(stage, "data", "migration-journal.json"), {
      source: plan.source,
      target: plan.target,
      profileId: lock.owner,
      manifest,
      oldRetained: true,
    });
    if (readdirSync(plan.target).length)
      throw new Error("目标在迁移期间被写入");
    rmdirSync(plan.target);
    renameSync(stage, plan.target);
    atomicJson(locator, {
      root: plan.target,
      onboarding: { profileConfirmed: true, accountPending: false },
    });
    return { ok: true, ...plan, profileId: lock.owner };
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  } finally {
    lock.close();
  }
}
export function removeOld(root: string) {
  const journal = readJson<JsonObject>(
    join(root, "data", "migration-journal.json"),
    {},
  );
  if (!journal.source || !journal.oldRetained) return { ok: true, changed: [] };
  const source = validateTarget(journal.source, root),
    changed: string[] = [];
  const metadata = readJson<JsonObject>(join(source, ".profile.json"), {});
  if (metadata.profileId !== journal.profileId)
    throw new Error("旧副本身份不正确");
  const lock = new ProfileStore(source, { lockOnly: true });
  try {
    const wal = join(source, "data/storage/workbench.sqlite-wal");
    if (existsSync(wal) && statSync(wal).size > 0)
      throw new Error("旧副本仍有未归并的数据库事务，未清理");
    const removable: string[] = [];
    for (const item of journal.manifest) {
      const file = safePath(source, item.path);
      if (!existsSync(file)) continue;
      if (
        !lstatSync(file).isFile() ||
        hash(requireBytes(file)) !== (item.sourceDigest || item.digest)
      ) {
        changed.push(item.path);
        continue;
      }
      removable.push(file);
    }
    for (const file of removable)
      if (!changed.length || file !== join(source, ".profile.json"))
        unlinkSync(file);
    journal.oldRetained = !!changed.length;
    atomicJson(join(root, "data", "migration-journal.json"), journal);
    return { ok: true, changed };
  } finally {
    lock.close();
  }
}
import { readFileSync } from "node:fs";
const requireBytes = (file: string) => readFileSync(file);
