import {
  existsSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Codex } from "./codex.ts";
import { remoteCollector } from "./remote-collector.ts";
import { canonical, iso } from "./monitor.ts";
import { parseExact, hash, uid, type JsonObject } from "./profile.ts";

export function compactLog(content: string) {
  if (
    typeof content !== "string" ||
    Buffer.byteLength(content) > 8 * 1024 * 1024
  )
    throw new Error("单份日志最多 8 MB");
  const rows: JsonObject[] = [];
  let session = "";
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: JsonObject;
    try {
      row = parseExact(line);
    } catch {
      throw new Error("日志不完整或 JSON 损坏");
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const kind = row.type;
    let payload = row.payload || {};
    if (typeof payload !== "object" || Array.isArray(payload)) continue;
    if (kind === "session_meta") {
      payload = Object.fromEntries(
        Object.entries(payload).filter(([k]) =>
          [
            "id",
            "session_id",
            "model_provider",
            "cwd",
            "timestamp",
            "forked_from_id",
            "originator",
          ].includes(k),
        ),
      );
      session = String(payload.id || payload.session_id || "");
    } else if (kind === "turn_context")
      payload = { model: payload.model ?? null };
    else if (kind === "event_msg" && payload.type === "token_count") {
      const info = payload.info || {};
      if (typeof info !== "object" || Array.isArray(info))
        throw new Error("消费证据格式不正确");
      const filtered = Object.fromEntries(
        Object.entries(info)
          .filter(([k]) =>
            ["last_token_usage", "total_token_usage", "response_id"].includes(
              k,
            ),
          )
          .map(([k, v]) => [
            k,
            v && typeof v === "object" && !Array.isArray(v)
              ? Object.fromEntries(
                  Object.entries(v).filter(([field]) =>
                    [
                      "input_tokens",
                      "output_tokens",
                      "cached_input_tokens",
                      "cache_write_input_tokens",
                      "reasoning_output_tokens",
                      "total_tokens",
                    ].includes(field),
                  ),
                )
              : v,
          ]),
      );
      payload = {
        type: "token_count",
        info: filtered,
        ...(payload.response_id ? { response_id: payload.response_id } : {}),
      };
    } else continue;
    rows.push({
      type: kind,
      payload,
      ...Object.fromEntries(
        Object.entries(row).filter(([k]) =>
          ["timestamp", "response_id"].includes(k),
        ),
      ),
    });
  }
  if (
    !session ||
    session.length > 300 ||
    !rows.some((r) => r.type === "event_msg")
  )
    throw new Error("日志缺少会话编号或原始用量证据");
  return rows.map((r) => canonical(r) + "\n").join("");
}
export class Sources {
  constructor(readonly codex: Codex) {
    codex.monitor.profile.db.exec(
      "CREATE TABLE IF NOT EXISTS codex_sources(owner TEXT,path TEXT,kind TEXT,label TEXT,digest TEXT,at TEXT,PRIMARY KEY(owner,path))",
    );
  }
  directory() {
    const p = this.codex.monitor.profile;
    return join(p.root, "data", "codex-sources", p.owner);
  }
  hosts() {
    return String(process.env.WORKBENCH_CODEX_SSH_HOSTS || "")
      .split(",")
      .filter((h) => /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,150}$/.test(h));
  }
  state() {
    const p = this.codex.monitor.profile;
    return {
      sources: p.db
        .prepare(
          "SELECT kind,label,COUNT(*) files,MAX(at) importedAt FROM codex_sources WHERE owner=? GROUP BY kind,label",
        )
        .all(p.owner),
      sshHosts: this.hosts(),
      cloudAutomatic: false,
      message: "本机日志含本地 Work；远程与云端需同步或导入原始日志",
    };
  }
  async sync(local?: string) {
    const roots = [
      ...(local ? [local] : []),
      ...(existsSync(this.directory()) ? [this.directory()] : []),
    ];
    if (!roots.length) throw new Error("尚未连接用量来源");
    let result: JsonObject = {
      imported: 0,
      corrected: 0,
      scanned: 0,
      files: 0,
      errors: [],
      pending: 0,
      truncated: false,
    };
    for (const root of roots) {
      const next = await this.codex.sync(root);
      result = {
        ...next,
        imported: result.imported + next.imported,
        corrected: result.corrected + next.corrected,
        scanned: result.scanned + next.scanned,
        files: result.files + next.files,
        errors: [...result.errors, ...next.errors],
        pending: result.pending + next.pending,
        truncated: result.truncated || next.truncated,
      };
    }
    return result;
  }
  async importFiles(body: JsonObject): Promise<JsonObject> {
    const kind = body.kind,
      label = body.label || (kind === "ssh" ? "远程 SSH" : "云端 Work"),
      files = body.files;
    if (
      !["ssh", "cloud"].includes(kind) ||
      typeof label !== "string" ||
      label.length > 100
    )
      throw new Error("日志来源格式不正确");
    if (!Array.isArray(files) || files.length < 1 || files.length > 128)
      throw new Error("每次导入 1–128 份日志");
    const clean: JsonObject[] = [];
    let bytes = 0;
    for (const item of files) {
      if (!item || typeof item !== "object")
        throw new Error("日志文件格式不正确");
      const content = compactLog(item.content);
      bytes += Buffer.byteLength(content);
      if (bytes > 16 * 1024 * 1024)
        throw new Error("每次导入最多 16 MB 用量证据");
      clean.push({ digest: hash(content), content });
    }
    const folder = this.directory(),
      temp = join(
        this.codex.monitor.profile.root,
        "runtime",
        "source-staging-" + uid(),
      );
    mkdirSync(temp, { recursive: true });
    mkdirSync(folder, { recursive: true });
    try {
      for (const file of clean) {
        const target = join(temp, file.digest + ".jsonl");
        writeFileSync(target, file.content, { flag: "wx" });
        await this.codex.parse(target);
      }
      for (const file of clean) {
        const target = join(folder, file.digest + ".jsonl");
        if (!existsSync(target))
          renameSync(join(temp, file.digest + ".jsonl"), target);
      }
      const result = await this.sync(),
        p = this.codex.monitor.profile;
      p.transaction(() => {
        for (const file of clean)
          p.db
            .prepare("INSERT OR REPLACE INTO codex_sources VALUES(?,?,?,?,?,?)")
            .run(
              p.owner,
              join(folder, file.digest + ".jsonl"),
              kind,
              label,
              file.digest,
              iso(),
            );
      });
      return { ...result, source: this.state(), received: clean.length };
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  async ssh(host: string) {
    if (!this.hosts().includes(host))
      throw new Error("该 SSH 主机尚未由服务器配置");
    let imported = 0,
      scanned = 0,
      offset = 0;
    for (let n = 0; n < 50; n++) {
      const script = remoteCollector(offset);
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(
            "ssh",
            [
              "-o",
              "BatchMode=yes",
              "-o",
              "StrictHostKeyChecking=yes",
              "-o",
              "ConnectTimeout=8",
              host,
              "node -",
            ],
            { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
          ),
          parts: Buffer[] = [];
        let bytes = 0;
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("SSH 同步超时"));
        }, 45000);
        child.stderr.resume();
        child.stdout.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 20 * 1024 * 1024) {
            child.kill();
            reject(new Error("远程证据响应过大"));
          } else parts.push(chunk);
        });
        child.once("error", () => {
          clearTimeout(timer);
          reject(
            new Error("SSH 同步失败，请检查主机连接、Node.js 与已配置的认证"),
          );
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(Buffer.concat(parts).toString("utf8"));
          else
            reject(
              new Error("SSH 同步失败，请检查主机连接、Node.js 与已配置的认证"),
            );
        });
        child.stdin.end(script);
      });
      const batch = parseExact(output);
      if (!Array.isArray(batch.files))
        throw new Error("远程证据响应格式不正确");
      if (batch.files.length) {
        const result = await this.importFiles({
          kind: "ssh",
          label: host,
          files: batch.files,
        });
        imported += result.imported;
        scanned += result.scanned;
      }
      if (batch.next === null)
        return { imported, scanned, errors: [], source: this.state() };
      if (!Number.isInteger(batch.next) || batch.next <= offset)
        throw new Error("远程分页没有前进");
      offset = batch.next;
    }
    throw new Error("远程证据超过单次分页限制");
  }
}
