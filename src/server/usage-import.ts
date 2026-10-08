import { parseCSV } from "./files.ts";
import { parseExact, type JsonObject } from "./profile.ts";

const ALIASES: Record<string, string[]> = {
  at: ["at", "timestamp", "created", "时间", "日期"],
  id: ["id", "request_id", "请求ID"],
  model: ["model", "模型", "模型名称"],
  requested_model: ["requested_model", "请求模型"],
  input: ["input", "input_tokens", "prompt_tokens", "输入Token"],
  output: ["output", "output_tokens", "completion_tokens", "输出Token"],
  cached: [
    "cached",
    "cached_input_tokens",
    "prompt_cache_hit_tokens",
    "缓存Token",
  ],
  reasoning: ["reasoning", "reasoning_tokens", "推理Token"],
  total: ["total", "total_tokens", "总Token"],
  cost: ["cost", "费用"],
  currency: ["currency", "币种"],
  provider: ["provider", "服务商"],
};
export function parseUsageFile(body: JsonObject) {
  if (
    typeof body.text !== "string" ||
    Buffer.byteLength(body.text) > 8 * 1024 * 1024
  )
    throw new Error("请选择不超过 8 MB 的用量文件");
  const text = body.text.replace(/^\uFEFF/, ""),
    kind = body.format || "json";
  let mapping: JsonObject = body.mapping || {},
    headers: string[] = [],
    rows: JsonObject[];
  if (
    !mapping ||
    typeof mapping !== "object" ||
    Array.isArray(mapping) ||
    Object.entries(mapping).some(
      ([k, v]) => !(k in ALIASES) || typeof v !== "string",
    )
  )
    throw new Error("字段映射格式不正确");
  if (kind === "csv") {
    const parsed = parseCSV(text);
    headers = parsed[0] || [];
    if (!headers.length || new Set(headers).size !== headers.length)
      throw new Error("CSV 需要不重复的标题行");
    mapping = Object.fromEntries(
      Object.entries(ALIASES).map(([key, aliases]) => [
        key,
        mapping[key] || aliases.find((a) => headers.includes(a)) || "",
      ]),
    );
    if (
      !mapping.at ||
      !mapping.model ||
      !(mapping.total || (mapping.input && mapping.output))
    )
      return { records: null, headers, mapping, needsMapping: true };
    rows = [];
    for (const [index, raw] of parsed.slice(1).entries()) {
      if (!raw.some(Boolean)) continue;
      if (rows.length >= 10000) throw new Error("一次最多导入 10000 条记录");
      if (raw.length > headers.length)
        throw new Error("CSV 第 " + (index + 2) + " 行字段数量不正确");
      const values = Object.fromEntries(
          headers.map((key, i) => [key, raw[i] || ""]),
        ),
        row: JsonObject = Object.fromEntries(
          Object.entries(mapping)
            .filter(([, column]) => column)
            .map(([key, column]) => [
              key,
              String(values[column as string] || "").trim(),
            ]),
        );
      for (const key of ["input", "output", "cached", "reasoning", "total"])
        if (key in row) {
          if (!row[key]) {
            delete row[key];
            continue;
          }
          if (!/^[+-]?\d+$/.test(row[key]))
            throw new Error(
              "CSV 第 " + (index + 2) + " 行 " + key + " 必须是整数",
            );
          const n = BigInt(row[key]);
          row[key] =
            n <= BigInt(Number.MAX_SAFE_INTEGER) &&
            n >= BigInt(Number.MIN_SAFE_INTEGER)
              ? Number(n)
              : n;
        }
      if (row.cost) {
        row.cost = Number(row.cost);
        if (!Number.isFinite(row.cost)) throw new Error("CSV 费用必须是数字");
      } else delete row.cost;
      if (!row.at || !row.model)
        throw new Error("CSV 第 " + (index + 2) + " 行缺少时间或模型");
      if (!/([zZ]|[+-]\d{2}:?\d{2})$/.test(row.at)) row.at += "+08:00";
      if (Number.isNaN(Date.parse(row.at)))
        throw new Error("CSV 第 " + (index + 2) + " 行时间格式不正确");
      if (!row.id) delete row.id;
      if (!row.currency) row.currency = "CNY";
      rows.push(row);
    }
  } else {
    try {
      if (kind === "jsonl")
        rows = text
          .split(/\r?\n/)
          .filter((s) => s.trim())
          .map(parseExact);
      else if (kind === "json") {
        const value = parseExact(text);
        rows = Array.isArray(value) ? value : value?.records || [value];
      } else throw new Error("请使用 JSON、JSONL 或 CSV 文件");
    } catch (error: any) {
      throw new Error(
        error.message === "请使用 JSON、JSONL 或 CSV 文件"
          ? error.message
          : "用量文件不是有效的 JSON / JSONL",
      );
    }
  }
  if (
    !Array.isArray(rows) ||
    rows.length > 10000 ||
    rows.some((r) => !r || typeof r !== "object" || Array.isArray(r))
  )
    throw new Error("文件需包含最多 10000 条对象记录");
  return { records: rows, headers, mapping, needsMapping: false };
}
