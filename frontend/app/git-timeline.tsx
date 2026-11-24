import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import "./motion";
import "./surfaces";
import "./overlay";
import "../compat/rounded-selects";
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

const LANE_COLORS = [
  "var(--git-lane-0)",
  "var(--git-lane-1)",
  "var(--git-lane-2)",
  "var(--git-lane-3)",
  "var(--git-lane-4)",
  "var(--git-lane-5)",
];

const laneColor = (lane: number) => LANE_COLORS[Math.max(0, Math.min(5, lane))];

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

const refFamily = (name: string) => name.replace(/^origin\//, "").split("/")[0];
const branchName: Record<string,string> = {master:"发布主线",main:"发布主线",develop:"开发集成",feature:"功能开发",release:"版本准备",hotfix:"紧急修复"};

function TimelineGraph({commits, history, lanes, selected, onSelect}: {
  commits: GitTimelineCommit[];
  history: GitTimelineCommit[];
  lanes: number;
  selected: string | null;
  onSelect: (hash: string) => void;
}) {
  const column=204, trackHeight=42, mapHeight=lanes*trackHeight+22;
  const x=(index:number)=>index*column+column/2;
  const y=(lane:number)=>lane*trackHeight+26;
  const order=useMemo(()=>new Map(commits.map((commit,i)=>[commit.hash,i])),[commits]);
  const scroll=useRef<HTMLDivElement>(null);
  const index=selected?order.get(selected):undefined;
  useLayoutEffect(()=>{
    const node=scroll.current;
    if(!node||index===undefined)return;
    const reduced=matchMedia("(prefers-reduced-motion: reduce)").matches||document.documentElement.dataset.motion==="reduced";
    node.scrollTo({left:Math.max(0,x(index)-node.clientWidth/2),behavior:reduced?"instant":"smooth"});
  },[index,commits]);
  const labels = Array.from({length:lanes},(_,lane)=>{
    const names=[...new Set(history.filter(c=>c.lane===lane).flatMap(c=>c.refs.filter(ref=>ref.kind==="branch"||ref.kind==="remote").map(ref=>ref.name)))];
    const family=names.map(refFamily).find(name=>branchName[name]);
    return {names, family};
  });
  const width=Math.max(column,commits.length*column);
  return <div className="gt-history">
    <aside aria-label="分支轨道" className="gt-track-labels">
      {labels.map(({names,family},lane)=><div key={lane} style={{height:trackHeight,"--commit-color":laneColor(lane)} as React.CSSProperties}>
        <strong>{family||names[0]||`轨道 ${lane+1}`}</strong>
        <small title={names.join(" / ")}>{family?branchName[family]:names.slice(1).join(" / ")}</small>
      </div>)}
    </aside>
    <div className="gt-graph-scroll" ref={scroll} tabIndex={0} aria-label="提交时间轴，左侧较早，右侧较新">
      <div className="gt-track" style={{width}}>
        <svg width={width} height={mapHeight} aria-hidden="true">
          {labels.map((_,lane)=><line key={lane} x1={0} x2={width} y1={y(lane)} y2={y(lane)} stroke="var(--line)" />)}
          {commits.flatMap((commit,to)=>commit.parents.map((parent,parentNumber)=>{
            const from=order.get(parent);
            if(from===undefined)return null;
            const px=x(from),cx=x(to),py=y(commits[from].lane),cy=y(commit.lane),mid=(px+cx)/2;
            const reached=index===undefined||to<=index;
            return <path key={commit.hash+parent} d={`M${px} ${py} C${mid} ${py},${mid} ${cy},${cx} ${cy}`}
              fill="none" stroke={laneColor(commits[from].lane)} strokeWidth={reached?3:2} opacity={reached?1:.24} strokeDasharray={parentNumber>0?"5 4":undefined}/>;
          }))}
          {index!==undefined&&<line className="gt-track-marker" x1={x(index)} x2={x(index)} y1={0} y2={mapHeight} />}
          {commits.map((commit,i)=><circle key={commit.hash} cx={x(i)} cy={y(commit.lane)} r={i===index?7:4} fill={laneColor(commit.lane)} opacity={index!==undefined&&i>index?0.32:1}/>)}
        </svg>
        <div className="gt-track-cards" style={{gridTemplateColumns:`repeat(${Math.max(1,commits.length)},${column}px)`}}>
          {commits.map((commit,i)=><button type="button" key={commit.hash} aria-pressed={commit.hash===selected}
            className={index!==undefined&&i>index?"is-upcoming":undefined}
            style={{"--commit-color":laneColor(commit.lane)} as React.CSSProperties} onClick={()=>onSelect(commit.hash)}>
            <span><b>{commit.kind==="merge"?"合并":"提交"}</b><time dateTime={commit.at||undefined}>{dayOf(commit.at)}</time></span>
            <strong title={commit.subject}>{commit.subject}</strong>
            <small>{commit.shortHash}</small>
            {commit.refs.length>0&&<span className="gt-card-refs">{commit.refs.slice(0,3).map(ref=><i key={ref.kind+ref.name} title={ref.name}>{ref.name}</i>)}</span>}
          </button>)}
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
        <i className="gt-detail-lane" style={{ background: laneColor(commit.lane) }} aria-hidden="true" />
        <small>L{commit.lane + 1}</small>
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
  const [choice,setChoice] = useState("");
  const [query,setQuery] = useState("");
  const [patch,setPatch] = useState<CommitChanges | null>(null);
  const [error,setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/git/timeline/changes?hash="+commit.hash,{signal:controller.signal})
      .then(async response => {
        if (!response.ok) throw Error((await response.json().catch(()=>null))?.error || "变更列表不可用");
        const value = await response.json() as CommitChanges;
        setChanges(value);
        setChoice(value.files[0]?.path || "");
      }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [commit.hash]);
  useEffect(() => {
    if (!choice) return;
    const controller = new AbortController();
    const params = new URLSearchParams({hash:commit.hash,file:choice});
    setPatch(null);
    fetch("/api/git/timeline/changes?"+params,{signal:controller.signal})
      .then(async response => { if (!response.ok) throw Error("代码差异不可用"); setPatch(await response.json()); })
      .catch(() => { if (!controller.signal.aborted) setPatch({available:false,files:[],patch:null}); });
    return () => controller.abort();
  },[commit.hash,choice]);
  if (error) return <p role="status">{error}</p>;
  if (!changes) return <p role="status">正在读取提交变更…</p>;
  if (!changes.available) return <p>当前仓库无法读取代码差异。</p>;
  const files = changes.files.filter(file => file.path.toLowerCase().includes(query.trim().toLowerCase()));
  const fileStatus=(file:CommitChanges["files"][number])=>file.added==null?"二进制":"变更";
  return <section className="gt-changes" aria-label="提交变更">
    <h2>变更文件 <small>{changes.files.length}</small></h2>
    <div className="gt-change-columns">
      <div className="gt-file-list">
        <input type="search" aria-label="筛选变更文件" placeholder="按路径筛选" value={query} onChange={event => setQuery(event.target.value)} />
        {files.map(file => <button type="button" key={file.path} aria-pressed={choice === file.path} onClick={() => setChoice(file.path)}>
          <span title={file.path}><small>{fileStatus(file)}</small> {file.path}</span><small>{file.added === null ? "—" : "+"+file.added+" / −"+file.deleted}</small>
        </button>)}
        {files.length === 0 && <p>没有匹配文件。</p>}
      </div>
      <div className="gt-diff-pane" aria-live="polite">
        {choice && <h3>{choice}</h3>}
        {patch?.truncated && <p>代码差异超过展示上限，已截断。</p>}
        {patch?.patch ? <DiffView patch={patch.patch}/> :
          <p>{!choice ? "请选择变更文件。" : patch ? "此文件没有可显示的文本差异。" : "正在读取代码差异…"}</p>}
      </div>
    </div>
  </section>;
}

function DiffView({patch}:{patch:string}){
  let oldLine=0,newLine=0,inHunk=false;
  return <div className="gt-diff-scroll" tabIndex={0} aria-label="逐行代码差异"><table><tbody>{patch.split("\n").map((line,i)=>{
    const hunk=/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if(hunk){oldLine=Number(hunk[1]);newLine=Number(hunk[2]);inHunk=true;return <tr key={i} data-kind="hunk"><td colSpan={4}>{line}</td></tr>;}
    if(!inHunk||(!line&&i>0)||line.startsWith("\\"))return null;
    const added=line.startsWith("+"),deleted=line.startsWith("-");
    return <tr key={i} data-kind={added?"added":deleted?"deleted":"context"}>
      <td>{added?"":oldLine++}</td><td>{deleted?"":newLine++}</td><td>{line[0]}</td><td>{line.slice(1)}</td>
    </tr>;
  })}</tbody></table></div>;
}

function App() {
  const [result, setResult] = useState<GitTimelineResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [limit, setLimit] = useState(40);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [branch, setBranch] = useState("");
  const ticket = useRef(0);

  const load = useCallback(
    async (nextLimit: number, force = false) => {
      const own = ++ticket.current;
      setLoading(true);
      setError("");
      try {
        const response = await fetch(
          `/api/git/timeline?limit=${nextLimit}${force ? "&force=1" : ""}`,
        );
        if (!response.ok) throw new Error("Git 时间轴读取失败");
        const value = (await response.json()) as GitTimelineResult;
        if (own !== ticket.current) return;
        setResult(value);
        setSelected((current) =>
          current && value.commits.some((c) => c.hash === current) ? current : value.commits[0]?.hash ?? null,
        );
      } catch (e) {
        if (own !== ticket.current) return;
        setError((e as Error).message);
      } finally {
        if (own === ticket.current) setLoading(false);
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
          <div className="gt-controls">
            <label>
              定位分支
              <span className="wb-select" data-select-host=""><select value={branch} onChange={event => locate(event.target.value)}>
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
              {chronological.length ? <TimelineGraph commits={chronological} history={result.commits} lanes={Math.max(1,result.summary.lanes)} selected={selectedCommit?.hash??null} onSelect={setSelected} /> : <p className="gt-muted">没有匹配的提交</p>}
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
            {result.source === "remote" && /^[\w.-]+\/[\w.-]+$/.test(result.summary.root) &&
              <a className="gt-external-commit" href={`https://github.com/${result.summary.root}/commit/${selectedCommit.hash}`} target="_blank" rel="noopener noreferrer">在 GitHub 打开提交 ↗</a>}
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
