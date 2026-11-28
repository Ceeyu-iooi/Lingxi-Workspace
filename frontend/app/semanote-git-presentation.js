// Semanote-Agent, cd8842d, MIT. See THIRD_PARTY_NOTICES.md.
/** Derive display groups from actual parent links and known refs; deleted branch names are never invented. */
export const gitGroups = {
  main: { name: "发布主线", color: "var(--git-main)" },
  develop: { name: "集成主线", color: "var(--git-develop)" },
  release: { name: "发布准备", color: "var(--git-release)" },
  feature: { name: "并行功能", color: "var(--git-feature)" },
  hotfix: { name: "修复分支", color: "var(--git-hotfix)" },
};
/** Normalize actual refs before classifying; substrings inside feature names are not mainlines. */
export function gitRefGroup(reference) {
  const value = reference
    .trim()
    .replace(/^HEAD -> /, "")
    .replace(/^origin\//, "");
  if (value.startsWith("tag:")) return "release";
  if (value === "master") return "main";
  if (value === "main" || value === "develop") return value;
  if (value.startsWith("hotfix/")) return "hotfix";
  if (value.startsWith("release/")) return "release";
  return "feature";
}
export function buildGitGraph(commits) {
  const byId = new Map(commits.map((commit) => [commit.id, commit]));
  const refs = (commit) =>
    commit.refs
      .split(",")
      .filter((value) => value.trim())
      .map((value) =>
        value
          .trim()
          .replace(/^HEAD -> /, "")
          .replace(/^origin\//, ""),
      );
  function firstParents(start, stop = new Set()) {
    const found = new Set();
    let id = start;
    while (id && !stop.has(id) && !found.has(id)) {
      found.add(id);
      id = byId.get(id)?.parents[0];
    }
    return found;
  }
  const main = commits.find((commit) => refs(commit).some((name) => name === "main" || name === "master")),
    develop = commits.find((commit) => refs(commit).includes("develop"));
  const mainPath = firstParents(main?.id),
    developPath = firstParents(develop?.id),
    releasePath = new Set(),
    hotfixPath = new Set();
  // Live refs provide evidence before merge; stop at the known integration/release baselines.
  const knownMainlines = new Set([...mainPath, ...developPath]);
  for (const commit of commits) {
    const names = refs(commit);
    for (const [prefix, path] of [
      ["release/", releasePath],
      ["hotfix/", hotfixPath],
    ]) {
      if (names.some((name) => name.startsWith(prefix)))
        for (const id of firstParents(commit.id, knownMainlines)) path.add(id);
    }
  }
  for (const id of mainPath) {
    const commit = byId.get(id);
    if (commit?.parents.length > 1)
      for (const parent of commit.parents.slice(1))
        for (const item of firstParents(parent, developPath))
          releasePath.add(item);
  }
  const nodes = [],
    positions = new Map();
  commits.forEach((commit, index) => {
    const group = hotfixPath.has(commit.id)
      ? "hotfix"
      : mainPath.has(commit.id)
        ? "main"
        : releasePath.has(commit.id)
          ? "release"
          : developPath.has(commit.id)
            ? "develop"
            : "feature";
    const node = {
      ...commit,
      group,
      x: (commits.length - 1 - index) * 248 + 124,
    };
    nodes.push(node);
    positions.set(commit.id, node);
  });
  // Main and integration paths retain separate labelled tracks instead of reusing a row over time.
  const groups = ["main", "develop", "release", "feature", "hotfix"].filter(
    (group) => nodes.some((node) => node.group === group),
  );
  const lanes = groups.map((group, lane) => {
    const names = [
      ...new Set(
        nodes
          .filter((node) => node.group === group)
          .flatMap((node) =>
            refs(node).filter(
              (name) =>
                name !== "HEAD" &&
                !name.startsWith("tag:") &&
                gitRefGroup(name) === group,
            ),
          ),
      ),
    ];
    return {
      group,
      lane,
      names: names.length ? names : [`${group} · 历史路径（名称未知）`],
    };
  });
  for (const node of nodes) {
    node.lane = groups.indexOf(node.group);
    node.y = 30 + node.lane * 44;
  }
  const edges = nodes.flatMap((node) =>
    node.parents
      .map((id) => positions.get(id))
      .filter(Boolean)
      .map((parent) => ({
        id: node.id + "-" + parent.id,
        group: parent.group,
        d: `M ${parent.x} ${parent.y} C ${(parent.x + node.x) / 2} ${parent.y}, ${(parent.x + node.x) / 2} ${node.y}, ${node.x} ${node.y}`,
      })),
  );
  return {
    nodes,
    edges,
    lanes,
    width: Math.max(248, commits.length * 248),
    height: Math.max(80, ...nodes.map((node) => node.y + 28)),
    groups: [...new Set(nodes.map((node) => node.group))],
  };
}

/** Parse unified patch text for a file-scoped, line-numbered read-only diff. */
export function parseUnifiedDiff(patch) {
  const files = [];
  let file = null,
    hunk = null,
    oldLine = 0,
    newLine = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = { path: "", oldPath: "", hunks: [], binary: false };
      files.push(file);
      hunk = null;
    } else if (file && line.startsWith("--- "))
      file.oldPath = line.slice(4).replace(/^a\//, "");
    else if (file && line.startsWith("+++ "))
      file.path =
        line.slice(4) === "/dev/null"
          ? file.oldPath
          : line.slice(4).replace(/^b\//, "");
    else if (file && /^Binary files |^GIT binary patch/.test(line))
      file.binary = true;
    else if (file && line.startsWith("@@ ")) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!match) continue;
      oldLine = Number(match[1]);
      newLine = Number(match[2]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
    } else if (hunk && /^[ +\-\\]/.test(line)) {
      const kind =
        line[0] === "+"
          ? "add"
          : line[0] === "-"
            ? "delete"
            : line[0] === "\\"
              ? "note"
              : "context";
      hunk.lines.push({
        kind,
        text: kind === "note" ? line : line.slice(1),
        oldNumber: kind === "add" || kind === "note" ? null : oldLine++,
        newNumber: kind === "delete" || kind === "note" ? null : newLine++,
      });
    }
  }
  return files.filter((file) => file.path);
}
