export interface BucketConfig {
  capacity: number;
  refillPerSecond: number;
}

interface BucketState {
  tokens: number;
  lastRefill: number;
  capacity: number;
  refillPerSecond: number;
  /** When set, capacity is temporarily reduced until this timestamp. */
  penaltyUntil: number | undefined;
  penalizedCapacity: number | undefined;
}

const DEFAULT_CONFIG: BucketConfig = { capacity: 60, refillPerSecond: 1 };

/**
 * In-memory token buckets keyed by `${pluginId}:${accountId}`.
 *
 * Each account gets its own bucket so a noisy account can't starve others.
 * Capacity + refill come from the plugin manifest (falls back to defaults).
 */
export class TokenBucketRegistry {
  private buckets = new Map<string, BucketState>();

  private key(pluginId: string, accountId: string): string {
    return `${pluginId}:${accountId}`;
  }

  private refill(state: BucketState, now: number): void {
    if (state.penaltyUntil && now >= state.penaltyUntil) {
      state.penaltyUntil = undefined;
      state.penalizedCapacity = undefined;
    }
    const effectiveCapacity = state.penalizedCapacity ?? state.capacity;
    const elapsed = (now - state.lastRefill) / 1000;
    if (elapsed > 0) {
      state.tokens = Math.min(effectiveCapacity, state.tokens + elapsed * state.refillPerSecond);
      state.lastRefill = now;
    }
  }

  private ensure(pluginId: string, accountId: string, config: BucketConfig): BucketState {
    const key = this.key(pluginId, accountId);
    let state = this.buckets.get(key);
    if (!state) {
      state = {
        tokens: config.capacity,
        lastRefill: Date.now(),
        capacity: config.capacity,
        refillPerSecond: config.refillPerSecond,
        penaltyUntil: undefined,
        penalizedCapacity: undefined,
      };
      this.buckets.set(key, state);
    } else if (
      state.capacity !== config.capacity ||
      state.refillPerSecond !== config.refillPerSecond
    ) {
      // Config changed (e.g. plugin updated its manifest) — adopt new values.
      state.capacity = config.capacity;
      state.refillPerSecond = config.refillPerSecond;
    }
    return state;
  }

  /**
   * Try to consume one token. Returns true if allowed, false if the bucket is empty.
   */
  tryTake(pluginId: string, accountId: string, config: BucketConfig = DEFAULT_CONFIG): boolean {
    const state = this.ensure(pluginId, accountId, config);
    this.refill(state, Date.now());
    if (state.tokens >= 1) {
      state.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Apply a temporary capacity penalty to an account after a rate-limit hit.
   * Halves capacity for `durationMs`.
   */
  penalize(pluginId: string, accountId: string, durationMs: number): void {
    const key = this.key(pluginId, accountId);
    const state = this.buckets.get(key);
    if (!state) return;
    const penalized = Math.max(1, Math.floor(state.capacity / 2));
    state.penaltyUntil = Date.now() + durationMs;
    state.penalizedCapacity = penalized;
    if (state.tokens > penalized) state.tokens = penalized;
  }

  /** Clear a bucket (used when an account is deleted). */
  clear(pluginId: string, accountId: string): void {
    this.buckets.delete(this.key(pluginId, accountId));
  }
}

export const defaultBucketConfig = DEFAULT_CONFIG;
