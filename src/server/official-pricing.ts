import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { encode, type JsonObject } from './profile.ts';
import type { PriceSnapshot } from './price-source.ts';

/**
 * Official price sources.
 *
 * Every rate that reaches a user-visible amount must come from the vendor's own
 * published page. Community mirrors (Portkey versioned registry, CloudPrice
 * current catalogue) are kept only as *hidden* corroboration: they are still
 * collected as evidence so a later mismatch can be detected, but they never
 * price usage, never appear in the price dialog and never stand in for a missing
 * official rate. `estimated` and `unknown` are the only honest answers for a gap.
 *
 * Volatility, not laziness, decides whether a vendor can be valued at all:
 * - `official_table`: the vendor publishes a stable per-token table we transcribe.
 * - `official_alias`: a deprecated model id the vendor documents as routing to a
 *   current model, so the current table applies.
 * - `official_page`: the vendor has an official pricing page, but it is
 *   JavaScript-rendered and cannot be read or quoted without inventing numbers.
 *   The model is registered so the UI can link the authority, and its price stays
 *   `unknown`. A wrong price is worse than a missing one.
 * - `official_usage_units`: billed per call, not per token (search/fetch), so it
 *   can be located but not converted into a token estimate.
 */

export const OFFICIAL_POLICY = 'official-price-table-v2';

export type OfficialSource = {
  vendor: string;
  /** The page a user is sent to. */
  url: string;
  /** A plain-text variant of the same page, when the site publishes one. */
  alternateUrl: string | null;
  /** When the numbers were read off this page. */
  fetchedAt: string;
  /** Digest of the text we transcribed, or null when only a link is registered. */
  sha256: string | null;
  /** Tables we transcribe are `official_table`; a link-only page is `official_page`. */
  kind: 'official_table' | 'official_page';
  /** Which click path on the page the table sits under. */
  section: string;
  /** What the page states, quoted narrowly enough to be checkable. */
  quote: string;
  /**
   * True when the page publishes a Standard tier only, with the same price below
   * and above the vendor's long-context threshold.
   */
  flatStandard?: boolean;
};

export type PeakWindow = { days: 'mon-fri'; from: string; to: string };

export type OfficialRate = {
  /** Identity used in every snapshot and every proof. */
  model: string;
  id: string;
  sourceType: 'official';
  provider: string;
  modelName: string;
  currency: string;
  sourceUrl: string;
  /** `official_table` = transcribed, `official_alias` = documented routing to a table. */
  basis: 'official_table' | 'official_alias';
  /** Alias notes from the vendor change log; the rate still comes from `sourceUrl`. */
  alias: { routing: string; note: string; url: string } | null;
  /**
   * Historical effective dates. Our stored snapshots only start when the current
   * table took effect; weeks before it were billed under an earlier table and
   * must be estimated from the nearest official rate, then labelled.
   */
  history: { currentEffective: string; start: string };
  pricingNotes: string;
  peak: {
    timezone: 'Asia/Shanghai';
    windows: PeakWindow[];
    /** Local public holidays are off-peak too (stated by the vendor page). */
    holidays: 'off-peak';
    /** Peak price is the table price; off-peak is the vendor-stated fraction. */
    offPeakFraction: string;
  };
  quote: { peak: Record<string, string | null>; offPeak: Record<string, string | null> };
};

export type OfficialLink = {
  model: string;
  id: string;
  provider: string;
  modelName: string;
  currency: string | null;
  sourceUrl: string;
  sourceType: 'official';
  basis: 'official_page' | 'official_usage_units';
  /** Never a number: the page is authoritative but not machine-readable. */
  unknown: true;
  detail: string;
};

