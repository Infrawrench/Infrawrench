/**
 * The order git walks history in: newest committer date first, and among
 * equal dates the commit that was queued first. Git keeps a list sorted by
 * date and inserts after equal dates; a heap with a sequence number gives
 * the same order, which is what makes `log` list commits the way
 * `git log` does.
 */
import { Heap } from "../heap";
import type { CommitNode } from "../objects";

interface Queued {
  readonly node: CommitNode;
  readonly sequence: number;
}

export class DateQueue {
  private readonly heap = new Heap<Queued>(
    (a, b) => a.node.time > b.node.time || (a.node.time === b.node.time && a.sequence < b.sequence),
  );
  private sequence = 0;

  get size(): number {
    return this.heap.size;
  }

  push(node: CommitNode): void {
    this.heap.push({ node, sequence: this.sequence++ });
  }

  pop(): CommitNode | undefined {
    return this.heap.pop()?.node;
  }

  peek(): CommitNode | undefined {
    return this.heap.peek()?.node;
  }
}
