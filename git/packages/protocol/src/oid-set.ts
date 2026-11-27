/**
 * Object ids kept as raw bytes. A fetch of a large repository names every
 * object it sends, and a million ids as JavaScript strings is over 100 MB;
 * here an id costs 28 bytes (20 for the id, 8 for its slot in the table).
 */
import { type ObjectId, toHex, writeHex } from "@infrawrench/git-core";

const OID_BYTES = 20;

/** A growable list of ids, in insertion order. */
export class OidList {
  private data: Uint8Array;
  private count = 0;

  constructor(capacity = 64) {
    this.data = new Uint8Array(Math.max(1, capacity) * OID_BYTES);
  }

  get length(): number {
    return this.count;
  }

  /** The ids' bytes, 20 each. A view: it is replaced when the list grows. */
  get bytes(): Uint8Array {
    return this.data.subarray(0, this.count * OID_BYTES);
  }

  private room(): number {
    if ((this.count + 1) * OID_BYTES > this.data.length) {
      const next = new Uint8Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    return this.count * OID_BYTES;
  }

  push(oid: ObjectId): number {
    writeHex(oid, this.data, this.room());
    return this.count++;
  }

  /** Appends the 20 bytes at `at` in `source`. */
  pushBytes(source: Uint8Array, at: number): number {
    const to = this.room();
    for (let i = 0; i < OID_BYTES; i++) this.data[to + i] = source[at + i]!;
    return this.count++;
  }

  hexAt(index: number): ObjectId {
    return toHex(this.data, index * OID_BYTES, index * OID_BYTES + OID_BYTES);
  }

  *[Symbol.iterator](): Iterator<ObjectId> {
    for (let i = 0; i < this.count; i++) yield this.hexAt(i);
  }
}

/** A set of ids: an open-addressed table of indices into an `OidList`. */
export class OidSet {
  readonly list: OidList;
  private table: Int32Array;
  private mask: number;
  private readonly scratch = new Uint8Array(OID_BYTES);

  constructor(capacity = 64) {
    let size = 16;
    while (size < capacity * 2) size *= 2;
    this.table = new Int32Array(size).fill(-1);
    this.mask = size - 1;
    this.list = new OidList(capacity);
  }

  get size(): number {
    return this.list.length;
  }

  /** The slot holding the id at `at` in `source`, or the empty slot where it would go. */
  private slot(source: Uint8Array, at: number): number {
    // An object id is a hash already: its first four bytes are as good as any.
    let slot =
      ((source[at]! << 24) | (source[at + 1]! << 16) | (source[at + 2]! << 8) | source[at + 3]!) &
      this.mask;
    const keys = this.list.bytes;
    for (;;) {
      const index = this.table[slot]!;
      if (index < 0) return slot;
      const key = index * OID_BYTES;
      let same = true;
      for (let i = 0; i < OID_BYTES; i++) {
        if (keys[key + i] !== source[at + i]) {
          same = false;
          break;
        }
      }
      if (same) return slot;
      slot = (slot + 1) & this.mask;
    }
  }

  private grow(): void {
    const size = this.table.length * 2;
    this.table = new Int32Array(size).fill(-1);
    this.mask = size - 1;
    const keys = this.list.bytes;
    for (let index = 0; index < this.list.length; index++) {
      this.table[this.slot(keys, index * OID_BYTES)] = index;
    }
  }

  hasBytes(source: Uint8Array, at: number): boolean {
    return this.table[this.slot(source, at)]! >= 0;
  }

  /** Adds the id at `at` in `source`. False when it was already there. */
  addBytes(source: Uint8Array, at: number): boolean {
    const slot = this.slot(source, at);
    if (this.table[slot]! >= 0) return false;
    this.table[slot] = this.list.pushBytes(source, at);
    if (this.list.length * 2 > this.table.length) this.grow();
    return true;
  }

  has(oid: ObjectId): boolean {
    writeHex(oid, this.scratch, 0);
    return this.hasBytes(this.scratch, 0);
  }

  add(oid: ObjectId): boolean {
    writeHex(oid, this.scratch, 0);
    return this.addBytes(this.scratch, 0);
  }

  [Symbol.iterator](): Iterator<ObjectId> {
    return this.list[Symbol.iterator]();
  }
}

/**
 * Calls `visit` for each entry of a tree with the entry's bytes still in
 * place: whether it is a tree, and where its id starts. Parsing a tree into
 * objects costs an allocation per entry, and a fetch reads every tree.
 * Submodule entries (gitlinks) name a commit in another repository and are
 * skipped.
 */
export function forEachTreeEntry(
  tree: Uint8Array,
  visit: (isTree: boolean, source: Uint8Array, at: number) => void,
): void {
  let at = 0;
  while (at < tree.length) {
    // Modes are octal ASCII: `40000` (or `040000`) is a tree, `160000` a gitlink.
    const first = tree[at]!;
    const second = tree[at + 1]!;
    let nul = at;
    while (nul < tree.length && tree[nul] !== 0) nul++;
    const oidAt = nul + 1;
    if (oidAt + OID_BYTES > tree.length) return;
    const isGitlink = first === 0x31 && second === 0x36;
    if (!isGitlink) visit(first === 0x34 || (first === 0x30 && second === 0x34), tree, oidAt);
    at = oidAt + OID_BYTES;
  }
}