export const OFFICIAL_SOURCES: Record<string, OfficialSource> = {
  deepseekPricing: {
    vendor: 'DeepSeek',
    url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
    alternateUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    fetchedAt: '2026-11-07T06:39:00Z',
    sha256: '6205cf5d53a7903827bf21938eefb6a8ab6041bb5a73fcf43e4bdd6adc8d344b',
    kind: 'official_table',
    section: '页面「模型 & 价格」表，单位：元/百万 token',
    quote:
      '单位：元/百万 token。空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。',
  },
  deepseekUpdates: {
    vendor: 'DeepSeek',
    url: 'https://api-docs.deepseek.com/zh-cn/updates/',
    alternateUrl: 'https://api-docs.deepseek.com/updates',
    fetchedAt: '2026-11-07T06:39:00Z',
    sha256: null,
    kind: 'official_page',
    section: '更新日志',
    quote:
      '2026-08-13：采用峰谷定价，闲时价格为高峰时段价格的一半，新价格于北京时间 2026 年 8 月 17 日 0 时生效。2026-09-10：DeepSeek-V4.1-Flash 上线，API 价格同步下调（具体价格见模型与价格页）。2026-10-17：V4.1-Flash-1017 发布，API 调用方式与价格保持不变。2026-04-24：deepseek-chat / deepseek-reasoner 分别指向 deepseek-v4-flash 的非思考与思考模式，2026-07-24 停止使用。',
  },
  zhipuPricing: {
    vendor: '智谱',
    url: 'https://docs.bigmodel.cn/cn/guide/start/pricing',
    alternateUrl: 'https://docs.bigmodel.cn/cn/guide/start/pricing.md',
    fetchedAt: '2026-11-07T08:31:00Z',
    sha256: 'c8b4d888027337ff73a24f58ebd25a6eea966155351214e164fcc640b34fca4f',
    kind: 'official_table',
    section: '「最新模型」与「模型推理 · 文本模型（更多文本模型）」表，单位：元/百万 Tokens；缓存存储当前限时免费，故不单列',
    quote:
      '除特别说明外，模型价格统一按照「元/百万 Tokens」展示。调用费用 = 未命中缓存的输入费用 + 缓存命中费用 + 输出费用 + 缓存存储费用。',
  },
  openaiPricing: {
    vendor: 'OpenAI',
    url: 'https://platform.openai.com/docs/pricing',
    alternateUrl: 'https://platform.openai.com/docs/pricing.md',
    fetchedAt: '2026-11-07T08:32:00Z',
    sha256: 'f1ade44afc62fd8a12dd6e199bcecaa989a94c9b691aa620a34e1504ff62ff57',
    kind: 'official_table',
    section:
      '「Flagship models · Standard pricing data」表，单位：美元/百万 tokens；只取 Short context 列，Long context 列不参与计价（见 pricingNotes）',
    quote:
      'Prices per 1M tokens. Standard pricing data. 列为 Short context input / output / cached input / 30m write / 12h write 与 Long context 同名列。',
    flatStandard: true,
  },
  anthropicPricing: {
    vendor: 'Anthropic',
    url: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
    alternateUrl: null,
    fetchedAt: '2026-11-07T06:39:00Z',
    sha256: null,
    kind: 'official_page',
    section: '官方定价页',
    quote: '官方定价页按模型列出输入、输出与提示缓存价格；本机未能取得可逐行核验的表格文本。',
  },
  googlePricing: {
    vendor: 'Google',
    url: 'https://ai.google.dev/gemini-api/docs/pricing',
    alternateUrl: null,
    fetchedAt: '2026-11-07T06:39:00Z',
    sha256: null,
    kind: 'official_page',
    section: '官方定价页',
    quote: '官方定价页；本机未能取得可逐行核验的表格文本。',
  },
  qwenPricing: {
    vendor: '阿里云百炼',
    url: 'https://help.aliyun.com/zh/model-studio/models',
    alternateUrl: null,
    fetchedAt: '2026-11-07T06:39:00Z',
    sha256: null,
    kind: 'official_page',
    section: '官方模型与计费页',
    quote: '官方模型与计费页；本机未能取得可逐行核验的表格文本。',
  },
  moonshotPricing: {
    vendor: 'Moonshot',
    url: 'https://platform.kimi.com/docs/pricing/chat',
    alternateUrl: null,
    fetchedAt: '2026-11-07T06:39:00Z',
    sha256: null,
    kind: 'official_page',
    section: '官方模型推理价格说明',
    quote: '官方模型推理价格说明；页面声明“表格中的价格代表每消耗 1 MTok 的价格”，但价格表由脚本渲染，正文未包含数值。',
  },
  minimaxPricing: {
    vendor: 'MiniMax',
    url: 'https://www.minimax.io/price',
    alternateUrl: null,
    fetchedAt: '2026-11-07T06:39:00Z',
    sha256: null,
    kind: 'official_page',
    section: '官方定价页',
    quote: '官方定价页；本机未能取得可逐行核验的表格文本。',
  },
};

/** Vendors whose price is billed per call instead of per token. */
export const OFFICIAL_CALL_RATES: Record<
  string,
  { source: keyof typeof OFFICIAL_SOURCES; amount: string; unit: string; billableFrom: string }
> = {
  search: {
    source: 'deepseekPricing',
    amount: '5',
    unit: '元/千次',
    billableFrom: '2026-11-01T00:00:00+08:00',
  },
  fetch: {
    source: 'deepseekPricing',
    amount: '5',
    unit: '元/千次',
    billableFrom: '2026-11-01T00:00:00+08:00',
  },
};

const DEEPSEEK_PEAK: OfficialRate['peak'] = {
  timezone: 'Asia/Shanghai',
  windows: [
    { days: 'mon-fri', from: '09:00', to: '12:00' },
    { days: 'mon-fri', from: '14:00', to: '18:00' },
  ],
  holidays: 'off-peak',
  offPeakFraction: '0.5',
};

const FLASH_PEAK_QUOTE = { input: '2', output: '8', cached: '0.04', write: null };
const FLASH_OFFPEAK_QUOTE = { input: '1', output: '4', cached: '0.02', write: null };

/**
 * A vendor with one price for the whole day: the same quote is the peak and the
 * off-peak quote, so the day/time split of the DeepSeek table never mis-applies.
 */
const FLAT_PEAK: OfficialRate['peak'] = {
  timezone: 'Asia/Shanghai',
  windows: [],
  holidays: 'off-peak',
  offPeakFraction: '1',
};

function flat(
  provider: string,
  modelName: string,
  currency: string,
  sourceUrl: string,
  quote: Record<string, string | null>,
  pricingNotes: string,
  history: OfficialRate['history'],
  options: { id?: string; model?: string } = {},
): OfficialRate {
  return {
    model: options.model || provider + '/' + modelName,
    id: options.id || provider.toLowerCase() + '/' + modelName.toLowerCase(),
    sourceType: 'official',
    provider,
    modelName,
    currency,
    sourceUrl,
    basis: 'official_table',
    alias: null,
    history,
    pricingNotes,
    peak: FLAT_PEAK,
    quote: { peak: { ...quote }, offPeak: { ...quote } },
  };
}

