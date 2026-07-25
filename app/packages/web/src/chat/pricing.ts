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
