/**
 * Per-million-token pricing for AI usage, by model. Base rates are provider
 * list prices (USD per million tokens) multiplied by a fixed 1.5x platform
 * markup: the charge is always exactly 1.5x what the API bills us, nothing
 * configurable. Unknown models fall back to the most expensive tier so we never
 * undercharge.
 *
 * Lives in server-core because two features price with it: AI chat (web) and
 * `infra.ai()` in workflows (web + poller). `web/src/chat/pricing.ts` re-exports
 * it, so chat code keeps its import path.
 *
 * Anthropic: cache write = 1.25x input; cache read = 0.1x input on most
 * models, 0.05x on Sonnet 5.5 and Opus 5.5. These are Anthropic's list rates;
 * calls go through Cloudflare AI Gateway (../anthropic-client.ts). Thinking
 * tokens bill at the output rate and are folded into outputTokens.
 */

const MARKUP = 1.5;

interface ModelRates {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** USD per million tokens, before markup. */
const MODEL_RATES: Record<string, ModelRates> = {
  "claude-sonnet-5-5": { input: 2.0, output: 10.0, cacheWrite: 2.5, cacheRead: 0.1 },
  "claude-opus-5-5": { input: 4.0, output: 20.0, cacheWrite: 5.0, cacheRead: 0.2 },
  // infra.ai() still accepts these, and the chat's web search runs on Haiku.
  "claude-opus-5": { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
};

const FALLBACK_RATES = MODEL_RATES["claude-opus-5"]!;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Per-search fees, USD per single web search query, before markup. The search
 * backend bills per query rather than per request (one call to the search tool
 * can fan out into several) so the unit here is the query, counted from what
 * the backend reports it actually ran.
 *
 * These are on top of the sub-model's token cost, which prices through
 * MODEL_RATES like any other call.
 */
const SEARCH_RATES: Record<string, number> = {
  // $10 per 1,000 searches.
  anthropic: 0.01,
};

/** Most expensive backend, so an unknown id never undercharges. */
const FALLBACK_SEARCH_RATE = Math.max(...Object.values(SEARCH_RATES));

/** Compute the billable per-query search fee in integer micro-dollars. */
export function computeSearchCostMicros(backend: string, queries: number): number {
  if (queries <= 0) return 0;
  const rate = SEARCH_RATES[backend] ?? FALLBACK_SEARCH_RATE;
  return Math.max(0, Math.round(rate * queries * MARKUP * 1_000_000));
}

/** Compute billable cost in integer micro-dollars (1 USD = 1_000_000). */
export function computeCostMicros(model: string, usage: TokenUsage): number {
  const rates = MODEL_RATES[model] ?? FALLBACK_RATES;
  const usd =
    ((usage.inputTokens / 1_000_000) * rates.input +
      (usage.outputTokens / 1_000_000) * rates.output +
      (usage.cacheReadTokens / 1_000_000) * rates.cacheRead +
      (usage.cacheWriteTokens / 1_000_000) * rates.cacheWrite) *
    MARKUP;
  return Math.max(0, Math.round(usd * 1_000_000));
}
