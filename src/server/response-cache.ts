import { encode, parseExact } from "./profile.ts";
import { deflateRawSync, inflateRawSync } from "node:zlib";
export class ResponseCache {
  readonly budget = 8 * 1024 * 1024;
  bytes = 0;
  private items = new Map<string, { value: Buffer; size: number; compressed: boolean; length: number }>();
  get(key: string) {
    const item = this.items.get(key);
    if (!item) return null;
    this.items.delete(key);
    this.items.set(key, item);
    const value = item.compressed
      ? inflateRawSync(item.value, { maxOutputLength: item.length })
      : item.value;
    return parseExact(value.toString("utf8"));
  }
  put(key: string, value: unknown) {
    const text = Buffer.from(encode(value), "utf8"),
      old = this.items.get(key);
    if (old) {
      this.items.delete(key);
      this.bytes -= old.size;
    }
    if (text.byteLength + key.length * 2 + 128 > this.budget) return;
    const packed = text.byteLength >= 4096 ? deflateRawSync(text, { level: 1 }) : text;
    const compressed = packed.byteLength < text.byteLength * 0.7;
    const payload = compressed ? packed : text;
    const size = payload.byteLength + key.length * 2 + 128;
    this.items.set(key, { value: payload, size, compressed, length: text.byteLength });
    this.bytes += size;
    while (this.bytes > this.budget) {
      const first = this.items.keys().next().value!;
      this.bytes -= this.items.get(first)!.size;
      this.items.delete(first);
    }
  }
  clear() {
    this.items.clear();
    this.bytes = 0;
  }
}
