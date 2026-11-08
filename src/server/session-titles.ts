import {closeSync, existsSync, openSync, readFileSync, readSync, statSync} from "node:fs";
import {dirname, extname, join, relative, resolve, isAbsolute, sep} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {parseExact, type JsonObject, type ProfileStore} from "./profile.ts";

const codexHeaders = new Map<string, {offset: number; session?: string; parent?: string; project?: string}>();

/** Only explicit source titles. Session prompts and stable IDs are never used as labels. */
export function sessionMetadata(profile: ProfileStore, source: string, root?: string) {
  const titles = new Map<string, {title?: string; project?: string; parent?: string}>();
  const add = (id: unknown, title: unknown, project?: unknown) => {
    if (typeof id !== "string" || !id) return;
    const name = typeof title === "string" ? title.trim().slice(0, 300) : "";
    const directory = typeof project === "string" ? project.trim() : "";
    if (name || directory) titles.set(id, {title: name || undefined, project: directory || undefined});
  };
  if (!root) return titles;
  try {
    if (source === "dsh") {
      const rows = profile.db.prepare("SELECT state FROM agent_reads WHERE owner=? AND source='dsh'").iterate(profile.owner) as Iterable<JsonObject>;
      for (const row of rows) {
        const meta = parseExact(row.state);
        add(meta.session, meta.title);
      }
    } else if (source === "codex") {
      const index = join(dirname(root), "session_index.jsonl");
      for (const line of existsSync(index) && statSync(index).size <= 16 * 1024 * 1024 ? readFileSync(index, "utf8").split(/\r?\n/) : []) {
        if (!line) continue;
        try { const row = JSON.parse(line); add(row.id, row.thread_name); } catch { /* ignore an incomplete line */ }
      }
      const roots = [resolve(root), resolve(dirname(root), "archived_sessions")];
      const cursors = profile.db.prepare("SELECT path,offset FROM cursors WHERE owner=?").iterate(profile.owner) as Iterable<JsonObject>;
      const buffer = Buffer.allocUnsafe(256 * 1024);
      for (const cursor of cursors) {
        const file = cursor.path;
        if (typeof file !== "string" || !file.endsWith(".jsonl") || !roots.some(base => {
          const rel = relative(base,file);
          return rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep);
        })) continue;
        let header = codexHeaders.get(file);
        if (!header || header.offset !== cursor.offset) {
          header = {offset:cursor.offset};
          try {
            const fd = openSync(file,"r");
            try {
              const count = readSync(fd,buffer,0,buffer.length,0);
              const newline = buffer.subarray(0,count).indexOf(10);
              const line = newline < 0 ? buffer.subarray(0,count) : buffer.subarray(0,newline);
              const row = JSON.parse(line.toString("utf8"));
              const data = row.payload;
              if (row.type === "session_meta" && typeof data?.id === "string") {
                header.session = data.id;
                header.project = typeof data.cwd === "string" ? data.cwd : undefined;
                const child = data.source?.subagent;
                const parent = child?.thread_spawn?.parent_thread_id || (child ? data.parent_thread_id : undefined);
                if (typeof parent === "string" && parent !== data.id) header.parent = parent;
              }
            } finally {closeSync(fd);}
          } catch { /* A moved or malformed source cannot supply ancestry. */ }
          if (codexHeaders.size >= 10000) codexHeaders.delete(codexHeaders.keys().next().value!);
          codexHeaders.set(file,header);
        }
        if (header.session) titles.set(header.session,{...titles.get(header.session),project:header.project,parent:header.parent});
      }
    } else if (source === "zcode") {
      const file = [".sqlite", ".db"].includes(extname(root)) ? root
        : [join(root, "db", "db.sqlite"), join(root, "db.sqlite")].find(existsSync);
      if (!file) return titles;
      const db = new DatabaseSync(file, {readOnly: true});
      try {
        const columns = db.prepare("PRAGMA table_info(session)").all();
        const project = columns.some(row => row.name === "directory") ? ",directory" : "";
        for (const row of db.prepare("SELECT id,title" + project + " FROM session").iterate()) add(row.id, row.title, row.directory);
      } finally { db.close(); }
    }
  } catch {
    // Optional metadata cannot make verified usage unavailable.
  }
  return titles;
}
