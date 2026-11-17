/**
 * Shared shapes for the chat agent's web access (search + fetch).
 *
 * Search is a normal tool whose handler runs its own small sub-model call
 * (./anthropic-search.ts), rather than a provider-native tool block on the main
 * turn: the cheap sub-model does the retrieval and compression, and the
 * conversation's model only reads the summary.
 */

/** One web result: what the model sees, and what the user must be able to click. */
export interface SearchHit {
  title: string;
  url: string;
  /** Backend-supplied freshness hint, when it gives one. */
  age?: string;
}

export interface SearchOutcome {
  /** The backend's prose summary of what it found, already grounded in `hits`. */
  summary: string;
  hits: SearchHit[];
  /**
   * Queries the backend actually issued. Search bills per query rather than
   * per tool call (one call can fan out) so this is the billable unit,
   * not a display detail. See ../pricing.ts.
   */
  queries: number;
  /** Token spend of the sub-model call, billed on top of the per-query fee. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  /** Model id the sub-call used, so the token spend prices against the right row. */
  model: string;
}

export interface SearchBackend {
  /** Stable id used in logs, the operator override env, and billing rows. */
  id: "anthropic";
  label: string;
  /** True when this deployment holds the credentials this backend needs. */
  isConfigured(): boolean;
  search(query: string): Promise<SearchOutcome>;
}
