export const extraAgentSources = {
  claude: { label: "Claude Code", input: "项目日志目录", icon: "claude" },
  copilot: { label: "GitHub Copilot", input: "session-store.db 或 OTLP 导出目录", icon: "copilot" },
  opencode: { label: "OpenCode", input: "opencode.db 或消息目录", icon: "opencode" },
  antigravity: { label: "Antigravity", input: "带时间戳的 CLI 流式日志目录", icon: "antigravity" },
} as const;
export type ExtraAgentSource = keyof typeof extraAgentSources;
export const extraAgentIds = Object.keys(extraAgentSources) as ExtraAgentSource[];
export const localAgentIds = ["codex", "zcode", "dsh", ...extraAgentIds] as const;
export type LocalAgentSource = (typeof localAgentIds)[number];
export const isExtraAgent = (value: string): value is ExtraAgentSource =>
  Object.hasOwn(extraAgentSources, value);
export const isLocalAgent = (value: string): value is LocalAgentSource =>
  (localAgentIds as readonly string[]).includes(value);
