import { ProfileStore, uid, stamp, hash, type JsonObject } from "./profile.ts";
import { parseCSV, csvValue, plainHTML, unzip, zipFiles } from "./files.ts";

const FORMATS = ["text", "markdown", "rich", "json", "custom"];
const text = (v: unknown, max = 262144) => {
  if (typeof v !== "string" || v.length > max)
    throw new Error("文本格式不正确或内容过长");
  return v;
};
const id = (v: unknown) => {
  const s = String(v);
  if (!/^[\p{L}\p{N}_-]{1,100}$/u.test(s)) throw new Error("标识格式不正确");
  return s;
};
export class Conflict extends Error {
  statusCode = 409;
  conflict = true;
  constructor(readonly current: JsonObject) {
    super("提示词已在其他窗口修改；你的草稿已保留");
  }
}
export function plain(content: string, format: string): string {
  if (format !== "rich") return content;
  let doc: JsonObject;
  try {
    doc = JSON.parse(content);
  } catch {
    throw new Error("富文本文档格式不正确");
  }
  if (doc.type !== "doc") throw new Error("富文本文档格式不正确");
  const parts: string[] = [];
  const walk = (node: JsonObject, depth = 0) => {
    if (depth > 30 || !node || typeof node !== "object")
      throw new Error("富文本文档格式不正确");
    if (node.type === "text") parts.push(text(node.text || ""));
    for (const child of node.content || []) walk(child, depth + 1);
    if (["paragraph", "heading", "listItem"].includes(node.type))
      parts.push("\n");
  };
  walk(doc);
  return parts.join("");
}
export function renderTemplate(content: string, values: JsonObject) {
  if (
    !values ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    Object.keys(values).length > 100
  )
    throw new Error("变量格式不正确");
  const out: string[] = [],
    stack: { parent: boolean; branch: boolean; else: boolean }[] = [],
    active = () => stack.every((s) => s.parent && s.branch);
  for (const token of content.split(/(\{\{[\s\S]*?\}\})/)) {
    if (token.startsWith("{{#if ")) {
      if (stack.length >= 8) throw new Error("条件嵌套过多");
      const v = values[token.slice(6, -2).trim()];
      stack.push({
        parent: active(),
        branch: ![null, undefined, false, "", 0, "false"].includes(v),
        else: false,
      });
    } else if (token === "{{else}}") {
      const current = stack.at(-1);
      if (!current || current.else) throw new Error("条件语法不正确");
      current.branch = !current.branch;
      current.else = true;
    } else if (token === "{{/if}}") {
      if (!stack.length) throw new Error("条件语法不正确");
      stack.pop();
    } else if (active()) {
      if (token.startsWith("{{") && token.endsWith("}}")) {
        const key = token.slice(2, -2).trim();
        if (!/^[\p{L}\p{N}_.-]{1,80}$/u.test(key))
          throw new Error("变量名称不正确");
        const value = values[key];
        if (value !== null && typeof value === "object")
          throw new Error("变量值需为文本、数字或布尔值");
        out.push(
          value == null
            ? ""
            : typeof value === "boolean"
              ? value
                ? "True"
                : "False"
              : String(value),
        );
      } else out.push(token);
    }
  }
  if (stack.length) throw new Error("条件没有结束");
  return out.join("");
}
export class Prompts {
  constructor(readonly profile: ProfileStore) {
    this.setup();
  }
  setup() {
    this.profile.db
      .exec(`CREATE TABLE IF NOT EXISTS prompts(rowid INTEGER PRIMARY KEY,owner TEXT NOT NULL,id TEXT NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,format TEXT NOT NULL,folder TEXT NOT NULL DEFAULT '',tags TEXT NOT NULL,variables TEXT NOT NULL,favorite INTEGER NOT NULL DEFAULT 0,pinned INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,created TEXT NOT NULL,updated TEXT NOT NULL,deleted TEXT,origin TEXT NOT NULL,legacy_id TEXT,UNIQUE(owner,id),UNIQUE(owner,legacy_id));
    CREATE INDEX IF NOT EXISTS prompt_owner_sort ON prompts(owner,deleted,pinned,updated);
    CREATE VIRTUAL TABLE IF NOT EXISTS prompt_fts USING fts5(title,body,tags,tokenize='trigram');
    CREATE VIRTUAL TABLE IF NOT EXISTS prompt_short_fts USING fts5(terms);
    CREATE TABLE IF NOT EXISTS prompt_folders(owner TEXT,id TEXT,name TEXT,parent TEXT,position INTEGER DEFAULT 0,PRIMARY KEY(owner,id));
    CREATE TABLE IF NOT EXISTS prompt_versions(owner TEXT,id TEXT,revision INTEGER,at TEXT,value TEXT,PRIMARY KEY(owner,id,revision));
    CREATE TABLE IF NOT EXISTS prompt_events(owner TEXT,event_id TEXT,id TEXT,revision INTEGER,action TEXT,at TEXT,details TEXT,PRIMARY KEY(owner,event_id));
    CREATE INDEX IF NOT EXISTS prompt_event_dates ON prompt_events(owner,at,id);
    CREATE INDEX IF NOT EXISTS prompt_event_usage ON prompt_events(owner,id,action);
    CREATE TABLE IF NOT EXISTS prompt_evaluations(owner TEXT,eval_id TEXT,id TEXT,revision INTEGER,kind TEXT,at TEXT,result TEXT,PRIMARY KEY(owner,eval_id));
    CREATE TABLE IF NOT EXISTS template_catalog(source TEXT,id TEXT,title TEXT,content TEXT,format TEXT,tags TEXT,origin TEXT,updated TEXT,PRIMARY KEY(source,id));
    CREATE TABLE IF NOT EXISTS template_sources(owner TEXT,id TEXT,config TEXT,PRIMARY KEY(owner,id));
    CREATE TABLE IF NOT EXISTS library_versions(owner TEXT PRIMARY KEY,version INTEGER NOT NULL);`);
    for (const table of ["prompts", "prompt_folders", "prompt_events"])
      for (const op of ["INSERT", "UPDATE", "DELETE"]) {
        const owner = op === "DELETE" ? "OLD.owner" : "NEW.owner";
        this.profile.db.exec(
          `CREATE TRIGGER IF NOT EXISTS ${table}_${op.toLowerCase()}_version AFTER ${op} ON ${table} BEGIN INSERT INTO library_versions VALUES(${owner},1) ON CONFLICT(owner) DO UPDATE SET version=version+1; END`,
        );
      }
  }
  public(row: JsonObject, withContent = true) {
    const item = { ...row };
    for (const k of ["rowid", "owner", "legacy_id"]) delete item[k];
    for (const k of ["tags", "variables", "origin"])
      item[k] = JSON.parse(item[k]);
    for (const k of ["favorite", "pinned"]) item[k] = Boolean(item[k]);
    if (!withContent) {
      item.excerpt = plain(item.content, item.format).slice(0, 180);
      delete item.content;
    }
    return item;
  }
  private row(pid: string) {
    const row = this.profile.db
      .prepare("SELECT * FROM prompts WHERE owner=? AND id=?")
      .get(this.profile.owner, pid) as JsonObject | undefined;
    if (!row) throw new Error("提示词不存在");
    return row;
  }
  get(pid: string) {
    return this.public(this.row(pid));
  }
  private index(row: JsonObject) {
    const db = this.profile.db;
    db.prepare("DELETE FROM prompt_fts WHERE rowid=?").run(row.rowid);
    db.prepare("DELETE FROM prompt_short_fts WHERE rowid=?").run(row.rowid);
    if (!row.deleted) {
      const value = plain(row.content, row.format);
      db.prepare(
        "INSERT INTO prompt_fts(rowid,title,body,tags) VALUES(?,?,?,?)",
      ).run(row.rowid, row.title, value, row.tags);
      const terms = new Set<string>();
      for (const word of (row.title + "\n" + value + "\n" + row.tags).match(
        /[\u3400-\u9fff]+/g,
      ) || [])
        for (let i = 0; i < word.length; i++) {
          terms.add(word[i]);
          if (i + 1 < word.length) terms.add(word.slice(i, i + 2));
        }
      db.prepare("INSERT INTO prompt_short_fts(rowid,terms) VALUES(?,?)").run(
        row.rowid,
        [...terms].sort().join(" "),
      );
    }
  }
  save(body: JsonObject, inTransaction = false): JsonObject {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("提示词格式不正确");
    const title =
        text(body.title ?? "未命名提示词", 160).trim() || "未命名提示词",
      content = text(body.content ?? ""),
      format = body.format || "markdown",
      folder = text(body.folder || "", 100),
      pid = id(body.id || uid());
    if (!FORMATS.includes(format)) throw new Error("内容格式不支持");
    plain(content, format);
    const tags = body.tags || [],
      variables = body.variables || {},
      origin = body.origin || {};
    if (
      !Array.isArray(tags) ||
      tags.length > 50 ||
      tags.some((v) => typeof v !== "string" || !v.trim() || v.length > 60)
    )
      throw new Error("标签格式不正确");
    for (const [label, v] of [
      ["变量", variables],
      ["来源", origin],
    ])
      if (
        !v ||
        typeof v !== "object" ||
        Array.isArray(v) ||
        JSON.stringify(v).length > 16000
      )
        throw new Error(label + "格式不正确");
    const work = () => {
      const db = this.profile.db,
        owner = this.profile.owner,
        old = db
          .prepare("SELECT * FROM prompts WHERE owner=? AND id=?")
          .get(owner, pid) as JsonObject | undefined;
      if (old && body.expectedRevision !== old.revision)
        throw new Conflict(this.public(old));
      if (
        folder &&
        !db
          .prepare("SELECT 1 FROM prompt_folders WHERE owner=? AND id=?")
          .get(owner, folder)
      )
        throw new Error("分类不存在");
      const at = stamp(),
        revision = old ? old.revision + 1 : 1;
      if (old) {
        const previous = db
          .prepare(
            "SELECT at FROM prompt_versions WHERE owner=? AND id=? ORDER BY revision DESC LIMIT 1",
          )
          .get(owner, pid) as JsonObject | undefined;
        if (
          body.checkpoint ||
          !previous ||
          Date.now() - Date.parse(previous.at) >= 60000
        ) {
          db.prepare(
            "INSERT OR IGNORE INTO prompt_versions VALUES(?,?,?,?,?)",
          ).run(owner, pid, old.revision, at, JSON.stringify(this.public(old)));
          db.prepare(
            "DELETE FROM prompt_versions WHERE owner=? AND id=? AND revision NOT IN (SELECT revision FROM prompt_versions WHERE owner=? AND id=? ORDER BY revision DESC LIMIT 50)",
          ).run(owner, pid, owner, pid);
        }
      }
      const row = {
        owner,
        id: pid,
        title,
        content,
        format,
        folder,
        tags: JSON.stringify([...new Set(tags.map((v) => v.trim()))]),
        variables: JSON.stringify(variables),
        favorite: Number(body.favorite ?? old?.favorite ?? false),
        pinned: Number(body.pinned ?? old?.pinned ?? false),
        revision,
        created: old?.created || at,
        updated: at,
        deleted: old?.deleted || null,
        origin: JSON.stringify(origin),
        legacy_id: old?.legacy_id || null,
      };
      const fields = Object.keys(row),
        values = Object.values(row);
      db.prepare(
        `INSERT INTO prompts(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")}) ON CONFLICT(owner,id) DO UPDATE SET ${fields
          .filter((f) => !["owner", "id", "created"].includes(f))
          .map((f) => `${f}=excluded.${f}`)
          .join(",")}`,
      ).run(...values);
      const saved = this.row(pid);
      this.index(saved);
      return this.public(saved);
    };
    return inTransaction ? work() : this.profile.transaction(work);
  }
  search(params: JsonObject) {
    const owner = this.profile.owner,
      args: any[] = [owner],
      where = [
        "p.owner=?",
        params.trash === "1" || params.trash === "true"
          ? "p.deleted IS NOT NULL"
          : "p.deleted IS NULL",
      ],
      query = text(params.q || "", 300).trim(),
      trash = where[1].includes("NOT");
    if (/^[\u3400-\u9fff]{1,2}$/.test(query) && !trash) {
      where.push(
        "p.rowid IN (SELECT rowid FROM prompt_short_fts WHERE prompt_short_fts MATCH ?)",
      );
      args.push('"' + query + '"');
    } else if (query.length >= 3 && !trash) {
      where.push(
        "p.rowid IN (SELECT rowid FROM prompt_fts WHERE prompt_fts MATCH ?)",
      );
      args.push('"' + query.replaceAll('"', '""') + '"');
    } else if (query) {
      where.push("(p.title LIKE ? ESCAPE '\' OR p.content LIKE ? ESCAPE '\')");
      const term =
        "%" +
        query
          .replaceAll("\\", "\\\\")
          .replaceAll("%", "\\%")
          .replaceAll("_", "\\_") +
        "%";
      args.push(term, term);
    }
    for (const key of ["folder", "format"])
      if (params[key]) {
        where.push("p." + key + "=?");
        args.push(params[key]);
      }
    for (const key of ["favorite", "pinned"])
      if (["1", "true", true].includes(params[key]))
        where.push("p." + key + "=1");
    for (const tag of Array.isArray(params.tags)
      ? params.tags
      : String(params.tags || "")
          .split(",")
          .filter(Boolean)) {
      where.push("EXISTS(SELECT 1 FROM json_each(p.tags) WHERE value=?)");
      args.push(tag);
    }
    for (const [key, op] of [
      ["start", ">="],
      ["end", "<="],
    ])
      if (params[key]) {
        where.push("substr(p.updated,1,10)" + op + "?");
        args.push(params[key]);
      }
    const db = this.profile.db,
      sql = " FROM prompts p WHERE " + where.join(" AND "),
      offset = Math.max(0, Number(params.offset) || 0),
      limit = Math.min(100, Math.max(1, Number(params.limit) || 40)),
      order =
        (
          {
            name: "p.title COLLATE NOCASE",
            created: "p.created DESC",
            usage: "uses DESC",
            updated: "p.updated DESC",
          } as JsonObject
        )[params.sort] || "p.updated DESC";
    const total = (
      db.prepare("SELECT count(*) n" + sql).get(...args) as JsonObject
    ).n;
    const rows = db
      .prepare(
        "SELECT p.*,(SELECT count(*) FROM prompt_events e WHERE e.owner=p.owner AND e.id=p.id AND e.action IN ('copy','apply')) uses" +
          sql +
          " ORDER BY p.pinned DESC," +
          order +
          ",p.id LIMIT ? OFFSET ?",
      )
      .all(...args, limit, offset) as JsonObject[];
    return {
      items: rows.map((r) => this.public(r, false)),
      total,
      offset,
      limit,
      tags: (
        db
          .prepare(
            "SELECT DISTINCT j.value FROM prompts p,json_each(p.tags) j WHERE p.owner=? AND p.deleted IS NULL ORDER BY j.value",
          )
          .all(owner) as JsonObject[]
      ).map((r) => r.value),
      folders: db
        .prepare(
          "SELECT id,name,parent,position FROM prompt_folders WHERE owner=? ORDER BY position,name",
        )
        .all(owner),
      dataVersion:
        (
          db
            .prepare("SELECT version FROM library_versions WHERE owner=?")
            .get(owner) as JsonObject | undefined
        )?.version || 0,
    };
  }
  folder(body: JsonObject) {
    const owner = this.profile.owner,
      fid = id(body.id || uid()),
      parent = text(body.parent || "", 100),
      name = text(body.name || "", 100).trim();
    return this.profile.transaction(() => {
      const db = this.profile.db;
      if (body.delete) {
        db.prepare(
          "UPDATE prompts SET folder='',revision=revision+1 WHERE owner=? AND folder=?",
        ).run(owner, fid);
        db.prepare(
          "UPDATE prompt_folders SET parent='' WHERE owner=? AND parent=?",
        ).run(owner, fid);
        db.prepare("DELETE FROM prompt_folders WHERE owner=? AND id=?").run(
          owner,
          fid,
        );
        return { ok: true };
      }
      if (!name) throw new Error("分类名称不能为空");
      const seen = new Set([fid]);
      let ancestor = parent;
      while (ancestor) {
        if (seen.has(ancestor) || seen.size > 8)
          throw new Error("分类不能循环或嵌套过深");
        seen.add(ancestor);
        const row = db
          .prepare("SELECT parent FROM prompt_folders WHERE owner=? AND id=?")
          .get(owner, ancestor) as JsonObject | undefined;
        if (!row) throw new Error("上级分类不存在");
        ancestor = row.parent;
      }
      db.prepare(
        "INSERT INTO prompt_folders VALUES(?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET name=excluded.name,parent=excluded.parent,position=excluded.position",
      ).run(owner, fid, name, parent, Number(body.position) || 0);
      return { id: fid, name, parent };
    });
  }
  bulk(body: JsonObject) {
    if (
      !Array.isArray(body.ids) ||
      body.ids.length > 1000 ||
      !["trash", "restore", "favorite", "pin", "move", "tag", "purge"].includes(
        body.action,
      )
    )
      throw new Error("批量操作不正确");
    return this.profile.transaction(() => {
      const rows = [...new Set<string>(body.ids)].map((pid) => this.row(pid)),
        db = this.profile.db;
      for (const row of rows) {
        if (["trash", "restore"].includes(body.action))
          db.prepare(
            "UPDATE prompts SET deleted=?,revision=revision+1,updated=? WHERE owner=? AND id=?",
          ).run(
            body.action === "trash" ? stamp() : null,
            stamp(),
            this.profile.owner,
            row.id,
          );
        else if (body.action === "purge") {
          if (!row.deleted) throw new Error("请先移入回收站");
          for (const table of [
            "prompts",
            "prompt_versions",
            "prompt_events",
            "prompt_evaluations",
          ])
            db.prepare(`DELETE FROM ${table} WHERE owner=? AND id=?`).run(
              this.profile.owner,
              row.id,
            );
          db.prepare("DELETE FROM prompt_fts WHERE rowid=?").run(row.rowid);
          db.prepare("DELETE FROM prompt_short_fts WHERE rowid=?").run(
            row.rowid,
          );
          continue;
        } else {
          const item = this.public(row);
          item.expectedRevision = row.revision;
          if (body.action === "favorite") item.favorite = body.value ?? true;
          if (body.action === "pin") item.pinned = body.value ?? true;
          if (body.action === "move") item.folder = body.folder || "";
          if (body.action === "tag")
            item.tags = [...new Set([...item.tags, text(body.tag || "", 60)])];
          this.save(item, true);
        }
        this.index(this.row(row.id));
      }
      return { ok: true, count: rows.length };
    });
  }
  versions(pid: string) {
    this.get(pid);
    return (
      this.profile.db
        .prepare(
          "SELECT * FROM prompt_versions WHERE owner=? AND id=? ORDER BY revision DESC",
        )
        .all(this.profile.owner, pid) as JsonObject[]
    ).map((r) => ({
      revision: r.revision,
      at: r.at,
      value: JSON.parse(r.value),
    }));
  }
  event(body: JsonObject) {
    const item = this.get(body.id),
      action = body.action,
      details = body.details || {},
      revision = body.revision ?? item.revision;
    if (!["copy", "apply", "evaluate", "optimize", "feedback"].includes(action))
      throw new Error("使用事件不正确");
    if (!Number.isInteger(revision) || revision < 1 || revision > item.revision)
      throw new Error("事件版本不正确");
    if (
      typeof details !== "object" ||
      Array.isArray(details) ||
      JSON.stringify(details).length > 10000
    )
      throw new Error("反馈格式不正确");
    if (
      "rating" in details &&
      (!Number.isInteger(details.rating) ||
        details.rating < 1 ||
        details.rating > 5)
    )
      throw new Error("评分为 1–5");
    this.profile.db
      .prepare("INSERT OR IGNORE INTO prompt_events VALUES(?,?,?,?,?,?,?)")
      .run(
        this.profile.owner,
        body.eventId || uid(),
        item.id,
        revision,
        action,
        stamp(),
        JSON.stringify(details),
      );
    return { ok: true };
  }
  evaluations(pid: string) {
    this.get(pid);
    return (
      this.profile.db
        .prepare(
          "SELECT * FROM prompt_evaluations WHERE owner=? AND id=? ORDER BY at DESC",
        )
        .all(this.profile.owner, pid) as JsonObject[]
    ).map((r) => ({
      id: r.eval_id,
      revision: r.revision,
      kind: r.kind,
      at: r.at,
      result: JSON.parse(r.result),
    }));
  }
  evaluation(pid: string, revision: number, kind: string, result: JsonObject) {
    this.get(pid);
    const eid = uid();
    this.profile.db
      .prepare("INSERT INTO prompt_evaluations VALUES(?,?,?,?,?,?,?)")
      .run(
        this.profile.owner,
        eid,
        pid,
        revision,
        kind,
        stamp(),
        JSON.stringify(result),
      );
    return { id: eid, promptId: pid, revision, kind, result };
  }
  stats(params: JsonObject = {}) {
    const args: any[] = [this.profile.owner],
      where = ["e.owner=?"];
    for (const [key, op] of [
      ["start", ">="],
      ["end", "<="],
    ])
      if (params[key]) {
        where.push("substr(e.at,1,10)" + op + "?");
        args.push(params[key]);
      }
    if (params.folder) {
      where.push("p.folder=?");
      args.push(params.folder);
    }
    if (params.tag) {
      where.push("EXISTS(SELECT 1 FROM json_each(p.tags) WHERE value=?)");
      args.push(params.tag);
    }
    const joined =
        " FROM prompt_events e JOIN prompts p ON p.owner=e.owner AND p.id=e.id WHERE " +
        where.join(" AND "),
      db = this.profile.db,
      read = (sql: string) => db.prepare(sql + joined).all(...args),
      prompts = db
        .prepare(
          "SELECT e.id,p.title,p.folder,p.tags,count(*) count" +
            joined +
            " AND e.action IN ('copy','apply') GROUP BY e.id ORDER BY count DESC",
        )
        .all(...args) as JsonObject[],
      categories: JsonObject = {},
      tagCounts: JsonObject = {};
    for (const row of prompts) {
      categories[row.folder] = (categories[row.folder] || 0) + row.count;
      for (const tag of JSON.parse(row.tags))
        tagCounts[tag] = (tagCounts[tag] || 0) + row.count;
    }
    return {
      actions: db
        .prepare(
          "SELECT e.action,count(*) count" + joined + " GROUP BY e.action",
        )
        .all(...args),
      daily: db
        .prepare(
          "SELECT substr(e.at,1,10) date,e.action,count(*) count" +
            joined +
            " GROUP BY date,e.action ORDER BY date",
        )
        .all(...args),
      prompts,
      feedback: (
        db
          .prepare(
            "SELECT e.id,e.at,e.details" +
              joined +
              " AND e.action='feedback' ORDER BY e.at DESC",
          )
          .all(...args) as JsonObject[]
      ).map((r) => ({ ...r, details: JSON.parse(r.details) })),
      folders: db
        .prepare("SELECT id,name FROM prompt_folders WHERE owner=?")
        .all(this.profile.owner),
      tags: (
        db
          .prepare(
            "SELECT DISTINCT j.value FROM prompts p,json_each(p.tags) j WHERE p.owner=? ORDER BY j.value",
          )
          .all(this.profile.owner) as JsonObject[]
      ).map((r) => r.value),
      categories,
      tagCounts,
    };
  }
  async importPreview(
    filename: string,
    raw: Buffer,
    depth = 0,
    budget = { bytes: 0 },
  ): Promise<JsonObject> {
    if (raw.length > 20 * 1024 * 1024) throw new Error("文件最多 20 MB");
    if (depth > 3) throw new Error("压缩文件嵌套过深");
    const suffix = filename.split(".").at(-1)?.toLowerCase();
    let items: JsonObject[] = [];
    if (suffix === "zip") {
      const files = await unzip(raw);
      budget.bytes += [...files.values()].reduce((n, b) => n + b.length, 0);
      if (budget.bytes > 50 * 1024 * 1024) throw new Error("压缩文件过大");
      for (const [name, body] of files.has("prompts.json")
        ? new Map([["prompts.json", files.get("prompts.json")!]])
        : files)
        items.push(
          ...(await this.importPreview(name, body, depth + 1, budget)).items,
        );
    } else {
      const value = raw.toString("utf8").replace(/^\uFEFF/, "");
      if (suffix === "json") {
        const data = JSON.parse(value);
        items = Array.isArray(data) ? data : data.items || [];
      } else if (suffix === "csv") {
        const [headers, ...rows] = parseCSV(value);
        items = rows
          .filter((r) => r.some(Boolean))
          .map((r) => {
            const row = Object.fromEntries(
              headers.map((h, i) => [h, r[i] || ""]),
            );
            return {
              title: row.title || row.name || "导入提示词",
              content: row.content || row.prompt || "",
              format: row.format || "markdown",
              tags: row.tags ? JSON.parse(row.tags) : [],
              variables: JSON.parse(row.variables || "{}"),
              origin: JSON.parse(row.origin || "{}"),
            };
          });
      } else
        items = [
          {
            title: filename.replace(/\.[^.]+$/, ""),
            content: ["html", "htm"].includes(suffix || "")
              ? plainHTML(value)
              : value,
            format: ["md", "markdown"].includes(suffix || "")
              ? "markdown"
              : ["txt", "html", "htm"].includes(suffix || "")
                ? "text"
                : "custom",
          },
        ];
    }
    if (!Array.isArray(items) || items.length > 10000)
      throw new Error("每次最多一万条提示词");
    const clean = items.map((item) => {
      if (!item || typeof item !== "object")
        throw new Error("提示词数据应为对象");
      const body = {
        title: text(item.title ?? item.name ?? "导入提示词", 160),
        content: text(item.content ?? item.prompt ?? ""),
        format: item.format || "markdown",
        tags: item.tags || [],
        variables: item.variables || {},
        origin: item.origin || {},
      };
      if (!FORMATS.includes(body.format)) throw new Error("内容格式不支持");
      plain(body.content, body.format);
      return { ...body, digest: hash(body.format + "\0" + body.content) };
    });
    return { items: clean, total: clean.length };
  }
  importItems(body: JsonObject) {
    if (!Array.isArray(body.items) || body.items.length > 1000)
      throw new Error("每批最多一千条");
    return this.profile.transaction(() => {
      const known = new Set(
          (
            this.profile.db
              .prepare(
                "SELECT format,content FROM prompts WHERE owner=? AND deleted IS NULL",
              )
              .all(this.profile.owner) as JsonObject[]
          ).map((r) => r.format + "\0" + r.content),
        ),
        saved: JsonObject[] = [];
      let duplicates = 0;
      for (const raw of body.items) {
        const fingerprint =
          (raw.format || "markdown") + "\0" + (raw.content || "");
        if (known.has(fingerprint) && !body.allowDuplicates) {
          duplicates++;
          continue;
        }
        const item = { ...raw };
        for (const key of [
          "id",
          "owner",
          "revision",
          "expectedRevision",
          "digest",
        ])
          delete item[key];
        if (body.folder) item.folder = body.folder;
        saved.push(this.save(item, true));
        known.add(fingerprint);
      }
      return { items: saved, imported: saved.length, duplicates };
    });
  }
  async export(ids: string[] | undefined, format = "json") {
    const items = (
        this.profile.db
          .prepare(
            "SELECT * FROM prompts WHERE owner=? AND deleted IS NULL ORDER BY title",
          )
          .all(this.profile.owner) as JsonObject[]
      )
        .filter((r) => !ids?.length || ids.includes(r.id))
        .map((r) => this.public(r)),
      manifest = JSON.stringify({ schemaVersion: 1, items }, null, 2);
    if (format === "json")
      return {
        filename: "prompts.json",
        mime: "application/json",
        content: manifest,
      };
    if (format === "csv")
      return {
        filename: "prompts.csv",
        mime: "text/csv",
        content:
          [
            ["title", "content", "format", "tags", "variables", "origin"],
            ...items.map((r) => [
              r.title,
              r.content,
              r.format,
              JSON.stringify(r.tags),
              JSON.stringify(r.variables),
              JSON.stringify(r.origin),
            ]),
          ]
            .map((r) => r.map(csvValue).join(","))
            .join("\r\n") + "\r\n",
      };
    if (["txt", "md"].includes(format))
      return {
        filename: "prompts." + format,
        mime: "text/plain",
        content: items
          .map(
            (r) =>
              (format === "md" ? "# " : "") +
              r.title +
              "\n\n" +
              plain(r.content, r.format),
          )
          .join("\n\n"),
      };
    if (format === "html") {
      const esc = (v: string) =>
        v.replace(
          /[&<>"']/g,
          (c) =>
            (
              ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
              }) as JsonObject
            )[c],
        );
      return {
        filename: "prompts.html",
        mime: "text/html",
        content:
          '<!doctype html><meta charset="utf-8"><title>提示词库</title><style>body{font:14px/1.6 system-ui;max-width:960px;margin:40px auto;color:#172033}article{border:1px solid #e1e5eb;border-radius:16px;padding:24px;margin:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>' +
          items
            .map(
              (r) =>
                "<article><h2>" +
                esc(r.title) +
                "</h2><pre>" +
                esc(plain(r.content, r.format)) +
                "</pre></article>",
            )
            .join(""),
      };
    }
    if (format === "zip") {
      const files = new Map<string, string | Buffer>([
        ["prompts.json", manifest],
      ]);
      for (const r of items)
        files.set(
          r.id + ".md",
          "# " + r.title + "\n\n" + plain(r.content, r.format),
        );
      return {
        filename: "prompts.zip",
        mime: "application/zip",
        base64: (await zipFiles(files)).toString("base64"),
      };
    }
    throw new Error("导出格式不支持");
  }
}
