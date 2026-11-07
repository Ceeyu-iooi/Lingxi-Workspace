// 技能管理中台：中央技能库、预设、工作区、Agent 部署与上游更新检查。
// 安全边界（AGENTS.md 第 7、8 节）：
// - 只扫描已登记本机目录，不扫整盘；路径一律经 realpath 校验在登记根内。
// - 绝不执行 SKILL.md 或任何脚本：这里没有 shell、没有 eval、没有命令字符串拼接。
// - 只读 git 命令通过 execFileSync 传入字面量参数；不读取技能正文以外的内容上传。
// - 活动日志不记录技能正文、凭据或完整个人路径细节。
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import YAML from "yaml";
import { ProfileStore, hash, type JsonObject } from "./profile.ts";
import { packText, unpackText, compactSkillCatalog } from "./compressed-text.ts";
import {
  skillPresentation,
  type SkillPresentation,
} from "../shared/skill-presentation.ts";
import {
  safeSkillId,
  type SkillActivityEvent,
  type SkillAgent,
  type SkillAgentBadge,
  type SkillCard,
  type SkillDeployMode,
  type SkillDeployStatus,
  type SkillDetail,
  type SkillLibraryConfig,
  type SkillLibraryStatus,
  type SkillManagerOverview,
  type SkillPreset,
  type SkillPresetApplyResult,
  type SkillSourceRef,
  type SkillSyncBody,
  type SkillUpstream,
  type SkillWorkspace,
  type SkillWorkspaceEntry,
  type SkillWorkspaceSyncRow,
} from "../shared/skills.ts";

export const rootInside = (path: string, root: string) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
};
export const safeRealpath = (path: string): string | null => {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
};
/**
 * 技能名/目录名只允许单段文件名：拒绝分隔符、盘符、保留名与长度超限，
 * 防止 join(root, name) 逃出登记根或命中 Windows 设备。
 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
export function safeSegment(name: unknown): string {
  if (typeof name !== "string") throw new Error("技能名称不正确");
  const value = name.trim();
  if (
    !value ||
    value.length > 128 ||
    value === "." ||
    value === ".." ||
    value.startsWith(".") ||
    /[\\/:*?"<>|\u0000-\u001f]/.test(value) ||
    /[. ]$/.test(value) ||
    RESERVED.test(value) ||
    (process.platform === "win32" &&
      Buffer.byteLength(value, "utf8") > 120)
  )
    throw new Error("技能名称含非法字符，无法部署");
  return value;
}
/** 返回真实路径，只有落在任一登记根内才放行；否则抛出可读错误。 */
export function requireInside(path: string, roots: string[], message = "技能路径不在已登记目录内") {
  const real = safeRealpath(path);
  if (!real) throw new Error("技能路径不可读或不存在");
  const canonical = roots.map((r) => safeRealpath(r)).filter((r): r is string => !!r);
  if (!canonical.some((r) => rootInside(real, r) || real === r)) throw new Error(message);
  return real;
}
const now = () => new Date().toISOString();
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "sessions",
  "archived_sessions",
  "dist",
  "build",
  "out",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".cache",
]);
const MAX_DEPTH = 12;
const MAX_VISITED = 50000;
const MAX_SKILLS = 10000;
const MAX_SKILL_FILE = 1024 * 1024;
const TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|toml|ini|xml|html|css|js|mjs|cjs|ts|tsx|jsx|py|sh|ps1|bat|sql|svg)$/i;

export interface SkillRecord {
  id: string;
  dir: string;
  name: string;
  description: string;
  body: string;
  digest: string;
  modified: number;
  size: number;
  version: string;
  warning: string;
  meta: JsonObject;
  fingerprint: string;
}

interface AgentDef {
  id: string;
  name: string;
  segments: string[];
  projectSegments: string[];
}

/**
 * 内置 Agent 全局技能目录。全部相对用户主目录，避免写入个人绝对路径。
 * 只登记已知存在的常见位置；不存在时状态记为 missing，不做推测。
 */
const BUILTIN_AGENTS: AgentDef[] = [
  { id: "shared", name: "共享 Agent", segments: [".agents", "skills"], projectSegments: [".agents", "skills"] },
  { id: "codex", name: "Codex", segments: [".codex", "skills"], projectSegments: [".codex", "skills"] },
  { id: "claude", name: "Claude Code", segments: [".claude", "skills"], projectSegments: [".claude", "skills"] },
  { id: "cursor", name: "Cursor", segments: [".cursor", "skills"], projectSegments: [".cursor", "skills"] },
  { id: "gemini", name: "Gemini CLI", segments: [".gemini", "skills"], projectSegments: [".gemini", "skills"] },
  { id: "dsh", name: "DeepSeek Harness", segments: [".dsh", "skills"], projectSegments: [".dsh", "skills"] },
];

