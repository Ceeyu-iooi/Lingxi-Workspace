import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { basename, dirname, join, resolve } from "node:path";
import type { JsonObject } from "./profile.ts";
import {
  GIT_TIMELINE_FAILURES,
  GIT_TIMELINE_LIMITS,
  GIT_TIMELINE_MAX_LANES,
  GIT_TIMELINE_NUMSTAT_LIMIT,
  GIT_TIMELINE_REMOTE_TTL_MS,
  compareTags,
  countActiveDays,
  describeGitTimelineSource,
  latestOfTags,
  sanitizeLimit,
  topAuthors,
  unavailableGitTimeline,
  type GitTimelineBranch,
  type GitTimelineCommit,
  type GitTimelineCommitRefs,
  type GitTimelineFailureCode,
  type GitTimelineRef,
  type GitTimelineResult,
  type GitTimelineSource,
  type GitTimelineTag,
} from "../shared/git-timeline.ts";

/**
 * Git 时间线读取器。
 *
 * 约束（与项目 AGENTS.md 一致）：
 * - 只用 execFileSync 调用 git，参数全部是字面量或已校验值，不经过 shell；
 * - 不依赖当前工作目录：本机读不到工作树时（桌面安装版没有 .git），
 *   自动改为读取远程仓库（GitHub REST），两者产出同样的载荷；
 * - 任何失败都转成 available:false + 原因码 + 中文 reason，不向调用方抛错；
 * - 远程结果写进 profile 内的缓存文件（15 分钟），断网时继续可用。
 */

const GIT_TIMEOUT_MS = 8_000;
const GIT_MAX_BUFFER = 24 * 1024 * 1024;
const CACHE_TTL_MS = 15_000;
const REMOTE_TIMEOUT_MS = 6_000;
const REMOTE_CONCURRENCY = 4;
const REMOTE_MAX_REQUESTS = 10;
const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x1f";
const HASH_PATTERN = /^[0-9a-f]{4,64}$/i;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const OVERFLOW_LANE = GIT_TIMELINE_MAX_LANES - 1;
const COMMIT_PRETTY =
  "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e";
const NUMSTAT_PRETTY = "--pretty=format:%x1e%H";
const REF_FORMAT =
  "--format=%(objectname)%1f%(*objectname)%1f%(refname)%1f%(creatordate:iso-strict)%1f%(objecttype)";
const GITHUB_API = "https://api.github.com";
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

interface GitCommandResult {
  ok: boolean;
  out: string;
}

interface CommitRecord {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  email: string;
  at: string;
  subject: string;
  body: string;
}

interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
  binary: boolean;
}

interface RefEntry {
  sha: string;
  at: string | null;
  annotated: boolean;
}

interface ParsedCommits {
  records: CommitRecord[];
  skipped: number;
  truncatedBodies: number;
  placeholderSubjects: number;
  missingDates: number;
}

interface ParsedBranches {
  branches: { name: string; remote: boolean; head: boolean }[];
  ok: boolean;
}

interface CacheEntry {
  at: number;
  limit: number;
  result: GitTimelineResult;
}

class RemoteFailure extends Error {
  readonly code: GitTimelineFailureCode;
  constructor(code: GitTimelineFailureCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface RemoteResponse {
  status: number;
  body: string;
  headers: {
    etag: string;
    link: string;
    remaining: string;
    reset: string;
    location: string;
  };
}

interface RemoteCommitRow {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  email: string;
  at: string;
  subject: string;
  body: string;
}

interface RemoteSnapshot {
  repository: string;
  commits: RemoteCommitRow[];
  branches: { name: string; remote: boolean; head: boolean; sha: string | null }[];
  tags: GitTimelineTag[];
  currentBranch: string | null;
  truncated: boolean;
  notes: string[];
  fetchedAt: number;
}

export function toGitTimelineJson(result: GitTimelineResult): JsonObject {
  return { ...result } as JsonObject;
}

/**
 * 把用户/仓库配置里的远程地址归一化成 `owner/repo`。
 * 支持 https、ssh（git@host:owner/repo.git）、git+ssh 与 `owner/repo` 简写。
 */
export function parseRemoteRepository(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let text = value.trim();
  if (!text) return null;
  if (text.startsWith("git@") || /^[A-Za-z0-9_.-]+@[^:]+:/.test(text)) {
    const colon = text.indexOf(":");
    if (colon < 0) return null;
    text = text.slice(colon + 1);
  } else if (/^(?:https?|ssh|git|git\+ssh):\/\//i.test(text)) {
    try {
      text = new URL(text).pathname;
    } catch {
      return null;
    }
  }
  text = text
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (REPOSITORY_PATTERN.test(text)) return text;
  return null;
}

function findGitRoot(start: string): string | null {
  let current = resolve(start);
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function splitRecords(out: string): string[] {
  return out.split(RECORD_SEPARATOR);
}

function trimRecord(record: string): string {
  return record.replace(/^\r?\n+/, "");
}

function parseCommitLog(out: string, maxBodyChars: number): ParsedCommits {
  const records: CommitRecord[] = [];
  let skipped = 0;
  let truncatedBodies = 0;
  let placeholderSubjects = 0;
  let missingDates = 0;

  for (const chunk of splitRecords(out)) {
    const record = trimRecord(chunk);
    if (!record.trim()) continue;
    const fields = record.split(FIELD_SEPARATOR);
    if (fields.length < 8) {
      skipped += 1;
      continue;
    }
    const hash = fields[0].trim();
    if (!HASH_PATTERN.test(hash)) {
      skipped += 1;
      continue;
    }
    const shortHash = fields[1].trim() || hash.slice(0, 7);
    const parents = fields[2].trim() ? fields[2].trim().split(/\s+/).filter(Boolean) : [];
    const author = fields[3].trim() || "(未署名)";
    const email = fields[4].trim();
    const at = fields[5].trim();
    if (!ISO_PATTERN.test(at)) missingDates += 1;
    let subject = fields[6].replace(/\s+$/, "");
    if (!subject.trim()) {
      subject = "(无标题提交)";
      placeholderSubjects += 1;
    }
    let body = fields.slice(7).join(FIELD_SEPARATOR).replace(/\s+$/, "");
    if (body.length > maxBodyChars) {
      body = `${body.slice(0, maxBodyChars).trimEnd()}…`;
      truncatedBodies += 1;
    }
    records.push({ hash, shortHash, parents, author, email, at, subject, body });
  }

  return { records, skipped, truncatedBodies, placeholderSubjects, missingDates };
}

/** 解析 `git log --numstat`：首行是提交哈希，其后是 新增/删除/路径 三列。 */
function parseNumstat(out: string): Map<string, DiffStat> {
  const stats = new Map<string, DiffStat>();
  for (const chunk of splitRecords(out)) {
    const lines = chunk.split("\n");
    const head = (lines.shift() ?? "").trim();
    if (!HASH_PATTERN.test(head)) continue;
    const stat: DiffStat = { files: 0, insertions: 0, deletions: 0, binary: false };
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      stat.files += 1;
      const added = parts[0].trim();
      const removed = parts[1].trim();
      if (/^\d+$/.test(added)) stat.insertions += Number(added);
      else if (added === "-") stat.binary = true;
      if (/^\d+$/.test(removed)) stat.deletions += Number(removed);
      else if (removed === "-") stat.binary = true;
    }
    stats.set(head, stat);
  }
  return stats;
}

function parseBranchLines(out: string): { name: string; remote: boolean; head: boolean }[] {
  const branches: { name: string; remote: boolean; head: boolean }[] = [];
  for (const rawLine of out.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) continue;
    const isHead = line.startsWith("*");
    const name = line.slice(1).trim();
    // 分离头指针时 git 显示 `* (HEAD detached at abc)`，不是分支。
    if (!name || name.startsWith("(") || name.includes(" -> ")) continue;
    if (name.startsWith("remotes/")) {
      const remote = name.slice("remotes/".length).trim();
      if (!remote || remote.endsWith("/HEAD")) continue;
      branches.push({ name: remote, remote: true, head: false });
    } else {
      branches.push({ name, remote: false, head: isHead });
    }
  }
  return branches;
}

function parseTagList(out: string): string[] {
  const names = new Set<string>();
  for (const rawLine of out.split("\n")) {
    const name = rawLine.replace(/\r$/, "").trim();
    if (name) names.add(name);
  }
  return [...names];
}

/** refname -> 目标提交 sha；附注标签取剥离后的提交。 */
function parseRefIndex(out: string): Map<string, RefEntry> {
  const index = new Map<string, RefEntry>();
  for (const rawLine of out.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) continue;
    const parts = line.split(FIELD_SEPARATOR);
    if (parts.length < 4) continue;
    const refName = parts[2].trim();
    if (!refName.startsWith("refs/")) continue;
    if (refName.startsWith("refs/remotes/") && refName.endsWith("/HEAD")) continue;
    const sha = parts[1].trim() || parts[0].trim();
    if (!HASH_PATTERN.test(sha)) continue;
    index.set(refName, {
      sha,
      at: parts[3].trim() || null,
      annotated: parts[4]?.trim() === "tag",
    });
  }
  return index;
}

