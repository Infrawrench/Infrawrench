/**
 * The pack index, version 2 (`.idx`): a fan-out table over the first byte
 * of each id, the ids sorted, a CRC-32 and an offset per object, and the
 * pack's and the index's own checksums.
 */
import { GitError } from "../errors";
import { isObjectId, toHex, writeHex } from "../hex";
import { Sha1 } from "../sha1";
import type { ObjectId } from "../types";

const MAGIC = [0xff, 0x74, 0x4f, 0x63];
const HEADER_LENGTH = 8;
const FANOUT_LENGTH = 256 * 4;
/** Offsets from here up do not fit the 31 bits of the main table and go to the 64-bit one. */
const LARGE_OFFSET = 0x80000000;

/** What an index is built from. `IndexedObjects` is one; `packIndexSource` adapts a plain array. */
export interface PackIndexSource {
  readonly count: number;
  copyOid(index: number, target: Uint8Array, at: number): void;
  offset(index: number): number;
  crc32(index: number): number;
}

export interface PackIndexRecord {
  readonly oid: ObjectId;
  readonly offset: number;
  readonly crc32: number;
}

export function packIndexSource(records: readonly PackIndexRecord[]): PackIndexSource {
  return {
    count: records.length,
    copyOid: (index, target, at) => writeHex(records[index]!.oid, target, at),
    offset: (index) => records[index]!.offset,
    crc32: (index) => records[index]!.crc32,
  };
}

/** Builds the `.idx` for a pack. For the same pack the bytes equal what `git index-pack` writes. */
export function writePackIndex(source: PackIndexSource, packChecksum: ObjectId): Uint8Array {
  if (!isObjectId(packChecksum)) throw new GitError("bad-index", "malformed pack checksum");
  const n = source.count;
  const ids = new Uint8Array(n * 20);
  for (let i = 0; i < n; i++) source.copyOid(i, ids, i * 20);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => {
    const x = a * 20;
    const y = b * 20;
    for (let k = 0; k < 20; k++) {
      const d = ids[x + k]! - ids[y + k]!;
      if (d !== 0) return d;
    }
    // The same object stored twice: keep pack order so the output is deterministic.
    return source.offset(a) - source.offset(b);
  });

  let large = 0;
  for (let i = 0; i < n; i++) if (source.offset(i) >= LARGE_OFFSET) large++;
  const size = HEADER_LENGTH + FANOUT_LENGTH + n * 28 + large * 8 + 40;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint32(4, 2);

  const idsAt = HEADER_LENGTH + FANOUT_LENGTH;
  const crcAt = idsAt + n * 20;
  const offsetsAt = crcAt + n * 4;
  const largeAt = offsetsAt + n * 4;
  const fanout = new Uint32Array(256);
  let nextLarge = 0;
  for (let position = 0; position < n; position++) {
    const index = order[position]!;
    out.set(ids.subarray(index * 20, index * 20 + 20), idsAt + position * 20);
    fanout[ids[index * 20]!]!++;
    view.setUint32(crcAt + position * 4, source.crc32(index));
    const offset = source.offset(index);
    if (offset < LARGE_OFFSET) {
      view.setUint32(offsetsAt + position * 4, offset);
    } else {
      view.setUint32(offsetsAt + position * 4, (LARGE_OFFSET | nextLarge) >>> 0);
      view.setUint32(largeAt + nextLarge * 8, Math.floor(offset / 0x100000000));
      view.setUint32(largeAt + nextLarge * 8 + 4, offset >>> 0);
      nextLarge++;
    }
  }
  let running = 0;
  for (let byte = 0; byte < 256; byte++) {
    running += fanout[byte]!;
    view.setUint32(HEADER_LENGTH + byte * 4, running);
  }
  const trailerAt = largeAt + large * 8;
  writeHex(packChecksum, out, trailerAt);
  new Sha1().update(out.subarray(0, trailerAt + 20)).digestInto(out, trailerAt + 20);
  return out;
}

/** A parsed `.idx`: lookups by id without unpacking the table. */
export class PackIndex {
  readonly count: number;
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly idsAt: number;
  private readonly crcAt: number;
  private readonly offsetsAt: number;
  private readonly largeAt: number;
  private readonly largeCount: number;
  private readonly trailerAt: number;

  constructor(bytes: Uint8Array) {
    if (bytes.length < HEADER_LENGTH + FANOUT_LENGTH + 40) {
      throw new GitError("bad-index", "pack index is cut short");
    }
    for (let i = 0; i < 4; i++) {
      if (bytes[i] !== MAGIC[i]) throw new GitError("bad-index", "not a version 2 pack index");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(4) !== 2) {
      throw new GitError("bad-index", `pack index version ${view.getUint32(4)} is not supported`);
    }
    let previous = 0;
    for (let byte = 0; byte < 256; byte++) {
      const value = view.getUint32(HEADER_LENGTH + byte * 4);
      if (value < previous) throw new GitError("bad-index", "pack index fan-out goes backwards");
      previous = value;
    }
    const n = previous;
    const fixed = HEADER_LENGTH + FANOUT_LENGTH + n * 28 + 40;
    const extra = bytes.length - fixed;
    if (extra < 0 || extra % 8 !== 0) {
      throw new GitError("bad-index", "pack index is not the size its object count needs");
    }
    this.bytes = bytes;
    this.view = view;
    this.count = n;
    this.idsAt = HEADER_LENGTH + FANOUT_LENGTH;
    this.crcAt = this.idsAt + n * 20;
    this.offsetsAt = this.crcAt + n * 4;
    this.largeAt = this.offsetsAt + n * 4;
    this.largeCount = extra / 8;
    this.trailerAt = this.largeAt + extra;
  }

