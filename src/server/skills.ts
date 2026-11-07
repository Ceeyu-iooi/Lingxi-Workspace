// 技能接口门面：保留原有 /api/skills* 的响应结构（前端兼容），
// 领域能力由 SkillManager 提供（中央库、预设、工作区、部署、上游检查）。
// 安全约束：只读扫描已登记目录，不执行 SKILL.md 或任何脚本；所有路径经 realpath 校验。
import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { homedir } from "node:os";
import { ProfileStore, hash, type JsonObject } from "./profile.ts";
import { Jobs } from "./control.ts";
import { packText } from "./compressed-text.ts";
import { SkillManager, rootInside, safeRealpath, requireInside } from "./skill-manager.ts";
import { skillPresentation } from "../shared/skill-presentation.ts";

const inside = (path: string, root: string) => rootInside(path, root);

export class Skills {
  readonly manager: SkillManager;
  constructor(
    readonly profile: ProfileStore,
    readonly jobs: Jobs,
  ) {
    this.manager = new SkillManager(profile);
    // 兼容旧表结构；新索引仍然写这两张表，保证旧接口与统计可用。
    profile.db.exec(
      "CREATE TABLE IF NOT EXISTS skill_presentations(owner TEXT,id TEXT,title TEXT,description TEXT,PRIMARY KEY(owner,id));CREATE TABLE IF NOT EXISTS skill_sources(owner TEXT,id TEXT,config TEXT,PRIMARY KEY(owner,id));CREATE TABLE IF NOT EXISTS skill_catalog(owner TEXT,id TEXT,title TEXT,description TEXT,body TEXT,meta TEXT,fingerprint TEXT,PRIMARY KEY(owner,id));CREATE TABLE IF NOT EXISTS skill_scan_state(owner TEXT PRIMARY KEY,value TEXT);CREATE INDEX IF NOT EXISTS skill_catalog_owner ON skill_catalog(owner,title)",
    );
  }
  /** 旧来源列表，现由 SkillManager 的 Agent 目录推导，字段保持原样。 */
  defaults(): JsonObject[] {
    if (process.env.WORKBENCH_SKILL_ROOTS) {
      const rows = JSON.parse(process.env.WORKBENCH_SKILL_ROOTS) as JsonObject[];
      return rows.map((row) => ({ ...row }));
    }
    return this.manager.legacySources().map((row) => ({ ...row }));
  }
  private sourceRows(): JsonObject[] {
    if (process.env.WORKBENCH_SKILL_ROOTS)
      return (JSON.parse(process.env.WORKBENCH_SKILL_ROOTS) as JsonObject[]).map((r) => ({
        ...r,
        enabled: r.enabled !== false,
      }));
    const stored = (
      this.profile.db
        .prepare("SELECT config FROM skill_sources WHERE owner=?")
        .all(this.profile.owner) as JsonObject[]
    ).map((r) => JSON.parse(r.config) as JsonObject);
    const live = this.manager.legacySources().map((row) => ({ ...row }) as JsonObject);
    // 记录过的开关与新增目录合并：以实时目录为准，开关取已保存值。
    const saved = new Map(stored.map((r) => [String(r.id), r]));
    return live.map((row) => {
      const prev = saved.get(String(row.id));
      return prev && typeof prev.enabled === "boolean" ? { ...row, enabled: prev.enabled } : row;
    });
  }
  sources(): JsonObject[] {
    return this.sourceRows().map((r) => ({
      ...r,
      exists: (() => {
        try {
          return statSync(String(r.path)).isDirectory();
        } catch {
          return false;
        }
      })(),
    }));
  }
  source(body: JsonObject) {
    if (body.id && Object.keys(body).every((k) => ["id", "enabled"].includes(k))) {
      const result = this.manager.legacyToggleSource(body);
      this.persistToggle(String(result.id), result.enabled);
      return result;
    }
    if (body.delete) {
      const result = this.manager.legacyDeleteSource(body);
      this.profile.db.prepare("DELETE FROM skill_sources WHERE owner=? AND id=?").run(this.profile.owner, String(body.id));
      return result;
    }
    const input = String(body.path || "").replace(/^~(?=[\\/])/, homedir());
    const result = this.manager.legacyAddSource({ ...body, path: input });
    this.persistToggle(String(result.id), body.enabled !== false);
    return result;
  }
  private persistToggle(id: string, enabled: boolean) {
    const row = this.sources().find((r) => r.id === id);
    if (!row) return;
    const config: JsonObject = { ...row, enabled };
    delete config.exists;
    this.profile.db
      .prepare(
        "INSERT INTO skill_sources VALUES(?,?,?) ON CONFLICT(owner,id) DO UPDATE SET config=excluded.config",
      )
      .run(this.profile.owner, id, JSON.stringify(config));
  }
  /** 只读扫描：吸收中央库尚不存在的技能，同时维护旧目录表。 */
  scan() {
    const sources = this.sources(),
      owner = this.profile.owner,
      signature = JSON.stringify(sources.map((r) => [r.id, r.path, r.kind, r.enabled]));
    return this.jobs.start("skills-scan", async (update) => {
      const result = await this.manager.scan((values) => update(values));
      if (owner !== this.profile.owner || signature !== JSON.stringify(this.sources().map((r) => [r.id, r.path, r.kind, r.enabled])))
        throw new Error("扫描期间来源发生变化，请刷新索引");
      this.syncLegacyCatalog();
      this.profile.db
        .prepare(
          "INSERT INTO skill_scan_state VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET value=excluded.value",
        )
        .run(owner, JSON.stringify(result));
      return result;
    });
  }
  /**
   * 把中央库内容整理成旧目录表：id 稳定（相对登记根的大小写不敏感摘要），
   * 正文与元数据同样 packText 压缩，保证旧接口读到的结构与原来一致。
   */
  private syncLegacyCatalog() {
    const roots = this.sources()
      .filter((r) => r.enabled !== false)
      .map((r) => safeRealpath(String(r.path)))
      .filter((r): r is string => !!r);
    const libraryRoot = this.manager.libraryRoot,
      canonicalLibrary = safeRealpath(libraryRoot);
    const records = new Map<
      string,
      { title: string; description: string; body: string; meta: JsonObject; fingerprint: string }
    >();
    if (!canonicalLibrary) return records;
    for (const card of this.manager.librarySkills()) {
      const detail = this.manager.detail({ id: card.id });
      const path = detail.path;
      const owner = roots.find((r) => inside(path, r)) || canonicalLibrary;
      const id = hash((path || "").toLowerCase()).slice(0, 24);
      if (records.has(id)) continue;
      const digits = (card.bytes || 0) > 0 ? card.files : 0;
      records.set(id, {
        title: card.name,
        description: card.description,
        body: detail.content,
        meta: {
          path,
          modified: 0,
          size: detail.content.length,
          digest: card.digest,
          version: "",
          warning: card.warning,
          status: "未核验启用状态",
          files: digits,
          bytes: card.bytes,
          sources: this.sources()
            .filter((s) => s.enabled !== false && safeRealpath(String(s.path)) && inside(path, safeRealpath(String(s.path))!))
            .map((s) => ({
              id: s.id,
              agent: s.name,
              kind: s.kind,
              project: s.project || "",
              path,
            })),
          libraryId: card.id,
          tags: card.tags,
          libraryStatus: card.libraryStatus,
          agentBadges: card.agents.map((b) => ({ agentId: b.agentId, deployed: b.deployed, status: b.status, mode: b.mode })),
        },
        fingerprint: card.fingerprint,
      });
      void owner;
    }
    this.manager.writeLegacyCatalog(records);
    return records;
  }
  presentation(body: JsonObject) {
    const result = this.manager.presentation(body);
    const legacy = this.legacyGet(result.id);
    return legacy || result;
  }
  private legacyGet(id: string) {
    const cards = this.manager.librarySkills();
    const card = cards.find((c) => c.id === id);
    return card ? card : null;
  }
  /** 旧搜索接口：改为读取中央库，保留字段结构（items/total/offset/limit/scan/sources/readonly）。 */
  search(params: JsonObject) {
    const registered = this.sources(),
      allowed = registered
        .filter((r) => r.enabled !== false)
        .map((r) => {
          try {
            return realpathSync(String(r.path));
          } catch {
            return resolve(String(r.path));
          }
        }),
      ids = new Set(registered.filter((r) => r.enabled !== false).map((r) => String(r.id))),
      q = String(params.q || "").toLowerCase(),
      libraryRoot = this.manager.libraryRoot,
      items: JsonObject[] = [];
    const tagFilter = Array.isArray(params.tags)
      ? (params.tags as string[])
      : params.tags
        ? [String(params.tags)]
        : [];
    for (const card of this.manager.librarySkills()) {
      const path = card.path;
      const inLibrary = inside(path, libraryRoot);
      const metaSources = registered
        .filter((r) => r.enabled !== false && allowed.some((root) => inside(path, root)))
        .map((r) => ({ id: r.id, agent: r.name, kind: r.kind, project: r.project || "", path: card.path }));
      const visible =
        inLibrary ||
        metaSources.length > 0 ||
        (card.source.type === "git" && card.source.url.length > 0);
      if (!visible) continue;
      if (
        q &&
        !(card.displayName + "\n" + card.displayDescription + "\n" + card.name + "\n" + card.description)
          .toLowerCase()
          .includes(q)
      )
        continue;
      if (params.agent && !card.agents.some((b) => b.agentId === params.agent)) continue;
      if (
        params.source &&
        !(card.source.type === params.source || metaSources.some((s) => s.id === params.source || s.kind === params.source))
      )
        continue;
      if (params.kind && !metaSources.some((s) => s.kind === params.kind)) continue;
      if (params.project && !metaSources.some((s) => s.project === params.project)) continue;
      if (tagFilter.length && !tagFilter.every((tag) => card.tags.includes(tag))) continue;
      const duplicateCount = 0;
      if (["true", "1"].includes(String(params.duplicates)) && duplicateCount < 2) continue;
      items.push({
        displayTitle: card.displayName,
        displayDescription: card.displayDescription,
        presentationSource: card.presentationSource,
        id: card.id,
        title: card.name,
        description: card.description,
        // 新字段：让前端无需额外请求即可渲染标签、来源、徽标与状态。
        tags: card.tags,
        source: card.source,
        upstream: card.upstream,
        deployedTo: card.deployedTo,
        agents: card.agents.map((b) => ({ agentId: b.agentId, name: b.name, deployed: b.deployed, status: b.status })),
        libraryStatus: card.libraryStatus,
        meta: {
          path: card.path,
          modified: 0,
          size: card.bytes,
          digest: card.digest,
          version: "",
          warning: card.warning,
          status: "未核验启用状态",
          duplicateCount,
          libraryId: card.id,
          files: card.files,
          bytes: card.bytes,
          sources: metaSources.length ? metaSources : [{ id: "library", agent: "中央技能库", kind: "library", project: "", path: card.path }],
        },
      });
    }
    items.sort(
      (a, b) =>
        String(a.displayTitle).localeCompare(String(b.displayTitle), "zh-CN") ||
        String(a.title).localeCompare(String(b.title)),
    );
    const requestedOffset = Number(params.offset),
      requestedLimit = Number(params.limit),
      offset =
        Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0,
      limit =
        Number.isFinite(requestedLimit) && requestedLimit > 0
          ? Math.min(100, Math.max(1, Math.floor(requestedLimit)))
          : 40;
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      offset,
      limit,
      scan: this.manager.scanState(),
      sources: registered.filter((r) => ids.has(String(r.id))),
      readonly: true,
    };
  }
  /** 旧详情接口：详情重新核验链接与文件存在，正文来自最新快照。 */
  get(id: string) {
    const detail = this.manager.detail({ id });
    const registered = this.sources().filter((s) => s.enabled !== false && s.exists);
    const roots = registered.map((s) => safeRealpath(String(s.path))).filter((r): r is string => !!r);
    const canonicalLibrary = safeRealpath(this.manager.libraryRoot);
    const path = safeRealpath(detail.path) || detail.path;
    const inRegistered =
      canonicalLibrary && (inside(path, canonicalLibrary) || roots.some((r) => inside(path, r)));
    if (!inRegistered) throw new Error("技能来源已移除");
    // 详情读文件时再次核验 realpath 仍在登记根内（防目录被替换为链接）。
    let available = existsSync(join(path, "SKILL.md"));
    if (available)
      available = !!requireInsidePath(join(path, "SKILL.md"), [...roots, canonicalLibrary!]);
    const sources = this.sources()
      .filter((s) => s.enabled !== false && s.exists)
      .filter((s) => {
        const root = safeRealpath(String(s.path));
        return !!root && inside(path, root);
      })
      .map((s) => ({ id: s.id, agent: s.name, kind: s.kind, project: s.project || "", path: detail.path }));
    return {
      displayTitle: detail.displayName,
      displayDescription: detail.displayDescription,
      presentationSource: detail.presentationSource,
      id,
      title: detail.name,
      description: detail.description,
      content: detail.content,
      readonly: true,
      tags: detail.tags,
      source: detail.source,
      upstream: detail.upstream,
      deployedTo: detail.deployedTo,
      agents: detail.agents,
      libraryStatus: detail.libraryStatus,
      fileExists: available ? "yes" : "no",
      entries: detail.entries,
      readme: detail.readme,
      meta: {
        path: detail.path,
        modified: 0,
        size: detail.content.length,
        digest: detail.digest,
        version: "",
        warning: detail.warning,
        status: available ? "未核验启用状态" : "来源不可读",
        available,
        duplicateCount: 0,
        files: detail.files,
        bytes: detail.bytes,
        sources: sources.length
          ? sources
          : [{ id: "library", agent: "中央技能库", kind: "library", project: "", path: detail.path }],
      },
    };
  }
  /** 旧统计用：总数来自中央库。 */
  total() {
    return this.manager.librarySkills().length;
  }
  /** 兼容：把来源写成旧表（首次启动时迁移一次）。 */
  seedLegacySources() {
    const db = this.profile.db;
    if (db.prepare("SELECT 1 FROM skill_sources WHERE owner=?").get(this.profile.owner)) return 0;
    let count = 0;
    for (const row of this.defaults()) {
      db.prepare("INSERT INTO skill_sources VALUES(?,?,?)").run(this.profile.owner, row.id, JSON.stringify(row));
      count++;
    }
    return count;
  }
}

function requireInsidePath(path: string, roots: string[]) {
  try {
    return requireInside(path, roots);
  } catch {
    return null;
  }
}
export { packText, skillPresentation, basename };
