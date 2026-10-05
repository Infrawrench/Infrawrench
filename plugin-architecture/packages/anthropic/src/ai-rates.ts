import type { AiModelRateCard, AiTokenType } from "@infrawrench/plugin-base";

/**
 * Anthropic's published per-million-token list rates, checked against
 * https://platform.claude.com/docs/en/about-claude/pricing on 2026-10-04.
 *
 * Used by the host only to weight requests against each other when splitting a
 * bill line between callers, and to estimate how much of a bill a request log
 * explains; never to produce a billed figure. Cache writes use the 5-minute
 * rate (1.25x input), the default cache lifetime. Keys are
 * `normalizeAiModel` output, which is why the dotted versions read `4-5`.
 */
export const anthropicModelRates: AiModelRateCard = {
  provider: "anthropic",
  currency: "USD",
  asOf: "2026-10-04",
  models: {
    "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    "claude-opus-4-1": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    "claude-3-5-haiku": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  },
};

/**
 * The cost report's `token_type` in the shared vocabulary. Both cache-creation
 * lifetimes are cache writes; anything unrecognised is left untyped rather
 * than guessed.
 */
export function anthropicTokenType(raw: string | null | undefined): AiTokenType | undefined {
  switch (raw) {
    case "uncached_input_tokens":
      return "input";
    case "output_tokens":
      return "output";
    case "cache_read_input_tokens":
      return "cache_read";
    case "cache_creation.ephemeral_5m_input_tokens":
    case "cache_creation.ephemeral_1h_input_tokens":
      return "cache_write";
    default:
      return undefined;
  }
}
