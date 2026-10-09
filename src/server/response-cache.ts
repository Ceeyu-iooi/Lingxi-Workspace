import { encode, parseExact } from "./profile.ts";
export class ResponseCache {
  readonly budget = 8 * 1024 * 1024;
  bytes = 0;
  private items = new Map<string, { value: string; size: number }>();
  get(key: string) {
    const item = this.items.get(key);
    if (!item) return null;
    this.items.delete(key);
    this.items.set(key, item);
    return parseExact(item.value);
  }
  put(key: string, value: unknown) {
    const text = encode(value),
      size = Buffer.byteLength(text) + Buffer.byteLength(key),
      old = this.items.get(key);
    if (old) {
      this.items.delete(key);
      this.bytes -= old.size;
    }
    if (size > this.budget) return;
    this.items.set(key, { value: text, size });
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
