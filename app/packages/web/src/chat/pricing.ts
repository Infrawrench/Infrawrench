/**
 * Per-million-token pricing for chat, by model. Base rates are provider list
 * prices (USD per million tokens) multiplied by a fixed 1.5x platform markup —
 * the charge is always exactly 1.5x what the API bills us, nothing
 * configurable. Unknown models fall back to the most expensive tier so we never
 * undercharge.
 *
 * Anthropic: cache write = 1.25x input, cache read = 0.1x input.
 * Gemini on Vertex AI: implicit caching is automatic and carries no write
 * charge, so cacheWrite is 0 and the provider reports zero cache-write tokens.
 * Reasoning tokens bill at the output rate and are folded into outputTokens.
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
  // Vertex AI standard-tier rates, which match AI Studio list for this model.
  "gemini-3.6-flash": { input: 1.5, output: 7.5, cacheWrite: 0, cacheRead: 0.15 },
  "claude-opus-5": { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
  // Legacy: conversations created before the model list moved to the current
  // generation still carry these ids.
  "claude-opus-4-8": { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
};

const FALLBACK_RATES = MODEL_RATES["claude-opus-5"]!;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Per-search fees, USD per single web search query, before markup. Both search
 * backends bill per query rather than per request — one call to the search tool
 * can fan out into several — so the unit here is the query, counted from what
 * the backend reports it actually ran.
 *
 * These are on top of the sub-model's token cost, which prices through
 * MODEL_RATES like any other call.
 *
 * Known imprecision, deliberate: Google gives 5,000 free search queries a month
 * aggregated across Gemini 3 models, and that allowance belongs to the Google
 * Cloud project — one pool shared by every organization on the deployment, with
 * no way to attribute a share of it to the org that used it. Rather than invent
 * an allocation, we charge from the first query, so early-month searches are
 * billed at list while the platform is still inside the free allowance. It is
 * the one place the "always exactly 1.5x what the API bills us" rule above does
 * not hold exactly, and it errs toward the platform.
 */
const SEARCH_RATES: Record<string, number> = {
  // $14 per 1,000 search queries on Gemini 3 models (billing began 2026-01-05).
  vertex: 0.014,
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
