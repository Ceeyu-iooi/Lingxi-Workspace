import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import Database from "./sqlite.ts";
import {
  ProfileStore,
  safePath,
  readJson,
  hash,
  uid,
  stamp,
  type ProfileMeta,
} from "./profile.ts";
import type { BackupEnvelope } from "../shared/contracts.ts";

const LIMIT = 512 * 1024 * 1024;
const TOP = ["data", "workspace", "config", ".profile.json"];
type Snapshot = {
  format: "lingxi-profile-snapshot";
  version: 1;
  createdAt: string;
  profileId: string;
  files: { path: string; sha256: string; data: string }[];
};
export class ProfileBackups {
  busy = false;
  constructor(readonly profile: ProfileStore) {}
  private password(value: unknown) {
    if (typeof value !== "string" || value.length < 8 || value.length > 1024)
      throw new Error("备份口令需为 8–1024 个字符");
    return value;
  }
  private key(password: string, salt: Buffer) {
    return scryptSync(password, salt, 32, {
      N: 131072,
      r: 8,
      p: 1,
      maxmem: 256 * 1024 * 1024,
    });
  }
  list() {
    const folder = join(this.profile.root, "backups");
    if (!existsSync(folder)) return [];
    return readdirSync(folder)
      .filter((name) => /^profile-\d+-[a-f0-9]{8}\.lxprofile$/.test(name))
      .sort()
      .reverse()
      .map((file) => {
        const s = statSync(join(folder, file));
        return {
          file,
          size: s.size,
          at: s.mtimeMs / 1000,
          scope: "profile",
          encrypted: true,
        };
      });
  }
  private async snapshot(): Promise<Snapshot> {
    const store = this.profile,
      temp = join(store.root, "runtime", "backup-" + uid());
    mkdirSync(temp, { recursive: true });
    try {
      const copied = join(temp, "workbench.sqlite");
      await store.db.backup(copied);
      const files: Snapshot["files"] = [];
      let size = 0;
      const walk = (file: string) => {
        const rel = relative(store.root, file).split(sep).join("/");
        if (
          rel.endsWith("-wal") ||
          rel.endsWith("-shm") ||
          rel.includes("/.writer.lock") ||
          rel.startsWith("data/storage/recovery/") ||
          rel.includes("/.maintenance-request.json")
        )
          return;
        const entry = statSync(file, { throwIfNoEntry: false });
        if (!entry) return;
        const link = requireLink(file);
        if (link) throw new Error("Profile 包含目录链接，无法制作完整备份");
        if (entry.isDirectory()) {
          for (const row of readdirSync(file, { withFileTypes: true })) {
            if (row.isSymbolicLink())
              throw new Error("Profile 包含目录链接，无法制作完整备份");
            walk(join(file, row.name));
          }
          return;
        }
        if (!entry.isFile()) return;
        const data = readFileSync(
          rel === "data/storage/workbench.sqlite" ? copied : file,
        );
        size += data.length;
        if (size > LIMIT) throw new Error("Profile 超过单次备份允许大小");
        files.push({
          path: rel,
          sha256: hash(data),
          data: data.toString("base64"),
        });
      };
      for (const name of TOP)
        if (existsSync(join(store.root, name))) walk(join(store.root, name));
      return {
        format: "lingxi-profile-snapshot",
        version: 1,
        createdAt: stamp(),
        profileId: store.owner,
        files,
      };
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  async make(passwordValue: unknown) {
    const password = this.password(passwordValue);
    if (this.busy) throw new Error("Profile 正在备份或恢复");
    this.busy = true;
    try {
      const snapshot = await this.snapshot(),
        salt = randomBytes(16),
        iv = randomBytes(12),
        key = this.key(password, salt);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from("lingxi-profile-encrypted:1:scrypt"));
      const ciphertext = Buffer.concat([
        cipher.update(gzipSync(JSON.stringify(snapshot))),
        cipher.final(),
      ]);
      key.fill(0);
      const envelope: BackupEnvelope = {
        format: "lingxi-profile-encrypted",
        formatVersion: 1,
        kdf: "scrypt",
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
      const folder = join(this.profile.root, "backups"),
        file = `profile-${Date.now()}-${uid().slice(0, 8)}.lxprofile`;
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, file), JSON.stringify(envelope), {
        flag: "wx",
        mode: 0o600,
      });
      return {
        file,
        size: statSync(join(folder, file)).size,
        encrypted: true,
        scope: "profile",
      };
    } finally {
      this.busy = false;
    }
  }
  file(name: string) {
    if (!/^profile-\d+-[a-f0-9]{8}\.lxprofile$/.test(name))
      throw new Error("备份名称不正确");
    return safePath(join(this.profile.root, "backups"), name);
  }
  async restore(envelope: BackupEnvelope, passwordValue: unknown) {
    const password = this.password(passwordValue);
    if (
      !envelope ||
      envelope.format !== "lingxi-profile-encrypted" ||
      envelope.formatVersion !== 1 ||
      envelope.kdf !== "scrypt" ||
      typeof envelope.ciphertext !== "string" ||
      envelope.ciphertext.length > LIMIT * 2
    )
      throw new Error("不支持的 Profile 备份格式");
    let payload: Snapshot;
    try {
      const salt = Buffer.from(envelope.salt, "base64"),
        iv = Buffer.from(envelope.iv, "base64"),
        tag = Buffer.from(envelope.tag, "base64");
      if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16)
        throw new Error();
      const key = this.key(password, salt),
        decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from("lingxi-profile-encrypted:1:scrypt"));
      decipher.setAuthTag(tag);
      let compressed: Buffer;
      try {
        compressed = Buffer.concat([
          decipher.update(Buffer.from(envelope.ciphertext, "base64")),
          decipher.final(),
        ]);
      } finally {
        key.fill(0);
      }
      payload = JSON.parse(
        gunzipSync(compressed, {
          maxOutputLength: Math.ceil((LIMIT * 4) / 3) + 64 * 1024 * 1024,
        }).toString("utf8"),
      );
    } catch {
      throw new Error("口令不正确或备份已损坏；没有修改当前 Profile");
    }
    if (
      payload.format !== "lingxi-profile-snapshot" ||
      payload.version !== 1 ||
      !Array.isArray(payload.files) ||
      payload.files.length > 100000
    )
      throw new Error("备份内容格式不正确");
    const names = new Set<string>();
    let total = 0;
    for (const file of payload.files) {
      if (
        typeof file.path !== "string" ||
        !TOP.includes(file.path.split("/")[0]) ||
        names.has(file.path) ||
        file.path.includes("\\")
      )
        throw new Error("备份资料路径不正确");
      safePath(this.profile.root, file.path);
      names.add(file.path);
      const raw = Buffer.from(file.data, "base64");
      total += raw.length;
      if (total > LIMIT || hash(raw) !== file.sha256)
        throw new Error("备份资料摘要或大小不正确");
    }
    if (
      !names.has(".profile.json") ||
      !names.has("data/storage/workbench.sqlite")
    )
      throw new Error("备份缺少 Profile 或数据库");
    const previous = await this.make(password);
    if (this.busy) throw new Error("Profile 正在备份或恢复");
    this.busy = true;
    const staging = join(this.profile.root, "runtime", "restore-" + uid()),
      next = join(staging, "next"),
      old = join(staging, "previous");
    mkdirSync(next, { recursive: true });
    mkdirSync(old, { recursive: true });
    const applied: string[] = [],
      moved: string[] = [];
    try {
      for (const file of payload.files) {
        const target = safePath(next, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, Buffer.from(file.data, "base64"), {
          flag: "wx",
          mode: 0o600,
        });
      }
      const meta = readJson<ProfileMeta | null>(
        join(next, ".profile.json"),
        null,
      );
      if (
        meta?.profileId !== payload.profileId ||
        meta?.format !== "lingxi-profile" ||
        meta?.schemaVersion !== 1
      )
        throw new Error("备份 Profile 身份不正确");
      const check = new Database(join(next, "data/storage/workbench.sqlite"), {
        readonly: true,
      });
      try {
        if (check.pragma("integrity_check", { simple: true }) !== "ok")
          throw new Error("备份数据库完整性检查失败");
      } finally {
        check.close();
      }
      this.profile.database?.close();
      this.profile.database = null;
      for (const name of TOP) {
        const current = join(this.profile.root, name);
        if (existsSync(current)) {
          renameSync(current, join(old, name));
          moved.push(name);
        }
        if (existsSync(join(next, name))) {
          renameSync(join(next, name), current);
          applied.push(name);
        }
      }
      this.profile.meta = meta;
      this.profile.open();
      return {
        ok: true,
        scope: "profile",
        restored: payload.files.length,
        preRestoreBackup: previous.file,
        profileId: meta.profileId,
      };
    } catch (error) {
      this.profile.database?.close();
      this.profile.database = null;
      for (const name of applied.reverse())
        rmSync(join(this.profile.root, name), { recursive: true, force: true });
      for (const name of moved.reverse())
        renameSync(join(old, name), join(this.profile.root, name));
      this.profile.meta = readJson<ProfileMeta | null>(
        join(this.profile.root, ".profile.json"),
        null,
      );
      this.profile.open();
      throw error;
    } finally {
      this.busy = false;
      rmSync(staging, { recursive: true, force: true });
    }
  }
}
import { lstatSync } from "node:fs";
function requireLink(file: string) {
  return lstatSync(file).isSymbolicLink();
}
