import {
  existsSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  lstatSync,
  rmSync,
} from "node:fs";
import { resolve, dirname, join, relative, isAbsolute, sep } from "node:path";
import {
  randomUUID,
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import Database from "./sqlite.ts";
type DatabaseSync = Database;
const DatabaseSync = Database;

export type JsonObject = Record<string, any>;
export interface ProfileMeta {
  format: "lingxi-profile";
  schemaVersion: 1;
  profileId: string;
  username: string;
  createdAt: string;
}
export const stamp = () => new Date().toISOString();
export const uid = () => randomUUID().replaceAll("-", "");
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const encode = (value: unknown) =>
  JSON.stringify(value, (_key, v) =>
    typeof v === "bigint" ? (JSON as any).rawJSON(v.toString()) : v,
  );
export const parseExact = (value: string) =>
  JSON.parse(value, (key, v, context?: { source?: string }) =>
    typeof v === "number" &&
    Number.isInteger(v) &&
    !Number.isSafeInteger(v) &&
    context?.source &&
    /^-?\d+$/.test(context.source)
      ? BigInt(context.source)
      : v,
  );
export function atomicJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + "." + uid() + ".tmp";
  try {
    writeFileSync(tmp, encode(value), { flag: "wx", mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}
export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return structuredClone(fallback);
  return parseExact(readFileSync(file, "utf8")) as T;
}
export function safePath(root: string, name: string) {
  if (typeof name !== "string" || isAbsolute(name) || name.includes("\0"))
    throw new Error("资料路径不正确");
  const target = resolve(root, name),
    rel = relative(resolve(root), target);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    throw new Error("资料路径越界");
  let parent = target;
  while (parent !== dirname(parent)) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink())
      throw new Error("资料路径不能包含目录链接");
    if (parent === resolve(root)) break;
    parent = dirname(parent);
  }
  return target;
}
export class ProfileStore {
  readonly root: string;
  readonly serviceId = randomUUID();
  readonly instanceToken = randomBytes(32).toString("hex");
  meta: ProfileMeta | null = null;
  database: DatabaseSync | null = null;
  private locked = false;
  private lockFile = "";
  constructor(root: string, options: { lockOnly?: boolean } = {}) {
    this.root = resolve(root);
    safePath(this.root, ".profile.json");
    this.meta = readJson<ProfileMeta | null>(
      join(this.root, ".profile.json"),
      null,
    );
    if (this.meta) {
      if (options.lockOnly) this.acquire();
      else this.open();
    }
  }
  create(username: string) {
    if (this.meta) throw new Error("此位置已经有 Profile");
    if (
      typeof username !== "string" ||
      !username.trim() ||
      [...username.trim()].length > 30
    )
      throw new Error("用户名需为 1–30 字");
    if (
      existsSync(this.root) &&
      readdirSync(this.root).some(
        (name) =>
          ![
            "runtime",
            "browser",
            "logs",
            "updates",
            "workspace",
            "config",
          ].includes(name),
      )
    )
      throw new Error("此目录为旧账户资料，请选择空目录");
    mkdirSync(this.root, { recursive: true });
    this.acquire();
    const meta: ProfileMeta = {
      format: "lingxi-profile",
      schemaVersion: 1,
      profileId: randomUUID(),
      username: username.trim(),
      createdAt: stamp(),
    };
    try {
      atomicJson(join(this.root, ".profile.json"), meta);
      this.meta = meta;
      this.open();
      this.write("settings", { display_name: meta.username });
      return this.session();
    } catch (error) {
      this.close();
      throw error;
    }
  }
  private acquire() {
    if (this.locked) return;
    this.lockFile = join(this.root, "runtime", ".writer.lock");
    mkdirSync(dirname(this.lockFile), { recursive: true });
    if (existsSync(this.lockFile)) {
      const old = readJson<JsonObject>(this.lockFile, {});
      let running = true;
      try {
        process.kill(Number(old.pid), 0);
      } catch (error: any) {
        running = error.code !== "ESRCH";
      }
      if (running)
        throw new Error("此 Profile 已有后台运行，请连接该实例或先正常退出");
      unlinkSync(this.lockFile);
    }
    writeFileSync(
      this.lockFile,
      JSON.stringify({
        pid: process.pid,
        serviceId: this.serviceId,
        startedAt: stamp(),
      }),
      { flag: "wx", mode: 0o600 },
    );
    this.locked = true;
  }
  open() {
    if (this.database) return;
    if (
      !this.meta ||
      this.meta.format !== "lingxi-profile" ||
      this.meta.schemaVersion !== 1 ||
      !/^[-a-f0-9]{36}$/.test(this.meta.profileId)
    )
      throw new Error("Profile 格式不支持");
    this.acquire();
    const file = join(this.root, "data", "storage", "workbench.sqlite");
    mkdirSync(dirname(file), { recursive: true });
    const recovery=join(this.root,'backups','usage-schema-baseline.sqlite');
    // Recover the only vulnerable rename boundary before SQLite could create
    // a fresh empty file after an interrupted conversion.
    if(!existsSync(file)&&existsSync(recovery))renameSync(recovery,file);
    this.database = new DatabaseSync(file);
    if(!this.database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' LIMIT 1").get())this.database.exec('PRAGMA auto_vacuum=INCREMENTAL');
    this.database
      .exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=15000; PRAGMA foreign_keys=ON; PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=1048576;
      CREATE TABLE IF NOT EXISTS documents(namespace TEXT NOT NULL,entity TEXT NOT NULL,payload TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,content_hash TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(namespace,entity));
      CREATE INDEX IF NOT EXISTS documents_updated ON documents(namespace,updated_at DESC);`);
  }
  get db() {
    if (!this.database) throw new Error("请先创建或选择 Profile");
    return this.database;
  }
  /** Lifecycle lock is already held. Publish a checked snapshot with a single
   * file rename; never rewrite the active legacy database during conversion. */
  migrateDatabase(transform:(candidate:Database)=>void){
    const live=this.db,file=join(this.root,'data','storage','workbench.sqlite');
    const stage=join(this.root,'runtime','usage-migration.sqlite');
    const recovery=join(this.root,'backups','usage-schema-baseline.sqlite');
    if(existsSync(stage)||existsSync(recovery))throw Error('已有用量迁移暂存或恢复基线，请核验恢复状态后再迁移');
    mkdirSync(dirname(recovery),{recursive:true});
    live.exec("VACUUM INTO '"+stage.replaceAll("'","''")+"'");
    let candidate:Database|null=new Database(stage),switched=false,detached=false;
    try{
      transform(candidate);
      const foreign=candidate.pragma('foreign_key_check');
      if(candidate.pragma('integrity_check',{simple:true})!=='ok'||!Array.isArray(foreign)||foreign.length)throw Error('迁移数据库完整性校验失败');
      candidate.exec('PRAGMA auto_vacuum=INCREMENTAL; VACUUM');candidate.close();candidate=null;
      const checkpoint=live.pragma('wal_checkpoint(TRUNCATE)') as JsonObject[];
      if(checkpoint.some(row=>row.busy))throw Error('数据库仍有读取连接，迁移保持原库，请关闭后重试');
      live.close();this.database=null;
      renameSync(file,recovery);detached=true;
      renameSync(stage,file);switched=true;
      this.open();
    }catch(error){
      candidate?.close();
      if(switched){this.database?.close();this.database=null;renameSync(file,stage);renameSync(recovery,file);this.open();if(existsSync(stage))unlinkSync(stage);}
      if(detached&&!switched){renameSync(recovery,file);this.open();}
      if(!detached&&existsSync(stage))unlinkSync(stage);
      throw error;
    }
  }
  get owner() {
    if (!this.meta) throw new Error("请先创建或选择 Profile");
    return this.meta.profileId;
  }
  session() {
    return {
      user: this.meta
        ? {
            username: this.meta.profileId,
            display_name: this.meta.username,
            profileId: this.meta.profileId,
          }
        : null,
      profile: this.meta ? { ...this.meta } : null,
    };
  }
  read<T>(entity: string, fallback: T): T {
    const row = this.db
      .prepare("SELECT payload FROM documents WHERE namespace=? AND entity=?")
      .get(this.owner, entity) as { payload: string } | undefined;
    return row ? parseExact(row.payload) : structuredClone(fallback);
  }
  write(entity: string, value: unknown) {
    const payload = encode(value);
    if (payload === undefined) throw new Error("资料内容不正确");
    this.db
      .prepare(
        `INSERT INTO documents VALUES(?,?,?,1,?,?) ON CONFLICT(namespace,entity) DO UPDATE SET payload=excluded.payload,revision=documents.revision+1,content_hash=excluded.content_hash,updated_at=excluded.updated_at`,
      )
      .run(this.owner, entity, payload, hash(payload), Date.now());
  }
  transaction<T>(work: () => T): T {
    const nested=this.db.inTransaction;
    this.db.exec(nested?"SAVEPOINT lingxi_nested":"BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec(nested?"RELEASE lingxi_nested":"COMMIT");
      return value;
    } catch (error) {
      this.db.exec(nested?"ROLLBACK TO lingxi_nested; RELEASE lingxi_nested":"ROLLBACK");
      throw error;
    }
  }
  credentials() {
    return readJson<JsonObject>(
      join(this.root, "data", "credentials", this.owner, "secrets.json"),
      {},
    );
  }
  saveCredentials(value: JsonObject) {
    atomicJson(
      join(this.root, "data", "credentials", this.owner, "secrets.json"),
      value,
    );
  }
  rename(username: string) {
    if (
      typeof username !== "string" ||
      !username.trim() ||
      [...username.trim()].length > 30
    )
      throw new Error("用户名需为 1–30 字");
    const next = { ...this.meta!, username: username.trim() };
    atomicJson(join(this.root, ".profile.json"), next);
    this.meta = next;
    this.write("settings", {
      ...this.read("settings", {}),
      display_name: next.username,
    });
    return next.username;
  }
  authenticate(token: string) {
    const a = Buffer.from(token || ""),
      b = Buffer.from(this.instanceToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  close() {
    this.database?.close();
    this.database = null;
    if (this.locked) {
      const marker = readJson<JsonObject>(this.lockFile, {});
      if (marker.serviceId === this.serviceId) unlinkSync(this.lockFile);
      this.locked = false;
    }
  }
}
