import type { GitTimelineResult } from "../../src/shared/git-timeline";

type Changes = {
  available: boolean;
  files: { path: string; added: number | null; deleted: number | null }[];
  patch: string | null;
  truncated?: boolean;
};

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, cache: "no-store" });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Git 记录读取失败");
  return value as T;
}

export async function readTimeline(force: boolean) {
  const history = await request<GitTimelineResult>(`/api/git/timeline?limit=120${force ? "&force=1" : ""}`);
  if (!history.available) throw new Error(history.reason || "仓库没有可读取的提交");
  const date = new Date(history.cachedAt ?? history.generatedAt).toLocaleString("zh-CN", { hour12: false });
  const status = history.stale ? "离线记录" : history.cached ? "已缓存" : "记录时间";
  const remote = history.remote && /^[\w.-]+\/[\w.-]+$/.test(history.remote) ? history.remote : null;
  return {
    branch: history.summary.branch,
    source: `${history.sourceLabel} · ${status} ${date}`,
    commitUrl: remote ? `https://github.com/${remote}/commit/` : null,
    commits: history.commits.map(commit => ({
      id: commit.hash,
      parents: commit.parents,
      date: commit.at ?? "",
      subject: commit.subject,
      refs: commit.refs
        .filter(ref => ref.kind !== "head")
        .map(ref => ref.kind === "tag" ? `tag: ${ref.name}` : ref.name)
        .join(", "),
    })),
  };
}

export async function readChanges(id: string) {
  const value = await request<Changes>(`/api/git/timeline/changes?${new URLSearchParams({hash:id})}`);
  if (!value.available) throw new Error("当前仓库无法读取变更文件。");
  return {
    files: value.files.map(file => ({
      path: file.path,
      additions: file.added,
      deletions: file.deleted,
      binary: file.added === null && file.deleted === null,
    })),
    patchTruncated: value.truncated,
  };
}

export async function readPatch(id: string, path: string, signal: AbortSignal) {
  const value = await request<Changes>(`/api/git/timeline/changes?${new URLSearchParams({hash:id,file:path})}`, signal);
  if (!value.available) throw new Error("当前仓库无法读取这个文件的差异。");
  const patch = value.patch ?? "";
  // GitHub REST can return the hunks without a unified diff file header.
  const prefixed = patch.startsWith("@@ ") ? `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${patch}` : patch;
  return { patch: prefixed, truncated: !!value.truncated };
}
