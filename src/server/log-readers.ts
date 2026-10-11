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
import { open } from "node:fs/promises";
import { zstdDecompressSync, constants } from "node:zlib";
import { parseExact } from "./profile.ts";

// Node's Zstandard decoder stops at the first frame. Read the framing (RFC
// 8878) separately so each complete frame is decoded once, without rescanning
// partial input or retaining the entire transcript in memory.
async function* zstdFrames(file: string, maxBytes: number) {
  const handle = await open(file, "r");
  let offset = 0, decoded = 0, frames = 0;
  const read = async (length: number, eof = false) => {
    const result = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(result, filled, length - filled, offset);
      if (!bytesRead) {
        if (!filled && eof) return null;
        throw new Error("Harness 压缩帧尚未写完或已截断");
      }
      offset += bytesRead; filled += bytesRead;
    }
    return result;
  };
  try {
    for (;;) {
      const magic = await read(4, true);
      if (!magic) break;
      const number = magic.readUInt32LE();
      if ((number >>> 4) === (0x184d2a50 >>> 4)) {
        const size = (await read(4))!.readUInt32LE();
        if (offset + size > (await handle.stat()).size) throw new Error("Harness 元数据帧已截断");
        offset += size;
        continue;
      }
      if (number !== 0xfd2fb528) throw new Error("Harness 压缩帧标识不正确");
      const descriptor = (await read(1))!, flags = descriptor[0];
      if (flags & 8) throw new Error("Harness 压缩帧使用不支持的格式");
      const single = !!(flags & 32), contentFlag = flags >>> 6;
      const headerSize = (single ? 0 : 1) + [0, 1, 2, 4][flags & 3] + (contentFlag ? [0, 2, 4, 8][contentFlag] : single ? 1 : 0);
      const parts: Buffer[] = [magic, descriptor];
      if (headerSize) parts.push((await read(headerSize))!);
      let frameBytes = 5 + headerSize;
      for (;;) {
        const block = (await read(3))!, value = block.readUIntLE(0, 3);
        const type = (value >>> 1) & 3, size = value >>> 3;
        if (type === 3 || size > 131072) throw new Error("Harness 压缩块不正确");
        const physicalSize = type === 1 ? 1 : size;
        frameBytes += 3 + physicalSize;
        if (frameBytes > 128 * 1024 * 1024) throw new Error("Harness 压缩帧超过读取限制");
        parts.push(block);
        if (physicalSize) parts.push((await read(physicalSize))!);
        if (value & 1) break;
      }
      if (flags & 4) parts.push((await read(4))!);
      const remaining = maxBytes - decoded;
      if (remaining <= 0) throw new Error("解压或读取数据超过单次限制");
      const output = zstdDecompressSync(Buffer.concat(parts), {
        maxOutputLength: Math.min(remaining, 64 * 1024 * 1024),
        params: { [constants.ZSTD_d_windowLogMax]: 26 },
      });
      decoded += output.length;
      yield output;
      if (++frames % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
  } finally { await handle.close(); }
}

export async function* records(
  file: string,
  options: {
    compressed?: boolean;
    maxBytes?: number;
    allowLargeResponse?: boolean;
    state?: { offset: number };
    codexUsageOnly?: boolean;
  } = {},
) {
  let stream: any = createReadStream(file, { highWaterMark: (options.codexUsageOnly ? 1024 : 128) * 1024 });
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
    if (magic.readUInt32LE() === 0xfd2fb528 || (magic.readUInt32LE() >>> 4) === (0x184d2a50 >>> 4)) {
      stream.destroy();
      stream = zstdFrames(file, options.maxBytes ?? 256 * 1024 * 1024);
    }
  }
  let chunks: Buffer[] = [],
    length = 0,
    total = 0,
    skipping = false,
    offset = 0;
  // Codex's canonical envelope identifies chat-only response items before
  // their potentially huge payload. Noncanonical ordering falls back to JSON.
  const chatOnly = (parts:Buffer[]) => {
    const first=parts[0];
    let text:string;
    if(parts.length===1||first.length>=384)text=first.toString('utf8',0,Math.min(first.length,384));
    else {
    let remaining=384;const head:Buffer[]=[];
    for(const part of parts){if(!remaining)break;const n=Math.min(remaining,part.length);head.push(part.subarray(0,n));remaining-=n;}
    text=Buffer.concat(head).toString('utf8');
    }
    const envelope=/^\s*\{\s*"timestamp"\s*:\s*"[0-9T:.+\-Z]+"\s*,\s*"type"\s*:\s*"([^"\\]+)"\s*,\s*"payload"\s*:/.exec(text);
    if(!envelope)return false;
    if(!['session_meta','turn_context','event_msg'].includes(envelope[1]))return true;
    if(envelope[1]!=='event_msg')return false;
    const kind=/^\s*\{\s*"type"\s*:\s*"([^"\\]+)"\s*[,}]/.exec(text.slice(envelope[0].length));
    return !!kind&&kind[1]!=='token_count';
  };
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > (options.maxBytes ?? Infinity))
        throw new Error("解压或读取数据超过单次限制");
      let start = 0;
      for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) {
          const part = chunk.subarray(start, i);
          offset += part.length + 1;
          if (!skipping) {
            chunks.push(part);
            length += part.length;
            if(options.codexUsageOnly&&chatOnly(chunks))skipping=true;
            if(!skipping){
            if (length > 8 * 1024 * 1024)
              throw new Error("单条用量或元数据记录超过 8 MB");
            const line = (chunks.length===1?chunks[0]:Buffer.concat(chunks)).toString("utf8").trim();
            if (line) {
              try {
                if (options.codexUsageOnly) {
                  // Inspect only record kind using the native parser. Exact-number
                  // revival remains mandatory for every retained usage record.
                  const header = JSON.parse(line);
                  if (['session_meta','turn_context'].includes(header?.type)) yield header;
                  else if (header?.type === 'event_msg' && header.payload?.type === 'token_count') {
                    // Any unsafe integer must have at least sixteen digits.
                    // False positives inside strings only use the exact fallback.
                    yield /\d{16,}/.test(line) ? parseExact(line) : header;
                  }
                } else yield parseExact(line);
              } catch (error) {
                if (
                  line.slice(0, 500).includes('"token_count"') ||
                  !options.allowLargeResponse
                )
                  throw new Error("用量记录 JSON 损坏");
              }
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
          if(options.codexUsageOnly&&length>=128&&chatOnly(chunks)){skipping=true;chunks=[];length=0;}
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
    stream.destroy?.();
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
