/**
 * 水平 Git 时间线的共享契约。
 *
 * 本文件同时被前端与后端类型检查使用，因此不引入任何 Node 能力，
 * 只保留可 JSON 序列化的纯数据形状与纯函数。
 */

/** 时间线上的引用标记；`head` 表示 HEAD 指向的提交。 */
export interface GitTimelineRef {
  name: string;
  kind: "branch" | "tag" | "head" | "remote";
  target?: string;
}

export interface GitTimelineCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  authorEmail?: string;
  /** ISO 8601，带时区偏移，例如 2026-11-06T15:25:59+08:00 */
  at: string;
  subject: string;
  body?: string;
  refs: GitTimelineRef[];
  /** 横向渲染使用的 0 起泳道序号，上限见 GIT_TIMELINE_MAX_LANES */
  lane: number;
  kind: "commit" | "merge";
  /** null 表示未计算或无法核验，绝不以猜测值代替 */
  filesChanged: number | null;
  insertions: number | null;
  deletions: number | null;
  /** 返回序列中的序号，最新提交为 0 */
  order: number;
}

export interface GitTimelineBranch {
  name: string;
  remote: boolean;
  head: boolean;
  lane: number | null;
}

export interface GitTimelineSummary {
  /** 仓库根目录的基名 */
  repository: string;
  /** 绝对仓库根路径，仅服务端使用；前端只展示基名 */
  root: string;
  /** 当前分支；分离头指针时为 null */
  branch: string | null;
  commitCountRequested: number;
  commitCountReturned: number;
  /** 仓库提交数多于请求上限时为 true */
  truncated: boolean;
  lanes: number;
  firstCommitAt: string | null;
  latestCommitAt: string | null;
  activeDays: number;
  /** 提交数前 8 名，按提交数降序、同数按名称升序 */
  authors: { name: string; commits: number }[];
  tags: { name: string; at: string | null; target: string }[];
}

export interface GitTimelineResult {
  available: boolean;
  /** available 为 false 时的中文原因 */
  reason?: string;
  summary: GitTimelineSummary;
  branches: GitTimelineBranch[];
  commits: GitTimelineCommit[];
  generatedAt: string;
  /** 服务端缓存签名计数（每个实例独立递增） */
  version: number;
  cached: boolean;
  durationMs: number;
  limits: { maxCommits: number; maxBodyChars: number };
  /** 无法确定的项，中文说明；不出现时表示无已知缺口 */
  unverified?: string[];
}

/** 提交数上限、正文截断长度与作者榜上限。 */
export const GIT_TIMELINE_LIMITS = {
  maxCommits: 500,
  maxBodyChars: 800,
  maxAuthors: 8,
} as const;

/** 横向时间线最多画 6 条泳道，超出的提交归入最后一条。 */
export const GIT_TIMELINE_MAX_LANES = 6;

/** 未给出可用上限时的默认读取条数。 */
export const GIT_TIMELINE_DEFAULT_LIMIT = 120;

/** 单次读取中，超过该提交数即跳过文件变更统计。 */
export const GIT_TIMELINE_NUMSTAT_LIMIT = 60;

/**
 * 把外部传入的 limit 收敛到 20..maxCommits。
 * 数字字符串（HTTP 查询参数）按数字处理；其余非数值输入回落到默认 120。
 */
export function sanitizeLimit(value: unknown): number {
  let numeric: number;
  if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) {
    numeric = Number(value.trim());
  } else {
    return GIT_TIMELINE_DEFAULT_LIMIT;
  }
  if (!Number.isFinite(numeric)) return GIT_TIMELINE_DEFAULT_LIMIT;
  const rounded = Math.floor(numeric);
  if (rounded < 20) return 20;
  if (rounded > GIT_TIMELINE_LIMITS.maxCommits) return GIT_TIMELINE_LIMITS.maxCommits;
  return rounded;
}

/** 该提交是否带合并父提交之外的分支。 */
export function isMergeCommit(commit: Pick<GitTimelineCommit, "parents">): boolean {
  return commit.parents.length > 1;
}

/** 取 ISO 时间戳的 UTC 日期键（YYYY-MM-DD）；无法解析时返回 null。 */
export function utcDayKey(at: string): string | null {
  const time = Date.parse(at);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}

/** 统计一组提交覆盖的 UTC 活跃天数。 */
export function countActiveDays(commits: readonly Pick<GitTimelineCommit, "at">[]): number {
  const days = new Set<string>();
  for (const commit of commits) {
    const key = utcDayKey(commit.at);
    if (key) days.add(key);
  }
  return days.size;
}

/** 按提交数降序、同数按名称升序，截取前 max 名。 */
export function topAuthors(
  counts: ReadonlyMap<string, number>,
  max: number = GIT_TIMELINE_LIMITS.maxAuthors,
): { name: string; commits: number }[] {  return [...counts.entries()]
    .map(([name, commits]) => ({ name, commits }))
    .sort((left, right) => right.commits - left.commits || left.name.localeCompare(right.name))
    .slice(0, Math.max(0, max));
}

/** 不可用结果的完整形状，供路由与测试共用。 */
export function unavailableGitTimeline(
  reason: string,
  root: string,
  requested: number,
): GitTimelineResult {
  return {
    available: false,
    reason,
    summary: {
      repository: "",
      root,
      branch: null,
      commitCountRequested: requested,
      commitCountReturned: 0,
      truncated: false,
      lanes: 0,
      firstCommitAt: null,
      latestCommitAt: null,
      activeDays: 0,
      authors: [],
      tags: [],
    },
    branches: [],
    commits: [],
    generatedAt: new Date().toISOString(),
    version: 0,
    cached: false,
    durationMs: 0,
    limits: {
      maxCommits: GIT_TIMELINE_LIMITS.maxCommits,
      maxBodyChars: GIT_TIMELINE_LIMITS.maxBodyChars,
    },
  };
}
