<script setup>
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { readTimeline, readChanges, readPatch } from "./git-workbench-api";
import {
  buildGitGraph,
  gitGroups,
  gitRefGroup,
  parseUnifiedDiff,
} from "./semanote-git-presentation.js";
function refColor(name, fallback) {
  const group =
    name.trim().replace(/^origin\//, "") === "HEAD"
      ? fallback
      : gitRefGroup(name);
  return gitGroups[group].color;
}
const laneLabels = computed(() => graph.value.lanes || []);
const data = ref(null),
  index = ref(0),
  detail = ref(null),
  error = ref(""),
  busy = ref(false),
  detailBusy = ref(false),
  patchBusy = ref(false),
  patchError = ref(""),
  patch = ref(""),
  track = ref(null),
  branch = ref("all"),
  fileQuery = ref(""),
  selectedFile = ref("");
const rows = computed(() => data.value?.commits || []),
  selected = computed(() => rows.value[index.value]);
const branches = computed(() =>
  [
    ...new Set(
      rows.value.flatMap((row) => row.refs.split(", ").filter(Boolean)),
    ),
  ].filter((value) => !value.includes("HEAD")),
);
const graph = computed(() => buildGitGraph(rows.value)),
  ordered = computed(() => [...graph.value.nodes].reverse());
const selectedNode = computed(() =>
  graph.value.nodes.find((node) => node.id === selected.value?.id),
);
const position = computed({
  get: () => rows.value.length - 1 - index.value,
  set: (value) => {
    index.value = rows.value.length - 1 - Number(value);
  },
});
const fill = computed(() =>
  rows.value.length <= 1
    ? 100
    : (position.value / (rows.value.length - 1)) * 100,
);
const patches = computed(() => parseUnifiedDiff(patch.value));
const files = computed(
  () =>
    detail.value?.files ||
    patches.value.map((file) => ({
      path: file.path,
      binary: file.binary,
      additions: null,
      deletions: null,
    })),
);
const visibleFiles = computed(() =>
  files.value.filter((file) =>
    file.path.toLowerCase().includes(fileQuery.value.toLowerCase()),
  ),
);
const chosenFile = computed(
  () =>
    visibleFiles.value.find((file) => file.path === selectedFile.value) ||
    visibleFiles.value[0],
);
const chosenPatch = computed(() =>
  patches.value.find((file) => file.path === chosenFile.value?.path) ?? patches.value[0],
);
const totals = computed(() =>
  files.value.reduce(
    (counts, file) => ({
      added: counts.added + (file.additions || 0),
      deleted: counts.deleted + (file.deletions || 0),
    }),
    { added: 0, deleted: 0 },
  ),
);
let sequence = 0, historySequence = 0;
async function load(force = false) {
  const ticket = ++historySequence;
  busy.value = true;
  error.value = "";
  try {
    const oldId = selected.value?.id;
    const value = await readTimeline(force);
    if (ticket !== historySequence) return;
    const oldIndex = value.commits.findIndex(row => row.id === oldId);
    index.value = Math.max(0, oldIndex);
    data.value = value;
    if (!value.commits.some(row => row.refs.split(", ").includes(branch.value))) branch.value = "all";
    if (selected.value?.id === oldId) await loadDetail();
  } catch (cause) {
    if (ticket === historySequence) error.value = cause.message;
  } finally {
    if (ticket === historySequence) busy.value = false;
  }
}
async function loadDetail() {
  const id = selected.value?.id,
    current = ++sequence;
  detail.value = null;
  detailBusy.value = !!id;
  patchError.value = "";
  selectedFile.value = "";
  fileQuery.value = "";
  if (!id) return;
  try {
    const result = await readChanges(id);
    if (current === sequence) detail.value = result;
  } catch (cause) {
    if (current === sequence) detail.value = { unavailable: cause.message };
  } finally {
    if (current === sequence) detailBusy.value = false;
  }
}
watch(() => [selected.value?.id, chosenFile.value?.path], async ([id, path], _, onCleanup) => {
  patch.value = "";
  patchError.value = "";
  patchBusy.value = !!id && !!path;
  if (!id || !path) return;
  const request = new AbortController();
  onCleanup(() => request.abort());
  try {
    const result = await readPatch(id, path, request.signal);
    if (!request.signal.aborted) {
      patch.value = result.patch;
      if (result.truncated) patchError.value = "差异达到展示上限。";
    }
  } catch (cause) {
    if (!request.signal.aborted) patchError.value = cause.message;
  } finally {
    if (!request.signal.aborted) patchBusy.value = false;
  }
});
watch(() => selected.value?.id, async (id) => {
  await nextTick();
  if (selected.value?.id !== id) return;
  track.value?.querySelector(`[data-commit="${id}"]`)?.scrollIntoView({
    block: "nearest", inline: "center", behavior: "instant",
  });
});
function selectCommit(id) {
  const found = rows.value.findIndex((row) => row.id === id);
  if (found >= 0) index.value = found;
}
function selectBranch() {
  const found = rows.value.find((row) =>
    row.refs.split(", ").includes(branch.value),
  );
  if (found) selectCommit(found.id);
}
function chooseFile(file) {
  selectedFile.value = file.path;
}
watch(() => selected.value?.id, loadDetail);
onMounted(load);
</script>
<template>
  <section class="git-view git-explorer">
    <header class="panel-toolbar">
      <div>
        <h1>Git 时间轴</h1>
        <p class="caption muted">
          {{ data?.branch || "仓库历史" }} · {{ rows.length }} 个提交
        </p>
        <small v-if="data" class="git-source muted" role="status">{{ data.source }}</small>
      </div>
      <div class="git-toolbar-actions">
        <button class="btn btn-outline-primary" :disabled="busy" @click="load(true)">
          {{ busy ? "读取中…" : "刷新记录" }}
        </button>
        <a class="utility-button" href="/index.html">返回工作坊</a>
      </div>
    </header>
    <p v-if="error" class="feedback error-feedback" role="alert">{{ error }}</p>
    <p v-if="!data && busy" class="empty-state" role="status">正在读取仓库历史…</p>
    <template v-if="data && rows.length">
      <div class="git-context-bar">
        <div class="git-legend" aria-label="Git 分支颜色图例">
          <span v-for="group in graph.groups" :key="group"
            ><i :style="{ background: gitGroups[group].color }"></i
            >{{ gitGroups[group].name }}</span
          >
        </div>
        <label
          >定位分支<select
            v-model="branch"
            class="form-select"
            aria-label="定位分支标记"
            @change="selectBranch"
          >
            <option value="all">全部历史</option>
            <option v-for="name in branches" :key="name">{{ name }}</option>
          </select></label
        >
      </div>
      <div class="git-history-board">
        <aside class="git-track-labels" aria-label="Git 分支路径名称">
          <div
            v-for="lane in laneLabels"
            :key="lane.lane"
            :style="{
              top: `${lane.lane * 44 + 30}px`,
              color: gitGroups[lane.group].color,
            }"
            :title="lane.names.join(' / ')"
          >
            <strong>{{ lane.group }}</strong
            ><small>{{
              lane.names.length === 1 && lane.names[0] === lane.group
                ? gitGroups[lane.group].name
                : lane.names.join(" / ")
            }}</small>
          </div>
        </aside>
        <div
          ref="track"
          class="git-map-scroll"
          tabindex="0"
          aria-label="Git 历史：左侧较早，右侧较新"
        >
          <div class="git-map" :style="{ width: `${graph.width}px` }">
            <svg
              :width="graph.width"
              :height="graph.height"
              aria-label="实际父关系和当前时间位置"
            >
              <defs>
                <clipPath id="gitCompleted">
                  <rect
                    x="0"
                    y="0"
                    :width="selectedNode?.x || 0"
                    :height="graph.height"
                  />
                </clipPath>
              </defs>
              <g opacity=".25">
                <path
                  v-for="edge in graph.edges"
                  :key="edge.id"
                  :d="edge.d"
                  fill="none"
                  :stroke="gitGroups[edge.group].color"
                  stroke-width="2"
                />
              </g>
              <g clip-path="url(#gitCompleted)">
                <path
                  v-for="edge in graph.edges"
                  :key="edge.id"
                  :d="edge.d"
                  fill="none"
                  :stroke="gitGroups[edge.group].color"
                  stroke-width="3"
                />
              </g>
              <line
                v-if="selectedNode"
                :x1="selectedNode.x"
                :x2="selectedNode.x"
                y1="0"
                :y2="graph.height"
                stroke="var(--color-primary)"
                stroke-dasharray="4 4"
              />
              <circle
                v-for="node in graph.nodes"
                :key="node.id"
                :cx="node.x"
                :cy="node.y"
                :r="selected?.id === node.id ? 7 : 4"
                :fill="gitGroups[node.group].color"
                :opacity="node.x <= (selectedNode?.x || 0) ? 1 : 0.35"
                tabindex="0"
                role="button"
                :aria-label="`选择提交 ${node.subject}`"
                @click="selectCommit(node.id)"
                @keydown.enter.prevent="selectCommit(node.id)"
                @keydown.space.prevent="selectCommit(node.id)"
              >
                <title>
                  {{ gitGroups[node.group].name }} · {{ node.subject }} ·
                  {{ node.id.slice(0, 7) }}
                </title>
              </circle>
            </svg>
            <div class="git-commit-cards">
              <button
                v-for="commit in ordered"
                :key="commit.id"
                :data-commit="commit.id"
                class="git-commit-card"
                :class="{
                  selected: commit.id === selected?.id,
                  upcoming: commit.x > (selectedNode?.x || 0),
                }"
                :style="{ '--branch-color': gitGroups[commit.group].color }"
                :aria-pressed="commit.id === selected?.id"
                @click="selectCommit(commit.id)"
              >
                <span class="git-card-kind"
                  >{{ gitGroups[commit.group].name }}
                  <time>{{ commit.date.slice(0, 10) }}</time></span
                ><strong>{{ commit.subject }}</strong
                ><small
                  >{{ commit.id.slice(0, 7)
                  }}{{ commit.parents.length > 1 ? " · 合并" : "" }}</small
                ><span v-if="commit.refs" class="git-ref-badges"
                  ><span
                    v-for="refName in commit.refs.split(', ')"
                    :key="refName"
                    class="badge rounded-pill"
                    :style="{ background: refColor(refName, commit.group) }"
                    >{{ refName }}</span
                  ></span
                >
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="timeline-controls">
        <button
          class="utility-button"
          :disabled="index >= rows.length - 1"
          @click="index++"
        >
          ← 较早</button
        ><label class="timeline-range"
          >时间定位<input
            v-model.number="position"
            type="range"
            min="0"
            :max="Math.max(0, rows.length - 1)"
            :style="{ '--range-fill': `${fill}%` }"
            aria-label="切换 Git 提交时间轴"
          /><small>{{
            selected?.date?.slice(0, 16).replace("T", " ")
          }}</small></label
        ><button class="utility-button" :disabled="index <= 0" @click="index--">
          较新 →
        </button>
      </div>
      <article class="git-change-panel">
        <header class="git-change-header">
          <div>
            <p class="eyebrow">
              {{
                selected?.parents.length > 1 ? "MERGE / FIRST PARENT" : "COMMIT"
              }}
              · {{ selected?.id.slice(0, 7) }}
            </p>
            <h2>{{ selected?.subject }}</h2>
            <p class="caption muted">
              <template v-if="detail && !detail.unavailable">{{ files.length }} 个文件
              <span class="diff-add-count">＋{{ totals.added }}</span>
              <span class="diff-delete-count">－{{ totals.deleted }}</span></template>
            </p>
          </div>
        </header>
        <div v-if="detailBusy" class="empty-state">正在读取提交…</div>
        <p v-else-if="detail?.unavailable" class="empty-state" role="status">{{ detail.unavailable }}<a v-if="data.commitUrl" :href="data.commitUrl + selected.id" target="_blank" rel="noopener noreferrer">在 GitHub 查看提交</a></p>
        <template v-else-if="detail"
          ><p v-if="detail.patchTruncated" class="feedback">
            代码差异超过展示上限；当前为前 1 MiB，文件统计完整。
          </p>
          <div class="git-file-workspace diff-mode">
            <section class="git-file-list">
              <label class="git-file-search"
                ><input
                  v-model="fileQuery"
                  type="search"
                  class="form-control"
                  aria-label="筛选变更文件"
                  placeholder="按路径筛选文件"
              /></label>
              <p v-if="!visibleFiles.length" class="empty-state">
                没有匹配的文件。
              </p>
              <button
                v-for="file in visibleFiles"
                :key="file.path"
                class="git-file-row"
                :class="{
                  selected: chosenFile?.path === file.path,
                }"
                @click="chooseFile(file)"
              >
                <span class="git-file-symbol">{{
                  file.additions === 0 ? "−" : file.deletions === 0 ? "+" : "±"
                }}</span
                ><span class="git-file-path">{{ file.path }}</span
                ><span v-if="file.binary" class="caption muted">二进制</span
                ><span v-else class="git-file-counts"
                  ><b class="diff-add-count">＋{{ file.additions ?? "—" }}</b
                  ><b class="diff-delete-count"
                    >－{{ file.deletions ?? "—" }}</b
                  ></span
                >
              </button>
            </section>
            <section class="git-code-view">
              <header>
                <strong>{{ chosenFile?.path || "选择文件" }}</strong
                ><span>原行 / 新行</span>
              </header>
              <p v-if="patchError" class="feedback" role="status">{{ patchError }}</p>
              <p v-if="patchBusy" class="empty-state" role="status">正在读取差异…</p>
              <div v-else-if="chosenPatch?.hunks.length" class="git-code-scroll">
                <table class="git-code-table">
                  <tbody
                    v-for="(hunk, hunkIndex) in chosenPatch.hunks"
                    :key="hunkIndex"
                  >
                    <tr class="diff-hunk">
                      <td colspan="4">{{ hunk.header }}</td>
                    </tr>
                    <tr
                      v-for="(line, lineIndex) in hunk.lines"
                      :key="lineIndex"
                      :class="`diff-${line.kind}`"
                    >
                      <td class="diff-line-number">{{ line.oldNumber }}</td>
                      <td class="diff-line-number">{{ line.newNumber }}</td>
                      <td class="diff-marker">
                        {{
                          line.kind === "add"
                            ? "+"
                            : line.kind === "delete"
                              ? "−"
                              : ""
                        }}
                      </td>
                      <td class="diff-source">
                        <code>{{ line.text || " " }}</code>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p v-else class="empty-state">
                {{
                  !chosenFile ? "请选择文件。" : chosenFile.binary
                    ? "二进制文件不显示文本差异。"
                    : "此文件没有可展示的代码差异；生成页面、配置与非代码资料仅列出文件统计。"
                }}
              </p>
            </section>
          </div></template
        >
      </article>
    </template>
  </section>
</template>
