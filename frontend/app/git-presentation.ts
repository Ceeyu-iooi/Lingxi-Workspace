// Adapted from Semanote-Agent's frontend/src/gitPresentation.js (MIT).
// Upstream revision cd8842d67532611a12a649b5eb0125ae59594d09.
import type { GitTimelineCommit } from "../../src/shared/git-timeline";

export const gitGroups = {
  main: { name: "发布主线", color: "var(--git-lane-0)" },
  develop: { name: "开发集成", color: "var(--git-lane-1)" },
  release: { name: "发布准备", color: "var(--git-lane-2)" },
  feature: { name: "并行功能", color: "var(--git-lane-3)" },
  hotfix: { name: "修复分支", color: "var(--git-lane-4)" },
};

type Group = keyof typeof gitGroups;

function branchNames(commit: GitTimelineCommit): string[] {
  return commit.refs
    .filter(ref => ref.kind === "branch" || ref.kind === "remote")
    .map(ref => ref.name.replace(/^origin\//, ""));
}

function branchGroup(name: string): Group {
  if (name === "main" || name === "master") return "main";
  if (name === "develop") return "develop";
  if (name.startsWith("release/")) return "release";
  if (name.startsWith("hotfix/")) return "hotfix";
  return "feature";
}

export const gitColumnWidth = 248;
export const gitLaneHeight = 44;

export function buildGitGraph(history: GitTimelineCommit[], visible: GitTimelineCommit[]) {
  const byId = new Map(history.map(commit => [commit.hash, commit]));
  function firstParents(start: string | undefined, stop = new Set<string>()) {
    const found = new Set<string>();
    let id = start;
    while (id && byId.has(id) && !stop.has(id) && !found.has(id)) {
      found.add(id);
      id = byId.get(id)?.parents[0];
    }
    return found;
  }

  const main = history.find(commit => branchNames(commit).some(name => name === "main" || name === "master"));
  const develop = history.find(commit => branchNames(commit).includes("develop"));
  const mainPath = firstParents(main?.hash);
  const developPath = firstParents(develop?.hash);
  const mainlines = new Set([...mainPath, ...developPath]);
  const releasePath = new Set<string>();
  const hotfixPath = new Set<string>();
  for (const commit of history) {
    const names = branchNames(commit);
    if (names.some(name => name.startsWith("release/"))) {
      for (const id of firstParents(commit.hash, mainlines)) releasePath.add(id);
    }
    if (names.some(name => name.startsWith("hotfix/"))) {
      for (const id of firstParents(commit.hash, mainlines)) hotfixPath.add(id);
    }
  }
  for (const id of mainPath) {
    for (const parent of byId.get(id)?.parents.slice(1) ?? []) {
      for (const item of firstParents(parent, mainlines)) releasePath.add(item);
    }
  }

  const groupById = new Map<string, Group>();
  for (const { hash } of history) {
    let group: Group = "feature";
    if (developPath.has(hash)) group = "develop";
    if (releasePath.has(hash)) group = "release";
    if (mainPath.has(hash)) group = "main";
    if (hotfixPath.has(hash)) group = "hotfix";
    groupById.set(hash, group);
  }
  const lanes = (Object.keys(gitGroups) as Group[])
    .filter(group => visible.some(commit => groupById.get(commit.hash) === group))
    .map((group, index) => ({
      group,
      y: 28 + index * gitLaneHeight,
      names: [...new Set(history
        .filter(commit => groupById.get(commit.hash) === group)
        .flatMap(commit => branchNames(commit).filter(name => branchGroup(name) === group)))],
    }));
  const laneByGroup = new Map(lanes.map(lane => [lane.group, lane]));
  const nodes = visible.map((commit, index) => {
    const group = groupById.get(commit.hash) ?? "feature";
    return { commit, group, x: (index + 0.5) * gitColumnWidth, y: laneByGroup.get(group)?.y ?? 28 };
  });
  const positions = new Map(nodes.map(node => [node.commit.hash, node]));
  const edges = nodes.flatMap(node => node.commit.parents.flatMap(id => {
    const parent = positions.get(id);
    if (!parent) return [];
    const midpoint = (parent.x + node.x) / 2;
    return [{
      id: node.commit.hash + "-" + id,
      group: parent.group,
      d: `M ${parent.x} ${parent.y} C ${midpoint} ${parent.y}, ${midpoint} ${node.y}, ${node.x} ${node.y}`,
    }];
  }));
  return {
    nodes, positions, edges, lanes,
    width: Math.max(gitColumnWidth, nodes.length * gitColumnWidth),
    height: Math.max(80, lanes.length * gitLaneHeight + 12),
  };
}

export function parseDiffHunks(patch: string) {
  type DiffLine = { kind: "add" | "delete" | "context" | "note"; text: string; oldNumber: number | null; newNumber: number | null };
  const hunks: { header: string; lines: DiffLine[] }[] = [];
  let current: (typeof hunks)[number] | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) current = undefined;
    const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (match) {
      oldLine = Number(match[1]);
      newLine = Number(match[2]);
      current = {header: line, lines: []};
      hunks.push(current);
      continue;
    }
    if (!current || !/^[ +\-\\]/.test(line)) continue;
    const kind = line[0] === "+" ? "add" : line[0] === "-" ? "delete" : line[0] === "\\" ? "note" : "context";
    current.lines.push({
      kind,
      text: kind === "note" ? line : line.slice(1),
      oldNumber: kind === "add" || kind === "note" ? null : oldLine++,
      newNumber: kind === "delete" || kind === "note" ? null : newLine++,
    });
  }
  return hunks;
}
