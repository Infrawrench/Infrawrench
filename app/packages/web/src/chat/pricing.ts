/**
 * Per-million-token pricing for chat. Defaults are passthrough rates for
 * Claude Sonnet 4.6 (input $3, output $15, cache write $3.75, cache read $0.30
 * per million) multiplied by INFRAWRENCH_CHAT_MARKUP (default 1.5). All env
 * overrides are in USD-per-million-tokens, decimals OK.
 */

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const MARKUP = envNum("INFRAWRENCH_CHAT_MARKUP", 1.5);

/** USD per million tokens, after markup. */
const RATES = {
  input: envNum("INFRAWRENCH_CHAT_PRICE_INPUT_PER_MTOK", 3.0) * MARKUP,
  output: envNum("INFRAWRENCH_CHAT_PRICE_OUTPUT_PER_MTOK", 15.0) * MARKUP,
  cacheWrite: envNum("INFRAWRENCH_CHAT_PRICE_CACHE_WRITE_PER_MTOK", 3.75) * MARKUP,
  cacheRead: envNum("INFRAWRENCH_CHAT_PRICE_CACHE_READ_PER_MTOK", 0.3) * MARKUP,
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Compute billable cost in integer micro-dollars (1 USD = 1_000_000). */
export function computeCostMicros(usage: TokenUsage): number {
  const usd =
    (usage.inputTokens / 1_000_000) * RATES.input +
    (usage.outputTokens / 1_000_000) * RATES.output +
    (usage.cacheReadTokens / 1_000_000) * RATES.cacheRead +
    (usage.cacheWriteTokens / 1_000_000) * RATES.cacheWrite;
  return Math.max(0, Math.round(usd * 1_000_000));
}
