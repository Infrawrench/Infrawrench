/**
 * Tick defaults, in a module of their own so the edge Worker can read them at
 * startup without evaluating the pass registry (see edge/worker.ts).
 */
export const DEFAULT_TICK_MS = 15_000;
export const DEFAULT_CONCURRENCY = 8;
