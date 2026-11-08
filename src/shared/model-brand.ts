/**
 * Provider/model brand identity for the usage surfaces.
 *
 * The taskbar panel and the main app both need to answer the same two questions:
 *   - which colour dot belongs in front of a model name (screenshot 3), and
 *   - which family logo belongs next to a model row (screenshot 7).
 *
 * Keeping the classification here means the two surfaces cannot drift. The function is
 * deliberately total: an unknown provider still gets a stable, distinct colour derived
 * from the family key instead of a grey "unknown" swatch.
 */

export type BrandFamily =
  | "openai"
  | "deepseek"
  | "zhipu"
  | "anthropic"
  | "google"
  | "qwen"
  | "moonshot"
  | "minimax"
  | "meta"
  | "mistral"
  | "xai"
  | "other";

export interface BrandDescriptor {
  /** Classification key; stable, so colours never move between releases. */
  family: BrandFamily;
  /** Human label shown in tooltips and legends. */
  label: string;
  /** Dot colour. Chosen to stay distinguishable on both light and dark panels. */
  color: string;
  /** Second stop for the gradient dot; equals `color` when the brand is flat. */
  colorStrong: string;
  /** Logo asset key resolved by the caller (`logo:<key>` draws an inline glyph). */
  logo: string;
  /** Initial letter used when no glyph exists. */
  monogram: string;
}

const FAMILIES: Record<BrandFamily, Omit<BrandDescriptor, "family">> = {
  openai: { label: "OpenAI", color: "#10a37f", colorStrong: "#0b7a5e", logo: "openai", monogram: "O" },
  deepseek: { label: "DeepSeek", color: "#4d6bfe", colorStrong: "#2f4bd8", logo: "deepseek", monogram: "D" },
  zhipu: { label: "智谱 GLM", color: "#2f7cf6", colorStrong: "#1a5fd0", logo: "zhipu", monogram: "G" },
  anthropic: { label: "Anthropic", color: "#d97757", colorStrong: "#b8563a", logo: "anthropic", monogram: "A" },
  google: { label: "Google", color: "#4285f4", colorStrong: "#1a73e8", logo: "google", monogram: "G" },
  qwen: { label: "通义千问", color: "#615ced", colorStrong: "#463fd0", logo: "qwen", monogram: "Q" },
  moonshot: { label: "月之暗面", color: "#8b5cf6", colorStrong: "#6d3fd8", logo: "moonshot", monogram: "K" },
  minimax: { label: "MiniMax", color: "#f2a13b", colorStrong: "#d4811c", logo: "minimax", monogram: "M" },
  meta: { label: "Meta", color: "#0866ff", colorStrong: "#0049c6", logo: "meta", monogram: "M" },
  mistral: { label: "Mistral", color: "#ff7000", colorStrong: "#d65b00", logo: "mistral", monogram: "M" },
  xai: { label: "xAI", color: "#111827", colorStrong: "#374151", logo: "xai", monogram: "X" },
  other: { label: "其他供应商", color: "#64748b", colorStrong: "#475569", logo: "generic", monogram: "•" },
};

/** Provider id → family. Matched case-insensitively on the start of the provider id. */
const PROVIDERS: [RegExp, BrandFamily][] = [
  [/^(openai|azure|azure-openai|openai-azure|oai)\b/, "openai"],
  [/^(deepseek|ds)\b/, "deepseek"],
  [/^(zhipu|zhipuai|bigmodel|glm|z-ai|zai)\b/, "zhipu"],
  [/^(anthropic|claude)\b/, "anthropic"],
  [/^(google|gemini|vertex|vertexai)\b/, "google"],
  [/^(dashscope|qwen|alibaba|aliyun|tongyi)\b/, "qwen"],
  [/^(moonshot|kimi)\b/, "moonshot"],
  [/^(minimax|abab|hailuo)\b/, "minimax"],
  [/^(meta|llama|groq-meta)\b/, "meta"],
  [/^(mistral|mixtral|codestral)\b/, "mistral"],
  [/^(xai|x-ai|grok)\b/, "xai"],
];

/** Fallbacks when the provider is missing or uninformative: classify by model name. */
const MODEL_HINTS: [RegExp, BrandFamily][] = [
  [/(?:^|[/:\s_-])(gpt|o[1-9]|chatgpt|codex|davinci|whisper|dall-e)(?:[-_.\s]|\d|$)/i, "openai"],
  [/(?:^|[/:\s_-])deepseek(?:[-_.\s]|$)/i, "deepseek"],
  [/(?:^|[/:\s_-])(glm|chatglm)(?:[-_.\s]|\d|$)/i, "zhipu"],
  [/(?:^|[/:\s_-])claude(?:[-_.\s]|\d|$)/i, "anthropic"],
  [/(?:^|[/:\s_-])(gemini|palm|bison)(?:[-_.\s]|\d|$)/i, "google"],
  [/(?:^|[/:\s_-])(qwen|qwq|qwen2|tongyi)(?:[-_.\s]|\d|$)/i, "qwen"],
  [/(?:^|[/:\s_-])(kimi|moonshot|kimik)(?:[-_.\s]|\d|$)/i, "moonshot"],
  [/(?:^|[/:\s_-])(minimax|abab|hailuo)(?:[-_.\s]|\d|$)/i, "minimax"],
  [/(?:^|[/:\s_-])(llama|llama-?[234])(?:[-_.\s]|\d|$)/i, "meta"],
  [/(?:^|[/:\s_-])(mistral|mixtral|codestral|devstral)(?:[-_.\s]|\d|$)/i, "mistral"],
  [/(?:^|[/:\s_-])grok(?:[-_.\s]|\d|$)/i, "xai"],
];

/** Small stable hash so two unknown providers do not share one indistinguishable dot. */
function hashHue(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

const brandCache = new Map<string, BrandDescriptor>();

/** Resolve the brand descriptor for a provider/model pair. Pure and memoized. */
export function modelBrand(provider: unknown, model: unknown): BrandDescriptor {
  const p = String(provider ?? "")
    .trim()
    .toLowerCase();
  const m = String(model ?? "").trim();
  const key = p + "\u0000" + m;
  const cached = brandCache.get(key);
  if (cached) return cached;
  let family: BrandFamily = "other";
  for (const [pattern, id] of MODEL_HINTS) {
    if (pattern.test(m)) { family = id; break; }
  }
  if (family === "other") {
    for (const [pattern, id] of PROVIDERS) {
      if (pattern.test(p)) { family = id; break; }
    }
  }
  let descriptor: BrandDescriptor;
  if (family === "other") {
    // Unknown but still distinct: keep one stable hue per provider id.
    const seed = p || m || "other";
    const hue = hashHue(seed);
    descriptor = {
      family,
      label: seed === "other" ? "其他供应商" : seed.slice(0, 24),
      color: `hsl(${hue} 62% 52%)`,
      colorStrong: `hsl(${hue} 66% 42%)`,
      logo: "generic",
      monogram: (seed[0] || "•").toUpperCase(),
    };
  } else descriptor = { family, ...FAMILIES[family] };
  if (brandCache.size > 512) brandCache.clear();
  brandCache.set(key, descriptor);
  return descriptor;
}

/** Convenience for chart legends that only carry a joined "provider/model" label. */
export function brandFromLabel(label: unknown): BrandDescriptor {
  const text = String(label ?? "");
  const [head, ...rest] = text.split(/[/:]/);
  return rest.length ? modelBrand(head, rest.join("/")) : modelBrand("", text);
}

export const BRAND_FAMILIES = Object.keys(FAMILIES) as BrandFamily[];
