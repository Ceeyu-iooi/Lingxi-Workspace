import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import "./motion";
import "./surfaces";
import "./overlay";
import "../compat/rounded-selects";
import { buildGitGraph, gitColumnWidth, gitGroups, gitLaneHeight, parseDiffHunks } from "./git-presentation";
import type {
  GitTimelineCommit,
  GitTimelineRef,
  GitTimelineResult,
} from "../../src/shared/git-timeline";

/* Horizontal Git timeline.
 *
 * The page is deliberately a sibling of the design preview rather than a main-nav route:
 * it is a maintenance view over this repository, not a business workspace module.
 * Every value comes from `/api/git/timeline`; nothing is synthesized. Counts that the
 * server could not determine stay `null` and render as "—".
 */

const refLabel: Record<GitTimelineRef["kind"], string> = {
  head: "HEAD",
  branch: "分支",
  tag: "标签",
  remote: "远程",
};

function shortDate(at: string | null): string {
  if (!at) return "—";
  return at.slice(0, 16).replace("T", " ");
}

function dayOf(at: string | null): string {
  return at ? at.slice(0, 10) : "—";
}

function countText(value: number | null): string {
  return value == null ? "—" : value.toLocaleString("zh-CN");
}

function TimelineGraph({ commits, history, selected, onSelect }: {
  commits: GitTimelineCommit[];
  history: GitTimelineCommit[];
  selected: string | null;
  onSelect: (hash: string) => void;
}) {
  const graph = useMemo(() => buildGitGraph(history, commits), [history, commits]);
  const scroll = useRef<HTMLDivElement>(null);
  const completed = useId();
  const selectedNode = selected ? graph.positions.get(selected) : undefined;
  const selectedX = selectedNode?.x ?? graph.width;

  useLayoutEffect(() => {
    const viewport = scroll.current;
    if (!viewport || !selectedNode) return;
    viewport.scrollTo({left: selectedNode.x - viewport.clientWidth / 2, behavior: "instant"});
  }, [selectedNode]);

  return <div className="gt-history">
    <aside aria-label="分支轨道" className="gt-track-labels">
      {graph.lanes.map(({group, names}) => (
        <div key={group} style={{height: gitLaneHeight, "--commit-color": gitGroups[group].color} as React.CSSProperties}>
          <strong>{gitGroups[group].name}</strong>
          <small title={names.join(" / ")}>{names.length ? names.join(" / ") : "历史路径"}</small>
        </div>
      ))}
    </aside>
    <div className="gt-graph-scroll" ref={scroll} tabIndex={0} aria-label="提交时间轴，左侧较早，右侧较新">
      <div className="gt-track" style={{width: graph.width}}>
        <svg width={graph.width} height={graph.height} aria-hidden="true">
          <defs><clipPath id={completed}><rect width={selectedX} height={graph.height} /></clipPath></defs>
          {graph.lanes.map(lane => <line key={lane.group} x1={0} x2={graph.width} y1={lane.y} y2={lane.y} stroke="var(--line)" />)}
          <g opacity=".25">
            {graph.edges.map(edge => <path key={edge.id} d={edge.d} fill="none" stroke={gitGroups[edge.group].color} strokeWidth={2} />)}
          </g>
          <g clipPath={`url(#${completed})`}>
            {graph.edges.map(edge => <path key={edge.id} d={edge.d} fill="none" stroke={gitGroups[edge.group].color} strokeWidth={3} />)}
          </g>
          {selectedNode && <line className="gt-track-marker" x1={selectedX} x2={selectedX} y1={0} y2={graph.height} />}
          {graph.nodes.map(({commit, group, x, y}) => (
            <circle key={commit.hash} cx={x} cy={y} r={commit.hash === selected ? 7 : 4}
              fill={gitGroups[group].color} opacity={x > selectedX ? .35 : 1} />
          ))}
        </svg>
        <div className="gt-track-cards" style={{gridTemplateColumns: `repeat(${graph.nodes.length}, ${gitColumnWidth}px)`}}>
          {graph.nodes.map(({commit, group, x}) => (
            <button type="button" key={commit.hash} aria-pressed={commit.hash === selected}
              className={x > selectedX ? "is-upcoming" : undefined}
              style={{"--commit-color": gitGroups[group].color} as React.CSSProperties} onClick={() => onSelect(commit.hash)}>
              <span><b>{gitGroups[group].name}</b><time dateTime={commit.at || undefined}>{dayOf(commit.at)}</time></span>
              <strong title={commit.subject}>{commit.subject}</strong>
              <small>{commit.shortHash}{commit.kind === "merge" ? " · 合并" : ""}</small>
              {commit.refs.length > 0 && <span className="gt-card-refs">{commit.refs.slice(0, 3).map(ref => <i key={ref.kind + ref.name} title={ref.name}>{ref.name}</i>)}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  </div>;
}

function CommitDetail({ commit }: { commit: GitTimelineCommit | null }) {
  if (!commit)
    return (
      <aside className="gt-detail gt-detail-empty">
        <h2>提交详情</h2>
        <p>点击时间轴上的任意节点查看该提交的完整信息。</p>
      </aside>
    );
  return (
    <aside className="gt-detail" aria-live="polite">
      <header>
        <span className="gt-detail-kind">{commit.kind === "merge" ? "合并提交" : "提交"}</span>
        <code title={commit.hash}>{commit.shortHash}</code>
      </header>
      <h2>{commit.subject}</h2>
      {commit.body ? <p className="gt-detail-body">{commit.body}</p> : null}
      <dl className="gt-detail-grid">
        <div>
          <dt>作者</dt>
          <dd>{commit.author}</dd>
        </div>
        <div>
          <dt>时间</dt>
          <dd>{shortDate(commit.at)}</dd>
        </div>
        <div>
          <dt>变更</dt>
          <dd>
            {commit.filesChanged == null
              ? "未计算"
              : `${commit.filesChanged} 文件 · +${countText(commit.insertions)} / −${countText(commit.deletions)}`}
          </dd>
        </div>
        <div>
          <dt>父提交</dt>
          <dd>{commit.parents.length ? commit.parents.map((p) => p.slice(0, 7)).join("、") : "无（根提交）"}</dd>
        </div>
      </dl>
      {commit.refs.length ? (
        <div className="gt-detail-refs">
          {commit.refs.map((ref) => (
            <span key={ref.kind + ref.name} data-kind={ref.kind} title={`${refLabel[ref.kind]}：${ref.name}`}>
              {ref.name}
            </span>
          ))}
        </div>
      ) : null}
    </aside>
  );
}

/* ------------------------------------------------------------------------ page */

interface CommitChanges {
  available: boolean;
  files: {path:string;added:number|null;deleted:number|null}[];
  patch: string | null;
  truncated?: boolean;
}

function ChangeWorkspace({commit}: {commit: GitTimelineCommit}) {
  const [changes,setChanges] = useState<CommitChanges | null>(null);
  const [filePreference, setFilePreference] = useState("");
  const [query,setQuery] = useState("");
  const [loadedPatch, setPatch] = useState<{path: string; value: CommitChanges | null} | null>(null);
  const [error,setError] = useState("");
  const files = (changes?.files ?? []).filter(file => file.path.toLowerCase().includes(query.trim().toLowerCase()));
  const choice = files.find(file => file.path === filePreference)?.path ?? files[0]?.path ?? "";
  const selectedPatch = loadedPatch?.path === choice ? loadedPatch : null;
  const patch = selectedPatch?.value;
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/git/timeline/changes?hash="+commit.hash,{signal:controller.signal})
      .then(async response => {
        if (!response.ok) throw Error((await response.json().catch(()=>null))?.error || "变更列表不可用");
        const value = await response.json() as CommitChanges;
        if (!controller.signal.aborted) setChanges(value);
      }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [commit.hash]);
  useEffect(() => {
    if (!choice) { setPatch(null); return; }
    const controller = new AbortController();
    const params = new URLSearchParams({hash:commit.hash,file:choice});
    setPatch(null);
    fetch("/api/git/timeline/changes?"+params,{signal:controller.signal})
      .then(async response => { if (!response.ok) throw Error("代码差异不可用"); const value = await response.json() as CommitChanges; if (!controller.signal.aborted) setPatch({path: choice, value}); })
      .catch(() => { if (!controller.signal.aborted) setPatch({path: choice, value: null}); });
    return () => controller.abort();
  },[commit.hash,choice]);
  if (error) return <p role="status">{error}</p>;
  if (!changes) return <p role="status">正在读取提交变更…</p>;
  if (!changes.available) return <p>当前仓库无法读取代码差异。</p>;
  const fileStatus=(file:CommitChanges["files"][number])=>file.added==null?"二进制":"变更";
  return <section className="gt-changes" aria-label="提交变更">
    <h2>变更文件 <small>{changes.files.length}</small></h2>
    <div className="gt-change-columns">
      <div className="gt-file-list">
        <input type="search" aria-label="筛选变更文件" placeholder="按路径筛选" value={query} onChange={event => setQuery(event.target.value)} />
        {files.map(file => <button type="button" key={file.path} aria-pressed={choice === file.path} onClick={() => setFilePreference(file.path)}>
          <span title={file.path}><small>{fileStatus(file)}</small> {file.path}</span><small>{file.added === null ? "—" : "+"+file.added+" / −"+file.deleted}</small>
        </button>)}
        {files.length === 0 && <p>没有匹配文件。</p>}
      </div>
      <div className="gt-diff-pane" aria-live="polite">
        {choice && <h3>{choice}</h3>}
        {patch?.truncated && <p>代码差异超过展示上限，已截断。</p>}
        {patch?.patch ? <DiffView patch={patch.patch}/> :
          <p>{!choice ? "请选择变更文件。" : selectedPatch?.value === null ? "代码差异读取失败。" : patch ? "此文件没有可显示的文本差异。" : "正在读取代码差异…"}</p>}
      </div>
    </div>
  </section>;
}

function DiffView({patch}: {patch: string}) {
  const hunks = useMemo(() => parseDiffHunks(patch), [patch]);
  if (!hunks.length) return <p>此文件没有可显示的文本差异。</p>;
  return <div className="gt-diff-scroll" tabIndex={0} aria-label="逐行代码差异">
    <table aria-label="差异行：原行号、新行号、类型、内容">
      {hunks.map((hunk, index) => <tbody key={index}>
        <tr data-kind="hunk"><td colSpan={4}>{hunk.header}</td></tr>
        {hunk.lines.map((line, index) => <tr key={index} data-kind={{add: "added", delete: "deleted", note: "note", context: "context"}[line.kind]}>
          <td>{line.oldNumber}</td><td>{line.newNumber}</td>
          <td>{line.kind === "add" ? "+" : line.kind === "delete" ? "−" : ""}</td>
          <td><code>{line.text || " "}</code></td>
        </tr>)}
      </tbody>)}
    </table>
  </div>;
}

function App() {
  const [result, setResult] = useState<GitTimelineResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [limit, setLimit] = useState(40);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [branch, setBranch] = useState("");
  const pending = useRef<AbortController | null>(null);
  const ticket = useRef(0);

  const load = useCallback(
    async (nextLimit: number, force = false) => {
      const own = ++ticket.current;
      pending.current?.abort();
      const request = new AbortController();
      pending.current = request;
      setLoading(true);
      setError("");
      try {
        const response = await fetch(
          `/api/git/timeline?limit=${nextLimit}${force ? "&force=1" : ""}`,
          { signal: request.signal, cache: "no-store" },
        );
        if (!response.ok) throw new Error("Git 时间轴读取失败");
        const value = (await response.json()) as GitTimelineResult;
        if (own !== ticket.current || request.signal.aborted) return;
        setResult(value);
        setSelected((current) =>
          current && value.commits.some((c) => c.hash === current) ? current : value.commits[0]?.hash ?? null,
        );
      } catch (e) {
        if (own !== ticket.current || request.signal.aborted) return;
        setError((e as Error).message);
      } finally {
        if (own === ticket.current && !request.signal.aborted) setLoading(false);
      }
    },
    [],
  );

  useLayoutEffect(() => {
    // Reuse the shared theme contract: same `data-theme` attribute and accent tokens as the
    // main app so the page never introduces a second visual language.
    fetch("/api/control")
      .then((r) => r.json())
      .then((control) => {
        (window as any).workbenchAppearance?.config(control.config);
      })
      .catch(() => {});
    void load(limit);
    return () => pending.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commits = useMemo(() => {
    if (!result) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return result.commits;
    return result.commits.filter(
      (c) =>
        c.subject.toLowerCase().includes(needle) ||
        c.author.toLowerCase().includes(needle) ||
        c.hash.startsWith(needle) ||
        c.shortHash.startsWith(needle),
    );
  }, [result, filter]);

  const selectedCommit = useMemo(
    () => commits.find((c) => c.hash === selected) ?? commits[0] ?? null,
    [commits, selected],
  );

  const chronological = useMemo(() => [...commits].reverse(), [commits]);
  const selectedPosition = Math.max(0, chronological.findIndex(commit => commit.hash === selectedCommit?.hash));
  const branches = [...new Set((result?.commits || []).flatMap(commit =>
    commit.refs.filter(ref => ref.kind === "branch" || ref.kind === "remote").map(ref => ref.name)))].sort();
  const branchSelection = branches.includes(branch) ? branch : "";
  const locate = (name: string) => {
    setBranch(name);
    if (!name) return;
    const match = result?.commits.find(commit => commit.refs.some(ref => ref.name === name));
    if (match) { setFilter(""); setSelected(match.hash); }
  };

  return (
    <div className="gt-page">
      <header className="gt-top">
        <div className="gt-brand">
          <img src="assets/lingxi-logo.svg" alt="" />
          <div>
            <h1>Git 时间轴</h1>
            <p>
              {result?.available
                ? `${result.summary.repository} · ${result.summary.branch ?? "分离头指针"} · 读取 ${result.summary.commitCountReturned} / ${result.summary.commitCountRequested} 个提交`
                : ""}
            </p>
          </div>
        </div>
        <nav className="gt-actions" aria-label="Git 时间轴操作">
          <button type="button" onClick={() => load(limit, true)} disabled={loading}>
            {loading ? "读取中…" : "刷新"}
          </button>
          <a href="/index.html">返回工作坊</a>
        </nav>
      </header>

      {error ? (
        <p className="gt-error" role="alert">
          {error}
          <button type="button" onClick={() => load(limit, true)}>
            重试
          </button>
        </p>
      ) : null}

      {result && !result.available ? (
        <section className="gt-unavailable">
          <h2>暂无可用时间轴</h2>
          <p>{result.reason || "当前资料目录不是 Git 仓库"}</p>
          <p className="gt-muted">
            可读取本机仓库或已配置的公开仓库。
          </p>
        </section>
      ) : null}

      {result?.available ? (
        <>
          <p className="gt-freshness" role="status">
            {result.sourceLabel} · {result.stale ? "离线记录" : result.cached ? "缓存" : "读取于"} {new Date(result.cachedAt ?? result.generatedAt).toLocaleString("zh-CN", { hour12: false })}
          </p>
          <div className="gt-controls">
            <label>
              定位分支
              <span className="wb-select" data-select-host=""><select value={branchSelection} onChange={event => locate(event.target.value)}>
                <option value="">全部历史</option>
                {branches.map(name => <option key={name} value={name}>{name}</option>)}
              </select></span>
            </label>
            <label>
              显示条数
              <span className="wb-select" data-select-host=""><select
                value={limit}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setLimit(next);
                  void load(next);
                }}
              >
                {[20, 40, 60, 120, 200].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select></span>
            </label>
            <label className="gt-search">
              筛选
              <input
                type="search"
                value={filter}
                placeholder="提交信息 / 作者 / 哈希"
                onChange={(e) => setFilter(e.target.value)}
              />
            </label>

          </div>

          <div className="gt-body">
            <section className="gt-main" aria-label="时间轴">
              {chronological.length ? <TimelineGraph commits={chronological} history={result.commits} selected={selectedCommit?.hash??null} onSelect={setSelected} /> : <p className="gt-muted">没有匹配的提交</p>}
              {chronological.length > 0 && <div className="gt-scrubber">
                <button type="button" disabled={selectedPosition === 0} onClick={() => setSelected(chronological[selectedPosition - 1].hash)} aria-label="较早提交">‹</button>
                <input type="range" min={0} max={chronological.length - 1} value={selectedPosition}
                  aria-label="提交位置" aria-valuetext={chronological[selectedPosition]?.subject}
                  onChange={event => setSelected(chronological[Number(event.target.value)].hash)} />
                <button type="button" disabled={selectedPosition >= chronological.length - 1} onClick={() => setSelected(chronological[selectedPosition + 1].hash)} aria-label="较新提交">›</button>
                <span>{selectedPosition + 1} / {chronological.length}</span>
              </div>}
              {result.summary.truncated ? (
                <p className="gt-muted gt-truncated">
                  仓库还有更早提交；提高“显示条数”可继续查看。变更统计仅在 60 条以内时计算。
                </p>
              ) : null}
            </section>
          </div>

          {selectedCommit && <section className="gt-selected">
            <CommitDetail commit={selectedCommit} />
            <ChangeWorkspace key={selectedCommit.hash} commit={selectedCommit} />
            {result.source === "remote" && result.remote && /^[\w.-]+\/[\w.-]+$/.test(result.remote) &&
              <a className="gt-external-commit" href={`https://github.com/${result.remote}/commit/${selectedCommit.hash}`} target="_blank" rel="noopener noreferrer">在 GitHub 打开提交 ↗</a>}
          </section>}
          {result.unverified?.length ? (
            <section className="gt-notes" aria-label="未核验项">
              <h2>未核验项</h2>
              <ul>
                {result.unverified.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}

      {loading && !result ? <p className="gt-loading">正在读取仓库历史…</p> : null}


    </div>
  );
}

const host = document.getElementById("git-timeline-root");
if (host) createRoot(host).render(<App />);
