/**
 * A least-recently-used cache of byte arrays with a byte budget, which is
 * what bounds the memory delta resolution takes.
 */
export class ByteLru<K> {
  // A Map iterates in insertion order, so re-inserting on every hit keeps the oldest entry first.
  private readonly entries = new Map<K, Uint8Array>();
  private readonly maxBytes: number;
  private readonly onEvict: ((key: K) => void) | undefined;
  private used = 0;

  constructor(maxBytes: number, onEvict?: (key: K) => void) {
    this.maxBytes = maxBytes;
    this.onEvict = onEvict;
  }

  get bytes(): number {
    return this.used;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: K): Uint8Array | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  /** Stores the value unless it alone is over the budget. Returns whether it was stored. */
  set(key: K, value: Uint8Array): boolean {
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.used -= previous.length;
      this.entries.delete(key);
    }
    if (value.length > this.maxBytes) return false;
    this.entries.set(key, value);
    this.used += value.length;
    while (this.used > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.used -= this.entries.get(oldest.value)!.length;
      this.entries.delete(oldest.value);
      this.onEvict?.(oldest.value);
    }
    return true;
  }

  keys(): IterableIterator<K> {
    return this.entries.keys();
  }

  clear(): void {
    this.entries.clear();
    this.used = 0;
  }
}
