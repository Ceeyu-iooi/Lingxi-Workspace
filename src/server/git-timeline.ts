import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { JsonObject } from "./profile.ts";
import {
  GIT_TIMELINE_LIMITS,
  GIT_TIMELINE_MAX_LANES,
  GIT_TIMELINE_NUMSTAT_LIMIT,
  countActiveDays,
  sanitizeLimit,
  topAuthors,
  unavailableGitTimeline,
  type GitTimelineBranch,
  type GitTimelineCommit,
  type GitTimelineRef,
  type GitTimelineResult,
  type GitTimelineSummary,
} from "../shared/git-timeline.ts";

/**
 * 只读的 Git 时间线读取器。
 *
 * 约束（与项目 AGENTS.md 一致）：
 * - 只用 execFileSync 调用 git，参数全部是字面量或已校验数字，不经过 shell。
 * - 任何失败都转成 available:false + 中文 reason，不向调用方抛错。
 * - 不读取除 WORKBENCH_APP_ROOT 之外的环境变量，也不打印绝对仓库路径。
 */

const GIT_TIMEOUT_MS = 8_000;
const GIT_MAX_BUFFER = 24 * 1024 * 1024;
const CACHE_TTL_MS = 15_000;
/** 提交记录之间、字段之间的分隔符，正常提交文本里不会出现。 */
const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x1f";
const HASH_PATTERN = /^[0-9a-f]{4,64}$/i;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const OVERFLOW_LANE = GIT_TIMELINE_MAX_LANES - 1;
const COMMIT_PRETTY =
  "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e";
const NUMSTAT_PRETTY = "--pretty=format:%x1e%H";
const REF_FORMAT =
  "--format=%(objectname)%1f%(*objectname)%1f%(refname)%1f%(creatordate:iso-strict)";

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

interface ParsedTags {
  names: string[];
  ok: boolean;
}

/** 把结果交给路由层写 JSON 时使用；结构本身已完全可序列化。 */
export function toGitTimelineJson(result: GitTimelineResult): JsonObject {
  return { ...result } as JsonObject;
}

/** 向上查找包含 `.git`（目录或文件）的目录。 */
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

/** 每个记录开头可能有 git 插入的换行，先去干净再判断是否为空。 */
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

/**
 * 解析 `git log --numstat` 的每个提交段：
 * 首行是提交哈希，其后是 `新增\t删除\t路径`；二进制文件的两列是 `-`。
 */
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
    index.set(refName, { sha, at: parts[3].trim() || null });
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