const DEEPSEEK_TABLE = OFFICIAL_SOURCES.deepseekPricing.url,
  DEEPSEEK_LOG = OFFICIAL_SOURCES.deepseekUpdates.url,
  ZHIPU_TABLE = OFFICIAL_SOURCES.zhipuPricing.url,
  OPENAI_TABLE = OFFICIAL_SOURCES.openaiPricing.url;

/**
 * Rates transcribed from the vendor's own page. Prices are per 1M tokens in the
 * vendor's currency; `null` means the vendor does not price that component
 * separately (cache write is charged as ordinary input, or the column reads "-").
 *
 * Every entry records where it came from and when it was read. A model with no
 * transcribed row is not priced at all — see OFFICIAL_LINKS.
 */
export const OFFICIAL_RATES: OfficialRate[] = [
  // ---- DeepSeek：峰谷两档，CNY/百万 token，转录自定价页（2026-11-07）
  {
    model: 'DeepSeek/deepseek-flash',
    id: 'deepseek/deepseek-flash',
    sourceType: 'official',
    provider: 'deepseek',
    modelName: 'deepseek-flash',
    currency: 'CNY',
    sourceUrl: DEEPSEEK_TABLE,
    basis: 'official_table',
    alias: null,
    history: { currentEffective: '2026-09-10', start: '2026-08-17' },
    pricingNotes:
      'deepseek-flash（DeepSeek-V4.1-Flash）官方峰谷价，转录自定价页「模型 & 价格」表（2026-11-07 读取）；2026-10-17 发布 1017 版本，官方说明价格不变。',
    peak: DEEPSEEK_PEAK,
    quote: { peak: FLASH_PEAK_QUOTE, offPeak: FLASH_OFFPEAK_QUOTE },
  },
  {
    model: 'DeepSeek/deepseek-v4-pro',
    id: 'deepseek/deepseek-v4-pro',
    sourceType: 'official',
    provider: 'deepseek',
    modelName: 'deepseek-v4-pro',
    currency: 'CNY',
    sourceUrl: DEEPSEEK_TABLE,
    basis: 'official_table',
    alias: null,
    history: { currentEffective: '2026-09-10', start: '2026-08-17' },
    pricingNotes: 'deepseek-v4-pro 官方峰谷价，转录自定价页「模型 & 价格」表（2026-11-07 读取）。',
    peak: DEEPSEEK_PEAK,
    quote: {
      peak: { input: '9', output: '27', cached: '0.3', write: null },
      offPeak: { input: '4.5', output: '13.5', cached: '0.15', write: null },
    },
  },
  {
    model: 'DeepSeek/deepseek-v4-flash',
    id: 'deepseek/deepseek-v4-flash',
    sourceType: 'official',
    provider: 'deepseek',
    modelName: 'deepseek-v4-flash',
    currency: 'CNY',
    sourceUrl: DEEPSEEK_TABLE,
    basis: 'official_alias',
    alias: {
      routing: 'deepseek/deepseek-flash',
      note: '2026-09-10：旧版本模型 V4 Flash 已下线，出于兼容考虑，模型名 deepseek-v4-flash 将被暂时路由到 V4.1 Flash。',
      url: DEEPSEEK_LOG,
    },
    history: { currentEffective: '2026-09-10', start: '2026-08-17' },
    pricingNotes: '原 deepseek-v4-flash 名称按官方说明路由到 deepseek-flash，取同一官方峰谷价。',
    peak: DEEPSEEK_PEAK,
    quote: { peak: FLASH_PEAK_QUOTE, offPeak: FLASH_OFFPEAK_QUOTE },
  },
  {
    model: 'DeepSeek/deepseek-v4-flash-vision-exp',
    id: 'deepseek/deepseek-v4-flash-vision-exp',
    sourceType: 'official',
    provider: 'deepseek',
    modelName: 'deepseek-v4-flash-vision-exp',
    currency: 'CNY',
    sourceUrl: DEEPSEEK_TABLE,
    basis: 'official_alias',
    alias: {
      routing: 'deepseek/deepseek-flash',
      note: '2026-09-10：旧版本模型 V4 Flash Vision Exp 已下线，出于兼容考虑，模型名 deepseek-v4-flash-vision-exp 将被暂时路由到 V4.1 Flash。',
      url: DEEPSEEK_LOG,
    },
    history: { currentEffective: '2026-09-10', start: '2026-08-17' },
    pricingNotes: '原 deepseek-v4-flash-vision-exp 名称按官方说明路由到 deepseek-flash，取同一官方峰谷价。',
    peak: DEEPSEEK_PEAK,
    quote: { peak: FLASH_PEAK_QUOTE, offPeak: FLASH_OFFPEAK_QUOTE },
  },
  {
    model: 'DeepSeek/deepseek-chat',
    id: 'deepseek/deepseek-chat',
    sourceType: 'official',
    provider: 'deepseek',
    modelName: 'deepseek-chat',
    currency: 'CNY',
    sourceUrl: DEEPSEEK_TABLE,
    basis: 'official_alias',
    alias: {
      routing: 'deepseek/deepseek-v4-flash',
      note: '2026-04-24：deepseek-chat 为非思考模式，指向 deepseek-v4-flash，2026-07-24 停止使用。',
      url: DEEPSEEK_LOG,
    },
    history: { currentEffective: '2026-08-17', start: '2026-08-17' },
    pricingNotes: 'deepseek-chat 官方说明指向 deepseek-v4-flash（再路由到 V4.1 Flash），取同一官方峰谷价。',
    peak: DEEPSEEK_PEAK,
    quote: { peak: FLASH_PEAK_QUOTE, offPeak: FLASH_OFFPEAK_QUOTE },
  },
  {
    model: 'DeepSeek/deepseek-reasoner',
    id: 'deepseek/deepseek-reasoner',
    sourceType: 'official',
    provider: 'deepseek',
    modelName: 'deepseek-reasoner',
    currency: 'CNY',
    sourceUrl: DEEPSEEK_TABLE,
    basis: 'official_alias',
    alias: {
      routing: 'deepseek/deepseek-v4-flash',
      note: '2026-04-24：deepseek-reasoner 为思考模式，指向 deepseek-v4-flash，2026-07-24 停止使用。',
      url: DEEPSEEK_LOG,
    },
    history: { currentEffective: '2026-08-17', start: '2026-08-17' },
    pricingNotes: 'deepseek-reasoner 官方说明指向 deepseek-v4-flash（再路由到 V4.1 Flash），取同一官方峰谷价。',
    peak: DEEPSEEK_PEAK,
    quote: { peak: FLASH_PEAK_QUOTE, offPeak: FLASH_OFFPEAK_QUOTE },
  },
  // 2026-11-07 起，日志里的新名字：官方更新日志说明 V4.1-Flash 及 1017 版本价格与现行表一致。
  {
    model: 'DeepSeek/deepseek-v4.1-flash',
    id: 'deepseek/deepseek-v4.1-flash',
    sourceType: 'official',
    provider: 'deepseek',
    modelName: 'deepseek-v4.1-flash',
    currency: 'CNY',
    sourceUrl: DEEPSEEK_TABLE,
    basis: 'official_alias',
    alias: {
      routing: 'deepseek/deepseek-flash',
      note: '2026-09-10：DeepSeek-V4.1-Flash 上线（API 价格同步下调，定价页现行表即为该版本价格）；2026-10-17：V4.1-Flash-1017 发布，API 调用方式与价格保持不变。',
      url: DEEPSEEK_LOG,
    },
    history: { currentEffective: '2026-09-10', start: '2026-08-17' },
    pricingNotes:
      'deepseek-v4.1-flash 是定价页表头模型 DeepSeek-V4.1-Flash 的日志名，直接对应现行官方表（2026-11-07 读取）；1017 版本官方声明价格不变。',
    peak: DEEPSEEK_PEAK,
    quote: { peak: FLASH_PEAK_QUOTE, offPeak: FLASH_OFFPEAK_QUOTE },
  },
  {
    model: 'DeepSeek/deepseek-v4.1-flash-1017',
    id: 'deepseek/deepseek-v4.1-flash-1017',
    sourceType: 'official',
    provider: 'deepseek',
    modelName: 'deepseek-v4.1-flash-1017',
    currency: 'CNY',
    sourceUrl: DEEPSEEK_TABLE,
    basis: 'official_alias',
    alias: {
      routing: 'deepseek/deepseek-v4.1-flash',
      note: '2026-10-17：V4.1-Flash-1017 发布，API 调用方式与价格保持不变。',
      url: DEEPSEEK_LOG,
    },
    history: { currentEffective: '2026-10-17', start: '2026-08-17' },
    pricingNotes: 'DeepSeek-V4.1-Flash-1017 官方更新日志声明价格不变，取 V4.1-Flash 同一官方价。',
    peak: DEEPSEEK_PEAK,
    quote: { peak: FLASH_PEAK_QUOTE, offPeak: FLASH_OFFPEAK_QUOTE },
  },

  // ---- 智谱 GLM：CNY/百万 Tokens，转录自官方文档「API 定价」（2026-11-07）
  flat(
    'Zhipu',
    'glm-5.3',
    'CNY',
    ZHIPU_TABLE,
    { input: '8', output: '28', cached: '2', write: null },
    'GLM-5.3「最新模型」表：输入 8、输出 28、缓存命中 2 元/百万 Tokens；缓存存储当前限时免费，未单列。',
    { currentEffective: '2026-08-01', start: '2026-08-01' },
  ),
  flat(
    'Zhipu',
    'glm-5.3-flash',
    'CNY',
    ZHIPU_TABLE,
    { input: '0.8', output: '2.8', cached: '0.23', write: null },
    'GLM-5.3-Flash「最新模型」表：输入 0.8、输出 2.8、缓存命中 0.23 元/百万 Tokens；缓存存储当前限时免费，未单列。',
    { currentEffective: '2026-08-01', start: '2026-08-01' },
  ),
  flat(
    'Zhipu',
    'glm-4.7',
    'CNY',
    ZHIPU_TABLE,
    { input: '2', output: '8', cached: '0.4', write: null },
    'GLM-4.7 按输入长度与输出长度分三档：本行取最低档（输入<32K、输出<0.2K）=输入 2、输出 8、缓存命中 0.4；更长上下文按官方表另档计费，本表未建模。',
    { currentEffective: '2026-03-01', start: '2026-03-01' },
  ),

  // ---- OpenAI：USD/百万 tokens，转录自官方文档「Pricing · Standard pricing data」（2026-11-07）
  //   Short context 列；cached input 为官方单列价；write 取 30 分钟缓存写入列。
  flat(
    'OpenAI',
    'gpt-6.1-sol',
    'USD',
    OPENAI_TABLE,
    { input: '2', output: '10', cached: '0.1', write: '2.5' },
    'gpt-6.1-sol Standard：Short context input $2、output $10、cached input $0.10、30m write $2.50（/1M tokens）。Long context（>272K）列存在且更贵，本表未建模，长上下文事件会低估。',
    { currentEffective: '2026-09-01', start: '2026-09-01' },
  ),
  flat(
    'OpenAI',
    'gpt-6.1-luna',
    'USD',
    OPENAI_TABLE,
    { input: '1', output: '5', cached: '0.05', write: '1.25' },
    'gpt-6.1-luna Standard：Short context input $1、output $5、cached input $0.05、30m write $1.25（/1M tokens）；Long context 列未建模。',
    { currentEffective: '2026-09-01', start: '2026-09-01' },
  ),
  flat(
    'OpenAI',
    'gpt-6.1-terra',
    'USD',
    OPENAI_TABLE,
    { input: '1', output: '5', cached: '0.05', write: '1.25' },
    'gpt-6.1-terra Standard：Short context input $1、output $5、cached input $0.05、30m write $1.25（/1M tokens）；Long context 列未建模。',
    { currentEffective: '2026-09-01', start: '2026-09-01' },
  ),
  flat(
    'OpenAI',
    'gpt-6-sol',
    'USD',
    OPENAI_TABLE,
    { input: '2', output: '10', cached: '0.2', write: '2.5' },
    'gpt-6-sol Standard：Short context input $2、output $10、cached input $0.20、30m write $2.50（/1M tokens）；Long context 列未建模。',
    { currentEffective: '2026-07-01', start: '2026-07-01' },
  ),
  flat(
    'OpenAI',
    'gpt-6-luna',
    'USD',
    OPENAI_TABLE,
    { input: '0.1', output: '0.5', cached: '0.01', write: '0.125' },
    'gpt-6-luna Standard：Short context input $0.10、output $0.50、cached input $0.01、30m write $0.125（/1M tokens）；Long context 列未建模。',
    { currentEffective: '2026-07-01', start: '2026-07-01' },
  ),
  flat(
    'OpenAI',
    'gpt-6-astra',
    'USD',
    OPENAI_TABLE,
    { input: '10', output: '50', cached: '1', write: '12.5' },
    'gpt-6-astra Standard：Short context input $10、output $50、cached input $1.00、30m write $12.50（/1M tokens）；Long context 列未建模。',
    { currentEffective: '2026-07-01', start: '2026-07-01' },
  ),
  flat(
    'OpenAI',
    'gpt-5.6-sol',
    'USD',
    OPENAI_TABLE,
    { input: '4', output: '20', cached: '0.4', write: '5' },
    'gpt-5.6-sol Standard：Short context input $4、output $20、cached input $0.40、30m write $5.00（/1M tokens）；Long context 列未建模。',
    { currentEffective: '2026-05-01', start: '2026-05-01' },
  ),
  flat(
    'OpenAI',
    'gpt-5.6-luna',
    'USD',
    OPENAI_TABLE,
    { input: '0.2', output: '1.2', cached: '0.02', write: '0.25' },
    'gpt-5.6-luna Standard：Short context input $0.20、output $1.20、cached input $0.02、30m write $0.25（/1M tokens）；Long context 列未建模。',
    { currentEffective: '2026-05-01', start: '2026-05-01' },
  ),
  flat(
    'OpenAI',
    'gpt-5.6-terra',
    'USD',
    OPENAI_TABLE,
    { input: '2', output: '12', cached: '0.2', write: '2.5' },
    'gpt-5.6-terra Standard：Short context input $2、output $12、cached input $0.20、30m write $2.50（/1M tokens）；Long context 列未建模。',
    { currentEffective: '2026-05-01', start: '2026-05-01' },
  ),
];

