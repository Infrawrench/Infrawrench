/**
 * Shared shapes for the chat agent's web access (search + fetch).
 *
 * Search is deliberately behind an interface with more than one implementation.
 * The chat surface is multi-provider — the default model is Gemini on Vertex and
 * `ANTHROPIC_API_KEY` is optional — so search cannot be a provider-native tool
 * block on the main turn without existing for only half of the deployments. It
 * is instead a normal tool whose handler runs its own small sub-model call, and
 * the backend for that call is chosen from whatever credentials the deployment
 * already has (see ./backend.ts).
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
   * Queries the backend actually issued. Both backends bill per query rather
   * than per tool call — one call can fan out — so this is the billable unit,
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
  id: "vertex" | "anthropic";
  label: string;
  /** True when this deployment holds the credentials this backend needs. */
  isConfigured(): boolean;
  search(query: string): Promise<SearchOutcome>;
}