function describeRef(refName: string, sha: string): GitTimelineRef | null {
  if (refName.startsWith("refs/tags/")) {
    const name = refName.slice("refs/tags/".length);
    return name ? { name, kind: "tag", target: sha } : null;
  }
  if (refName.startsWith("refs/remotes/")) {
    const name = refName.slice("refs/remotes/".length);
    return name ? { name, kind: "remote" } : null;
  }
  if (refName.startsWith("refs/heads/")) {
    const name = refName.slice("refs/heads/".length);
    return name ? { name, kind: "branch" } : null;
  }
  return null;
}

const REF_ORDER: Record<GitTimelineRef["kind"], number> = {
  head: 0,
  branch: 1,
  remote: 2,
  tag: 3,
};

function sortRefs(refs: GitTimelineRef[]): GitTimelineRef[] {
  return refs.sort(
    (left, right) =>
      REF_ORDER[left.kind] - REF_ORDER[right.kind] || left.name.localeCompare(right.name),
  );
}

/** 把扁平的引用列表整理成分组明细（分支 / 远程 / 标签）。 */
function groupRefs(refs: readonly GitTimelineRef[]): GitTimelineCommitRefs {
  const branches: string[] = [];
  const remotes: string[] = [];
  const tags: GitTimelineCommitRefs["tags"] = [];
  for (const ref of refs) {
    if (ref.kind === "branch") branches.push(ref.name);
    else if (ref.kind === "remote") remotes.push(ref.name);
    else if (ref.kind === "tag") {
      tags.push({ name: ref.name, points: true, annotated: ref.annotated === true });
    }
  }
  return {
    branches: branches.sort((a, b) => a.localeCompare(b)),
    remotes: remotes.sort((a, b) => a.localeCompare(b)),
    tags: tags.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * 横向泳道分配：新提交优先沿用期待它的泳道，其次取编号最小的空泳道；
 * 首个父提交继续占用当前泳道，其余父提交另开泳道；期待哈希不在本次结果内的泳道立即关闭。
 */
function assignLanes(commits: readonly { hash: string; parents: string[] }[]): number[] {
  const open: (string | null)[] = [];
  const known = new Set(commits.map((commit) => commit.hash));
  const raw: number[] = [];
  const freeLane = (): number =>
    open.findIndex(
      (expected, index) => expected === null && index < GIT_TIMELINE_MAX_LANES,
    );

  for (const commit of commits) {
    let lane = open.indexOf(commit.hash);
    if (lane < 0) {
      lane = freeLane();
      if (lane < 0) {
        open.push(null);
        lane = open.length - 1;
      }
    }
    raw.push(Math.min(lane, OVERFLOW_LANE));
    open[lane] = commit.parents[0] ?? null;
    for (const parent of commit.parents.slice(1)) {
      if (open.includes(parent)) continue;
      const free = freeLane();
      if (free >= 0) open[free] = parent;
      else open.push(parent);
    }
    for (let index = 0; index < open.length; index += 1) {
      const expected = open[index];
      if (expected !== null && !known.has(expected)) open[index] = null;
    }
  }
  return raw;
}

/** 把 {0,2,3} 这类有空缺的泳道压成 {0,1,2}，保证前端泳道连续。 */
function compactLanes(raw: readonly number[]): { lanes: number[]; count: number } {
  const used = [...new Set(raw)].sort((left, right) => left - right);
  const remap = new Map(used.map((lane, index) => [lane, index]));
  return { lanes: raw.map((lane) => remap.get(lane) ?? 0), count: used.length };
}

/** 解析统一后的 ISO 时间；失败返回 null。 */
function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** 并发受限的 map，保持输入顺序。 */
async function mapLimited<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<unknown>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

/** 受限的 https GET：返回状态、正文与关键响应头。 */
function httpsGet(url: string, headers: Record<string, string>): Promise<RemoteResponse> {
  return new Promise((resolvePromise, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "GET",
        headers: { Accept: "application/vnd.github+json", ...headers },
        timeout: REMOTE_TIMEOUT_MS,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolvePromise({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: {
              etag: String(response.headers.etag ?? ""),
              link: String(response.headers.link ?? ""),
              remaining: String(response.headers["x-ratelimit-remaining"] ?? ""),
              reset: String(response.headers["x-ratelimit-reset"] ?? ""),
              location: String(response.headers.location ?? ""),
            },
          });
        });
        response.on("error", reject);
      },
    );
    request.on("timeout", () => {
      request.destroy(new RemoteFailure("remote_unreachable", "请求远程仓库超时"));
    });
    request.on("error", (error: NodeJS.ErrnoException) => {
      if (error instanceof RemoteFailure) return reject(error);
      const offline = new Set([
        "ENOTFOUND",
        "EAI_AGAIN",
        "ENETUNREACH",
        "ENETDOWN",
        "EHOSTUNREACH",
        "ECONNREFUSED",
        "ECONNRESET",
        "ETIMEDOUT",
      ]);
      reject(
        new RemoteFailure(
          offline.has(error.code ?? "") ? "no_network" : "remote_unreachable",
          error.code ? `${error.code}：${error.message}` : error.message,
        ),
      );
    });
    request.end();
  });
}

