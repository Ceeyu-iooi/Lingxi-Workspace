export type Theme = "zai-light" | "zai-dark" | "light" | "dark" | "system";

export interface UsageEventRecord {
  id: string;
  source: string;
  at: string;
  granularity?: "event";
}
export interface UsageAggregateRecord {
  source: string;
  at: string;
  local_date: string;
  granularity: "summary";
  _aggregate: { observations: number; failures: number; [key: string]: unknown };
}
/** Aggregate identity is source + date + dimensions, never an event ID. */
export function isUsageEventRecord(row: Record<string, any>): row is UsageEventRecord {
  if (row.granularity === "summary") return false;
  if (typeof row.id !== "string" || !row.id)
    throw new Error("逐条用量记录缺少有效消费 ID");
  return true;
}
export interface ProfileSession {
  user: { username: string; display_name: string; profileId: string } | null;
  profile: {
    format: "lingxi-profile";
    schemaVersion: 1;
    profileId: string;
    username: string;
    createdAt: string;
  } | null;
}
export interface RuntimeInfo {
  version: string;
  profileId: string | null;
  serviceId: string;
  pid: number;
  desktop: boolean;
  preview: boolean;
  sharedService: boolean;
  startedAt: string;
  backend: "node-typescript";
}
export interface Project {
  id: string;
  name: string;
  status: "active" | "waiting" | "done";
  createdAt: string;
  note: string;
}
export interface Task {
  id: string;
  projectId: string | null;
  title: string;
  done: boolean;
  createdAt: string;
  completedAt: string | null;
  dueAt: string | null;
  location: string | null;
  keywords: string[];
}
export interface Transaction {
  id: string;
  date: string;
  amount: number;
  kind: "income" | "expense";
  title: string;
  category: string;
  fingerprint: string;
  createdAt: string;
}
export interface Activity {
  id: string;
  text: string;
  at: string;
}
export interface Summary {
  id: string;
  month: string;
  content: string;
  stats: Record<string, number>;
  savedAt: string;
}
export interface BackupEnvelope {
  format: "lingxi-profile-encrypted";
  formatVersion: 1;
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}
export interface ApiFailure {
  error: string;
  status?: number;
  conflict?: boolean;
  current?: unknown;
}

export interface CodexAccountSnapshot {
  authorization: "chatgpt" | "missing" | "expired";
  observedAt: string;
  quota?: { rateLimitsByLimitId?: Record<string, unknown>; rateLimits?: unknown; rateLimitResetCredits?: { availableCount: number | null; credits: Array<{ id: string; expiresAt: number | null }> | null } | null };
  unavailable: Record<string, string>;
}
