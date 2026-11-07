// 技能管理中台（对齐 skills-manager 的概念）与前端共享的接口契约。
// 这里只放类型与常量，不包含任何 I/O；服务端实现见 src/server/skill-manager.ts。
// 约定：所有“状态”字段都表示实际核验结果，未核验时使用 unknown，不猜测。

/** 工作区类别：与 skills-manager 的 Global / Project / Linked 一一对应。 */
export type SkillWorkspaceKind = "global" | "project" | "linked";

/** 部署真实方式。symlink-fallback-copy 表示申请符号链接失败后实际复制。 */
export type SkillDeployMode = "symlink" | "junction" | "copy" | "symlink-fallback-copy";

export type SkillDeployStatus =
  /** 目标不存在 */
  | "absent"
  /** 目标就是指向中央库的链接，且链接目标内可读 */
  | "linked"
  /** 目标是与中央库内容一致的副本 */
  | "copied"
  /** 目标存在但内容与中央库不同 */
  | "different"
  /** 目标存在，来源不是中央库（例如手工安装或第三方工具安装） */
  | "external"
  /** 目标存在但不可读 */
  | "unreadable";

export type SkillLibraryStatus =
  /** 中央库记录完整可用 */
  | "ok"
  /** 中央库目录已被删除或被移动 */
  | "missing"
  /** 中央库内容在本地被改动（与指纹不一致） */
  | "modified";

export type SkillUpstreamStatus =
  | "unknown"
  | "current"
  | "behind"
  | "local-changes"
  | "diverged"
  | "unavailable";

/** 通用三态：核验为真、核验为假、无法核验。 */
export type SkillEvidence = "yes" | "no" | "unknown";

export interface SkillSourceRef {
  /** git、local、archive、market、manual、adopted */
  type: string;
  /** 来源地址：Git 远程、本地路径或市场标识；archive 为归档文件路径。 */
  url: string;
  /** Git 分支或标签；非 Git 来源为空字符串。 */
  ref: string;
  /** 安装时记录的来源版本（提交号 / 内容指纹）。 */
  revision: string;
  /** 首次安装时间（ISO 8601），未知时为空字符串。 */
  installedAt: string;
}

export interface SkillUpstream {
  /** 跟踪方式：git、none。 */
  kind: string;
  /** 远端地址（已脱敏，不含账号密码）。 */
  repository: string;
  ref: string;
  localRevision: string;
  remoteRevision: string;
  /** 与上游比较后的结论；只在显式检查后才有非 unknown 值。 */
  status: SkillUpstreamStatus;
  /** 上次检查时间（ISO 8601）。 */
  checkedAt: string;
  /** 检查失败或无法核验的原因。 */
  error: string;
}

export interface SkillAgentBadge {
  agentId: string;
  name: string;
  /** 该 Agent 的全局技能目录中是否已部署（实时核验）。 */
  deployed: boolean;
  status: SkillDeployStatus;
  mode: SkillDeployMode | "";
  path: string;
}

export interface SkillCard {
  /** 稳定 id：来源路径 + 技能目录名的摘要。 */
  id: string;
  /** SKILL.md frontmatter 的原始名称（主标题）。 */
  name: string;
  /** 中文展示名（本地词目或当前 Profile 覆盖）。 */
  displayName: string;
  /** 原始 description。 */
  description: string;
  /** 中文展示简介。 */
  displayDescription: string;
  /** 中文展示来源：custom（当前 Profile 覆盖）、catalog（本地词目）、source（原文即中文）、untranslated（未收录）。 */
  presentationSource: "custom" | "catalog" | "source" | "untranslated" | string;
  /** 标签（本地保存，按中央库技能 id 归档）。 */
  tags: string[];
  source: SkillSourceRef;
  upstream: SkillUpstream;
  /**
   * 最近一次成功部署的 Agent id（只用于展示"已部署"标记与回显）。
   * 实际是否存在请看 agents[].deployed —— 那是每次实时核验的结果。
   */
  deployedTo: string[];
  /** 实时核验的 Agent 徽标。 */
  agents: SkillAgentBadge[];
  libraryStatus: SkillLibraryStatus;
  /** SKILL.md 内联摘要（前 240 个字符，安全快照，不含脚本）。 */
  excerpt: string;
  /** 正文摘要（sha256）。 */
  digest: string;
  /** 目录内容指纹（文件相对路径 + 大小 + 修改时间的摘要）。 */
  fingerprint: string;
  /** 技能文件数量与总字节数（只统计已登记目录内的普通文件）。 */
  files: number;
  bytes: number;
  /** 修改时间（ISO 8601）。 */
  updatedAt: string;
  /** 无法解析元数据时的警告。 */
  warning: string;
}

export interface SkillDetail extends SkillCard {
  /** SKILL.md 原文（只读快照，可能为压缩前内容）。 */
  content: string;
  /** 技能根目录的绝对路径。 */
  path: string;
  /** 详情返回时刻重新核验：SKILL.md 是否仍位于登记根内。 */
  fileExists: SkillEvidence;
  /** SKILL.md 与索引快照是否一致。 */
  contentMatchesSnapshot: boolean;
  /** 目录内相对路径列表（最多 200 条），用于预览结构。 */
  entries: string[];
  /** 附加文档：README.md 等（若存在）。 */
  readme: string;
}

