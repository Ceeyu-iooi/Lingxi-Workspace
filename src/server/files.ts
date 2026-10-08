import yauzl from "yauzl";
import yazl from "yazl";
export function parseCSV(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (quoted || !field) quoted = !quoted;
      else field += c;
    } else if (c === delimiter && !quoted) {
      row.push(field);
      field = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) throw new Error("CSV 引号没有闭合");
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
export const csvValue = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
};
export function decodeHTML(value: string) {
  return value.replace(
    /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi,
    (entity) => {
      const map: Record<string, string> = {
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&apos;": "'",
      };
      if (entity.toLowerCase() in map) return map[entity.toLowerCase()];
      const code = entity.toLowerCase().startsWith("&#x")
        ? parseInt(entity.slice(3, -1), 16)
        : parseInt(entity.slice(2, -1), 10);
      return code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity;
    },
  );
}
export const plainHTML = (value: string) =>
  decodeHTML(
    value
      .replace(/<(script|style|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<\/?(?:p|br|div|li|h[1-6])\b[^>]*>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  ).trim();
export function unzip(
  raw: Buffer,
  limit = 50 * 1024 * 1024,
  maxEntries = 1000,
): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      raw,
      { lazyEntries: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) {
          reject(new Error("压缩文件无法读取"));
          return;
        }
        const files = new Map<string, Buffer>();
        let total = 0,
          count = 0,
          ended = false;
        const fail = (error: Error) => {
          if (ended) return;
          ended = true;
          zip.close();
          reject(error);
        };
        zip.on("error", () => fail(new Error("压缩文件无法读取")));
        zip.on("entry", (entry) => {
          const name = entry.fileName.replaceAll("\\", "/");
          if (
            name.startsWith("/") ||
            /^[A-Za-z]:/.test(name) ||
            name.split("/").includes("..") ||
            name.includes("\0") ||
            ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
          ) {
            fail(new Error("压缩文件包含非法路径"));
            return;
          }
          total += entry.uncompressedSize;
          count++;
          if (total > limit || count > maxEntries) {
            fail(new Error("压缩文件过大"));
            return;
          }
          if (name.endsWith("/")) {
            zip.readEntry();
            return;
          }
          if (files.has(name)) {
            fail(new Error("压缩文件包含重复路径"));
            return;
          }
          zip.openReadStream(entry, (error, stream) => {
            if (error || !stream) {
              fail(new Error("压缩文件无法读取"));
              return;
            }
            const parts: Buffer[] = [];
            let size = 0;
            stream.on("data", (chunk) => {
              size += chunk.length;
              if (size > entry.uncompressedSize || size > limit) {
                stream.destroy();
                fail(new Error("压缩文件过大"));
              } else parts.push(chunk);
            });
            stream.on("error", () => fail(new Error("压缩文件无法读取")));
            stream.on("end", () => {
              if (ended) return;
              files.set(name, Buffer.concat(parts));
              zip.readEntry();
            });
          });
        });
        zip.on("end", () => {
          if (!ended) {
            ended = true;
            resolve(files);
          }
        });
        zip.readEntry();
      },
    );
  });
}
export function zipFiles(files: Map<string, string | Buffer>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile(),
      parts: Buffer[] = [];
    zip.outputStream.on("data", (chunk) => parts.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(parts)));
    for (const [name, value] of files)
      zip.addBuffer(Buffer.isBuffer(value) ? value : Buffer.from(value), name);
    zip.end();
  });
}