/**
 * Vendors with an official page we can cite but not quote as a table. They are
 * listed so the dialog can show the authority behind a model and so nobody
 * mistakes the community mirror for the source of truth.
 */
const OFFICIAL_LINKS: OfficialLink[] = [
  ...['claude-opus-4-8', 'claude-sonnet-4-8', 'claude-haiku-4-8', 'claude-opus-4-7', 'claude-sonnet-4-7', 'claude-fable-5'].map(
    (model): OfficialLink => ({
      model: 'Anthropic/' + model,
      id: 'anthropic/' + model,
      provider: 'anthropic',
      modelName: model,
      currency: 'USD',
      sourceUrl: OFFICIAL_SOURCES.anthropicPricing.url,
      sourceType: 'official',
      basis: 'official_page',
      unknown: true,
      detail: '官方定价页已登记，但表格未能取得可核验文本，价格保持未知。',
    }),
  ),
  ...['gemini-3-pro', 'gemini-3-flash', 'gemini-2.5-pro', 'gemini-2.5-flash'].map(
    (model): OfficialLink => ({
      model: 'Google/' + model,
      id: 'google/' + model,
      provider: 'google',
      modelName: model,
      currency: 'USD',
      sourceUrl: OFFICIAL_SOURCES.googlePricing.url,
      sourceType: 'official',
      basis: 'official_page',
      unknown: true,
      detail: '官方定价页已登记，但表格未能取得可核验文本，价格保持未知。',
    }),
  ),
  ...['qwen3-max', 'qwen3-plus', 'qwen-max', 'qwen-plus', 'qwen-long'].map(
    (model): OfficialLink => ({
      model: 'DashScope/' + model,
      id: 'dashscope/' + model,
      provider: 'dashscope',
      modelName: model,
      currency: 'CNY',
      sourceUrl: OFFICIAL_SOURCES.qwenPricing.url,
      sourceType: 'official',
      basis: 'official_page',
      unknown: true,
      detail: '官方模型与计费页已登记，但未能取得可核验的表格文本，价格保持未知。',
    }),
  ),
  ...['kimi-k3.1-pro', 'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'].map(
    (model): OfficialLink => ({
      model: 'Moonshot/' + model,
      id: 'moonshot/' + model,
      provider: 'moonshot',
      modelName: model,
      currency: 'CNY',
      sourceUrl: OFFICIAL_SOURCES.moonshotPricing.url,
      sourceType: 'official',
      basis: 'official_page',
      unknown: true,
      detail: '官方价格说明已登记，但价格表由脚本渲染、正文无数值，价格保持未知。',
    }),
  ),
  ...['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.6'].map(
    (model): OfficialLink => ({
      model: 'MiniMax/' + model,
      id: 'minimax/' + model,
      provider: 'minimax',
      modelName: model,
      currency: null,
      sourceUrl: OFFICIAL_SOURCES.minimaxPricing.url,
      sourceType: 'official',
      basis: 'official_page',
      unknown: true,
      detail: '官方定价页已登记，但表格未能取得可核验文本，价格未知。',
    }),
  ),
  ...Object.entries(OFFICIAL_CALL_RATES).map(
    ([name, rate]): OfficialLink => ({
      model: 'DeepSeek/deepseek-' + name,
      id: 'deepseek/deepseek-' + name,
      provider: 'deepseek',
      modelName: 'deepseek-' + name,
      currency: null,
      sourceUrl: OFFICIAL_SOURCES[rate.source].url,
      sourceType: 'official',
      basis: 'official_usage_units',
      unknown: true,
      detail:
        '按次计费：' +
        rate.amount +
        ' ' +
        rate.unit +
        '，自 ' +
        rate.billableFrom +
        ' 起按次收费；这不是 Token 单价，不进入 Token 参考估算。',
    }),
  ),
];

