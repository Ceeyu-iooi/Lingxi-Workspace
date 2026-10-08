export type Theme = "zai-light" | "zai-dark" | "light" | "dark" | "system";
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
