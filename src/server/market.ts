import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Prompts } from "./prompts.ts";
import { Jobs, fetchJSON } from "./control.ts";
import { hash, stamp, type JsonObject } from "./profile.ts";
import { parseCSV } from "./files.ts";

const SOURCES = [
  {
    id: "prompts-chat",
    name: "prompts.chat",
    repo: "f/prompts.chat",
    path: "prompts.csv",
    ref: "main",
    format: "csv",
    license: "CC0-1.0",
  },
  {
    id: "langgpt",
    name: "LangGPT",
    repo: "langgptai/LangGPT",
    path: "examples/chinese_poet/Prompt_chinese_poet.md",
    ref: "main",
    format: "markdown",
    license: "Apache-2.0",
  },
];
export class Market {
  constructor(
    readonly prompts: Prompts,
    readonly jobs: Jobs,
    readonly assets: string,
  ) {
    this.seed();
  }
  sources() {
    const p = this.prompts.profile;
    return [
      ...SOURCES,
      ...(
        p.db
          .prepare("SELECT config FROM template_sources WHERE owner=?")
          .all(p.owner) as JsonObject[]
      ).map((r) => JSON.parse(r.config)),
    ];
  }
  config(body: JsonObject) {
    const repo = String(body.repo || ""),
      path = String(body.path || ""),
      ref = String(body.ref || "main"),
      license = String(body.license || "").trim(),
      format = body.format || "json",
      mapping = body.mapping || {};
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
      repo.length > 200 ||
      path.split("/").includes("..") ||
      path.startsWith("/") ||
      !/^[\w./-]+$/.test(path) ||
      path.length > 500 ||
      !/^[\w.-]+$/.test(ref) ||
      ref.length > 100
    )
      throw new Error("仓库、分支或文件路径不正确");
    if (!license || license.length > 100)
      throw new Error("请填写并核验模板数据许可");
    if (!["csv", "json", "markdown"].includes(format))
      throw new Error("模板源格式不支持");
    if (
      typeof mapping !== "object" ||
      Array.isArray(mapping) ||
      Object.entries(mapping).some(
        ([k, v]) =>
          !["title", "content"].includes(k) ||
          typeof v !== "string" ||
          v.length > 100,
      )
    )
      throw new Error("字段映射不正确");
    return {
      id: hash(this.prompts.profile.owner + repo + path).slice(0, 24),
      name: body.name || repo,
      repo,
      path,
      ref,
      format,
      license,
      mapping,
      owner: this.prompts.profile.owner,
    };
  }
  source(body: JsonObject) {
    const value = this.config(body),
      p = this.prompts.profile;
    p.db
      .prepare(
        "INSERT INTO template_sources VALUES(?,?,?) ON CONFLICT(owner,id) DO UPDATE SET config=excluded.config",
      )
      .run(p.owner, value.id, JSON.stringify(value));
    return value;
  }
  private async raw(url: string) {
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      headers: { "User-Agent": "Lingxi-Workbench" },
    });
    if (!response.ok) throw new Error("模板来源读取失败");
    const reader = response.body!.getReader(),
      parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 20 * 1024 * 1024) throw new Error("模板数据源过大");
        parts.push(value);
      }
    } catch (error) {
      await reader.cancel();
      throw error;
    }
    return Buffer.concat(parts)
      .toString("utf8")
      .replace(/^\uFEFF/, "");
  }
  sync(id: string, expectedCommit?: string, previewSource?: JsonObject) {
    const source = previewSource || this.sources().find((s) => s.id === id);
    if (!source) throw new Error("模板源不存在");
    const owner = this.prompts.profile.owner;
    return this.jobs.start(
      (previewSource ? "template-preview:" : "template-sync:") + id,
      async () => {
        const commit = (
          await fetchJSON(
            "https://api.github.com/repos/" +
              source.repo +
              "/commits/" +
              source.ref,
            { headers: { "User-Agent": "Lingxi-Workbench" } },
            20 * 1024 * 1024,
            20000,
          )
        ).sha;
        if (!/^[a-f0-9]{40}$/.test(commit))
          throw new Error("模板提交标识不正确");
        if (expectedCommit && expectedCommit !== commit)
          throw new Error("来源在预览后已变化，请重新预览再同步");
        const raw = await this.raw(
          "https://raw.githubusercontent.com/" +
            source.repo +
            "/" +
            commit +
            "/" +
            source.path,
        );
        let rows: JsonObject[];
        if (source.format === "csv") {
          const [header, ...data] = parseCSV(raw);
          rows = data.map((r) =>
            Object.fromEntries(header.map((k, i) => [k, r[i] || ""])),
          );
        } else if (source.format === "json") {
          const data = JSON.parse(raw);
          rows = Array.isArray(data) ? data : data.items || [];
        } else rows = [{ title: source.name + " · 结构化模板", content: raw }];
        const mapping = (source as JsonObject).mapping || {},
          items: JsonObject[] = [];
        for (let i = 0; i < Math.min(rows.length, 20000); i++) {
          const row = rows[i],
            title =
              row[mapping.title || "title"] ||
              row.act ||
              row.name ||
              "模板 " + (i + 1),
            content =
              row[mapping.content || "content"] || row.prompt || row.body;
          if (
            typeof content !== "string" ||
            !content.trim() ||
            content.length > 262144
          )
            continue;
          const rid = hash(String(title) + "\0" + i).slice(0, 24),
            origin = {
              source: id,
              id: rid,
              repo: source.repo,
              path: source.path,
              commit,
              license: source.license,
              digest: hash(content),
              url:
                "https://github.com/" +
                source.repo +
                "/blob/" +
                commit +
                "/" +
                source.path,
            };
          items.push({
            source: id,
            id: rid,
            title: String(title).slice(0, 160),
            content,
            format: "markdown",
            tags: Array.isArray(row.tags) ? row.tags : [],
            origin,
            updated: stamp(),
          });
        }
        if (previewSource)
          return {
            source: id,
            count: items.length,
            commit,
            license: source.license,
            items: items
              .slice(0, 20)
              .map((r) => ({
                title: r.title,
                excerpt: r.content.slice(0, 400),
              })),
            preview: true,
          };
        if (owner !== this.prompts.profile.owner)
          throw new Error("Profile 已切换");
        const p = this.prompts.profile;
        p.transaction(() => {
          p.db.prepare("DELETE FROM template_catalog WHERE source=?").run(id);
          const insert = p.db.prepare(
            "INSERT INTO template_catalog VALUES(?,?,?,?,?,?,?,?)",
          );
          for (const r of items)
            insert.run(
              id,
              r.id,
              r.title,
              r.content,
              r.format,
              JSON.stringify(r.tags),
              JSON.stringify(r.origin),
              r.updated,
            );
        });
        return {
          source: id,
          count: items.length,
          commit,
          license: source.license,
        };
      },
    );
  }
  preview(body: JsonObject) {
    const source = this.config(body);
    return this.sync(source.id, undefined, source);
  }
  seed() {
    const p = this.prompts.profile;
    if (p.db.prepare("SELECT 1 FROM template_catalog LIMIT 1").get()) return;
    const file = join(this.assets, "vendor", "prompt-market", "seed.json");
    if (!existsSync(file)) return;
    for (const r of JSON.parse(readFileSync(file, "utf8")).items)
      p.db
        .prepare(
          "INSERT OR IGNORE INTO template_catalog VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          r.source,
          r.id,
          r.title,
          r.content,
          r.format,
          JSON.stringify(r.tags),
          JSON.stringify(r.origin),
          stamp(),
        );
  }
  search(params: JsonObject) {
    const allowed = new Set(this.sources().map((s) => s.id)),
      q = String(params.q || "").toLowerCase(),
      items = (
        this.prompts.profile.db
          .prepare("SELECT * FROM template_catalog ORDER BY title")
          .all() as JsonObject[]
      )
        .filter(
          (r) =>
            allowed.has(r.source) &&
            (!params.source || r.source === params.source) &&
            (!q || (r.title + "\n" + r.content).toLowerCase().includes(q)),
        )
        .map((r) => ({
          id: r.id,
          source: r.source,
          title: r.title,
          excerpt: r.content.slice(0, 180),
          origin: JSON.parse(r.origin),
          tags: JSON.parse(r.tags),
          updated: r.updated,
        })),
      offset = Math.max(0, Number(params.offset) || 0),
      limit = Math.min(100, Math.max(1, Number(params.limit) || 40));
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      sources: this.sources(),
    };
  }
  get(source: string, id: string) {
    if (!this.sources().some((s) => s.id === source))
      throw new Error("模板源不存在");
    const row = this.prompts.profile.db
      .prepare("SELECT * FROM template_catalog WHERE source=? AND id=?")
      .get(source, id) as JsonObject | undefined;
    if (!row) throw new Error("模板不存在");
    return {
      title: row.title,
      content: row.content,
      format: row.format,
      tags: JSON.parse(row.tags),
      origin: { ...JSON.parse(row.origin), source, id },
    };
  }
  updateStatus(item: JsonObject) {
    const origin = item.origin || {};
    if (
      !origin.source ||
      !origin.id ||
      !this.sources().some((s) => s.id === origin.source)
    )
      return item;
    const row = this.prompts.profile.db
      .prepare("SELECT origin FROM template_catalog WHERE source=? AND id=?")
      .get(origin.source, origin.id) as JsonObject | undefined;
    if (row) {
      const latest = JSON.parse(row.origin);
      if (latest.digest !== origin.digest)
        item.templateUpdate = {
          commit: latest.commit,
          url: latest.url,
          message: "模板来源有更新；你的个人副本保持不变",
        };
    }
    return item;
  }
}