  /** The checksum of the pack this index describes. */
  get packChecksum(): ObjectId {
    return toHex(this.bytes, this.trailerAt, this.trailerAt + 20);
  }

  /** Recomputes the index's own checksum. */
  verify(): boolean {
    const end = this.trailerAt + 20;
    const actual = new Sha1().update(this.bytes.subarray(0, end)).digestHex();
    return actual === toHex(this.bytes, end, end + 20);
  }

  /** The position of `oid` in the sorted table, or -1. */
  find(oid: ObjectId): number {
    if (!isObjectId(oid)) return -1;
    const first = Number.parseInt(oid.slice(0, 2), 16);
    let low = first === 0 ? 0 : this.view.getUint32(HEADER_LENGTH + (first - 1) * 4);
    let high = this.view.getUint32(HEADER_LENGTH + first * 4) - 1;
    const want = new Uint8Array(20);
    writeHex(oid, want, 0);
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const at = this.idsAt + middle * 20;
      let order = 0;
      for (let k = 0; k < 20 && order === 0; k++) order = this.bytes[at + k]! - want[k]!;
      if (order === 0) return middle;
      if (order < 0) low = middle + 1;
      else high = middle - 1;
    }
    return -1;
  }

  has(oid: ObjectId): boolean {
    return this.find(oid) >= 0;
  }

  /** Where `oid`'s entry starts in the pack, or null when the pack does not have it. */
  lookup(oid: ObjectId): PackIndexRecord | null {
    const position = this.find(oid);
    return position < 0 ? null : this.at(position);
  }

  oidAt(position: number): ObjectId {
    const at = this.idsAt + position * 20;
    return toHex(this.bytes, at, at + 20);
  }

  crc32At(position: number): number {
    return this.view.getUint32(this.crcAt + position * 4);
  }

  offsetAt(position: number): number {
    const value = this.view.getUint32(this.offsetsAt + position * 4);
    if (value < LARGE_OFFSET) return value;
    const index = value - LARGE_OFFSET;
    if (index >= this.largeCount) {
      throw new GitError("bad-index", "pack index points past its 64-bit offset table");
    }
    const at = this.largeAt + index * 8;
    const offset = this.view.getUint32(at) * 0x100000000 + this.view.getUint32(at + 4);
    if (!Number.isSafeInteger(offset)) throw new GitError("bad-index", "absurd pack offset");
    return offset;
  }

  at(position: number): PackIndexRecord {
    if (position < 0 || position >= this.count) throw new RangeError("no such index position");
    return {
      oid: this.oidAt(position),
      offset: this.offsetAt(position),
      crc32: this.crc32At(position),
    };
  }

  /** Every record, in id order. */
  *[Symbol.iterator](): Iterator<PackIndexRecord> {
    for (let position = 0; position < this.count; position++) yield this.at(position);
  }

  /**
   * The ids that start with a hex prefix, at most `limit` of them: what
   * turns an abbreviated id from a URL into the object, or says it is
   * ambiguous.
   */
  findByPrefix(prefix: string, limit = 2): ObjectId[] {
    if (!/^[0-9a-f]{2,40}$/.test(prefix)) return [];
    const first = Number.parseInt(prefix.slice(0, 2), 16);
    const start = first === 0 ? 0 : this.view.getUint32(HEADER_LENGTH + (first - 1) * 4);
    const end = this.view.getUint32(HEADER_LENGTH + first * 4);
    // Lower bound of the prefix padded with zeros.
    const want = new Uint8Array(20);
    writeHex(prefix.length % 2 === 0 ? prefix : `${prefix}0`, want, 0);
    let low = start;
    let high = end;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const at = this.idsAt + middle * 20;
      let order = 0;
      for (let k = 0; k < 20 && order === 0; k++) order = this.bytes[at + k]! - want[k]!;
      if (order < 0) low = middle + 1;
      else high = middle;
    }
    const found: ObjectId[] = [];
    for (let position = low; position < end && found.length < limit; position++) {
      const oid = this.oidAt(position);
      if (!oid.startsWith(prefix)) break;
      found.push(oid);
    }
    return found;
  }

  /**
   * Each entry's packed length, by sorting the offsets: an entry ends where
   * the next begins, and the last one at the trailer. `packSize` is the
   * whole pack file's size.
   */
  entryLengths(packSize: number): Map<number, number> {
    const offsets = new Float64Array(this.count);
    for (let position = 0; position < this.count; position++) {
      offsets[position] = this.offsetAt(position);
    }
    offsets.sort();
    const lengths = new Map<number, number>();
    for (let i = 0; i < offsets.length; i++) {
      const next = i + 1 < offsets.length ? offsets[i + 1]! : packSize - 20;
      lengths.set(offsets[i]!, next - offsets[i]!);
    }
    return lengths;
  }
}