export function officialLinks(): OfficialLink[] {
  return OFFICIAL_LINKS.map((link) => ({ ...link }));
}

/**
 * Normalise a model name the way the vendors write it in logs.
 *
 * Lower-case, drop a `chatgpt-web/` or `provider/` prefix, treat `.` as `-`
 * (`gpt-5.2` → `gpt-5-2`), and drop a trailing date/version stamp such as the
 * `-1017` in `deepseek-v4.1-flash-1017` or `-250414` in `GLM-4-Flash-250414`.
 * The stamp is dropped only for lookup; a row that names it exactly still wins
 * because exact names are tried before the normalised form.
 */
export function normalizeModelKey(model: string): string {
  return String(model)
    .trim()
    .toLowerCase()
    .replace(/^chatgpt-web\//, '')
    .replace(/^[a-z0-9._-]+\//, '')
    .replace(/\./g, '-')
    .replace(/-(?:\d{4}|\d{3,4}(?:-\d{2}-\d{2}))$/, '');
}

/** Identity rules that map a logged model name to its official row. */
const ALIASES: [RegExp, string][] = [
  [/^deepseek-(?:v4-?1-)?flash(?:-\d+)?$/, 'deepseek/deepseek-flash'],
  [/^deepseek-v4-?pro$/, 'deepseek/deepseek-v4-pro'],
  [/^deepseek-v4-flash-vision-exp$/, 'deepseek/deepseek-v4-flash-vision-exp'],
  [/^deepseek-chat$/, 'deepseek/deepseek-chat'],
  [/^deepseek-reasoner$/, 'deepseek/deepseek-reasoner'],
  [/^glm-5-3-flashx?$/, 'zhipu/glm-5.3-flash'],
  [/^glm-5-3$/, 'zhipu/glm-5.3'],
  [/^glm-4-7$/, 'zhipu/glm-4.7'],
];

/** Exact lookup first, then documented aliases; never a fuzzy guess. */
export function officialRate(model: string): OfficialRate | null {
  const name = String(model).trim().replace(/^chatgpt-web\//, '').replace(/^[a-z0-9._-]+\//i, '');
  const direct = OFFICIAL_RATES.find((rate) => rate.modelName.toLowerCase() === name.toLowerCase());
  if (direct) return direct;
  const key = normalizeModelKey(model);
  const byKey = OFFICIAL_RATES.find((rate) => normalizeModelKey(rate.modelName) === key);
  if (byKey) return byKey;
  for (const [pattern, id] of ALIASES) if (pattern.test(key)) return OFFICIAL_RATES.find((rate) => rate.id === id) || null;
  return null;
}

/**
 * Price lookup for anything that carries a model name: logs, mirror rows, a
 * dialog row. Follows `alias.routing` so an old name answers with the row that
 * actually holds the numbers, and returns null rather than guessing.
 */
export function officialPriceIndex(modelKey: string): OfficialRate | null {
  const rate = officialRate(modelKey);
  if (!rate) return null;
  if (rate.basis === 'official_alias' && rate.alias) {
    const routed = OFFICIAL_RATES.find((item) => item.id === rate.alias!.routing);
    if (routed) return routed;
  }
  return rate;
}

export function officialLink(model: string): OfficialLink | null {
  const name = String(model).trim().replace(/^chatgpt-web\//, '');
  return (
    OFFICIAL_LINKS.find((link) => link.model === name) ||
    OFFICIAL_LINKS.find((link) => link.modelName.toLowerCase() === name.replace(/^[a-z0-9._-]+\//i, '').toLowerCase()) ||
    null
  );
}

const shanghai = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
});

export type PeakVerdict = {
  peak: boolean;
  window: PeakWindow | null;
  local: string;
  weekday: string;
  timezone: 'Asia/Shanghai';
  holidayCalendar: 'not-applied';
};

/**
 * Peak/off-peak at an instant, in the vendor's billing time zone.
 *
 * The vendor bills on Beijing time and states that weekends and Chinese public
 * holidays are off-peak all day. A public-holiday calendar is not embedded, so a
 * weekday holiday is treated as peak; the verdict says `holidayCalendar:
 * 'not-applied'` so an over-charge is visible instead of hidden.
 */
export function shanghaiPeak(at: string | Date, rule: OfficialRate['peak']): PeakVerdict {
  const parts = Object.fromEntries(shanghai.formatToParts(typeof at === 'string' ? new Date(at) : at).map((part) => [part.type, part.value]));
  const weekday = String(parts.weekday || ''),
    local = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`,
    minute = Number(parts.hour) * 60 + Number(parts.minute),
    isWeekday = weekday !== 'Sat' && weekday !== 'Sun';
  let window: PeakWindow | null = null;
  if (isWeekday)
    for (const item of rule.windows) {
      const [fromH, fromM] = item.from.split(':').map(Number),
        [toH, toM] = item.to.split(':').map(Number);
      if (minute >= fromH * 60 + fromM && minute < toH * 60 + toM) window = item;
    }
  return { peak: window != null, window, local, weekday, timezone: 'Asia/Shanghai', holidayCalendar: 'not-applied' };
}

export const QUOTE_FIELDS = ['input', 'cached', 'write', 'output'] as const;
export type QuoteField = (typeof QUOTE_FIELDS)[number];

export function officialQuote(rate: OfficialRate, peak: boolean): Record<QuoteField, string | null> {
  return { ...(peak ? rate.quote.peak : rate.quote.offPeak) } as Record<QuoteField, string | null>;
}

export function isPeak(asOfUtcInstant: string, model: string): boolean {
  const rate = officialPriceIndex(model);
  return rate ? shanghaiPeak(asOfUtcInstant, rate.peak).peak : false;
}

export function addDay(day: string, delta: number): string {
  return new Date(Date.parse(day + 'T00:00:00Z') + delta * 86400000).toISOString().slice(0, 10);
}

export type OfficialApplicability =
  | {
      status: 'exact' | 'estimated';
      /** The official table date the amount comes from, as its own effective date. */
      effective: string;
      gapDays: number;
      estimatedFrom: string | null;
    }
  | { status: 'unknown'; effective: null; gapDays: number; estimatedFrom: null };

/**
 * The official table that applies to a day, on Beijing calendar days.
 *
 * - `exact`: the day falls on or after the current official table's effective
 *   date (or after a vendor-announced version that kept the same price).
 * - `estimated`: the day is after the vendor's first published table but before
 *   the current one. The nearest official rate (the earlier table) is used and
 *   the caller must label the amount with `estimatedFrom`.
 * - `unknown`: before the vendor published anything we can cite — no honest rate
 *   exists, and inventing one would be worse than saying so.
 *
 * DeepSeek did publish a different table between 2026-08-17 and 2026-09-10 — its
 * change log says prices were cut — but the numbers were never published in a
 * form we could read, so those days are estimated rather than invented.
 */
export function officialQuoteFor(rate: OfficialRate, day: string): OfficialApplicability {
  if (day >= rate.history.currentEffective)
    return { status: 'exact', effective: rate.history.currentEffective, gapDays: 0, estimatedFrom: null };
  const gapDays = Math.round((Date.parse(rate.history.currentEffective) - Date.parse(day)) / 86400000);
  if (day > rate.history.start)
    return { status: 'estimated', effective: rate.history.start, gapDays, estimatedFrom: rate.history.start };
  return { status: 'unknown', effective: null, gapDays, estimatedFrom: null };
}

/** Off-peak is the vendor-stated fraction of peak; keep it exact, in Decimal. */
function halfOf(value: string | null, fraction: string): string | null {
  return value == null ? null : new Decimal(value).times(fraction).toString();
}

/**
 * Snapshot body for one day. A day whose rate came from an estimate says so in
 * the body, so the label survives restarts instead of living only in the first
 * valuation run.
 */
export function officialSnapshot(day: string): PriceSnapshot {
  const models: JsonObject[] = [],
    gaps: JsonObject[] = [];
  for (const rate of OFFICIAL_RATES) {
    const applicable = officialQuoteFor(rate, day);
    if (applicable.status === 'unknown') {
      gaps.push({ model: rate.model, error: 'official_table_not_published', effective: rate.history.start });
      continue;
    }
    const estimated = applicable.status === 'estimated',
      source = OFFICIAL_SOURCES[Object.keys(OFFICIAL_SOURCES).find((key) => OFFICIAL_SOURCES[key].url === rate.sourceUrl) || ''] as
        | OfficialSource
        | undefined,
      peakQuote = rate.quote.peak,
      offPeakQuote = rate.quote.offPeak;
    models.push({
      id: rate.id,
      provider: rate.provider,
      model: rate.modelName,
      currency: rate.currency,
      sourceType: 'official',
      sourceUrl: rate.sourceUrl,
      basis: rate.basis,
      aliasRouting: rate.alias?.routing || null,
      aliasNote: rate.alias?.note || null,
      aliasUrl: rate.alias?.url || null,
      pricingNotes: estimated
        ? `${rate.pricingNotes} 该日早于现行官方价的生效日，按 ${applicable.estimatedFrom} 官方价估计。`
        : rate.pricingNotes,
      peakWindows: rate.peak.windows,
      peakTimezone: rate.peak.timezone,
      offPeakFraction: rate.peak.offPeakFraction,
      peakInputPricePer1M: peakQuote.input,
      peakOutputPricePer1M: peakQuote.output,
      peakCacheReadPricePer1M: peakQuote.cached,
      peakCacheWritePricePer1M: peakQuote.write,
      offPeakInputPricePer1M: offPeakQuote.input,
      offPeakOutputPricePer1M: offPeakQuote.output,
      offPeakCacheReadPricePer1M: offPeakQuote.cached,
      offPeakCacheWritePricePer1M: offPeakQuote.write,
      estimated,
      estimatedFrom: applicable.estimatedFrom,
      gapDays: estimated ? applicable.gapDays : 0,
      tableEffective: applicable.effective,
      fetchedAt: source?.fetchedAt || null,
      fetchedSha256: source?.sha256 || null,
    });
  }
  const transcribed = Object.values(OFFICIAL_SOURCES).filter((source) => source.kind === 'official_table');
  return {
    day,
    source: transcribed[0]?.url || OFFICIAL_SOURCES.deepseekPricing.url,
    body: encode({
      schemaVersion: 1,
      billingUnit: 'per_1m_tokens',
      effectiveDate: day,
      generatedAt: day + 'T00:00:00Z',
      scope: 'official_price_table',
      coverage: {
        officialSources: transcribed.map((source) => source.url),
        officialPages: Object.values(OFFICIAL_SOURCES)
          .filter((source) => source.kind === 'official_page')
          .map((source) => source.url),
        gaps,
      },
      models,
    }),
  };
}

export function officialSnapshots(days: string[]): { snapshots: PriceSnapshot[]; gaps: JsonObject[]; errors: JsonObject[] } {
  const unique = [...new Set(days)].sort();
  return { snapshots: unique.map(officialSnapshot), gaps: [], errors: [] };
}

export type OfficialFetcher = (url: string, etag?: string) => Promise<{ body: string | null; etag: string }>;

/**
 * Collect the official pages themselves.
 *
 * Only text pages we can check are fetched; a JavaScript-rendered pricing page
 * returns no numbers, which is the evidence that it cannot be transcribed. The
 * stored digest of each transcribed page is compared with the digest taken when
 * the table was read, so an official price change is reported as something to
 * review instead of silently quoting a stale table.
 */
export async function collectOfficial(
  options: { loader?: OfficialFetcher; evidence?: (url: string, body: string) => void; check?: () => void } = {},
) {
  const errors: JsonObject[] = [],
    gaps: JsonObject[] = [],
    sources: JsonObject[] = [],
    observedAt = new Date().toISOString(),
    urls = Object.values(OFFICIAL_SOURCES)
      .filter((source) => source.kind === 'official_table')
      .map((source) => source.alternateUrl || source.url)
      .concat([OFFICIAL_SOURCES.deepseekUpdates.url, OFFICIAL_SOURCES.anthropicPricing.url, OFFICIAL_SOURCES.googlePricing.url, OFFICIAL_SOURCES.qwenPricing.url, OFFICIAL_SOURCES.minimaxPricing.url]);
  for (const url of urls) {
    const declared = Object.values(OFFICIAL_SOURCES).find((source) => source.url === url || source.alternateUrl === url)!;
    if (!options.loader) {
      sources.push({ url: declared.url, vendor: declared.vendor, checked: false, digest: declared.sha256 });
      continue;
    }
    try {
      options.check?.();
      const result = await options.loader(url);
      const digest = createHash('sha256').update(result.body || '').digest('hex'),
        changed = declared.sha256 != null && declared.sha256 !== digest;
      sources.push({
        url: declared.url,
        vendor: declared.vendor,
        checked: true,
        digest: result.body == null ? null : digest,
        fetchedAt: observedAt,
        matchesTranscription: declared.sha256 == null ? null : !changed,
        bytes: Buffer.byteLength(result.body || ''),
      });
      if (changed)
        gaps.push({
          source: declared.url,
          error: 'official_table_review_required',
          message: '官方定价页内容与转录时不同，需人工核对后更新定价表；期间沿用已核对的表',
        });
    } catch (error: any) {
      errors.push({
        source: declared.url,
        error: 'official_page_unavailable',
        message: String(error?.message || '官方页面读取失败，沿用已核对的定价表'),
      });
    }
  }
  return { sources, gaps, errors, observedAt };
}

/**
 * Hidden corroboration key. Mirror rows live under their own namespace so a
 * lookup for a model can never pick one up by accident.
 */
export function corroborationKey(provider: string, id: string): string {
  return 'corroboration/' + provider.toLowerCase() + '/' + String(id).replace(/^.*\//, '').toLowerCase();
}
