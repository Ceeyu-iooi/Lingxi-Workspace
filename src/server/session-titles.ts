import {existsSync, readFileSync, statSync} from "node:fs";
import {dirname, extname, join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {parseExact, type JsonObject, type ProfileStore} from "./profile.ts";

/** Only explicit source titles. Session prompts and stable IDs are never used as labels. */
export function sessionMetadata(profile: ProfileStore, source: string, root?: string) {
  const titles = new Map<string, {title?: string; project?: string}>();
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
      if (!existsSync(index) || statSync(index).size > 16 * 1024 * 1024) return titles;
      for (const line of readFileSync(index, "utf8").split(/\r?\n/)) {
        if (!line) continue;
        try { const row = JSON.parse(line); add(row.id, row.thread_name); } catch { /* ignore an incomplete line */ }
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