export class SkillManager {
  constructor(readonly profile: ProfileStore) {
    profile.db.exec(
      [
        "CREATE TABLE IF NOT EXISTS skill_manager_library(id TEXT PRIMARY KEY,name TEXT,display TEXT,description TEXT,tags TEXT,source TEXT,upstream TEXT,deployments TEXT,body TEXT,created TEXT,updated TEXT)",
        "CREATE TABLE IF NOT EXISTS skill_manager_presets(id TEXT PRIMARY KEY,name TEXT,description TEXT,skills TEXT,applied_at TEXT,applied_workspace TEXT,created TEXT)",
        "CREATE TABLE IF NOT EXISTS skill_manager_settings(key TEXT PRIMARY KEY,value TEXT)",
        "CREATE TABLE IF NOT EXISTS skill_manager_activity(at TEXT,action TEXT,workspace_id TEXT,agent_id TEXT,skill_id TEXT,skill_name TEXT,ok INTEGER,mode TEXT,detail TEXT)",
        "CREATE TABLE IF NOT EXISTS skill_manager_workspaces(id TEXT PRIMARY KEY,kind TEXT,name TEXT,root TEXT,agents TEXT)",
        "CREATE INDEX IF NOT EXISTS skill_manager_activity_at ON skill_manager_activity(at DESC)",
      ].join(";"),
    );
    // 旧版只读索引沿用原表，这里只做一次无损压缩迁移，不改正文。
    if (profile.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='skill_catalog'").get())
      profile.transaction(() => compactSkillCatalog(profile.db, 128));
  }

  // ---------------------------------------------------------------- 设置与 Agent
  private setting<T>(key: string, fallback: T): T {
    const row = this.profile.db
      .prepare("SELECT value FROM skill_manager_settings WHERE key=?")
      .get(key) as { value: string } | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }
  private store(key: string, value: unknown) {
    this.profile.db
      .prepare(
        "INSERT INTO skill_manager_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  /** 中央技能库根目录：默认在 Profile 内，可被设置覆盖为其他绝对路径。 */
  get libraryRoot(): string {
    const configured = this.setting<string>("libraryRoot", "");
    if (configured && isAbsolute(configured)) return resolve(configured);
    return join(this.profile.root, "data", "skills", "library");
  }
  private home() {
    return process.env.USERPROFILE || homedir();
  }
  private overrides(): JsonObject {
    return this.setting<JsonObject>("agentPaths", {});
  }
  agents(): SkillAgent[] {
    const overrides = this.overrides(),
      out: SkillAgent[] = [];
    for (const agent of BUILTIN_AGENTS) {
      const override = overrides[agent.id] as JsonObject | undefined,
        globalPath =
          typeof override?.path === "string" && isAbsolute(override.path)
            ? resolve(override.path)
            : join(this.home(), ...agent.segments);
      out.push({
        id: agent.id,
        name: agent.name,
        globalPath,
        exists: this.isDirectory(globalPath),
        origin: "builtin",
        projectRelative: agent.projectSegments.join("/"),
        enabled: override?.enabled !== false,
      });
    }
    for (const [id, override] of Object.entries(overrides))
      if (
        !BUILTIN_AGENTS.some((a) => a.id === id) &&
        typeof (override as JsonObject)?.path === "string" &&
        isAbsolute(String((override as JsonObject).path))
      )
        out.push({
          id,
          name: String((override as JsonObject).name || id).slice(0, 60),
          globalPath: resolve(String((override as JsonObject).path)),
          exists: this.isDirectory(resolve(String((override as JsonObject).path))),
          origin: "custom",
          projectRelative: String((override as JsonObject).projectRelative || ""),
          enabled: (override as JsonObject).enabled !== false,
        });
    return out;
  }
  private agent(id: unknown): SkillAgent {
    if (!safeSkillId(id)) throw new Error("Agent 标识不正确");
    const agent = this.agents().find((a) => a.id === id);
    if (!agent) throw new Error("Agent 不存在");
    return agent;
  }
  private isDirectory(path: string) {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }
  agentsSave(body: JsonObject) {
    const id = body.id,
      deleteIt = body.delete === true;
    if (!safeSkillId(id)) throw new Error("Agent 标识应为字母、数字或 _.- ");
    const overrides = { ...this.overrides() };
    if (deleteIt) {
      if (BUILTIN_AGENTS.some((a) => a.id === id))
        throw new Error("内置 Agent 不能删除，可恢复默认路径");
      delete overrides[String(id)];
    } else {
      const path = String(body.path || "").trim();
      if (path && !isAbsolute(path)) throw new Error("Agent 技能目录须为本机绝对路径");
      const existing = (overrides[String(id)] || {}) as JsonObject;
      overrides[String(id)] = {
        ...existing,
        ...(path ? { path: resolve(path) } : {}),
        ...(typeof body.name === "string" ? { name: String(body.name).slice(0, 60) } : {}),
        ...(typeof body.projectRelative === "string"
          ? { projectRelative: String(body.projectRelative).slice(0, 120) }
          : {}),
        ...(body.restore === true ? { path: "" } : {}),
        ...(body.enabled === true || body.enabled === false ? { enabled: body.enabled } : {}),
      };
      if (body.restore === true && !(overrides[String(id)] as JsonObject).path)
        delete overrides[String(id)];
    }
    this.store("agentPaths", overrides);
    return { items: this.agents() };
  }

  // ---------------------------------------------------------------- 工作区
  workspaceRoot(): string {
    const configured = this.setting<string>("workspacePath", "");
    return configured && isAbsolute(configured)
      ? resolve(configured)
      : join(this.profile.root, "workspace");
  }
  workspaces(): SkillWorkspace[] {
    const root = this.workspaceRoot(),
      agents = this.agents(),
      out: SkillWorkspace[] = [
        {
          id: "global",
          kind: "global",
          name: "全局技能",
          root: "",
          agentIds: agents.map((a) => a.id),
          exists: true,
        },
        {
          id: "project",
          kind: "project",
          name: basename(root) || "项目工作区",
          root,
          agentIds: agents.filter((a) => a.projectRelative).map((a) => a.id),
          exists: this.isDirectory(root),
        },
      ];
    for (const row of this.profile.db
      .prepare("SELECT id,kind,name,root,agents FROM skill_manager_workspaces ORDER BY name COLLATE NOCASE")
      .all() as JsonObject[])
      out.push({
        id: row.id,
        kind: "linked",
        name: row.name,
        root: row.root,
        agentIds: JSON.parse(row.agents),
        exists: this.isDirectory(row.root),
      });
    return out;
  }
  workspace(id: unknown): SkillWorkspace {
    const found = this.workspaces().find((w) => w.id === id);
    if (!found) throw new Error("工作区不存在");
    return found;
  }
  workspaceSave(body: JsonObject) {
    const raw = String(body.root || "").trim();
    if (!isAbsolute(raw)) throw new Error("请选择本机绝对目录");
    if (raw.startsWith("\\\\") || raw.startsWith("//"))
      throw new Error("不支持网络共享目录");
    const real = safeRealpath(raw);
    if (!real) throw new Error("目录不存在或不可读");
    if (!this.isDirectory(real) || dirname(real) === real)
      throw new Error("请选择具体的技能目录");
    const agentIds: string[] = Array.isArray(body.agentIds)
      ? body.agentIds.filter((id: unknown) => typeof id === "string" && safeSkillId(id))
      : this.agents().filter((a) => a.projectRelative).map((a) => a.id);
    const id = safeSkillId(body.id) ? String(body.id) : "linked-" + hash(real).slice(0, 12),
      name = String(body.name || basename(real) || "关联工作区").slice(0, 80);
    this.profile.db
      .prepare(
        "INSERT INTO skill_manager_workspaces(id,kind,name,root,agents) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,root=excluded.root,agents=excluded.agents",
      )
      .run(id, "linked", name, real, JSON.stringify(agentIds));
    return { id, workspace: this.workspace(id) };
  }
  workspaceDelete(body: JsonObject) {
    const id = String(body.id || "");
    if (!id.startsWith("linked-")) throw new Error("只能移除自定义关联工作区");
    this.profile.db.prepare("DELETE FROM skill_manager_workspaces WHERE id=?").run(id);
    return { id };
  }
  /** 工作区里某 Agent 的技能目录。 */
  private agentRoots(workspace: SkillWorkspace): { agent: SkillAgent; path: string }[] {
    const agents = this.agents().filter((a) => workspace.agentIds.includes(a.id));
    if (workspace.kind === "global")
      return agents.map((agent) => ({ agent, path: agent.globalPath }));
    return agents
      .filter((a) => a.projectRelative)
      .map((agent) => ({ agent, path: join(workspace.root, ...projectSegments(agent)) }));
  }

  // ---------------------------------------------------------------- 中央库
  private libraryRows(): JsonObject[] {
    return this.profile.db
      .prepare("SELECT * FROM skill_manager_library ORDER BY name COLLATE NOCASE")
      .all() as JsonObject[];
  }
  librarySkills(): (SkillCard & { path: string })[] {
    return this.libraryRows().map((row) => this.card(row));
  }
  private card(row: JsonObject): SkillCard & { path: string } {
    const dir = String(row.display || ""),
      real = safeRealpath(join(dir, "SKILL.md")),
      libraryRoot = this.libraryRoot,
      canonicalRoot = safeRealpath(libraryRoot),
      inside = !!real && !!canonicalRoot && rootInside(real, canonicalRoot),
      bodyDigest = String(row.body || ""),
      exists = !!real,
      currentReal = safeRealpath(join(libraryRoot, String(row.name || ""), "SKILL.md")),
      currentDigest = currentReal
        ? hash(readFileSync(currentReal, "utf8").replace(/^\uFEFF/, ""))
        : "",
      libraryStatus: SkillLibraryStatus = !exists || !inside ? "missing" : "ok";
    const tags = JSON.parse(String(row.tags || "[]")) as string[],
      source = JSON.parse(String(row.source || "{}")) as SkillSourceRef,
      upstream = JSON.parse(String(row.upstream || "{}")) as SkillUpstream,
      deployedTo = JSON.parse(String(row.deployments || "[]")) as string[],
      presentation = this.localization(String(row.id), String(row.name || ""), String(row.description || "")),
      record = this.readSkill(exists && inside ? real! : null);
    return {
      id: String(row.id),
      name: String(row.name || ""),
      displayName: presentation.title,
      description: String(row.description || ""),
      displayDescription: presentation.description,
      presentationSource: presentation.source,
      tags,
      source,
      upstream,
      deployedTo,
      agents: this.badges(String(row.name || ""), record?.digest || bodyDigest),
      libraryStatus:
        libraryStatus === "ok" && !!currentDigest && currentDigest !== bodyDigest
          ? "modified"
          : libraryStatus,
      digest: record?.digest || bodyDigest,
      excerpt: (record?.body || "").slice(0, 240),
      fingerprint: record?.fingerprint || "",
      files: record?.meta.files ?? 0,
      bytes: record?.meta.bytes ?? 0,
      updatedAt: String(row.updated || ""),
      warning: record?.warning || "",
      path: exists && inside ? real! : join(libraryRoot, String(row.name || "")),
    };
  }
  /** 读取 SKILL.md，只解析 frontmatter，不执行任何内容。 */
  /**
   * 按技能名在已登记来源里找 SKILL.md，返回真实路径。
   * 先要求 file 的 realpath 落在登记根内，再交给 readSkill 读取，避免先读后校验。
   */
  private registeredSkillFile(name: string): string | null {
    let segment: string;
    try {
      segment = safeSegment(name);
    } catch {
      return null;
    }
    const roots = this.canonicalRoots();
    for (const root of roots) {
      const candidate = join(root, segment, "SKILL.md"),
        real = safeRealpath(candidate);
      if (real && roots.some((r) => rootInside(real, r))) return real;
    }
    return null;
  }
  private readSkill(file: string | null): SkillRecord | null {
    if (!file) return null;
    let stat;
    try {
      stat = statSync(file);
    } catch {
      return null;
    }
    if (!stat.isFile() || stat.size > MAX_SKILL_FILE) return null;
    // 符号链接解析后再核验一次：防止登记目录内被替换成指向外部文件的链接。
    const real = safeRealpath(file);
    if (!real || !this.canonicalRoots().concat(safeRealpath(this.libraryRoot) || []).some((root) => rootInside(real, root))) return null;
    let body: string;
    try {
      body = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    } catch {
      return null;
    }
    let fields: JsonObject = {},
      warning = "";
    if (body.startsWith("---")) {
      const front = body.slice(3).split(/^---\s*$/m)[0];
      try {
        fields = YAML.parse(front, { maxAliasCount: 50 }) || {};
        if (typeof fields !== "object" || Array.isArray(fields)) throw new Error();
      } catch {
        fields = {};
        warning = "元数据无法解析；仍可查看原文";
      }
    }
    const dir = dirname(real),
      digest = hash(body),
      dirStat = this.dirStat(dir),
      name =
        typeof fields.name === "string" && fields.name.trim()
          ? fields.name.trim().slice(0, 160)
          : basename(dir);
    return {
      id: "",
      dir,
      name,
      description:
        typeof fields.description === "string" ? fields.description.slice(0, 2000) : "",
      body,
      digest,
      modified: stat.mtimeMs / 1000,
      size: stat.size,
      version: fields.version === undefined ? "" : String(fields.version),
      warning,
      meta: { files: dirStat.files, bytes: dirStat.bytes },
      fingerprint: `${Math.round(stat.mtimeMs)}:${stat.size}:${digest.slice(0, 16)}`,
    };
  }
  private dirStat(dir: string) {
    let files = 0,
      bytes = 0,
      visited = 0;
    const walk = (path: string, depth: number) => {
      if (depth > 6 || visited > 4000) return;
      let children;
      try {
        children = readdirSync(path, { withFileTypes: true });
      } catch {
        return;
      }
      for (const child of children) {
        if (++visited > 4000) return;
        if (child.isSymbolicLink()) continue;
        const full = join(path, child.name);
        if (child.isDirectory()) {
          if (!SKIP_DIRS.has(child.name)) walk(full, depth + 1);
        } else if (child.isFile())
          try {
            files++;
            bytes += statSync(full).size;
          } catch {
            /* 不可读文件不计入 */
          }
      }
    };
    walk(dir, 0);
    return { files, bytes };
  }
  private localization(id: string, name: string, description: string) {
    const custom = this.profile.db
      .prepare("SELECT title,description FROM skill_presentations WHERE owner=? AND id=?")
      .get(this.profile.owner, id) as SkillPresentation | undefined;
    return skillPresentation(name, description, custom);
  }
  /** 已部署徽标：按实际内容比对，多来源同名技能同样能识别。 */
  private badges(name: string, digest: string): SkillAgentBadge[] {
    // 同一技能可能以多份来源（扫描吸收 + 中央库副本）存在，按任意一份内容一致即视为已部署。
    // 同名但内容不同时说明是不同来源的同名技能，不能凭同名就算已部署。
    const digests = this.libraryRows()
      .filter((r) => String(r.name) === name && String(r.body || "") === digest)
      .map((r) => String(r.body || ""))
      .filter((d) => d && d !== digest);
    return this.agents().map((agent) => {
      const path = join(agent.globalPath, name),
        state = this.deployState(path, digest, digests);
      return {
        agentId: agent.id,
        name: agent.name,
        deployed: state.status === "linked" || state.status === "copied",
        status: state.status,
        mode: state.mode,
        path,
      };
    });
  }
  /** 真实核验某目录条目相对中央库内容的部署状态。 */
  private deployState(
    path: string,
    digest: string,
    alsoMatches: string[] = [],
  ): { status: SkillDeployStatus; mode: SkillDeployMode | "" } {
    let link;
    try {
      link = lstatSync(path);
    } catch {
      return { status: "absent", mode: "" };
    }
    if (link.isSymbolicLink()) {
      try {
        readlinkSync(path);
        return { status: "linked", mode: "junction" };
      } catch {
        return { status: "unreadable", mode: "" };
      }
    }
    if (!link.isDirectory()) return { status: "external", mode: "" };
    const real = safeRealpath(path);
    if (!real) return { status: "unreadable", mode: "" };
    const file = join(real, "SKILL.md");
    if (!existsSync(file)) return { status: "external", mode: "" };
    try {
      const current = hash(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
      return current === digest || alsoMatches.includes(current)
        ? { status: "copied", mode: "copy" }
        : { status: "different", mode: "" };
    } catch {
      return { status: "unreadable", mode: "" };
    }
  }
  private librarySkill(id: unknown) {
    if (!safeSkillId(id)) throw new Error("技能标识不正确");
    const row = this.profile.db
      .prepare("SELECT * FROM skill_manager_library WHERE id=?")
      .get(String(id)) as JsonObject | undefined;
    if (!row) throw new Error("技能不在中央库中");
    return row;
  }
  private patchLibrary(id: string, patch: JsonObject) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.profile.db
      .prepare(
        `UPDATE skill_manager_library SET ${keys.map((k) => k + "=?").join(",")} WHERE id=?`,
      )
      .run(...keys.map((k) => patch[k]), id);
  }
  private requireSource(file: string | null, roots: string[], message = "技能来源不在已登记目录内") {
    if (!file) throw new Error("技能文件不存在");
    return requireInside(file, roots, message);
  }

  // ---------------------------------------------------------------- 扫描（只读）
  /**
   * 只读扫描已登记目录，把中央库中尚不存在的技能吸收为 library 来源技能记录。
   * 绝不写入被扫描目录；绝不执行其中任何文件。
   */
  async scan(update?: (values: JsonObject) => void) {
    const started = Date.now(),
      libraryRoot = this.libraryRoot;
    mkdirSync(libraryRoot, { recursive: true });
    const librarySection = {
        id: "library",
        agentId: "",
        path: libraryRoot,
        projectRelative: "",
      },
      agentSections = this.agents()
        .filter((a) => a.exists)
        .map((a) => ({
          id: a.id,
          agentId: a.id,
          path: a.globalPath,
          projectRelative: a.projectRelative,
        })),
      projectSections = this.isDirectory(this.workspaceRoot())
        ? this.agentRoots(this.workspace("project")).map((r) => ({
            id: r.agent.id + "-project",
            agentId: r.agent.id,
            path: r.path,
            projectRelative: r.agent.projectRelative,
          }))
        : [],
      sections = [librarySection, ...agentSections, ...projectSections],
      canonicalRoots = [
        ...new Set(
          sections.map((s) => safeRealpath(s.path)).filter((p): p is string => !!p),
        ),
      ],
      found = new Map<string, { file: string; record: SkillRecord; alias: JsonObject[] }>(),
      coverage: JsonObject[] = [];
    let visited = 0,
      limited = false,
      errors = 0;
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i],
        sourceId = section.id,
        seen = new Set<string>();
      let count = 0;
      const walk = async (path: string, depth: number) => {
        // 先核验"请求路径本身"是否在登记根内（不存在的登记根此时直接跳过），
        // 再 realpath；两者都通过才继续，避免用真实路径绕过固定根校验。
        const canonical = safeRealpath(path),
          requested = normalize(path).toLowerCase();
        if (!canonical || seen.has(canonical)) return;
        if (
          !sections.some((s) => {
            const base = normalize(s.path).toLowerCase();
            return requested === base || requested.startsWith(base + sep);
          })
        )
          return;
        if (!canonicalRoots.some((r) => rootInside(canonical, r) || canonical === r)) return;
        seen.add(canonical);
        if (++visited > MAX_VISITED || found.size >= MAX_SKILLS) {
          limited = true;
          return;
        }
        if (visited % 50 === 0) await new Promise<void>((r) => setImmediate(r));
        const skillFile = join(canonical, "SKILL.md");
        if (existsSync(skillFile)) {
          const real = safeRealpath(skillFile);
          if (real && canonicalRoots.some((r) => rootInside(real, r))) {
            const record = this.readSkill(real);
            if (record) {
              const key = safeRealpath(dirname(real)) || dirname(real);
              const alias = {
                id: section.agentId || "library",
                section: sourceId,
                agent: section.agentId || "library",
                root: section.path,
                path: canonical,
                project: section.projectRelative,
              };
              if (found.has(key)) found.get(key)!.alias.push(alias);
              else {
                // 同一目录出现在多个登记根（例如全局与项目目录互相链接）时，优先保留项目级来源。
                found.set(key, { file: real, record, alias: [alias] });
                count++;
              }
            } else errors++;
          }
        }
        if (depth >= MAX_DEPTH) return;
        let children;
        try {
          children = readdirSync(canonical, { withFileTypes: true });
        } catch {
          errors++;
          return;
        }
        for (const child of children) {
          if (SKIP_DIRS.has(child.name)) continue;
          const full = join(canonical, child.name);
          if (child.isSymbolicLink()) {
            const real = safeRealpath(full);
            if (real && canonicalRoots.some((r) => rootInside(real, r))) await walk(full, depth + 1);
            continue;
          }
          if (child.isDirectory()) await walk(full, depth + 1);
        }
      };
      await walk(section.path, 0);
      coverage.push({
        id: sourceId,
        path: section.path,
        status: limited ? "limited" : errors ? "partial" : "complete",
        count,
        errors,
      });
      update?.({ progress: { done: i + 1, total: sections.length, skills: found.size } });
    }
    // 扫描吸收：只新增不存在的技能，不覆盖用户已安装的同名技能。
    let absorbed = 0;
    const existing = new Map(
      this.libraryRows().map((r) => [String(r.name), r]),
    );
    for (const entry of found.values()) {
      const name = entry.record.name;
      if (existing.has(name)) continue;
      const id = "src-" + hash(entry.record.dir.toLowerCase()).slice(0, 32);
      if (this.profile.db.prepare("SELECT 1 FROM skill_manager_library WHERE id=?").get(id)) continue;
      const origin = entry.alias[0];
      const source: SkillSourceRef = {
        type: origin.id === "library" ? "local" : "adopted",
        url: origin.id === "library" ? entry.record.dir : origin.path,
        ref: "",
        revision: entry.record.digest,
        installedAt: now(),
      };
      this.profile.db
        .prepare(
          "INSERT INTO skill_manager_library(id,name,display,description,tags,source,upstream,deployments,body,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          name,
          entry.record.dir,
          entry.record.description,
          JSON.stringify([]),
          JSON.stringify(source),
          JSON.stringify(this.emptyUpstream()),
          JSON.stringify([]),
          entry.record.digest,
          now(),
          now(),
        );
      existing.set(name, { id });
      absorbed++;
    }
    const result = {
      count: found.size,
      absorbed,
      coverage,
      at: Date.now() / 1000,
      elapsedMs: Date.now() - started,
      visited,
      limited,
      version: String(Date.now()),
      readonly: true,
    };
    this.profile.db
      .prepare(
        "INSERT INTO skill_manager_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run("lastScan", JSON.stringify(result));
    this.log({
      action: "scan",
      workspaceId: "",
      agentId: "",
      skillId: "",
      skillName: "",
      ok: !limited,
      mode: "",
      detail: `扫描 ${found.size} 项技能，新增吸收 ${absorbed} 项`,
    });
    return result;
  }
  /** 已登记的只读扫描根（中央库 + 存在的 Agent 目录 + 项目工作区目录）。 */
  private canonicalRoots(): string[] {
    const roots = [
      this.libraryRoot,
      ...this.agents().filter((a) => a.exists).map((a) => a.globalPath),
    ];
    if (this.isDirectory(this.workspaceRoot()))
      roots.push(
        ...this.agentRoots(this.workspace("project")).map((r) => r.path),
      );
    return [...new Set(roots.map((p) => safeRealpath(p)).filter((p): p is string => !!p))];
  }
  private emptyUpstream(): SkillUpstream {
    return {
      kind: "none",
      repository: "",
      ref: "",
      localRevision: "",
      remoteRevision: "",
      status: "unknown",
      checkedAt: "",
      error: "",
    };
  }
  scanState(): unknown {
    return this.setting<unknown>("lastScan", null);
  }

  // ---------------------------------------------------------------- 详情与中文展示
  detail(body: JsonObject): SkillDetail {
    const row = this.librarySkill(body.id),
      card = this.card(row),
      libraryRoot = this.libraryRoot,
      roots = [libraryRoot],
      file = card.path,
      real = safeRealpath(file),
      // 中央库副本优先；尚未入库的技能回退到已登记来源里的同一路径。
      inside = !!real && !!safeRealpath(libraryRoot) && rootInside(real, safeRealpath(libraryRoot)!),
      sourceFile = inside ? real : this.registeredSkillFile(String(row.name)),
      record = this.readSkill(inside ? real : null) || this.readSkill(sourceFile),
      entries: string[] = [];
    if (inside && record) {
      const walk = (path: string, depth: number) => {
        if (depth > 3 || entries.length >= 200) return;
        let children;
        try {
          children = readdirSync(path, { withFileTypes: true });
        } catch {
          return;
        }
        for (const child of children) {
          if (entries.length >= 200) return;
          if (child.isSymbolicLink() || SKIP_DIRS.has(child.name)) continue;
          const rel = relative(record.dir, join(path, child.name)).split(sep).join("/");
          entries.push(child.isDirectory() ? rel + "/" : rel);
          if (child.isDirectory()) walk(join(path, child.name), depth + 1);
        }
      };
      walk(record.dir, 0);
    }
    let readme = "";
    if (inside && record)
      for (const name of ["README.md", "readme.md"]) {
        const candidate = join(record.dir, name),
          realReadme = safeRealpath(candidate);
        if (realReadme && safeRealpath(libraryRoot) && rootInside(realReadme, safeRealpath(libraryRoot)!)) {
          const stat = statSync(realReadme);
          if (stat.isFile() && stat.size <= 256 * 1024) {
            readme = readFileSync(realReadme, "utf8").slice(0, 256 * 1024);
            break;
          }
        }
      }
    const source = card.source;
    return {
      ...card,
      content: record?.body || "",
      path: record?.dir || card.path,
      fileExists: inside ? "yes" : real ? "unknown" : "no",
      contentMatchesSnapshot: !!record && !!source.revision && hash(record.body) === card.digest,
      entries,
      readme,
    };
  }
  presentation(body: JsonObject) {
    const row = this.librarySkill(body.id),
      title = String(body.title || "").trim(),
      description = String(body.description || "").trim();
    if (
      !title ||
      title.length > 80 ||
      !/[\u3400-\u9fff]/.test(title) ||
      !description ||
      description.length > 320 ||
      !/[\u3400-\u9fff]/.test(description)
    )
      throw new Error("请填写中文名称（80 字以内）与中文简介（320 字以内）");
    if (body.clear === true) {
      this.profile.db
        .prepare("DELETE FROM skill_presentations WHERE owner=? AND id=?")
        .run(this.profile.owner, String(row.id));
      return this.detail({ id: row.id });
    }
    this.profile.db
      .prepare(
        "INSERT INTO skill_presentations VALUES(?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET title=excluded.title,description=excluded.description",
      )
      .run(this.profile.owner, String(row.id), title, description);
    return this.detail({ id: row.id });
  }
  tagsSave(body: JsonObject) {
    const row = this.librarySkill(body.id),
      tags = Array.isArray(body.tags)
        ? [...new Set(
            body.tags
              .filter((t: unknown) => typeof t === "string")
              .map((t: string) => t.trim().slice(0, 40))
              .filter((t: string) => t.length > 0 && /^[\p{L}\p{N} ._+#&-]+$/u.test(t)),
          )].slice(0, 20)
        : [];
    this.patchLibrary(String(row.id), { tags: JSON.stringify(tags) });
    return { id: String(row.id), tags };
  }
  remove(body: JsonObject) {
    const ids: string[] = Array.isArray(body.ids) ? body.ids : [body.id];
    const results: JsonObject[] = [];
    for (const id of ids) {
      try {
        const row = this.librarySkill(id),
          name = String(row.name);
        // 只移除中央库副本；已部署到 Agent 的目录保留，并在结果中如实标注。
        const dir = join(safeRealpath(this.libraryRoot) || this.libraryRoot, name);
        const real = safeRealpath(dir),
          canonicalRoot = safeRealpath(this.libraryRoot);
        const underRoot = !!real && !!canonicalRoot && rootInside(real, canonicalRoot);
        const deployed = this.badges(name, String(row.body || "")).filter((b) => b.deployed);
        if (underRoot && real !== canonicalRoot) rmSync(real, { recursive: true, force: true });
        this.profile.db.prepare("DELETE FROM skill_manager_library WHERE id=?").run(String(row.id));
        this.log({
          action: "remove-from-library",
          workspaceId: "",
          agentId: "",
          skillId: String(row.id),
          skillName: name,
          ok: true,
          mode: "",
          detail: deployed.length
            ? `保留 ${deployed.length} 个 Agent 中的已部署副本`
            : "",
        });
        results.push({ id: String(row.id), ok: true, keptDeployments: deployed.map((b) => b.agentId) });
      } catch (error) {
        results.push({
          id: String(id),
          ok: false,
          error: error instanceof Error ? error.message : "删除失败",
        });
      }
    }
    return { results };
  }

  // ---------------------------------------------------------------- 部署
  private copySkill(source: string, target: string) {
    mkdirSync(target, { recursive: true });
    const walk = (from: string, to: string, depth: number) => {
      if (depth > 8) throw new Error("技能目录层级过深");
      for (const child of readdirSync(from, { withFileTypes: true })) {
        if (SKIP_DIRS.has(child.name) || child.isSymbolicLink()) continue;
        const src = join(from, child.name),
          dst = join(to, child.name);
        if (child.isDirectory()) {
          mkdirSync(dst, { recursive: true });
          walk(src, dst, depth + 1);
        } else if (child.isFile()) {
          const stat = statSync(src);
          if (stat.size > 8 * 1024 * 1024) throw new Error("技能文件超过 8MiB，未复制");
          writeFileSync(dst, readFileSync(src), { flag: "wx" });
        }
      }
    };
    walk(source, target, 0);
  }
  /**
   * 部署一个中央库技能到某 Agent 的全局目录。
   * symlink 在 Windows 需要权限或开发者模式，失败时如实回退为 copy 并记录真实方式。
   */
  private deployOne(
    row: JsonObject,
    agent: SkillAgent,
    mode: "symlink" | "copy",
  ): { ok: boolean; mode: SkillDeployMode | ""; error: string; status: SkillDeployStatus } {
    const name = safeSegment(row.name),
      canonicalLibrary = safeRealpath(this.libraryRoot);
    if (!canonicalLibrary) throw new Error("中央技能库目录不可读");
    // 来源解析顺序：中央库副本 → 已登记来源里的同名技能。
    // 只读扫描吸收技能时只登记来源，不强制复制一份副本；部署时再按需读取。
    const record =
      this.readSkill(insideReal(join(canonicalLibrary, name, "SKILL.md"), canonicalLibrary)) ||
      this.readSkill(this.registeredSkillFile(name));
    if (!record) throw new Error("技能正文不在中央库，也不在已登记来源内，无法部署");
    const sourceReal = record.dir;
    const target = join(agent.globalPath, name),
      targetReal = safeRealpath(target);
    // 目标若已存在，只允许是当前已部署的副本或链接；不做覆盖。
    if (existsSync(target) || targetReal) {
      const state = this.deployState(target, record.digest);
      if (state.status === "linked" || state.status === "copied")
        return { ok: true, mode: state.mode, error: "", status: state.status };
      throw new Error(
        state.status === "different"
          ? "目标目录内容与中央库不同，请先手动处理"
          : "目标目录已被其他内容占用，未覆盖",
      );
    }
    mkdirSync(agent.globalPath, { recursive: true });
    const canonicalAgent = safeRealpath(agent.globalPath);
    if (!canonicalAgent || !rootInside(target, canonicalAgent))
      throw new Error("目标路径不在 Agent 目录内");
    let realMode: SkillDeployMode = mode === "copy" ? "copy" : "symlink",
      linkError = "";
    if (mode === "symlink") {
      try {
        symlinkSync(sourceReal, target, "junction");
        realMode = "junction";
      } catch (error) {
        linkError = error instanceof Error ? error.message.slice(0, 120) : "符号链接创建失败";
        realMode = "symlink-fallback-copy";
      }
    }
    if (realMode !== "junction") this.copySkill(sourceReal, target);
    const verified = this.deployState(target, record.digest);
    return {
      ok: verified.status === "linked" || verified.status === "copied",
      mode: realMode,
      error: linkError && realMode === "symlink-fallback-copy" ? "符号链接不可用，已复制：" + linkError : "",
      status: verified.status,
    };
  }
  deploy(body: JsonObject) {
    const row = this.librarySkill(body.skillId ?? body.id),
      ids: string[] = Array.isArray(body.agentIds) ? body.agentIds : [body.agentId],
      mode: "symlink" | "copy" = body.mode === "copy" ? "copy" : this.defaultMode(),
      results: JsonObject[] = [],
      // 循环内每轮重建集合，避免上一轮写入的结果被本轮覆盖丢掉。
      deployedTo = new Set(JSON.parse(String(row.deployments || "[]")) as string[]);
    for (const agentId of ids) {
      try {
        const agent = this.agent(agentId),
          outcome = this.deployOne(row, agent, mode);
        if (outcome.ok) deployedTo.add(agent.id);
        else deployedTo.delete(agent.id);
        this.patchLibrary(String(row.id), { deployments: JSON.stringify([...deployedTo]) });
        this.log({
          action: "deploy",
          workspaceId: "",
          agentId: agent.id,
          skillId: String(row.id),
          skillName: String(row.name),
          ok: outcome.ok,
          mode: outcome.mode,
          detail: outcome.error,
        });
        results.push({ agentId: agent.id, ...outcome });
      } catch (error) {
        const message = error instanceof Error ? error.message : "部署失败";
        this.log({
          action: "deploy",
          workspaceId: "",
          agentId: String(agentId),
          skillId: String(row.id),
          skillName: String(row.name),
          ok: false,
          mode: "",
          detail: message,
        });
        results.push({ agentId: String(agentId), ok: false, mode: "", error: message, status: "absent" });
      }
    }
    return { results };
  }
  undeploy(body: JsonObject) {
    const row = this.librarySkill(body.skillId ?? body.id),
      ids: string[] = Array.isArray(body.agentIds) ? body.agentIds : [body.agentId],
      results: JsonObject[] = [],
      deployedTo = new Set(JSON.parse(String(row.deployments || "[]")) as string[]);
    for (const agentId of ids) {
      try {
        const agent = this.agent(agentId),
          target = join(agent.globalPath, safeSegment(row.name)),
          canonicalAgent = safeRealpath(agent.globalPath),
          // Windows 上指向不存在目标的悬空 junction 会 realpath 失败，但目录条目仍然存在，
          // 因此判断"是否存在"必须看 lstat，而不是看 realpath 结果。
          listed = (() => {
            try {
              return lstatSync(target);
            } catch {
              return null;
            }
          })(),
          real = safeRealpath(target);
        if (!canonicalAgent) throw new Error("Agent 目录不可读");
        if (!listed) {
          results.push({ agentId: agent.id, ok: true, removed: false });
          continue;
        }
        // 只移除指向中央库的链接或内容一致的副本，避免误删他人技能。
        const file = join(real || target, "SKILL.md"),
          realFile = safeRealpath(file),
          record = this.readSkill(realFile),
          isLink = listed.isSymbolicLink(),
          linkTarget = isLink ? safeRealpath(target) : null,
          canonicalLibrary = safeRealpath(this.libraryRoot),
          // 副本可能来自中央库，也可能来自已登记的扫描来源；两者都算库内副本，
          // 其余目录一律视为他人技能，不删除。
          inLibrary =
            (!!linkTarget && !!canonicalLibrary && rootInside(linkTarget, canonicalLibrary)) ||
            (!!realFile && !!canonicalLibrary && rootInside(realFile, canonicalLibrary)),
          inRegistered = !!realFile && this.canonicalRoots().some((r) => rootInside(realFile, r)),
          ownedByLibrary = inLibrary || (!!record && inRegistered);
        if (!isLink && !ownedByLibrary)
          throw new Error("该目录不是中央库部署的副本，未删除");
        if (isLink) unlinkSync(target);
        else rmSync(real || target, { recursive: true, force: true });
        deployedTo.delete(agent.id);
        this.patchLibrary(String(row.id), { deployments: JSON.stringify([...deployedTo]) });
        this.log({
          action: "undeploy",
          workspaceId: "",
          agentId: agent.id,
          skillId: String(row.id),
          skillName: String(row.name),
          ok: true,
          mode: isLink ? "junction" : "copy",
          detail: "",
        });
        results.push({ agentId: agent.id, ok: true, removed: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "取消部署失败";
        this.log({
          action: "undeploy",
          workspaceId: "",
          agentId: String(agentId),
          skillId: String(row.id),
          skillName: String(row.name),
          ok: false,
          mode: "",
          detail: message,
        });
        results.push({ agentId: String(agentId), ok: false, error: message });
      }
    }
    return { results };
  }

  // ---------------------------------------------------------------- 工作区视图与双向同步
  workspaceEntries(body: JsonObject): {
    workspace: SkillWorkspace;
    items: SkillWorkspaceEntry[];
    rows: SkillWorkspaceSyncRow[];
  } {
    const workspace = this.workspace(body.id),
      localNames = new Set<string>(),
      entries: SkillWorkspaceEntry[] = [];
    for (const { agent, path } of this.agentRoots(workspace)) {
      const canonical = safeRealpath(path);
      if (!canonical) continue;
      for (const child of readdirSync(canonical, { withFileTypes: true })) {
        if (SKIP_DIRS.has(child.name)) continue;
        const full = join(canonical, child.name),
          real = safeRealpath(full);
        if (!real || !this.isDirectory(real)) continue;
        const file = join(real, "SKILL.md"),
          realFile = safeRealpath(file),
          record = realFile ? this.readSkill(realFile) : null;
        if (!record) continue;
        localNames.add(record.name);
        const libraryRow = this.libraryRows().find((r) => String(r.name) === record.name),
          state = libraryRow
            ? this.deployState(full, String(libraryRow.body || ""))
            : { status: "external" as SkillDeployStatus, mode: "" as "" },
          presentation = this.localization(
            libraryRow ? String(libraryRow.id) : "local-" + hash(real).slice(0, 16),
            record.name,
            record.description,
          );
        entries.push({
          id: libraryRow ? String(libraryRow.id) : "local-" + hash(real).slice(0, 16),
          name: record.name,
          displayName: presentation.title,
          displayDescription: presentation.description,
          description: record.description,
          inLibrary: !!libraryRow,
          librarySkillId: libraryRow ? String(libraryRow.id) : "",
          deployStatus: state.status,
          mode: state.mode,
          path: real,
          libraryStatus: libraryRow ? (this.card(libraryRow).libraryStatus as SkillLibraryStatus) : "missing",
          tags: libraryRow ? (JSON.parse(String(libraryRow.tags || "[]")) as string[]) : [],
          missingLocalization: presentation.source === "untranslated",
          agentId: agent.id,
        } as SkillWorkspaceEntry & { agentId: string });
      }
    }
    const rows: SkillWorkspaceSyncRow[] = this.libraryRows().map((row) => {
      const name = String(row.name),
        inWorkspace = localNames.has(name),
        card = this.card(row);
      return {
        skillId: String(row.id),
        name,
        displayName: card.displayName,
        library: card.libraryStatus === "ok",
        workspace: inWorkspace,
        deployStatus: card.agents.find((b) => workspace.agentIds.includes(b.agentId))?.status || "absent",
        action: !inWorkspace
          ? "add-to-workspace"
          : card.libraryStatus === "ok"
            ? "in-sync"
            : "add-to-library",
      };
    });
    return { workspace, items: entries, rows };
  }
  sync(body: Partial<SkillSyncBody> | JsonObject) {
    const workspace = this.workspace(body.workspaceId || "project"),
      mode: "symlink" | "copy" = body.mode === "copy" ? "copy" : this.defaultMode(),
      skillIds = Array.isArray(body.skillIds) && body.skillIds.length ? new Set(body.skillIds) : null,
      dryRun = body.dryRun === true,
      rows = this.workspaceEntries({ id: workspace.id }).rows.filter(
        (r) => !skillIds || skillIds.has(r.skillId),
      ),
      toWorkspace = rows.filter((r) => r.action === "add-to-workspace"),
      toLibrary = rows.filter((r) => r.action === "add-to-library"),
      applied: string[] = [],
      errors: JsonObject[] = [];
    if (dryRun)
      return {
        workspace,
        dryRun: true,
        plan: { toWorkspace: toWorkspace.map((r) => r.skillId), toLibrary: toLibrary.map((r) => r.skillId) },
        applied,
        errors,
      };
    const agents = this.agents().filter((a) => workspace.agentIds.includes(a.id));
    for (const row of toWorkspace) {
      const record = this.librarySkill(row.skillId),
        targets =
          workspace.kind === "global"
            ? agents
            : agents.filter((a) => a.projectRelative);
      for (const agent of targets) {
        const root =
          workspace.kind === "global"
            ? agent.globalPath
            : join(workspace.root, ...projectSegments(agent));
        try {
          const staged = { ...agent, globalPath: root } as SkillAgent;
          const outcome = this.deployOne(record, staged, mode);
          if (!outcome.ok) throw new Error(outcome.error || "同步未完成");
          applied.push(row.skillId);
          this.log({
            action: "sync-to-workspace",
            workspaceId: workspace.id,
            agentId: agent.id,
            skillId: row.skillId,
            skillName: row.name,
            ok: true,
            mode: outcome.mode,
            detail: "",
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "同步失败";
          errors.push({ skillId: row.skillId, agentId: agent.id, error: message });
          this.log({
            action: "sync-to-workspace",
            workspaceId: workspace.id,
            agentId: agent.id,
            skillId: row.skillId,
            skillName: row.name,
            ok: false,
            mode: "",
            detail: message,
          });
        }
      }
    }
    // 反向：工作区里有、中央库缺的技能，从工作区复制进中央库（一次性拷贝）。
    const seen = new Set<string>();
    for (const { path } of this.agentRoots(workspace)) {
      const canonical = safeRealpath(path);
      if (!canonical) continue;
      for (const child of readdirSync(canonical, { withFileTypes: true })) {
        const real = safeRealpath(join(canonical, child.name));
        if (!real || !this.isDirectory(real) || seen.has(real)) continue;
        seen.add(real);
        const record = this.readSkill(join(real, "SKILL.md"));
        if (!record) continue;
        if (this.libraryRows().some((r) => String(r.name) === record.name)) continue;
        if (skillIds && !toLibrary.some((r) => r.name === record.name)) continue;
        try {
          const target = join(this.libraryRoot, record.name);
          if (existsSync(target)) throw new Error("中央库已有同名目录");
          this.copySkill(real, target);
          const id = "src-" + hash(real.toLowerCase()).slice(0, 32);
          this.profile.db
            .prepare(
              "INSERT INTO skill_manager_library(id,name,display,description,tags,source,upstream,deployments,body,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              id,
              record.name,
              target,
              record.description,
              JSON.stringify([]),
              JSON.stringify({ type: "local", url: real, ref: "", revision: record.digest, installedAt: now() }),
              JSON.stringify(this.emptyUpstream()),
              JSON.stringify([]),
              record.digest,
              now(),
              now(),
            );
          applied.push(id);
          this.log({
            action: "add-to-library",
            workspaceId: workspace.id,
            agentId: "",
            skillId: id,
            skillName: record.name,
            ok: true,
            mode: "copy",
            detail: "",
          });
        } catch (error) {
          errors.push({
            skillId: "",
            skillName: record.name,
            error: error instanceof Error ? error.message : "导入中央库失败",
          });
        }
      }
    }
    return { workspace, dryRun: false, applied, errors };
  }

  // ---------------------------------------------------------------- 预设
  presets(): SkillPreset[] {
    return (
      this.profile.db
        .prepare("SELECT * FROM skill_manager_presets ORDER BY name COLLATE NOCASE")
        .all() as JsonObject[]
    ).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      description: String(row.description || ""),
      skillIds: JSON.parse(String(row.skills || "[]")),
      appliedAt: String(row.applied_at || ""),
      appliedWorkspace: String(row.applied_workspace || ""),
    }));
  }
  presetSave(body: JsonObject) {
    const name = String(body.name || "").trim().slice(0, 80);
    if (!name) throw new Error("请填写预设名称");
    const skills = Array.isArray(body.skillIds)
      ? [...new Set(body.skillIds.filter((id: unknown) => safeSkillId(id)))]
      : [];
    const id = safeSkillId(body.id) ? String(body.id) : "preset-" + randomUUID().slice(0, 8);
    this.profile.db
      .prepare(
        "INSERT INTO skill_manager_presets(id,name,description,skills,applied_at,applied_workspace,created) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,skills=excluded.skills",
      )
      .run(id, name, String(body.description || "").slice(0, 240), JSON.stringify(skills), "", "", now());
    return { id, presets: this.presets() };
  }
  presetDelete(body: JsonObject) {
    const id = String(body.id || "");
    if (!safeSkillId(id)) throw new Error("预设标识不正确");
    this.profile.db.prepare("DELETE FROM skill_manager_presets WHERE id=?").run(id);
    return { id, presets: this.presets() };
  }
  /** 应用预设：在指定工作区一次性部署该组技能（不是持续同步）。 */
  presetApply(body: JsonObject): SkillPresetApplyResult {
    const preset = this.presets().find((p) => p.id === body.id);
    if (!preset) throw new Error("预设不存在");
    const workspace = this.workspace(body.workspaceId || "global"),
      mode: "symlink" | "copy" = body.mode === "copy" ? "copy" : this.defaultMode(),
      agents = this.agents().filter((a) => workspace.agentIds.includes(a.id)),
      applied: string[] = [],
      skipped: string[] = [],
      results: SkillPresetApplyResult["results"] = [];
    for (const skillId of preset.skillIds) {
      let row: JsonObject;
      try {
        row = this.librarySkill(skillId);
      } catch {
        results.push({ skillId, agentId: "", ok: false, mode: "", error: "技能已不在中央库" });
        continue;
      }
      const skillMode: "symlink" | "copy" = body.mode === "undeploy" ? "copy" : mode,
        remove = body.mode === "undeploy";
      for (const agent of agents) {
        const root =
          workspace.kind === "global"
            ? agent.globalPath
            : join(workspace.root, ...projectSegments(agent));
        try {
          if (remove) {
            this.undeploy({ skillId, agentId: agent.id });
            if (!applied.includes(skillId)) applied.push(skillId);
            results.push({ skillId, agentId: agent.id, ok: true, mode: "", error: "" });
            continue;
          }
          const state = this.deployState(join(root, String(row.name)), String(row.body || ""));
          if (state.status === "linked" || state.status === "copied") {
            if (!skipped.includes(skillId)) skipped.push(skillId);
            results.push({ skillId, agentId: agent.id, ok: true, mode: state.mode, error: "" });
            continue;
          }
          const outcome = this.deployOne(row, { ...agent, globalPath: root } as SkillAgent, skillMode);
          if (outcome.ok && !applied.includes(skillId)) applied.push(skillId);
          results.push({
            skillId,
            agentId: agent.id,
            ok: outcome.ok,
            mode: outcome.mode,
            error: outcome.error,
          });
        } catch (error) {
          results.push({
            skillId,
            agentId: agent.id,
            ok: false,
            mode: "",
            error: error instanceof Error ? error.message : "应用预设失败",
          });
        }
      }
    }
    this.profile.db
      .prepare(
        "UPDATE skill_manager_presets SET applied_at=?,applied_workspace=? WHERE id=?",
      )
      .run(now(), workspace.name, preset.id);
    this.log({
      action: body.mode === "undeploy" ? "preset-undeploy" : "preset-apply",
      workspaceId: workspace.id,
      agentId: "",
      skillId: preset.id,
      skillName: preset.name,
      ok: results.every((r) => r.ok),
      mode: "",
      detail: `新增 ${new Set(applied).size} 项，跳过 ${new Set(skipped).size} 项`,
    });
    return {
      presetId: preset.id,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      applied: [...new Set(applied)],
      skipped: [...new Set(skipped)],
      results,
    };
  }

  // ---------------------------------------------------------------- 上游更新检查
  private git(cwd: string, args: string[]): { ok: boolean; out: string } {
    try {
      const out = execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        windowsHide: true,
        timeout: 20000,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" },
      });
      return { ok: true, out };
    } catch {
      return { ok: false, out: "" };
    }
  }
  private gitStatus(repo: string) {
    const head = this.git(repo, ["rev-parse", "HEAD"]);
    if (!head.ok) return null;
    const dirty = this.git(repo, ["status", "--porcelain", "--untracked-files=no"]);
    return { head: head.out.trim(), dirty: dirty.out.trim().length > 0 };
  }
  /**
   * 检查 Git 来源技能的上游更新：仅在本地仓库内执行只读 git 命令，
   * 不 fetch、不修改工作区、不执行钩子（-c core.hooksPath= 置空）。
   */
  checkUpdates(body: JsonObject) {
    const ids: string[] = Array.isArray(body.ids) ? body.ids : [],
      rows = ids.length
        ? ids.map((id) => this.librarySkill(id))
        : this.libraryRows(),
      result: JsonObject[] = [],
      started = Date.now();
    for (const row of rows) {
      const source = JSON.parse(String(row.source || "{}")) as SkillSourceRef,
        dir = String(row.display || ""),
        repoRoot = (() => {
          const found = this.git(dir, ["-c", "core.hooksPath=", "rev-parse", "--show-toplevel"]);
          return found.ok ? found.out.trim() : "";
        })();
      if (source.type !== "git" && !repoRoot) {
        result.push({ id: String(row.id), status: "unavailable", error: "本地来源无法比对上游，可重新导入" });
        continue;
      }
      const repo = repoRoot || dir,
        state = this.gitStatus(repo);
      if (!state) {
        result.push({ id: String(row.id), status: "unavailable", error: "不是可读的 Git 仓库" });
        continue;
      }
      const branch = this.git(repo, ["-c", "core.hooksPath=", "rev-parse", "--abbrev-ref", "HEAD"]),
        base = source.revision && /^[0-9a-f]{7,40}$/i.test(source.revision) ? source.revision : "",
        ahead = base ? this.git(repo, ["-c", "core.hooksPath=", "rev-list", "--count", base + "..HEAD"]) : null,
        behind =
          base && this.git(repo, ["-c", "core.hooksPath=", "cat-file", "-e", base + "^{commit}"]).ok
            ? this.git(repo, ["-c", "core.hooksPath=", "rev-list", "--count", "HEAD.." + base])
            : null;
      const upstream: SkillUpstream = {
        kind: "git",
        repository: source.url,
        ref: branch.ok ? branch.out.trim() : "",
        localRevision: state.head,
        remoteRevision: base,
        status: "unknown",
        checkedAt: now(),
        error: "",
      };
      if (!base) upstream.status = "behind";
      else {
        const forward = ahead && ahead.ok ? Number(ahead.out.trim()) || 0 : 0,
          back = behind && behind.ok ? Number(behind.out.trim()) || 0 : 0;
        if (forward > 0 && state.dirty) upstream.status = "diverged";
        else if (state.dirty) upstream.status = "local-changes";
        else if (forward > 0) upstream.status = "behind";
        else if (back > 0) upstream.status = "unknown";
        else upstream.status = "current";
      }
      upstream.remoteRevision = state.head;
      this.patchLibrary(String(row.id), { upstream: JSON.stringify(upstream) });
      result.push({ id: String(row.id), name: String(row.name), ...upstream });
    }
    return { items: result, elapsedMs: Date.now() - started, checkedAt: now() };
  }

  // ---------------------------------------------------------------- 活动日志
  private log(event: Omit<SkillActivityEvent, "at">) {
    const detail = event.detail
      .replace(/[A-Za-z]:\\Users\\[^\\]+/gi, "<用户目录>")
      .replace(/\/Users\/[^/]+/g, "<用户目录>")
      .slice(0, 400);
    this.profile.db
      .prepare(
        "INSERT INTO skill_manager_activity(at,action,workspace_id,agent_id,skill_id,skill_name,ok,mode,detail) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        now(),
        event.action,
        event.workspaceId,
        event.agentId,
        event.skillId,
        event.skillName.slice(0, 160),
        event.ok ? 1 : 0,
        event.mode,
        detail,
      );
    // 活动日志只保留最近 500 条，避免无限增长。
    this.profile.db.exec(
      "DELETE FROM skill_manager_activity WHERE rowid NOT IN (SELECT rowid FROM skill_manager_activity ORDER BY at DESC LIMIT 500)",
    );
  }
  activity(limit = 50): SkillActivityEvent[] {
    return (
      this.profile.db
        .prepare("SELECT * FROM skill_manager_activity ORDER BY at DESC LIMIT ?")
        .all(Math.min(Math.max(1, Math.floor(limit)), 200)) as JsonObject[]
    ).map((row) => ({
      at: String(row.at),
      action: String(row.action),
      workspaceId: String(row.workspace_id || ""),
      agentId: String(row.agent_id || ""),
      skillId: String(row.skill_id || ""),
      skillName: String(row.skill_name || ""),
      ok: row.ok === 1,
      mode: (row.mode || "") as SkillDeployMode | "",
      detail: String(row.detail || ""),
    }));
  }

  // ---------------------------------------------------------------- 设置
  defaultMode(): "symlink" | "copy" {
    return this.setting<string>("defaultMode", "symlink") === "copy" ? "copy" : "symlink";
  }
  settings(body?: JsonObject) {
    if (body) {
      if (body.libraryRoot !== undefined) {
        const raw = String(body.libraryRoot || "").trim();
        if (raw && !isAbsolute(raw)) throw new Error("技能库路径须为本机绝对路径");
        this.store("libraryRoot", raw ? resolve(raw) : "");
      }
      if (body.defaultMode !== undefined) {
        if (!["symlink", "copy"].includes(String(body.defaultMode)))
          throw new Error("同步方式只能为符号链接或复制");
        this.store("defaultMode", String(body.defaultMode));
      }
      if (body.workspacePath !== undefined) {
        const raw = String(body.workspacePath || "").trim();
        if (raw && !isAbsolute(raw)) throw new Error("工作区路径须为本机绝对路径");
        this.store("workspacePath", raw ? resolve(raw) : "");
      }
    }
    return {
      libraryRoot: this.libraryRoot,
      libraryRootEditable: true,
      defaultMode: this.defaultMode(),
      workspacePath: this.workspaceRoot(),
    };
  }
  libraryConfig(): SkillLibraryConfig {
    const cards = this.librarySkills();
    return {
      root: this.libraryRoot,
      defaultMode: this.defaultMode(),
      count: cards.length,
      bytes: cards.reduce((sum, c) => sum + (c.bytes || 0), 0),
    };
  }
  overview(): SkillManagerOverview {
    const cards = this.librarySkills(),
      tags = new Map<string, number>();
    for (const card of cards) for (const tag of card.tags) tags.set(tag, (tags.get(tag) || 0) + 1);
    return {
      library: this.libraryConfig(),
      agents: this.agents(),
      presets: this.presets(),
      workspaces: this.workspaces(),
      libraryTotal: cards.length,
      tags: [...tags.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      activity: this.activity(20),
      scan: this.scanState(),
      readonlySources: true,
    };
  }
  /** 旧接口兼容：来源列表（Agent 全局目录）。 */
  legacySources() {
    return this.agents().map((agent) => ({
      id: agent.id,
      name: agent.name,
      path: agent.globalPath,
      kind: agent.origin === "custom" ? "custom" : "user",
      enabled: agent.enabled,
      exists: agent.exists,
      project: "",
    }));
  }
  legacyAddSource(body: JsonObject) {
    const path = String(body.path || "").trim();
    if (!isAbsolute(path)) throw new Error("请选择本机绝对目录");
    const real = safeRealpath(path);
    if (!real || !this.isDirectory(real)) throw new Error("请选择具体的技能目录");
    const id = safeSkillId(body.id) ? String(body.id) : "custom-" + hash(real).slice(0, 12);
    const overrides = { ...this.overrides() };
    overrides[id] = {
      ...(overrides[id] || {}),
      name: String(body.name || basename(real) || "自定义来源").slice(0, 60),
      path: real,
    };
    this.store("agentPaths", overrides);
    return { id };
  }
  legacyToggleSource(body: JsonObject) {
    if (typeof body.enabled !== "boolean") throw new Error("来源开关不正确");
    const agent = this.agent(body.id),
      overrides = { ...this.overrides() };
    overrides[agent.id] = { ...(overrides[agent.id] || {}), enabled: body.enabled };
    this.store("agentPaths", overrides);
    return { id: agent.id, enabled: body.enabled };
  }
  legacyDeleteSource(body: JsonObject) {
    const id = String(body.id || "");
    const overrides = { ...this.overrides() };
    const entry = overrides[id] as JsonObject | undefined;
    if (!entry || !BUILTIN_AGENTS.some((a) => a.id === id))
      throw new Error("只能移除自定义来源");
    if (entry.path) throw new Error("内置来源只能停用，不能移除");
    delete overrides[id];
    this.store("agentPaths", overrides);
    return { id };
  }
  /** 旧目录索引（skill_catalog）同步维护，保证旧接口/统计不失效。 */
  writeLegacyCatalog(records: Map<string, { title: string; description: string; body: string; meta: JsonObject; fingerprint: string }>) {
    this.profile.transaction(() => {
      const db = this.profile.db;
      db.prepare("DELETE FROM skill_catalog WHERE owner=?").run(this.profile.owner);
      const put = db.prepare("INSERT INTO skill_catalog VALUES(?,?,?,?,?,?,?)");
      for (const [id, r] of records)
        put.run(this.profile.owner, id, r.title, r.description, packText(r.body), packText(JSON.stringify(r.meta)), r.fingerprint);
    });
  }
  readLegacyCatalog() {
    return this.profile.db
      .prepare("SELECT id,title,description,body,meta,fingerprint FROM skill_catalog WHERE owner=? ORDER BY title COLLATE NOCASE")
      .all(this.profile.owner) as JsonObject[];
  }
  unpackLegacyMeta(meta: unknown) {
    return JSON.parse(unpackText(meta));
  }
  unpackLegacyBody(body: unknown) {
    return unpackText(body);
  }
}

/** 返回 path 的真实路径，仅当它落在 root 内；否则返回 null（不抛错）。 */
function insideReal(path: string, root: string): string | null {
  const real = safeRealpath(path),
    canonical = safeRealpath(root);
  return real && canonical && rootInside(real, canonical) ? real : null;
}

/** Agent 项目级目录片段，来自登记的 projectRelative（已按 / 分隔）。 */
function projectSegments(agent: SkillAgent): string[] {
  return agent.projectRelative.split("/").filter(Boolean);
}
