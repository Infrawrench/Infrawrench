/**
 * A small time-to-live cache whose loads are single-flight: a hover and a
 * CodeLens asking for the org's posture feed in the same tick share one
 * request. A failed load is not cached, so the next ask retries.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { at: number; value: Promise<V> }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const value = load();
    const entry = { at: this.now(), value };
    this.entries.set(key, entry);
    value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
