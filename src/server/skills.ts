import {
  existsSync,
  statSync,
  realpathSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import {
  resolve,
  join,
  basename,
  dirname,
  isAbsolute,
  relative,
  sep,
  parse as parsePath,
} from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import { ProfileStore, hash, type JsonObject } from "./profile.ts";
import { Jobs } from "./control.ts";

const inside = (path: string, root: string) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
};
export class Skills {
  constructor(
    readonly profile: ProfileStore,
    readonly jobs: Jobs,
  ) {
    profile.db.exec(
      "CREATE TABLE IF NOT EXISTS skill_sources(owner TEXT,id TEXT,config TEXT,PRIMARY KEY(owner,id));CREATE TABLE IF NOT EXISTS skill_catalog(owner TEXT,id TEXT,title TEXT,description TEXT,body TEXT,meta TEXT,fingerprint TEXT,PRIMARY KEY(owner,id));CREATE TABLE IF NOT EXISTS skill_scan_state(owner TEXT PRIMARY KEY,value TEXT);CREATE INDEX IF NOT EXISTS skill_catalog_owner ON skill_catalog(owner,title)",
    );
  }
  defaults(): JsonObject[] {
    if (process.env.WORKBENCH_SKILL_ROOTS)
      return JSON.parse(process.env.WORKBENCH_SKILL_ROOTS);
    const home = process.env.USERPROFILE || homedir(),
      workspace = join(this.profile.root, "workspace"),
      rows = [
        ["shared", "共享 Agent", join(home, ".agents", "skills"), "user"],
        ["codex", "Codex", join(home, ".codex", "skills"), "user"],
        ["claude", "Claude Code", join(home, ".claude", "skills"), "user"],
        ["cursor", "Cursor", join(home, ".cursor", "skills"), "user"],
        ["gemini", "Gemini CLI", join(home, ".gemini", "skills"), "user"],
        ["dsh", "DeepSeek Harness", join(home, ".dsh", "skills"), "user"],
        [
          "codex-cache",
          "Codex 插件缓存",
          join(home, ".codex", "plugins", "cache"),
          "cache",
        ],
        [
          "claude-cache",
          "Claude 插件缓存",
          join(home, ".claude", "plugins", "cache"),
          "cache",
        ],
      ];
    for (const agent of ["agents", "codex", "claude", "cursor", "gemini"])
      rows.push([
        "project-" + agent,
        agent[0].toUpperCase() + agent.slice(1),
        join(workspace, "." + agent, "skills"),
        "project",
      ]);
    return rows.map(([id, name, path, kind]) => ({
      id,
      name,
      path,
      kind,
      project: kind === "project" ? basename(workspace) : "",
      enabled: true,
    }));
  }
  sources() {
    const rows = (
      this.profile.db
        .prepare("SELECT config FROM skill_sources WHERE owner=?")
        .all(this.profile.owner) as JsonObject[]
    ).map((r) => JSON.parse(r.config));
    return (rows.length ? rows : this.defaults()).map((r) => ({
      ...r,
      exists: existsSync(r.path) && statSync(r.path).isDirectory(),
    }));
  }
  source(body: JsonObject) {
    const db = this.profile.db,
      owner = this.profile.owner;
    const seed = () => {
      if (!db.prepare("SELECT 1 FROM skill_sources WHERE owner=?").get(owner))
        for (const row of this.defaults())
          db.prepare("INSERT INTO skill_sources VALUES(?,?,?)").run(
            owner,
            row.id,
            JSON.stringify(row),
          );
    };
    if (
      body.id &&
      Object.keys(body).every((k) => ["id", "enabled"].includes(k))
    ) {
      if (typeof body.enabled !== "boolean") throw new Error("来源开关不正确");
      const row = this.sources().find((r) => r.id === body.id);
      if (!row) throw new Error("来源不存在");
      delete row.exists;
      row.enabled = body.enabled;
      this.profile.transaction(() => {
        seed();
        db.prepare(
          "INSERT INTO skill_sources VALUES(?,?,?) ON CONFLICT(owner,id) DO UPDATE SET config=excluded.config",
        ).run(owner, row.id, JSON.stringify(row));
      });
      return { id: row.id, enabled: row.enabled };
    }
    if (body.delete) {
      db.prepare("DELETE FROM skill_sources WHERE owner=? AND id=?").run(
        owner,
        body.id,
      );
      return { id: body.id };
    }
    const input = String(body.path || "").replace(/^~(?=[\\/])/, homedir());
    if (
      !isAbsolute(input) ||
      input.startsWith("\\\\") ||
      input.startsWith("//")
    )
      throw new Error("请选择本机绝对目录");
    const path = realpathSync(input);
    if (
      !statSync(path).isDirectory() ||
      path === parsePath(path).root ||
      path.split(/[\\/]/).length < 3
    )
      throw new Error("请选择具体的技能目录");
    const id = body.id || hash(path).slice(0, 20),
      row = {
        id,
        name: String(body.name || "自定义技能来源")
          .trim()
          .slice(0, 80),
        path,
        kind: "custom",
        enabled: body.enabled !== false,
      };
    this.profile.transaction(() => {
      seed();
      db.prepare(
        "INSERT INTO skill_sources VALUES(?,?,?) ON CONFLICT(owner,id) DO UPDATE SET config=excluded.config",
      ).run(owner, id, JSON.stringify(row));
    });
    return { id };
  }
  scan() {
    const sources = this.sources(),
      owner = this.profile.owner,
      signature = JSON.stringify(
        sources.map((r) => [r.id, r.path, r.kind, r.enabled]),
      );
    return this.jobs.start("skills-scan", async (update) => {
      const allowed = sources
          .filter((s) => s.enabled !== false && existsSync(s.path))
          .map((s) => realpathSync(s.path)),
        found = new Map<string, JsonObject>(),
        coverage: JsonObject[] = [];
      let visited = 0;
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        if (source.enabled === false) continue;
        if (!source.exists) {
          coverage.push({ id: source.id, status: "missing", count: 0 });
          continue;
        }
        let count = 0,
          errors = 0,
          limited = false;
        const seen = new Set<string>();
        const walk = async (path: string, depth: number) => {
          let canonical: string;
          try {
            canonical = realpathSync(path);
          } catch {
            errors++;
            return;
          }
          if (seen.has(canonical) || !allowed.some((r) => inside(canonical, r)))
            return;
          seen.add(canonical);
          visited++;
          if (visited > 50000 || found.size >= 10000) {
            limited = true;
            return;
          }
          if (visited % 100 === 0)
            await new Promise<void>((r) => setImmediate(r));
          let children: ReturnType<typeof readdirSync>;
          try {
            children = readdirSync(canonical, { withFileTypes: true }) as any;
          } catch {
            errors++;
            return;
          }
          const skill = join(canonical, "SKILL.md");
          if (existsSync(skill))
            try {
              const real = realpathSync(skill);
              if (!allowed.some((r) => inside(real, r))) throw new Error();
              const stat = statSync(real);
              if (stat.size > 1024 * 1024 || !stat.isFile()) throw new Error();
              const sid = hash(real.toLowerCase()).slice(0, 24),
                alias = {
                  id: source.id,
                  agent: source.name,
                  kind: source.kind,
                  project: source.project || "",
                  path: skill,
                };
              if (found.has(sid)) {
                found.get(sid)!.meta.sources.push(alias);
                count++;
              } else {
                const body = readFileSync(real, "utf8").replace(/^\uFEFF/, ""),
                  front = body.startsWith("---")
                    ? body.split("---", 3)[1]
                    : null;
                let fields: JsonObject = {},
                  warning = "";
                if (front)
                  try {
                    fields = YAML.parse(front, { maxAliasCount: 50 }) || {};
                    if (typeof fields !== "object" || Array.isArray(fields))
                      throw new Error();
                  } catch {
                    fields = {};
                    warning = "元数据无法解析；仍可查看原文";
                  }
                found.set(sid, {
                  id: sid,
                  title:
                    typeof fields.name === "string"
                      ? fields.name.slice(0, 160)
                      : basename(dirname(real)),
                  description:
                    typeof fields.description === "string"
                      ? fields.description.slice(0, 2000)
                      : "",
                  body,
                  meta: {
                    path: real,
                    modified: stat.mtimeMs / 1000,
                    size: stat.size,
                    digest: hash(body),
                    version: String(fields.version || ""),
                    warning,
                    status: "未核验启用状态",
                    sources: [alias],
                  },
                  fingerprint: String(stat.mtimeMs) + ":" + stat.size,
                });
                count++;
              }
            } catch {
              errors++;
            }
          if (depth < 12)
            for (const child of children as any[])
              if (
                ![
                  ".git",
                  "node_modules",
                  "sessions",
                  "archived_sessions",
                  "dist",
                  "__pycache__",
                ].includes(child.name) &&
                (child.isDirectory() || child.isSymbolicLink())
              )
                await walk(join(canonical, child.name), depth + 1);
        };
        await walk(source.path, 0);
        coverage.push({
          id: source.id,
          status: limited ? "limited" : errors ? "partial" : "complete",
          count,
          errors,
        });
        update({
          progress: { done: i + 1, total: sources.length, skills: found.size },
        });
      }
      if (
        owner !== this.profile.owner ||
        signature !==
          JSON.stringify(
            this.sources().map((r) => [r.id, r.path, r.kind, r.enabled]),
          )
      )
        throw new Error("扫描期间来源发生变化，请刷新索引");
      const hashes = new Map<string, number>();
      for (const row of found.values())
        hashes.set(row.meta.digest, (hashes.get(row.meta.digest) || 0) + 1);
      for (const row of found.values())
        row.meta.duplicateCount = hashes.get(row.meta.digest);
      const result = {
        count: found.size,
        coverage,
        at: Date.now() / 1000,
        version: String(Date.now()),
      };
      this.profile.transaction(() => {
        const db = this.profile.db;
        db.prepare("DELETE FROM skill_catalog WHERE owner=?").run(owner);
        const put = db.prepare(
          "INSERT INTO skill_catalog VALUES(?,?,?,?,?,?,?)",
        );
        for (const r of found.values())
          put.run(
            owner,
            r.id,
            r.title,
            r.description,
            r.body,
            JSON.stringify(r.meta),
            r.fingerprint,
          );
        db.prepare(
          "INSERT INTO skill_scan_state VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET value=excluded.value",
        ).run(owner, JSON.stringify(result));
      });
      return result;
    });
  }
  search(params: JsonObject) {
    const registered = this.sources(),
      allowed = registered
        .filter((r) => r.enabled !== false)
        .map((r) => resolve(r.path)),
      ids = new Set(
        registered.filter((r) => r.enabled !== false).map((r) => r.id),
      ),
      q = String(params.q || "").toLowerCase(),
      items: JsonObject[] = [];
    for (const row of this.profile.db
      .prepare(
        "SELECT * FROM skill_catalog WHERE owner=? ORDER BY title COLLATE NOCASE",
      )
      .all(this.profile.owner) as JsonObject[]) {
      const meta = JSON.parse(row.meta);
      if (!allowed.some((r) => inside(meta.path, r))) continue;
      meta.sources = meta.sources.filter((s: JsonObject) => ids.has(s.id));
      if (
        q &&
        !(row.title + "\n" + row.description + "\n" + row.body)
          .toLowerCase()
          .includes(q)
      )
        continue;
      if (
        params.agent &&
        !meta.sources.some((s: JsonObject) => s.agent === params.agent)
      )
        continue;
      if (
        params.source &&
        !meta.sources.some(
          (s: JsonObject) => s.kind === params.source || s.id === params.source,
        )
      )
        continue;
      if (
        params.project &&
        !meta.sources.some((s: JsonObject) => s.project === params.project)
      )
        continue;
      if (["true", "1"].includes(params.duplicates) && meta.duplicateCount < 2)
        continue;
      items.push({
        id: row.id,
        title: row.title,
        description: row.description,
        meta,
      });
    }
    const offset = Math.max(0, Number(params.offset) || 0),
      limit = Math.min(100, Math.max(1, Number(params.limit) || 40)),
      scan = this.profile.db
        .prepare("SELECT value FROM skill_scan_state WHERE owner=?")
        .get(this.profile.owner) as JsonObject | undefined;
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      offset,
      limit,
      scan: scan ? JSON.parse(scan.value) : null,
      sources: registered,
      readonly: true,
    };
  }
  get(id: string) {
    const row = this.profile.db
      .prepare("SELECT * FROM skill_catalog WHERE owner=? AND id=?")
      .get(this.profile.owner, id) as JsonObject | undefined;
    if (!row) throw new Error("技能不存在");
    const meta = JSON.parse(row.meta),
      allowed = this.sources()
        .filter((s) => s.enabled !== false && s.exists)
        .map((s) => realpathSync(s.path));
    meta.available = existsSync(meta.path);
    const path = meta.available ? realpathSync(meta.path) : resolve(meta.path);
    if (!allowed.some((r) => inside(path, r)))
      throw new Error("技能来源已移除");
    return {
      id,
      title: row.title,
      description: row.description,
      content: row.body,
      meta,
      readonly: true,
    };
  }
}