function hasNextPage(link: string): boolean {
  return /rel="next"/.test(link);
}

/** 解析 GitHub 提交行，字段缺失时跳过。 */
function parseRemoteCommit(row: unknown): RemoteCommitRow | null {
  const entry = row as {
    sha?: unknown;
    commit?: {
      author?: { name?: unknown; email?: unknown; date?: unknown };
      committer?: { date?: unknown };
      message?: unknown;
    };
    parents?: unknown;
  };
  const hash = typeof entry?.sha === "string" ? entry.sha.trim() : "";
  if (!HASH_PATTERN.test(hash)) return null;
  const message = typeof entry.commit?.message === "string" ? entry.commit.message : "";
  const lines = message.replace(/\r\n/g, "\n").split("\n");
  const subject = (lines[0] ?? "").trim() || "(无标题提交)";
  const body = lines.slice(1).join("\n").replace(/^\s*\n/, "").trim();
  const parents = Array.isArray(entry.parents)
    ? entry.parents
        .map((parent) => (parent as { sha?: unknown })?.sha)
        .filter((sha): sha is string => typeof sha === "string" && HASH_PATTERN.test(sha))
    : [];
  const at =
    isoOrNull(entry.commit?.author?.date) ?? isoOrNull(entry.commit?.committer?.date) ?? "";
  const author =
    (typeof entry.commit?.author?.name === "string" && entry.commit.author.name.trim()) ||
    "(未署名)";
  const email =
    typeof entry.commit?.author?.email === "string" ? entry.commit.author.email.trim() : "";
  return { hash, shortHash: hash.slice(0, 7), parents, author, email, at, subject, body };
}

export interface GitTimelineOptions {
  /** 本机工作树提示目录；缺省读 WORKBENCH_APP_ROOT，再退到 process.cwd()。 */
  rootHint?: string;
  /** 远程仓库（`owner/repo` 或完整地址）；缺省依次读 WORKBENCH_GIT_REMOTE、`git remote get-url origin`。 */
  remote?: string | null;
  /** 缓存目录（通常是 profile 根）；给出时才写磁盘缓存。 */
  cacheDir?: string | null;
  /** 是否允许读取本机工作树；桌面安装版可显式关闭。 */
  allowLocal?: boolean;
}

export class GitTimeline {
  private readonly options: GitTimelineOptions;
  private resolvedRoot: string | null = null;
  private rootChecked = false;
  private gitPath: string | null = null;
  private gitChecked = false;
  private memory = new Map<string, CacheEntry>();
  private counter = 0;
  private signature = "";

  constructor(options: GitTimelineOptions | string = {}) {
    this.options = typeof options === "string" ? { rootHint: options } : options;
  }

  /** 当前内容签名对应的版本号；由每次内容变化的自增计数得出。 */
  version(): number {
    return this.counter;
  }

  /** 本机是否有可读工作树（不触发远程请求）。 */
  hasLocalRepository(): boolean {
    return this.resolveRoot() !== null;
  }

  /** 解析出的远程仓库 `owner/repo`；没有时返回 null。 */
  remoteName(): string | null {
    const configured = parseRemoteRepository(this.options.remote);
    if (configured) return configured;
    const environment = parseRemoteRepository(process.env.WORKBENCH_GIT_REMOTE);
    if (environment) return environment;
    const root = this.resolveRoot();
    if (!root) return null;
    const url = this.runGit(root, ["remote", "get-url", "origin"]);
    if (!url.ok) return null;
    return parseRemoteRepository(url.out);
  }

  /** 首选读取入口：本地优先，读不到时改读远程。 */
  async readAsync(
    options: { limit?: unknown; force?: boolean } = {},
  ): Promise<GitTimelineResult> {
    const started = Date.now();
    const limit = sanitizeLimit(options.limit);
    const attempts: string[] = [];

    const root = this.resolveRoot();
    if (root) {
      const local = this.collectLocal(root, limit);
      if (local.result.available) {
        this.memory.set(`local:${limit}`, { at: Date.now(), limit, result: local.result });
        return this.finalize(local.result, local.signature, started);
      }
      attempts.push(`本机工作树：${local.result.reason ?? "读取失败"}`);
    } else {
      attempts.push(
        this.options.allowLocal === false
          ? "本机读取：已在桌面模式下关闭"
          : this.gitChecked && this.gitPath === null
            ? `本机读取：${GIT_TIMELINE_FAILURES.git_not_found.reason}`
            : `本机读取：${GIT_TIMELINE_FAILURES.not_a_repository.reason}`,
      );
    }

    const remote = this.remoteName();
    if (!remote) {
      const code: GitTimelineFailureCode =
        this.options.allowLocal === false
          ? "no_remote"
          : this.gitChecked && this.gitPath === null
            ? "git_not_found"
            : "not_a_repository";
      const failure = unavailableGitTimeline(GIT_TIMELINE_FAILURES[code].reason, "", limit, {
        code,
        attempts: [...attempts, "远程读取：未配置远程仓库（可用 WORKBENCH_GIT_REMOTE 指定）"],
      });
      return this.finalize(failure, "", started);
    }

    return this.readRemote(remote, limit, started, attempts, options.force === true);
  }

