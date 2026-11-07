/**
 * 水平 Git 时间线的共享契约。
 *
 * 本文件同时被前端与后端类型检查使用，因此不引入任何 Node 能力，
 * 只保留可 JSON 序列化的纯数据形状与纯函数。
 *
 * 读取来源有两种：
 * - `local`：本机存在 Git 工作树时，直接读工作树（源码运行场景）；
 * - `remote`：桌面安装版没有 `.git`，改用 GitHub REST API 读同一仓库。
 * 两者产出完全相同的载荷形状，前端无需分支处理。
 */

/** 时间线上的引用标记；`head` 表示 HEAD 指向的提交。 */
export interface GitTimelineRef {
  name: string;
  kind: "branch" | "tag" | "head" | "remote";
  target?: string;
  /** Tags only: annotated tags carry a message/signature, lightweight ones do not. */
  annotated?: boolean;
}

/** 标签的呈现数据：是否落在本次返回的提交上、是否附注标签。 */
export interface GitTimelineTagRef {
  name: string;
  /** 该标签是否指向它所在的那条提交（已解引用附注标签） */
  points: boolean;
  /** 附注标签（含注释与签名）为 true，轻量标签为 false */
  annotated: boolean;
}

/** 提交上的引用明细：分支与标签分开，前端各用一套视觉层。 */
export interface GitTimelineCommitRefs {
  /** 本地分支名 */
  branches: string[];
  /** 远程分支名（`origin/main` 形式） */
  remotes: string[];
  /** 该提交上的标签，按名称升序 */
  tags: GitTimelineTagRef[];
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
  /** 扁平引用列表，保留给搜索与旧调用方；分组视图见 `refGroups` */
  refs: GitTimelineRef[];
  /** 分支/远程/标签的分组明细 */
  refGroups: GitTimelineCommitRefs;
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

export interface GitTimelineTag {
  name: string;
  /** 创建时间（附注标签取标签对象时间，轻量标签取提交时间）；未知为 null */
  at: string | null;
  /** 解引用后的提交哈希 */
  target: string;
  annotated: boolean;
  /** 该标签指向的提交是否在本次返回的提交里 */
  onTimeline: boolean;
}

export interface GitTimelineSummary {
  /** 仓库根目录的基名 / 远程仓库名 */
  repository: string;
  /** 绝对仓库根路径（本地）或 `owner/repo`（远程） */
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
  /** 本次返回的提交上出现的不同标签数 */
  tagCount: number;
  /** 本次返回的提交上出现的不同分支数（本地 + 远程） */
  branchCount: number;
  /** 最近的一个标签（按创建时间，其次按名称）；没有标签时为 null */
  latestTag: GitTimelineTag | null;
  tags: GitTimelineTag[];
}

/** 读取来源：本地工作树或远程仓库。 */
export type GitTimelineSource = "local" | "remote";

/** 最近一次成功读取的痕迹，读取失败时用于说明“上次成功是什么时候”。 */
export interface GitTimelineLastSuccess {
  at: string;
  source: GitTimelineSource;
  repository: string;
  commitCountReturned: number;
}

/**
 * 失败原因码。前端按码决定提示文案与操作建议：
 * - `not_a_repository`：本地没有工作树
 * - `git_not_found`：本机找不到 git 可执行文件
 * - `no_remote`：没有配置远程仓库
 * - `remote_unreachable`：远程请求失败（域名解析、超时、404 等）
 * - `rate_limited`：GitHub API 限流（未配置令牌时 60 次/小时）
 * - `no_network`：本机没有可用网络
 * - `empty_repository`：仓库没有提交
 * - `unknown`：其他异常
 */
export type GitTimelineFailureCode =
  | "not_a_repository"
  | "git_not_found"
  | "no_remote"
  | "remote_unreachable"
  | "rate_limited"
  | "no_network"
  | "empty_repository"
  | "unknown";

export interface GitTimelineResult {
  available: boolean;
  /** 失败原因码；available 为 true 时不存在 */
  code?: GitTimelineFailureCode;
  /** available 为 false 时的中文原因 */
  reason?: string;
  /** 失败时给出的恢复建议（中文短句） */
  hint?: string;
  /** 本次载荷来自哪里 */
  source: GitTimelineSource;
  /** 读取来源的中文说明，例如“读取来源：远程仓库 · 仓库名” */
  sourceLabel: string;
  /** 远程仓库的 `owner/repo`；本地模式为 null */
  remote: string | null;
  /** 结果是否来自缓存（内存或磁盘） */
  stale?: boolean;
  /** 该缓存写入时间（ISO）；非缓存结果不出现 */
  cachedAt?: string;
  /** 失败时补充说明：本机为什么读不到、远程是否可用 */
  attempts?: string[];
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
  /** 时间轴单节点最多展示的标签数，其余折叠成 “+N” */
  maxTagsPerNode: 3,
  /** 时间轴单节点最多展示的分支名数，其余折叠成 “+N” */
  maxBranchesPerNode: 2,
} as const;

/** 横向时间线最多画 6 条泳道，超出的提交归入最后一条。 */
export const GIT_TIMELINE_MAX_LANES = 6;

/** 未给出可用上限时的默认读取条数。 */
export const GIT_TIMELINE_DEFAULT_LIMIT = 120;

/** 单次读取中，超过该提交数即跳过文件变更统计。 */
export const GIT_TIMELINE_NUMSTAT_LIMIT = 60;

/** 远程结果在内存与磁盘上的保留时长（15 分钟）。 */
export const GIT_TIMELINE_REMOTE_TTL_MS = 15 * 60 * 1000;

/** 远程仓库每页可读的提交上限（GitHub 单页最多 100 条）。 */
export const GIT_TIMELINE_REMOTE_PAGE_SIZE = 100;

/** 失败原因码对应的默认中文说明与恢复建议。 */
export const GIT_TIMELINE_FAILURES: Record<
  GitTimelineFailureCode,
  { reason: string; hint: string }
> = {
  not_a_repository: {
    reason: "本机没有可读的 Git 工作树",
    hint: "安装版默认不带 .git；可改用远程仓库读取，或把应用指向源码目录。",
  },
  git_not_found: {
    reason: "本机找不到 git 命令",
    hint: "安装 Git 后重试，或改用远程仓库读取（不需要本机 git）。",
  },
  no_remote: {
    reason: "没有可用的远程仓库",
    hint: "设置 WORKBENCH_GIT_REMOTE=owner/repo 或完整仓库地址后重试。",
  },
  remote_unreachable: {
    reason: "远程仓库无法访问",
    hint: "检查网络与仓库地址；仓库为私有时需要配置访问令牌。",
  },
  rate_limited: {
    reason: "GitHub API 限流",
    hint: "未配置令牌时每小时只能请求 60 次；配置 WORKBENCH_GIT_TOKEN 可放宽到 5000 次。",
  },
  no_network: {
    reason: "本机没有可用网络",
    hint: "连上网络后重试；期间继续展示上一次成功读取的结果。",
  },
  empty_repository: {
    reason: "仓库没有提交记录",
    hint: "首次推送之后即可在时间轴上看到提交。",
  },
  unknown: {
    reason: "读取 Git 时间线失败",
    hint: "稍后重试；若持续失败，请检查仓库是否可访问。",
  },
};

/**
 * 把外部传入的 limit 收敛到 20..maxCommits。
 * 数字字符串（HTTP 查询参数）按数字处理；其余非数值输入回落到默认 120。
 */
export function sanitizeLimit(value: unknown): number {
  let numeric: number;
  if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string" && /^\s*\d+\s*$/.test(value.trim())) {
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

/** 该提交是否带多个父提交（合并提交）。 */
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
): { name: string; commits: number }[] {
  return [...counts.entries()]
    .map(([name, commits]) => ({ name, commits }))
    .sort((left, right) => right.commits - left.commits || left.name.localeCompare(right.name))
    .slice(0, Math.max(0, max));
}

/** 标签排序：有时间的在前按时间倒序，无时间的按名称升序排在最后。 */
export function compareTags(
  left: Pick<GitTimelineTag, "name" | "at">,
  right: Pick<GitTimelineTag, "name" | "at">,
): number {
  if (left.at && right.at && left.at !== right.at) {
    return Date.parse(right.at) - Date.parse(left.at);
  }
  if (left.at && !right.at) return -1;
  if (!left.at && right.at) return 1;
  return left.name.localeCompare(right.name);
}

/** 从标签列表里挑出“最近的一个标签”。 */
export function latestOfTags(tags: readonly GitTimelineTag[]): GitTimelineTag | null {
  if (tags.length === 0) return null;
  return [...tags].sort(compareTags)[0] ?? null;
}

/** 空的分组引用，供不可用结果与序列化兜底使用。 */
export function emptyCommitRefGroups(): GitTimelineCommitRefs {
  return { branches: [], remotes: [], tags: [] };
}

/** 读取来源的中文说明。 */
export function describeGitTimelineSource(
  source: GitTimelineSource,
  remote: string | null,
  repository: string,
): string {
  if (source === "remote") {
    return `读取来源：远程仓库 · ${remote || repository || "未指定"}`;
  }
  return `读取来源：本地工作树${repository ? ` · ${repository}` : ""}`;
}

/** 不可用结果的完整形状，供路由与测试共用。 */
export function unavailableGitTimeline(
  reason: string,
  root: string,
  requested: number,
  options: {
    code?: GitTimelineFailureCode;
    hint?: string;
    source?: GitTimelineSource;
    remote?: string | null;
    attempts?: string[];
    repository?: string;
    unverified?: string[];
  } = {},
): GitTimelineResult {
  const code: GitTimelineFailureCode = options.code ?? "unknown";
  const source: GitTimelineSource = options.source ?? "local";
  const remote = options.remote ?? null;
  const result: GitTimelineResult = {
    available: false,
    code,
    reason,
    hint: options.hint ?? GIT_TIMELINE_FAILURES[code].hint,
    source,
    sourceLabel: describeGitTimelineSource(source, remote, options.repository ?? ""),
    remote,
    summary: {
      repository: options.repository ?? "",
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
      tagCount: 0,
      branchCount: 0,
      latestTag: null,
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
  if (options.attempts?.length) result.attempts = options.attempts;
  if (options.unverified?.length) result.unverified = options.unverified;
  return result;
}