/**
 * 横向泳道分配：新提交优先沿用期待它的泳道，其次取编号最小的空泳道；
 * 首个父提交继续占用当前泳道，其余父提交另开泳道；期待哈希不在本次结果内的泳道立即关闭。
 * 最多 6 条泳道，超出部分落到第 6 条（下标 5）。
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

export class GitTimeline {
  private resolvedRoot: string | null = null;
  private rootChecked = false;
  private cache: { at: number; limit: number; signature: string; result: GitTimelineResult } | null =
    null;
  private counter = 0;
  private lastSignature: string | null = null;

  constructor(private rootHint?: string) {}

  /** 当前内容签名对应的版本号；由每次内容变化的自增计数得出。 */
  version(): number {
    return this.counter;
  }

  read(options: { limit?: unknown; force?: boolean } = {}): GitTimelineResult {
    const started = Date.now();
    const limit = sanitizeLimit(options.limit);
    const cached = this.cache;
    // 仓库根固定，缓存只按时间失效；同一实例下不同 limit 的载荷不同，因此必须同 limit 才命中。
    if (!options.force && cached && cached.limit === limit && started - cached.at < CACHE_TTL_MS) {
      return { ...cached.result, cached: true, durationMs: Date.now() - started };
    }

    try {
      const { result, signature } = this.collect(limit);
      result.version = this.counter;
      result.durationMs = Math.max(0, Date.now() - started);
      if (!result.available) {
        // 根目录已确认找不到时，不可用结论本身也可短暂缓存，避免频繁拉起 git。
        if (this.rootChecked && this.resolvedRoot === null) {
          this.cache = { at: Date.now(), limit, signature: "", result };
        }
        return result;
      }
      if (signature !== this.lastSignature) {
        this.counter += 1;
        this.lastSignature = signature;
        result.version = this.counter;
      }
      this.cache = { at: Date.now(), limit, signature, result };
      return result;
    } catch {
      const fallback = unavailableGitTimeline("读取 Git 时间线失败", "", limit);
      fallback.version = this.counter;
      fallback.durationMs = Math.max(0, Date.now() - started);
      return fallback;
    }
  }

  private collect(limit: number): { result: GitTimelineResult; signature: string } {
    const root = this.resolveRoot();
    if (!root) {
      return {
        result: unavailableGitTimeline("未找到 Git 仓库：当前资料目录不是 Git 工作树", "", limit),
        signature: "",
      };
    }

    const log = this.runGit(root, [
      "log",
      `--max-count=${limit}`,
      "--date=iso-strict",
      "--no-color",
      COMMIT_PRETTY,
    ]);
    if (!log.ok) {
      return {
        result: unavailableGitTimeline(this.describeLogFailure(root), root, limit),
        signature: "",
      };
    }

    const parsed = parseCommitLog(log.out, GIT_TIMELINE_LIMITS.maxBodyChars);
    if (parsed.records.length === 0) {
      return {
        result: unavailableGitTimeline("仓库没有提交记录", root, limit),
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

    // 仓库提交总数：一次独立调用，用于判断截断与内容签名。
    const countCall = this.runGit(root, ["rev-list", "--count", "HEAD"]);
    const total = countCall.ok ? Number.parseInt(countCall.out.trim(), 10) : Number.NaN;
    const totalKnown = Number.isFinite(total) && total >= 0;
    if (!totalKnown) notes.push("无法核验仓库提交总数，截断状态按未确认处理");
    // 只有取满请求条数、且仓库确实还有更多提交时才算截断。
    const returnedAll = parsed.records.length;
    const truncated = totalKnown && returnedAll >= limit && total > limit;

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
    const tagInfo = this.readTags(root);
    if (!tagInfo.ok) notes.push("标签列表读取失败");

    const refIndex = this.readRefIndex(root);
    if (!refIndex) notes.push("引用映射读取失败，提交未附加分支或标签标记");

    const currentBranch = this.readCurrentBranch(root, branchInfo.branches, notes);
    const laneInfo = compactLanes(assignLanes(parsed.records));

    const refsByCommit = new Map<string, GitTimelineRef[]>();
    if (refIndex) {
      for (const [refName, entry] of refIndex) {
        const ref = describeRef(refName, entry.sha);
        if (!ref) continue;
        const list = refsByCommit.get(entry.sha);
        if (list) list.push(ref);
        else refsByCommit.set(entry.sha, [ref]);
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
    const tags = this.summarizeTags(tagInfo.names, refIndex);

    const authorCounts = new Map<string, number>();
    for (const commit of commits) {
      authorCounts.set(commit.author, (authorCounts.get(commit.author) ?? 0) + 1);
    }

    const times = commits
      .map((commit) => ({ at: commit.at, time: Date.parse(commit.at) }))
      .filter((entry) => Number.isFinite(entry.time))
      .sort((left, right) => left.time - right.time);

    const summary: GitTimelineSummary = {
      repository: basename(root) || root,
      root,
      branch: currentBranch,
      commitCountRequested: limit,
      commitCountReturned: commits.length,
      truncated,
      lanes: laneInfo.count,
      firstCommitAt: times.length > 0 ? times[0].at : null,
      latestCommitAt: times.length > 0 ? times[times.length - 1].at : null,
      activeDays: countActiveDays(commits),
      authors: topAuthors(authorCounts),
      tags,
    };

    const result: GitTimelineResult = {
      available: true,
      summary,
      branches,
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
    if (notes.length > 0) result.unverified = notes;

    // 内容签名：HEAD、仓库提交数、当前分支的摘要，用于判断版本号是否需要递增。
    const signature = createHash("sha256")
      .update(
        [headSha, totalKnown ? String(total) : "?", currentBranch ?? "DETACHED"].join("|"),
      )
      .digest("hex");
    return { result, signature };
  }

  private resolveRoot(): string | null {
    if (this.rootChecked) return this.resolvedRoot;
    this.rootChecked = true;
    const hint = this.rootHintPath();
    const probed = this.runGit(hint, ["rev-parse", "--show-toplevel"]);
    if (probed.ok) {
      const top = probed.out.trim();
      if (top) {
        this.resolvedRoot = resolve(top);
        return this.resolvedRoot;
      }
    }
    this.resolvedRoot = findGitRoot(hint);
    return this.resolvedRoot;
  }

  /** 只读取 WORKBENCH_APP_ROOT 这一个环境变量。 */
  private rootHintPath(): string {
    const explicit = this.rootHint?.trim();
    if (explicit) return resolve(explicit);
    const appRoot = process.env.WORKBENCH_APP_ROOT?.trim();
    if (appRoot) return resolve(appRoot);
    return resolve(process.cwd());
  }

  private describeLogFailure(root: string): string {
    if (!this.runGit(root, ["rev-parse", "--git-dir"]).ok) return "git 命令不可用";
    if (!this.runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).ok) {
      return "仓库没有提交记录";
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

  private readTags(root: string): ParsedTags {
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
  ): { name: string; at: string | null; target: string }[] {
    const tags = names.map((name) => {
      const entry = refIndex?.get(`refs/tags/${name}`);
      return { name, at: entry?.at ?? null, target: entry?.sha ?? "" };
    });
    // 有可用的创建时间时按时间倒序，缺失时间的排在最后；否则按名称升序。
    return tags.sort((left, right) => {
      if (left.at && right.at && left.at !== right.at) {
        return Date.parse(right.at) - Date.parse(left.at);
      }
      if (left.at && !right.at) return -1;
      if (!left.at && right.at) return 1;
      return left.name.localeCompare(right.name);
    });
  }

  private runGit(cwd: string, args: readonly string[]): GitCommandResult {
    try {
      const out: string = execFileSync("git", args, {
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
