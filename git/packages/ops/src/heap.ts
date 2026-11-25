/** A binary heap. `before(a, b)` says whether `a` must come out ahead of `b`. */
export class Heap<T> {
  private readonly items: T[] = [];

  constructor(private readonly before: (a: T, b: T) => boolean) {}

  get size(): number {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  push(item: T): void {
    const items = this.items;
    let at = items.length;
    items.push(item);
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (!this.before(item, items[parent]!)) break;
      items[at] = items[parent]!;
      at = parent;
    }
    items[at] = item;
  }

  pop(): T | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length === 0 || last === undefined) return top;
    let at = 0;
    for (;;) {
      let child = 2 * at + 1;
      if (child >= items.length) break;
      if (child + 1 < items.length && this.before(items[child + 1]!, items[child]!)) child++;
      if (!this.before(items[child]!, last)) break;
      items[at] = items[child]!;
      at = child;
    }
    items[at] = last;
    return top;
  }
}
