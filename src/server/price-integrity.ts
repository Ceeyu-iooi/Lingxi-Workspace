import { Decimal } from 'decimal.js';

/** Reject evidence, never guess a column permutation or backfill historical rates.
 * ModelRadar's OpenAI scraper has emitted two incompatible column layouts.
 * A sourceType=provider label alone does not verify the extracted semantics. */
export function priceIntegrityIssue(row: {
  id: string; provider?: string; sourceUrl?: string; sourceType?: string;
}, quote: Record<string, string | null>): string | null {
  let host = '';
  try { host = new URL(row.sourceUrl || '').hostname; } catch { return null; }
  if (row.provider?.toLowerCase() !== 'openai' ||
      !['provider','registry'].includes(row.sourceType||'')) return null;
  const { input, cached, write, output } = quote;
  if (input != null && cached != null && new Decimal(cached).gt(input))
    return 'cached_rate_exceeds_input';
  // Known cache-write/output column collision in the GPT-5.6 and GPT-6
  // standard text tables. This is a quarantine signature, not a replacement rate.
  if (/^gpt-(?:5\.6|6(?:\.1)?)-(?:sol|luna|terra|astra|cyber)$/.test(row.id) &&
      write == null && input != null && output != null &&
      new Decimal(input).gt(0) && new Decimal(output).eq(new Decimal(input).times('1.25')))
    return 'output_matches_cache_write_column';
  return null;
}