  /** 同步读取：只走本地工作树，保留给脚本与测试使用。 */
  read(options: { limit?: unknown; force?: boolean } = {}): GitTimelineResult {
    const started = Date.now();
    const limit = sanitizeLimit(options.limit);
    const cached = this.memory.get(`local:${limit}`);
    if (!options.force && cached && started - cached.at < CACHE_TTL_MS) {
      return { ...cached.result, cached: true, durationMs: Date.now() - started };
    }
    const root = this.resolveRoot();
    if (!root) {
      const code: GitTimelineFailureCode =
        this.options.allowLocal === false
          ? "not_a_repository"
          : this.gitChecked && this.gitPath === null
            ? "git_not_found"
            : "not_a_repository";
      return this.finalize(
        unavailableGitTimeline(GIT_TIMELINE_FAILURES[code].reason, "", limit, {
          code,
          attempts: [`本机读取：${GIT_TIMELINE_FAILURES[code].reason}`],
        }),
        "",
        started,
      );
    }
    const outcome = this.collectLocal(root, limit);
    if (outcome.result.available) {
      this.memory.set(`local:${limit}`, { at: Date.now(), limit, result: outcome.result });
    }
    return this.finalize(outcome.result, outcome.signature, started);
  }

  /* ------------------------------------------------------------- 来源判定 */

