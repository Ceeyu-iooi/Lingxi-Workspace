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

/* ------------------------------------------------------------------ stat chips */

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="gt-stat" title={hint}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

/* --------------------------------------------------------------------- the rail */

function LaneRail({
  commits,
  lanes,
  activeLane,
  onHover,
}: {
  commits: GitTimelineCommit[];
  lanes: number;
  activeLane: number | null;
  onHover: (lane: number | null) => void;
}) {
  return (
    <div className="gt-lanes" style={{ ["--gt-lanes" as string]: lanes }}>
      <span className="gt-lanes-caption" aria-hidden="true">
        泳道
      </span>
      {Array.from({ length: Math.max(1, lanes) }, (_, lane) => (
        <button
          key={lane}
          type="button"
          className="gt-lane-key"
          aria-pressed={activeLane === lane}
          onMouseEnter={() => onHover(lane)}
          onMouseLeave={() => onHover(null)}
          onFocus={() => onHover(lane)}
          onBlur={() => onHover(null)}
          title={`只高亮第 ${lane + 1} 条泳道（${commits.filter((c) => c.lane === lane).length} 个提交）`}
        >
          <i style={{ background: laneColor(lane) }} aria-hidden="true" />
          L{lane + 1}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- the graph */

function TimelineGraph({
  result,
  activeLane,
  selected,
  onSelect,
}: {
  result: GitTimelineResult;
  activeLane: number | null;
  selected: string | null;
  onSelect: (hash: string) => void;
}) {
  const commits = result.commits;
  const lanes = Math.max(1, result.summary.lanes);
  const laneHeight = 28;
  const scroller = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(1200);
  // A horizontal rail that shows only a handful of nodes reads as broken, so the per-node
  // gap adapts: fill the viewport up to ~24 commits, then scroll.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const measure = () => setViewport(Math.max(320, Math.round(node.clientWidth || 1200)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const wanted = Math.max(1, Math.min(commits.length, 24));
  const nodeGap = Math.max(46, Math.min(132, Math.floor(viewport / wanted)));
  const graphWidth = Math.max(viewport, 40 + Math.max(0, commits.length - 1) * nodeGap);
  const graphHeight = lanes * laneHeight + 30;
  const y = (lane: number) => 20 + lane * laneHeight;
  const labelEvery = Math.max(1, Math.round(72 / nodeGap));
  return (
    <div
      className="gt-graph-scroll"
      ref={scroller}
      tabIndex={0}
      aria-label="Git 水平时间轴图，可左右滚动"
    >
      <div className="gt-graph" style={{ width: graphWidth, height: graphHeight }}>
        <svg
          className="gt-graph-lines"
          width={graphWidth}
          height={graphHeight}
          aria-hidden="true"
        >
          {commits.map((commit, index) => {
            const x = 20 + index * nodeGap;
            const lane = commit.lane;
            const firstParent = commit.parents[0];
            const parentIndex = firstParent
              ? commits.findIndex((c) => c.hash === firstParent)
              : -1;
            const segments: React.ReactNode[] = [];
            if (parentIndex >= 0) {
              const parent = commits[parentIndex];
              const px = 20 + parentIndex * nodeGap;
              const py = y(parent.lane);
              segments.push(
                <path
                  key={`p-${index}`}
                  d={`M ${x} ${y(lane)} C ${x - nodeGap / 2} ${y(lane)}, ${px + nodeGap / 2} ${py}, ${px} ${py}`}
                  fill="none"
                  stroke={laneColor(lane)}
                  strokeWidth={commit.kind === "merge" ? 2.4 : 1.7}
                  opacity={activeLane == null || activeLane === lane ? 0.85 : 0.16}
                />,
              );
            }
            for (const extra of commit.parents.slice(1)) {
              const parentIndex2 = commits.findIndex((c) => c.hash === extra);
              if (parentIndex2 < 0) continue;
              const other = commits[parentIndex2];
              segments.push(
                <path
                  key={`m-${index}-${extra.slice(0, 6)}`}
                  d={`M ${x} ${y(lane)} C ${x - nodeGap / 2} ${y(lane)}, ${x - nodeGap / 2} ${y(other.lane)}, ${20 + parentIndex2 * nodeGap} ${y(other.lane)}`}
                  fill="none"
                  stroke={laneColor(other.lane)}
                  strokeWidth={1.6}
                  strokeDasharray="5 4"
                  opacity={activeLane == null || activeLane === lane ? 0.7 : 0.14}
                />,
              );
            }
            return segments;
          })}
        </svg>
        {commits.map((commit, index) => (
          <div
            key={commit.hash}
            className={
              "gt-node" +
              (activeLane === commit.lane ? " is-lane-active" : "") +
              (selected === commit.hash ? " is-selected" : "")
            }
            style={{
              left: 20 + index * nodeGap,
              top: y(commit.lane),
              ["--gt-lane" as string]: laneColor(commit.lane),
            }}
          >
            <button
              type="button"
              className="gt-node-dot"
              aria-label={`${commit.kind === "merge" ? "合并" : "提交"} ${commit.shortHash} ${commit.subject}`}
              aria-pressed={selected === commit.hash}
              onClick={() => onSelect(commit.hash)}
              title={`${commit.shortHash} · ${shortDate(commit.at)}\n${commit.subject}`}
            >
              <i aria-hidden="true" />
            </button>
            {index % labelEvery === 0 || index === commits.length - 1 ? (
              <span className="gt-node-meta" aria-hidden="true">
                <b>{commit.shortHash.slice(0, 6)}</b>
                <small>{dayOf(commit.at).slice(5)}</small>
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ detail card */

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

function App() {
  const [result, setResult] = useState<GitTimelineResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [limit, setLimit] = useState(40);
  const [selected, setSelected] = useState<string | null>(null);
  const [activeLane, setActiveLane] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
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
          current && value.commits.some((c) => c.hash === current) ? current : null,
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
    () => result?.commits.find((c) => c.hash === selected) || null,
    [result, selected],
  );

  const byDay = useMemo(() => {
    const buckets = new Map<string, GitTimelineCommit[]>();
    for (const commit of commits) {
      const day = dayOf(commit.at);
      (buckets.get(day) || buckets.set(day, []).get(day)!).push(commit);
    }
    return [...buckets]
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 14);
  }, [commits]);

  const maxDay = byDay.reduce((n, [, list]) => Math.max(n, list.length), 0);

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
                : "读取仓库历史"}
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
            时间轴只读取本机仓库元数据，不联网、不修改仓库配置，也不会上传提交信息。
          </p>
        </section>
      ) : null}

      {result?.available ? (
        <>
          <section className="gt-stats" aria-label="仓库概览">
            <Stat label="提交（本次）" value={countText(result.summary.commitCountReturned)} hint="本次读取的提交条数" />
            <Stat label="泳道" value={String(result.summary.lanes)} hint="按父子关系推导出的分支泳道数，最多 6 条" />
            <Stat label="活跃天" value={String(result.summary.activeDays)} hint="本次提交覆盖的不同日期数" />
            <Stat label="分支" value={String(result.branches.length)} hint="本地与远程分支总数" />
            <Stat label="标签" value={String(result.summary.tags.length)} />
            <Stat
              label="最新"
              value={shortDate(result.summary.latestCommitAt)}
              hint="本次返回中最新的提交时间"
            />
          </section>

          <div className="gt-controls">
            <label>
              显示条数
              <select
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
              </select>
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
            <LaneRail
              commits={commits}
              lanes={Math.max(1, result.summary.lanes)}
              activeLane={activeLane}
              onHover={setActiveLane}
            />
            <span className="gt-muted">
              {result.cached ? "缓存结果" : "实时读取"} · {result.durationMs} ms
            </span>
          </div>

          <div className="gt-body">
            <section className="gt-main" aria-label="时间轴">
              <TimelineGraph
                result={{ ...result, commits }}
                activeLane={activeLane}
                selected={selected}
                onSelect={setSelected}
              />
              {result.summary.truncated ? (
                <p className="gt-muted gt-truncated">
                  仓库还有更早提交；提高“显示条数”可继续查看。变更统计仅在 60 条以内时计算。
                </p>
              ) : null}
            </section>
            <CommitDetail commit={selectedCommit} />
          </div>

          <div className="gt-bottom">
            <section className="gt-card" aria-label="按日期分布">
              <h2>提交节奏</h2>
              <ul className="gt-days">
                {byDay.map(([day, list]) => (
                  <li key={day}>
                    <span>{day}</span>
                    <i style={{ width: `${maxDay ? (list.length / maxDay) * 100 : 0}%` }} aria-hidden="true" />
                    <b>{list.length}</b>
                  </li>
                ))}
                {!byDay.length ? <li className="gt-muted">没有匹配的提交</li> : null}
              </ul>
            </section>
            <section className="gt-card" aria-label="作者">
              <h2>作者</h2>
              <ul className="gt-authors">
                {result.summary.authors.map((author) => (
                  <li key={author.name}>
                    <span>{author.name}</span>
                    <b>{author.commits}</b>
                  </li>
                ))}
                {!result.summary.authors.length ? <li className="gt-muted">未记录作者</li> : null}
              </ul>
            </section>
            <section className="gt-card" aria-label="分支与标签">
              <h2>分支与标签</h2>
              <ul className="gt-refs">
                {result.branches.map((branch) => (
                  <li key={branch.name} data-head={branch.head} data-remote={branch.remote}>
                    <span>{branch.name}</span>
                    <b>{branch.head ? "当前" : branch.remote ? "远程" : "本地"}</b>
                  </li>
                ))}
                {result.summary.tags.map((tag) => (
                  <li key={"tag-" + tag.name} data-tag="true">
                    <span>{tag.name}</span>
                    <b>标签</b>
                  </li>
                ))}
              </ul>
            </section>
          </div>

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

      <footer className="gt-foot">
        <span>灵犀工作坊 · Git 时间轴</span>
        <span className="gt-muted">
          只读：git log / branch / tag。不推送、不修改仓库；绝对路径不离开本机。
        </span>
      </footer>
    </div>
  );
}

const host = document.getElementById("git-timeline-root");
if (host) createRoot(host).render(<App />);
