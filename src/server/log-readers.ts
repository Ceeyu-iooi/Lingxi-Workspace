import {
  createReadStream,
  openSync,
  readSync,
  closeSync,
  statSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { join, relative, isAbsolute, sep } from "node:path";
import { createZstdDecompress, constants } from "node:zlib";
import { parseExact } from "./profile.ts";

export async function* records(
  file: string,
  options: {
    compressed?: boolean;
    maxBytes?: number;
    allowLargeResponse?: boolean;
    state?: { offset: number };
  } = {},
) {
  let stream: any = createReadStream(file, { highWaterMark: 128 * 1024 }),
    decoder: any = null;
  if (options.compressed) {
    if (statSync(file).size > 128 * 1024 * 1024)
      throw new Error("Harness 压缩文件超过单次限制");
    const fd = openSync(file, "r"),
      magic = Buffer.alloc(4);
    try {
      readSync(fd, magic, 0, 4, 0);
    } finally {
      closeSync(fd);
    }
    if (magic.equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) {
      decoder = createZstdDecompress({
        params: { [constants.ZSTD_d_windowLogMax]: 26 },
      });
      stream = stream.pipe(decoder);
    }
  }
  let chunks: Buffer[] = [],
    length = 0,
    total = 0,
    skipping = false,
    offset = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > (options.maxBytes ?? Infinity))
        throw new Error("解压或读取数据超过单次限制");
      let start = 0;
      for (let i = 0; i < chunk.length; i++)
        if (chunk[i] === 10) {
          const part = chunk.subarray(start, i);
          offset += part.length + 1;
          if (!skipping) {
            chunks.push(part);
            length += part.length;
            if (length > 8 * 1024 * 1024)
              throw new Error("单条用量或元数据记录超过 8 MB");
            const line = Buffer.concat(chunks).toString("utf8").trim();
            if (line) {
              try {
                yield parseExact(line);
              } catch (error) {
                if (
                  line.slice(0, 500).includes('"token_count"') ||
                  !options.allowLargeResponse
                )
                  throw new Error("用量记录 JSON 损坏");
              }
            }
          }
          if (options.state) options.state.offset = offset;
          chunks = [];
          length = 0;
          skipping = false;
          start = i + 1;
        }
      if (start < chunk.length) {
        const part = chunk.subarray(start);
        offset += part.length;
        if (!skipping) {
          chunks.push(part);
          length += part.length;
          if (length > 8 * 1024 * 1024) {
            const head = Buffer.concat(chunks)
              .subarray(0, 2048)
              .toString("utf8");
            if (
              options.allowLargeResponse &&
              /"type"\s*:\s*"response_item"/.test(head)
            ) {
              skipping = true;
              chunks = [];
              length = 0;
            } else throw new Error("单条用量或元数据记录超过 8 MB");
          }
        }
      }
    }
  } finally {
    stream.destroy();
    decoder?.destroy();
  }
}
export async function listFiles(
  root: string,
  match: (name: string) => boolean,
  limit = 50000,
) {
  const canonical = realpathSync(root),
    files: string[] = [],
    seen = new Set<string>();
  const walk = async (path: string, depth: number) => {
    if (depth > 30 || files.length >= limit) return;
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      return;
    }
    const rel = relative(canonical, real);
    if (
      rel === ".." ||
      rel.startsWith(".." + sep) ||
      isAbsolute(rel) ||
      seen.has(real)
    )
      return;
    seen.add(real);
    let children: ReturnType<typeof readdirSync>;
    try {
      children = readdirSync(real, { withFileTypes: true }) as any;
    } catch {
      return;
    }
    for (const child of children as any[]) {
      if (child.isDirectory() && !["node_modules", ".git"].includes(child.name))
        await walk(join(real, child.name), depth + 1);
      else if (child.isFile() && match(child.name))
        files.push(realpathSync(join(real, child.name)));
    }
    if (seen.size % 100 === 0) await new Promise<void>((r) => setImmediate(r));
  };
  await walk(canonical, 0);
  return files.sort();
}