  /** 本机 git 可执行文件；PATH 里找不到时探测常见安装位置。 */
  private resolveGit(): string | null {
    if (this.gitChecked) return this.gitPath;
    this.gitChecked = true;
    const candidates: string[] = [];
    const exe = process.platform === "win32" ? "git.exe" : "git";
    for (const dir of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
      if (!dir.trim()) continue;
      candidates.push(join(dir.trim(), exe));
    }
    if (process.platform === "win32") {
      const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
      const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
      const localAppData = process.env.LOCALAPPDATA ?? "";
      candidates.push(
        join(programFiles, "Git", "cmd", "git.exe"),
        join(programFilesX86, "Git", "cmd", "git.exe"),
        join(programFiles, "Git", "bin", "git.exe"),
        ...(localAppData ? [join(localAppData, "Programs", "Git", "cmd", "git.exe")] : []),
      );
    } else {
      candidates.push("/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git");
    }
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      if (this.probe(candidate)) {
        this.gitPath = candidate;
        return this.gitPath;
      }
    }
    // PATH 里的相对名最后兜底（某些包装器不在可枚举的目录里）。
    if (this.probe("git")) {
      this.gitPath = "git";
      return this.gitPath;
    }
    this.gitPath = null;
    return null;
  }

  private probe(binary: string): boolean {
    try {
      execFileSync(binary, ["--version"], {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        timeout: 4_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return true;
    } catch {
      return false;
    }
  }

  private resolveRoot(): string | null {
    if (this.rootChecked) return this.resolvedRoot;
    this.rootChecked = true;
    if (this.options.allowLocal === false) {
      this.resolvedRoot = null;
      return null;
    }
    const hint = this.rootHintPath();
    if (this.resolveGit()) {
      const probed = this.runGit(hint, ["rev-parse", "--show-toplevel"]);
      if (probed.ok) {
        const top = probed.out.trim();
        if (top) {
          this.resolvedRoot = resolve(top);
          return this.resolvedRoot;
        }
      }
    }
    this.resolvedRoot = findGitRoot(hint);
    return this.resolvedRoot;
  }

  /** 只读取 WORKBENCH_APP_ROOT 这一个环境变量。 */
  private rootHintPath(): string {
    const explicit = this.options.rootHint?.trim();
    if (explicit) return resolve(explicit);
    const appRoot = process.env.WORKBENCH_APP_ROOT?.trim();
    if (appRoot) return resolve(appRoot);
    return resolve(process.cwd());
  }

  /* ------------------------------------------------------------- 本地读取 */

  private collectLocal(
    root: string,
    limit: number,
  ): { result: GitTimelineResult; signature: string } {
    const log = this.runGit(root, [
      "log",
      `--max-count=${limit}`,
      "--date=iso-strict",
      "--no-color",
      COMMIT_PRETTY,
    ]);
    if (!log.ok) {
      const code: GitTimelineFailureCode = this.resolveGit() ? "not_a_repository" : "git_not_found";
      return {
        result: unavailableGitTimeline(this.describeLogFailure(root), root, limit, {
          code,
          source: "local",
          repository: basename(root),
        }),
        signature: "",
      };
    }

    const parsed = parseCommitLog(log.out, GIT_TIMELINE_LIMITS.maxBodyChars);
    if (parsed.records.length === 0) {
      return {
        result: unavailableGitTimeline(GIT_TIMELINE_FAILURES.empty_repository.reason, root, limit, {
          code: "empty_repository",
          source: "local",
          repository: basename(root),
        }),
        signature: "",
      };
    }

    const notes: string[] = [];
    if (parsed.skipped > 0) notes.push(`有 ${parsed.skipped} 条提交记录格式异常，已跳过`);
    if (parsed.truncatedBodies > 0) {
      notes.push(
        `有 ${parsed.truncatedBodies} 条提交正文超过 ${GIT_TIMELINE_LIMITS.maxBodyChars} 字，已截断`,
      );
    }
    if (parsed.placeholderSubjects > 0) notes.push("部分提交没有标题，已使用占位说明");
    if (parsed.missingDates > 0) notes.push("部分提交时间无法解析，活跃天数可能偏小");

    const countCall = this.runGit(root, ["rev-list", "--count", "HEAD"]);
    const total = countCall.ok ? Number.parseInt(countCall.out.trim(), 10) : Number.NaN;
    const totalKnown = Number.isFinite(total) && total >= 0;
    if (!totalKnown) notes.push("无法核验仓库提交总数，截断状态按未确认处理");
    const truncated = totalKnown && parsed.records.length >= limit && total > limit;

    // 差异统计按提交数开关：超过 60 条时不计算，字段保持 null。
    let stats: Map<string, DiffStat> | null = null;
    if (limit <= GIT_TIMELINE_NUMSTAT_LIMIT) {
      const numstat = this.runGit(root, [
        "log",
        `--max-count=${limit}`,
        "--numstat",
        "--no-color",
        NUMSTAT_PRETTY,
      ]);
      if (numstat.ok) stats = parseNumstat(numstat.out);
      else notes.push("git 差异统计读取失败，文件与行数变更保持未知");
    } else {
      notes.push(`提交数超过 ${GIT_TIMELINE_NUMSTAT_LIMIT} 条，未计算文件与行数变更统计`);
    }

    const branchInfo = this.readBranches(root);
    if (!branchInfo.ok) notes.push("分支列表读取失败");
    const refIndex = this.readRefIndex(root);
    if (!refIndex) notes.push("引用映射读取失败，提交未附加分支或标签标记");

    const tagNames = new Set<string>();
    if (refIndex) {
      for (const refName of refIndex.keys()) {
        if (refName.startsWith("refs/tags/")) tagNames.add(refName.slice("refs/tags/".length));
      }
    }
    const tagInfo = tagNames.size > 0 ? { names: [...tagNames], ok: true } : this.readTags(root);
    if (!tagInfo.ok) notes.push("标签列表读取失败");

    const currentBranch = this.readCurrentBranch(root, branchInfo.branches, notes);
    const laneInfo = compactLanes(assignLanes(parsed.records));

    const refsByCommit = new Map<string, GitTimelineRef[]>();
    if (refIndex) {
      for (const [refName, entry] of refIndex) {
        const ref = describeRef(refName, entry.sha);
        if (!ref) continue;
        const rich: GitTimelineRef = { ...ref, annotated: entry.annotated };
        const list = refsByCommit.get(entry.sha);
        if (list) list.push(rich);
        else refsByCommit.set(entry.sha, [rich]);
      }
    }

    const headSha = parsed.records[0].hash;
    const laneByCommit = new Map<string, number>();
    let sawBinary = false;
    let sawMergeWithoutStat = false;

    const commits: GitTimelineCommit[] = parsed.records.map((record, index) => {
      laneByCommit.set(record.hash, laneInfo.lanes[index]);
      const refs = [...(refsByCommit.get(record.hash) ?? [])];
      if (record.hash === headSha) refs.unshift({ name: "HEAD", kind: "head" });
      sortRefs(refs);

      let filesChanged: number | null = null;
      let insertions: number | null = null;
      let deletions: number | null = null;
      if (stats) {
        const stat = stats.get(record.hash);
        const isMerge = record.parents.length > 1;
        if (stat && isMerge && stat.files === 0) {
          // git 默认不输出合并提交的差异，记 0 会是假数据，只能保持未知。
          sawMergeWithoutStat = true;
        } else if (stat) {
          filesChanged = stat.files;
          if (stat.binary) sawBinary = true;
          else {
            insertions = stat.insertions;
            deletions = stat.deletions;
          }
        }
      }

      const commit: GitTimelineCommit = {
        hash: record.hash,
        shortHash: record.shortHash,
        parents: record.parents,
        author: record.author,
        at: record.at,
        subject: record.subject,
        refs,
        refGroups: groupRefs(refs),
        lane: laneInfo.lanes[index],
        kind: record.parents.length > 1 ? "merge" : "commit",
        filesChanged,
        insertions,
        deletions,
        order: index,
      };
      if (record.email) commit.authorEmail = record.email;
      if (record.body) commit.body = record.body;
      return commit;
    });

    if (stats && sawMergeWithoutStat) {
      notes.push("合并提交默认不输出差异统计，其文件与行数变更记为未知");
    }
    if (stats && sawBinary) notes.push("部分提交包含二进制文件，行数变更无法完整统计");

    const branches = this.decorateBranches(
      branchInfo.branches,
      currentBranch,
      refIndex,
      laneByCommit,
    );
    const tags = this.summarizeTags(tagInfo.names, refIndex, new Set(laneByCommit.keys()));

    const result = this.buildResult({
      source: "local",
      repository: basename(root),
      root,
      remote: null,
      branch: currentBranch,
      limit,
      commits,
      branches,
      tags,
      truncated,
      notes,
    });
    const signature = [headSha, totalKnown ? String(total) : "?", currentBranch ?? "DETACHED"].join(
      "|",
    );
    return { result, signature };
  }

  private describeLogFailure(root: string): string {
    if (!this.resolveGit()) return GIT_TIMELINE_FAILURES.git_not_found.reason;
    if (!this.runGit(root, ["rev-parse", "--git-dir"]).ok) {
      return "目录不是 Git 工作树";
    }
    if (!this.runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).ok) {
      return GIT_TIMELINE_FAILURES.empty_repository.reason;
    }
    return "git 读取提交失败：仓库可能处于异常状态";
  }

  private readCurrentBranch(
    root: string,
    branches: { name: string; remote: boolean; head: boolean }[],
    notes: string[],
  ): string | null {
    const symbolic = this.runGit(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
    const name = symbolic.ok ? symbolic.out.trim() : "";
    if (name) return name;
    const marked = branches.find((branch) => !branch.remote && branch.head);
    if (marked) return marked.name;
    notes.push("当前处于分离头指针状态，未识别当前分支");
    return null;
  }

  private readBranches(root: string): ParsedBranches {
    const call = this.runGit(root, ["branch", "-a", "--no-color"]);
    return { branches: call.ok ? parseBranchLines(call.out) : [], ok: call.ok };
  }

  private readTags(root: string): { names: string[]; ok: boolean } {
    const call = this.runGit(root, ["tag", "--list", "--no-color"]);
    return { names: call.ok ? parseTagList(call.out) : [], ok: call.ok };
  }

  private readRefIndex(root: string): Map<string, RefEntry> | null {
    const call = this.runGit(root, [
      "for-each-ref",
      REF_FORMAT,
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]);
    if (!call.ok) return null;
    return parseRefIndex(call.out);
  }

  private decorateBranches(
    parsed: { name: string; remote: boolean; head: boolean }[],
    currentBranch: string | null,
    refIndex: Map<string, RefEntry> | null,
    laneByCommit: Map<string, number>,
  ): GitTimelineBranch[] {
    const seen = new Set<string>();
    const branches: GitTimelineBranch[] = [];
    for (const branch of parsed) {
      const key = `${branch.remote ? "r" : "l"}:${branch.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const refName = branch.remote ? `refs/remotes/${branch.name}` : `refs/heads/${branch.name}`;
      const sha = refIndex?.get(refName)?.sha;
      const lane = sha !== undefined ? laneByCommit.get(sha) ?? null : null;
      branches.push({
        name: branch.name,
        remote: branch.remote,
        head: branch.remote ? false : branch.head || branch.name === currentBranch,
        lane,
      });
    }
    // 本地分支在前，远端分支在后，同类按名称升序，保证前端顺序稳定。
    return branches.sort(
      (left, right) =>
        Number(left.remote) - Number(right.remote) || left.name.localeCompare(right.name),
    );
  }

  private summarizeTags(
    names: string[],
    refIndex: Map<string, RefEntry> | null,
    timelineHashes: ReadonlySet<string>,
  ): GitTimelineTag[] {
    const tags = names.map((name) => {
      const entry = refIndex?.get(`refs/tags/${name}`);
      return {
        name,
        at: entry?.at ?? null,
        target: entry?.sha ?? "",
        annotated: entry?.annotated ?? false,
        onTimeline: entry ? timelineHashes.has(entry.sha) : false,
      };
    });
    return tags.sort(compareTags);
  }

  /* ------------------------------------------------------------- 远程读取 */

  private async readRemote(
    remote: string,
    limit: number,
    started: number,
    attempts: string[],
    force: boolean,
  ): Promise<GitTimelineResult> {
    const cacheKey = `remote:${remote}:${limit}`;
    if (!force) {
      const memory = this.memory.get(cacheKey);
      if (memory && started - memory.at < GIT_TIMELINE_REMOTE_TTL_MS) {
        return this.finalize(memory.result, this.signatureOf(memory.result), started);
      }
      const stored = this.readDiskCache(remote, limit);
      if (stored) {
        const cached: GitTimelineResult = {
          ...stored.result,
          cached: true,
          cachedAt: stored.at.toISOString(),
        };
        this.memory.set(cacheKey, { at: stored.at.getTime(), limit, result: cached });
        return this.finalize(cached, this.signatureOf(cached), started);
      }
    }

    let snapshot: RemoteSnapshot;
    try {
      snapshot = await this.fetchRemote(remote, limit);
    } catch (error) {
      const failure =
        error instanceof RemoteFailure
          ? error
          : new RemoteFailure(
              "remote_unreachable",
              error instanceof Error ? error.message : String(error),
            );
      const fallback = this.readDiskCache(remote, limit, { ignoreAge: true });
      if (fallback) {
        // 有旧缓存时优先展示旧缓存，同时把失败原因写进未核验项。
        const stale: GitTimelineResult = {
          ...fallback.result,
          stale: true,
          cached: true,
          cachedAt: fallback.at.toISOString(),
          code: failure.code,
        };
        stale.unverified = [
          ...(stale.unverified ?? []),
          `${GIT_TIMELINE_FAILURES[failure.code].reason}（${failure.message}）；当前展示 ${fallback.at.toLocaleString("zh-CN", { hour12: false })} 读取的缓存。`,
        ];
        return this.finalize(stale, this.signatureOf(stale), started);
      }
      const failed = unavailableGitTimeline(
        GIT_TIMELINE_FAILURES[failure.code].reason,
        remote,
        limit,
        {
          code: failure.code,
          source: "remote",
          remote,
          repository: remote,
          attempts: [...attempts, `远程仓库 ${remote}：${failure.message}`],
        },
      );
      return this.finalize(failed, "", started);
    }

    const notes = [...snapshot.notes];
    const laneInfo = compactLanes(assignLanes(snapshot.commits));
    const tagsBySha = new Map<string, GitTimelineTag[]>();
    for (const tag of snapshot.tags) {
      const list = tagsBySha.get(tag.target);
      if (list) list.push(tag);
      else tagsBySha.set(tag.target, [tag]);
    }
    const branchesBySha = new Map<string, { name: string; remote: boolean }[]>();
    for (const branch of snapshot.branches) {
      if (!branch.sha) continue;
      const list = branchesBySha.get(branch.sha);
      if (list) list.push({ name: branch.name, remote: branch.remote });
      else branchesBySha.set(branch.sha, [{ name: branch.name, remote: branch.remote }]);
    }
    const headSha = snapshot.commits[0]?.hash ?? "";
    const laneByCommit = new Map<string, number>();

    const commits: GitTimelineCommit[] = snapshot.commits.map((record, index) => {
      laneByCommit.set(record.hash, laneInfo.lanes[index]);
      const refs: GitTimelineRef[] = [];
      if (record.hash === headSha) refs.push({ name: "HEAD", kind: "head" });
      for (const branch of branchesBySha.get(record.hash) ?? []) {
        refs.push({ name: branch.name, kind: branch.remote ? "remote" : "branch" });
      }
      for (const tag of tagsBySha.get(record.hash) ?? []) {
        refs.push({ name: tag.name, kind: "tag", target: tag.target, annotated: tag.annotated });
      }
      sortRefs(refs);
      const commit: GitTimelineCommit = {
        hash: record.hash,
        shortHash: record.shortHash,
        parents: record.parents,
        author: record.author,
        at: record.at,
        subject: record.subject,
        refs,
        refGroups: groupRefs(refs),
        lane: laneInfo.lanes[index],
        kind: record.parents.length > 1 ? "merge" : "commit",
        filesChanged: null,
        insertions: null,
        deletions: null,
        order: index,
      };
      if (record.email) commit.authorEmail = record.email;
      if (record.body) commit.body = record.body;
      return commit;
    });

    notes.push("远程读取不计算文件与行数变更（需逐条查询，超出首页读取预算）");

    const branches: GitTimelineBranch[] = snapshot.branches
      .map((branch) => ({
        name: branch.name,
        remote: branch.remote,
        head: !branch.remote && branch.name === snapshot.currentBranch,
        lane: branch.sha ? laneByCommit.get(branch.sha) ?? null : null,
      }))
      .sort(
        (left, right) =>
          Number(left.remote) - Number(right.remote) || left.name.localeCompare(right.name),
      );

    const result = this.buildResult({
      source: "remote",
      repository: remote,
      root: remote,
      remote,
      branch: snapshot.currentBranch,
      limit,
      commits,
      branches,
      tags: snapshot.tags,
      truncated: snapshot.truncated,
      notes,
    });
    result.cachedAt = new Date(snapshot.fetchedAt).toISOString();
    this.memory.set(cacheKey, { at: Date.now(), limit, result });
    this.writeDiskCache(remote, limit, result);
    return this.finalize(result, this.signatureOf(result), started);
  }

  /** 通过 GitHub REST 拉取提交、分支与标签。 */
  private async fetchRemote(remote: string, limit: number): Promise<RemoteSnapshot> {
    const notes: string[] = [];
    const token = (process.env.WORKBENCH_GIT_TOKEN ?? process.env.GITHUB_TOKEN ?? "").trim();
    const headers: Record<string, string> = {
      "User-Agent": "Lingxi-Workbench-Git-Timeline",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) {
      headers.Authorization = /^(Bearer|token)\s/i.test(token) ? token : `Bearer ${token}`;
    }

    let requests = 0;
    const get = async (path: string): Promise<RemoteResponse> => {
      if (requests >= REMOTE_MAX_REQUESTS) {
        throw new RemoteFailure("remote_unreachable", "本次读取的请求次数已超出预算");
      }
      requests += 1;
      const response = await httpsGet(`${GITHUB_API}${path}`, headers);
      if (
        (response.status === 403 || response.status === 429) &&
        (response.headers.remaining === "0" || /rate limit/i.test(response.body))
      ) {
        throw new RemoteFailure("rate_limited", "GitHub API 限流（未配置令牌时 60 次/小时）");
      }
      if (
        (response.status === 301 || response.status === 307 || response.status === 308) &&
        response.headers.location &&
        requests < REMOTE_MAX_REQUESTS
      ) {
        requests += 1;
        return httpsGet(response.headers.location, headers);
      }
      return response;
    };

    // 1) 仓库元信息：默认分支与可见性。
    const meta = await get(`/repos/${remote}`);
    if (meta.status === 401) throw new RemoteFailure("remote_unreachable", "仓库需要认证（401）");
    if (meta.status === 403) throw new RemoteFailure("rate_limited", "GitHub API 拒绝访问（403）");
    if (meta.status === 404) {
      throw new RemoteFailure("remote_unreachable", `远程仓库 ${remote} 不存在或不可见（404）`);
    }
    if (meta.status < 200 || meta.status >= 300) {
      throw new RemoteFailure("remote_unreachable", `GitHub API 返回 ${meta.status}`);
    }
    let defaultBranch = "";
    let isPrivate = false;
    try {
      const body = JSON.parse(meta.body) as { default_branch?: unknown; private?: unknown };
      if (typeof body.default_branch === "string" && body.default_branch.trim()) {
        defaultBranch = body.default_branch.trim();
      }
      isPrivate = body.private === true;
    } catch {
      notes.push("仓库元信息无法解析，已按默认分支读取");
    }
    if (isPrivate && !token) notes.push("这是私有仓库，未配置令牌时可能读不到全部信息");

    // 2) 提交：最多两页（每页最多 100 条），保证首页读取时间可控。
    const pageSize = Math.min(100, Math.max(20, limit));
    const commitRows: RemoteCommitRow[] = [];
    let truncated = false;
    for (let page = 1; page <= 2; page += 1) {
      const branch = defaultBranch ? `&sha=${encodeURIComponent(defaultBranch)}` : "";
      const response = await get(
        `/repos/${remote}/commits?per_page=${pageSize}&page=${page}${branch}`,
      );
      if (response.status === 409) {
        throw new RemoteFailure("empty_repository", "远程仓库还没有任何提交（409）");
      }
      if (response.status === 404) {
        throw new RemoteFailure("remote_unreachable", "分支不存在或仓库不可见（404）");
      }
      if (response.status < 200 || response.status >= 300) {
        throw new RemoteFailure("remote_unreachable", `GitHub API 返回 ${response.status}`);
      }
      let rows: unknown;
      try {
        rows = JSON.parse(response.body);
      } catch {
        throw new RemoteFailure("remote_unreachable", "GitHub API 返回的提交列表无法解析");
      }
      if (!Array.isArray(rows)) {
        throw new RemoteFailure("remote_unreachable", "GitHub API 返回的提交列表格式不正确");
      }
      if (rows.length === 0 && page === 1) {
        throw new RemoteFailure("empty_repository", GIT_TIMELINE_FAILURES.empty_repository.reason);
      }
      for (const row of rows) {
        const parsedRow = parseRemoteCommit(row);
        if (parsedRow) commitRows.push(parsedRow);
      }
      const more = hasNextPage(response.headers.link);
      if (!more) break;
      if (page === 2 || commitRows.length >= limit) {
        truncated = true;
        break;
      }
    }
    if (commitRows.length > limit) {
      commitRows.length = limit;
      truncated = true;
    }

    // 3) 分支：最多 3 页。
    const branches: RemoteSnapshot["branches"] = [];
    for (let page = 1; page <= 3; page += 1) {
      const response = await get(`/repos/${remote}/branches?per_page=100&page=${page}`);
      if (response.status < 200 || response.status >= 300) {
        notes.push(`分支列表读取失败（HTTP ${response.status}）`);
        break;
      }
      let rows: unknown;
      try {
        rows = JSON.parse(response.body);
      } catch {
        notes.push("分支列表无法解析");
        break;
      }
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const row of rows) {
        const entry = row as { name?: unknown; commit?: { sha?: unknown } };
        if (typeof entry.name !== "string" || !entry.name) continue;
        const sha = typeof entry.commit?.sha === "string" ? entry.commit.sha : null;
        branches.push({ name: entry.name, remote: false, head: entry.name === defaultBranch, sha });
      }
      if (rows.length < 100) break;
      if (page === 3) notes.push("远程分支超过 300 个，只读取了前 300 个");
    }

    // 4) 标签：最多两页。
    const tagTargets: { name: string; sha: string }[] = [];
    for (let page = 1; page <= 2; page += 1) {
      const response = await get(`/repos/${remote}/tags?per_page=100&page=${page}`);
      if (response.status < 200 || response.status >= 300) {
        notes.push(`标签列表读取失败（HTTP ${response.status}）`);
        break;
      }
      let rows: unknown;
      try {
        rows = JSON.parse(response.body);
      } catch {
        notes.push("标签列表无法解析");
        break;
      }
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const row of rows) {
        const entry = row as { name?: unknown; commit?: { sha?: unknown }; sha?: unknown };
        if (typeof entry.name !== "string" || !entry.name) continue;
        const sha =
          typeof entry.commit?.sha === "string"
            ? entry.commit.sha
            : typeof entry.sha === "string"
              ? entry.sha
              : "";
        if (!sha) continue;
        tagTargets.push({ name: entry.name, sha });
      }
      if (rows.length < 100) break;
      if (page === 2) notes.push("远程标签超过 200 个，只读取了前 200 个");
    }

    // 5) 附注标签的创建时间：只查落在时间轴上的标签，最多 6 个，失败不影响主流程。
    const windowHashes = new Set(commitRows.map((row) => row.hash));
    const onTimeline = tagTargets.filter((tag) => windowHashes.has(tag.sha)).slice(0, 6);
    const tagTimes = new Map<string, string | null>();
    await mapLimited(onTimeline, REMOTE_CONCURRENCY, async (tag) => {
      try {
        const ref = await get(`/repos/${remote}/git/ref/tags/${encodeURIComponent(tag.name)}`);
        if (ref.status !== 200) return null;
        const body = JSON.parse(ref.body) as { object?: { type?: unknown; sha?: unknown } };
        if (body.object?.type !== "tag" || typeof body.object.sha !== "string") {
          return null;
        }
        const annotated = await get(`/repos/${remote}/git/tags/${body.object.sha}`);
        if (annotated.status !== 200) return null;
        const detail = JSON.parse(annotated.body) as { tagger?: { date?: unknown } };
        tagTimes.set(tag.name, isoOrNull(detail.tagger?.date));
        return null;
      } catch {
        return null;
      }
    });

    const tags: GitTimelineTag[] = tagTargets.map((tag) => {
      const annotatedDate = tagTimes.get(tag.name) ?? null;
      const commit = commitRows.find((row) => row.hash === tag.sha);
      return {
        name: tag.name,
        at: annotatedDate ?? commit?.at ?? null,
        target: tag.sha,
        annotated: tagTimes.has(tag.name),
        onTimeline: windowHashes.has(tag.sha),
      };
    });
    tags.sort(compareTags);

    if (!token) notes.push("未配置访问令牌：GitHub API 每小时限 60 次请求，结果会缓存 15 分钟");
    return {
      repository: remote,
      commits: commitRows,
      branches,
      tags,
      currentBranch: defaultBranch || null,
      truncated,
      notes,
      fetchedAt: Date.now(),
    };
  }

  /* ------------------------------------------------------------- 结果装配 */

  private buildResult(input: {
    source: GitTimelineSource;
    repository: string;
    root: string;
    remote: string | null;
    branch: string | null;
    limit: number;
    commits: GitTimelineCommit[];
    branches: GitTimelineBranch[];
    tags: GitTimelineTag[];
    truncated: boolean;
    notes: string[];
  }): GitTimelineResult {
    const { commits } = input;
    const authorCounts = new Map<string, number>();
    for (const commit of commits) {
      authorCounts.set(commit.author, (authorCounts.get(commit.author) ?? 0) + 1);
    }
    const times = commits
      .map((commit) => ({ at: commit.at, time: Date.parse(commit.at) }))
      .filter((entry) => Number.isFinite(entry.time))
      .sort((left, right) => left.time - right.time);

    const branchNames = new Set<string>();
    const tagNames = new Set<string>();
    for (const commit of commits) {
      for (const name of commit.refGroups.branches) branchNames.add(name);
      for (const name of commit.refGroups.remotes) branchNames.add(name);
      for (const tag of commit.refGroups.tags) tagNames.add(tag.name);
    }
    const laneMax = commits.reduce((max, commit) => Math.max(max, commit.lane), 0);

    const result: GitTimelineResult = {
      available: true,
      source: input.source,
      sourceLabel: describeGitTimelineSource(input.source, input.remote, input.repository),
      remote: input.remote,
      summary: {
        repository: input.repository,
        root: input.root,
        branch: input.branch,
        commitCountRequested: input.limit,
        commitCountReturned: commits.length,
        truncated: input.truncated,
        lanes: laneMax + 1,
        firstCommitAt: times.length > 0 ? times[0].at : null,
        latestCommitAt: times.length > 0 ? times[times.length - 1].at : null,
        activeDays: countActiveDays(commits),
        authors: topAuthors(authorCounts),
        tagCount: tagNames.size,
        branchCount: branchNames.size,
        latestTag: latestOfTags(input.tags.filter((tag) => tag.onTimeline)),
        tags: input.tags,
      },
      branches: input.branches,
      commits,
      generatedAt: new Date().toISOString(),
      version: 0,
      cached: false,
      durationMs: 0,
      limits: {
        maxCommits: GIT_TIMELINE_LIMITS.maxCommits,
        maxBodyChars: GIT_TIMELINE_LIMITS.maxBodyChars,
      },
    };
    if (input.notes.length > 0) result.unverified = [...new Set(input.notes)];
    return result;
  }

  private finalize(
    result: GitTimelineResult,
    signature: string,
    started: number,
  ): GitTimelineResult {
    if (result.available) {
      const merged = [result.source, result.remote ?? "", signature].join("|");
      if (merged !== this.signature) {
        this.counter += 1;
        this.signature = merged;
      }
      result.version = this.counter;
    }
    result.durationMs = Math.max(0, Date.now() - started);
    return result;
  }

  private signatureOf(result: GitTimelineResult): string {
    const head = result.commits[0]?.hash ?? "";
    return [result.source, result.remote ?? "", head, result.summary.commitCountReturned].join("|");
  }

  /* ------------------------------------------------------------- 磁盘缓存 */

  private cacheFile(remote: string, limit: number): string | null {
    const dir = this.options.cacheDir?.trim();
    if (!dir) return null;
    const key = createHash("sha256").update(`${remote}|${limit}`).digest("hex").slice(0, 16);
    return join(resolve(dir), "runtime", "git-timeline-cache", `${key}.json`);
  }

  private readDiskCache(
    remote: string,
    limit: number,
    options: { ignoreAge?: boolean } = {},
  ): { at: Date; result: GitTimelineResult } | null {
    const file = this.cacheFile(remote, limit);
    if (!file || !existsSync(file)) return null;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as {
        at?: unknown;
        remote?: unknown;
        limit?: unknown;
        result?: unknown;
      };
      if (raw.remote !== remote || raw.limit !== limit) return null;
      const at = new Date(String(raw.at ?? ""));
      if (!Number.isFinite(at.getTime())) return null;
      if (!options.ignoreAge && Date.now() - at.getTime() >= GIT_TIMELINE_REMOTE_TTL_MS) return null;
      const result = raw.result as GitTimelineResult;
      if (!result || typeof result !== "object" || !Array.isArray(result.commits)) return null;
      return { at, result: { ...result, available: result.available === true, cached: true } };
    } catch {
      return null;
    }
  }

  private writeDiskCache(remote: string, limit: number, result: GitTimelineResult): void {
    const file = this.cacheFile(remote, limit);
    if (!file) return;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), remote, limit, result }), {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(tmp, file);
    } catch {
      // 缓存写入失败不影响读取结果，只清理残留临时文件。
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* 忽略 */
      }
    }
  }

  /* ------------------------------------------------------------- git 调用 */

  private runGit(cwd: string, args: readonly string[]): GitCommandResult {
    const git = this.resolveGit();
    if (!git) return { ok: false, out: "" };
    try {
      const out: string = execFileSync(git, args, {
        cwd,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: GIT_MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return { ok: true, out };
    } catch {
      return { ok: false, out: "" };
    }
  }
}