export interface SkillPreset {
  id: string;
  name: string;
  /** 预设说明。 */
  description: string;
  /** 中央库技能 id 集合。 */
  skillIds: string[];
  /** 最近一次应用到某工作区的时间。 */
  appliedAt: string;
  /** 最近一次应用显示名称。 */
  appliedWorkspace: string;
}

export interface SkillPresetApplyResult {
  presetId: string;
  workspaceId: string;
  workspaceName: string;
  /** 实际新增部署的技能。 */
  applied: string[];
  /** 已处于满足状态而跳过的技能。 */
  skipped: string[];
  /** 逐技能结果与失败原因。 */
  results: { skillId: string; agentId: string; ok: boolean; mode: SkillDeployMode | ""; error: string }[];
}

export interface SkillWorkspace {
  id: string;
  kind: SkillWorkspaceKind;
  name: string;
  /** 工作区根目录（project/linked 为绝对路径；global 为空的 Agent 聚合视图）。 */
  root: string;
  /** 该工作区涉及的 Agent id 列表。 */
  agentIds: string[];
  /** 根目录是否存在。 */
  exists: boolean;
}

export interface SkillAgent {
  id: string;
  name: string;
  /** 全局技能目录（绝对路径）。 */
  globalPath: string;
  /** 全局目录是否存在。 */
  exists: boolean;
  /** global（用户级）或 custom（自定义覆盖）。 */
  origin: "builtin" | "custom";
  /** 项目级目录相对工作区根的路径，例如 ".codex/skills"；不支持的 Agent 为空字符串。 */
  projectRelative: string;
  /** 来源：本地登记或 Profile 覆盖。 */
  enabled: boolean;
}

export interface SkillWorkspaceEntry {
  /** global 工作区内的技能 id（中央库 id 或本地扫描 id）。 */
  id: string;
  name: string;
  displayName: string;
  displayDescription: string;
  description: string;
  /** 是否来自中央库。 */
  inLibrary: boolean;
  librarySkillId: string;
  /** 该工作区内实际核验到的部署状态。 */
  deployStatus: SkillDeployStatus;
  mode: SkillDeployMode | "";
  path: string;
  /** 中央库状态（仅 inLibrary 时有意义）。 */
  libraryStatus: SkillLibraryStatus;
  tags: string[];
  /** 无中文资料时为 true。 */
  missingLocalization: boolean;
}

export interface SkillWorkspaceSyncRow {
  skillId: string;
  name: string;
  displayName: string;
  /** 中央库存在 / 工作区存在。 */
  library: boolean;
  workspace: boolean;
  deployStatus: SkillDeployStatus;
  /** add-to-workspace、add-to-library、in-sync、differs、external。 */
  action: "add-to-workspace" | "add-to-library" | "in-sync" | "differs" | "external";
}

export interface SkillActivityEvent {
  at: string;
  action: string;
  workspaceId: string;
  agentId: string;
  skillId: string;
  skillName: string;
  ok: boolean;
  /** 真实部署方式（失败时为空）。 */
  mode: SkillDeployMode | "";
  /** 失败原因或核验说明；不记录技能正文与凭据。 */
  detail: string;
}

export interface SkillLibraryConfig {
  /** 中央库根目录（Profile 内），可由设置覆盖绝对路径。 */
  root: string;
  /** 同步方式偏好：symlink 失败回退 copy。 */
  defaultMode: "symlink" | "copy";
  /** 技能数量与占用字节（只统计已登记目录内的普通文件）。 */
  count: number;
  bytes: number;
}

export interface SkillManagerOverview {
  library: SkillLibraryConfig;
  agents: SkillAgent[];
  presets: SkillPreset[];
  workspaces: SkillWorkspace[];
  /** 中央库技能数量。 */
  libraryTotal: number;
  /** 标签汇总（名称与技能数）。 */
  tags: { name: string; count: number }[];
  /** 最近活动（倒序）。 */
  activity: SkillActivityEvent[];
  /** 上次扫描信息。 */
  scan: unknown;
  /** 所有写操作在此保持只读：技能正文只预览，不执行。 */
  readonlySources: true;
}

/** POST /api/skill-manager/sync 的请求体。 */
export interface SkillSyncBody {
  workspaceId: string;
  /** 只处理这些技能；为空表示全部。 */
  skillIds?: string[];
  /** symlink | copy，缺省用设置偏好。 */
  mode?: "symlink" | "copy";
  /** 仅预览，不写入。 */
  dryRun?: boolean;
}

const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;
/** 请求中的 id 只允许字母数字与 _.- ，用于在访问文件系统前拒绝非法输入。 */
export const safeSkillId = (value: unknown) => typeof value === "string" && SAFE_ID.test(value);
