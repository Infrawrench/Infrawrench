/**
 * Git's delta format: two sizes (base, result), then instructions that
 * either copy a range of the base or insert literal bytes.
 */
import { GitError } from "../errors";

export interface DeltaHeader {
  readonly baseSize: number;
  readonly resultSize: number;
  /** Bytes the two sizes take; the instructions start here. */
  readonly headerLength: number;
}

function bad(message: string): GitError {
  return new GitError("bad-delta", message);
}

/**
 * Reads the two sizes at the start of a delta. Only the first bytes are
 * needed (20 always suffice), so it works on a prefix.
 */
export function readDeltaHeader(delta: Uint8Array): DeltaHeader {
  let at = 0;
  const sizes: number[] = [];
  for (let k = 0; k < 2; k++) {
    let value = 0;
    let scale = 1;
    for (;;) {
      if (at >= delta.length) throw bad("delta is cut short in its size header");
      if (scale > 2 ** 53) throw bad("delta has an absurd size");
      const byte = delta[at++]!;
      value += (byte & 0x7f) * scale;
      scale *= 128;
      if (!(byte & 0x80)) break;
    }
    if (!Number.isSafeInteger(value)) throw bad("delta has an absurd size");
    sizes.push(value);
  }
  return { baseSize: sizes[0]!, resultSize: sizes[1]!, headerLength: at };
}

/** Rebuilds an object from its base and a delta. Every instruction is bounds-checked. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  const { baseSize, resultSize, headerLength } = readDeltaHeader(delta);
  if (baseSize !== base.length) {
    throw bad(`delta is for a base of ${baseSize} bytes, not ${base.length}`);
  }
  const out = new Uint8Array(resultSize);
  const end = delta.length;
  let at = headerLength;
  let position = 0;
  while (at < end) {
    const command = delta[at++]!;
    if (command & 0x80) {
      let offset = 0;
      let size = 0;
      if (command & 0x01) offset = delta[at++]!;
      if (command & 0x02) offset |= delta[at++]! << 8;
      if (command & 0x04) offset |= delta[at++]! << 16;
      // The top byte can set bit 31, which `|` would turn negative.
      if (command & 0x08) offset += delta[at++]! * 0x1000000;
      if (command & 0x10) size = delta[at++]!;
      if (command & 0x20) size |= delta[at++]! << 8;
      if (command & 0x40) size |= delta[at++]! << 16;
      if (at > end) throw bad("delta is cut short in a copy");
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw bad("delta copies past the end of its base");
      if (position + size > resultSize) throw bad("delta writes past its declared size");
      out.set(base.subarray(offset, offset + size), position);
      position += size;
    } else if (command !== 0) {
      if (at + command > end) throw bad("delta is cut short in an insert");
      if (position + command > resultSize) throw bad("delta writes past its declared size");
      out.set(delta.subarray(at, at + command), position);
      at += command;
      position += command;
    } else {
      throw bad("delta uses the reserved instruction 0");
    }
  }
  if (position !== resultSize) throw bad("delta stops short of its declared size");
  return out;
}

/** The window the index hashes. Git uses the same; matches shorter than this are not found. */
const BLOCK = 16;
/** How many candidates one lookup tries. Bounds the cost when many blocks share a hash. */
const MAX_PROBES = 32;
const MULTIPLIER = 0x01000193;

class DeltaBuffer {
  private bytes: Uint8Array;
  private length = 0;

  constructor(capacity: number) {
    this.bytes = new Uint8Array(Math.max(64, capacity));
  }

  private reserve(extra: number): void {
    if (this.length + extra <= this.bytes.length) return;
    const grown = new Uint8Array(Math.max(this.bytes.length * 2, this.length + extra));
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }

  size(value: number): void {
    this.reserve(10);
    let rest = value;
    while (rest >= 128) {
      this.bytes[this.length++] = (rest % 128) | 0x80;
      rest = Math.floor(rest / 128);
    }
    this.bytes[this.length++] = rest;
  }

  insert(source: Uint8Array, start: number, end: number): void {
    for (let at = start; at < end;) {
      const n = Math.min(127, end - at);
      this.reserve(n + 1);
      this.bytes[this.length++] = n;
      this.bytes.set(source.subarray(at, at + n), this.length);
      this.length += n;
      at += n;
    }
  }

  copy(offset: number, size: number): void {
    // 64 KB per instruction: larger sizes exist in the format but old readers refuse them.
    for (let done = 0; done < size;) {
      const n = Math.min(0x10000, size - done);
      const from = offset + done;
      this.reserve(8);
      const commandAt = this.length++;
      let command = 0x80;
      if (from & 0xff) {
        command |= 0x01;
        this.bytes[this.length++] = from & 0xff;
      }
      if (from & 0xff00) {
        command |= 0x02;
        this.bytes[this.length++] = (from >>> 8) & 0xff;
      }
      if (from & 0xff0000) {
        command |= 0x04;
        this.bytes[this.length++] = (from >>> 16) & 0xff;
      }
      if (from >>> 24) {
        command |= 0x08;
        this.bytes[this.length++] = from >>> 24;
      }
      if (n !== 0x10000) {
        if (n & 0xff) {
          command |= 0x10;
          this.bytes[this.length++] = n & 0xff;
        }
        if (n & 0xff00) {
          command |= 0x20;
          this.bytes[this.length++] = (n >>> 8) & 0xff;
        }
      }
      this.bytes[commandAt] = command;
      done += n;
    }
  }

  finish(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

function hashBlock(data: Uint8Array, at: number): number {
  let h = 0;
  for (let i = 0; i < BLOCK; i++) h = (Math.imul(h, MULTIPLIER) + data[at + i]!) | 0;
  return h;
}

/**
 * Makes a delta that turns `base` into `target`.
 *
 * The base is cut into 16-byte blocks and indexed by hash; the target is
 * scanned with the same hash rolling one byte at a time, and wherever a
 * block matches, the match is grown in both directions and written as a
 * copy. It does not try to be as small as git's own deltas, only valid and
 * reasonably tight.
 */
export function createDelta(base: Uint8Array, target: Uint8Array): Uint8Array {
  if (base.length > 0xffffffff) throw bad("a delta base is at most 4 GiB");
  const out = new DeltaBuffer(Math.min(target.length, 1024) + 32);
  out.size(base.length);
  out.size(target.length);
  const blocks = Math.floor(base.length / BLOCK);
  if (blocks === 0 || target.length < BLOCK) {
    out.insert(target, 0, target.length);
    return out.finish();
  }

  let bits = 4;
  while (1 << bits < blocks && bits < 24) bits++;
  const shift = 32 - bits;
  const heads = new Int32Array(1 << bits).fill(-1);
  const next = new Int32Array(blocks);
  // Backwards, so each chain lists the earliest block first and equal matches prefer low offsets.
  for (let block = blocks - 1; block >= 0; block--) {
    const slot = Math.imul(hashBlock(base, block * BLOCK), 0x9e3779b1) >>> shift;
    next[block] = heads[slot]!;
    heads[slot] = block;
  }

  // MULTIPLIER^(BLOCK - 1): what the outgoing byte was multiplied by.
  let leaving = 1;
  for (let i = 1; i < BLOCK; i++) leaving = Math.imul(leaving, MULTIPLIER);

  const targetLength = target.length;
  const baseLength = base.length;
  let pending = 0;
  let at = 0;
  let hash = hashBlock(target, 0);
  while (at + BLOCK <= targetLength) {
    let bestLength = 0;
    let bestOffset = 0;
    let probes = 0;
    for (
      let block = heads[Math.imul(hash, 0x9e3779b1) >>> shift]!;
      block >= 0 && probes < MAX_PROBES;
      block = next[block]!, probes++
    ) {
      const offset = block * BLOCK;
      const limit = Math.min(baseLength - offset, targetLength - at);
      if (limit <= bestLength) continue;
      let length = 0;
      while (length < limit && base[offset + length] === target[at + length]) length++;
      if (length > bestLength) {
        bestLength = length;
        bestOffset = offset;
        if (at + length === targetLength) break;
      }
    }
    if (bestLength < BLOCK) {
      if (at + BLOCK >= targetLength) break;
      hash =
        (Math.imul(hash - Math.imul(target[at]!, leaving), MULTIPLIER) + target[at + BLOCK]!) | 0;
      at++;
      continue;
    }
    // The match may have begun before the block boundary: take back bytes still waiting as an insert.
    while (bestOffset > 0 && at > pending && base[bestOffset - 1] === target[at - 1]) {
      bestOffset--;
      at--;
      bestLength++;
    }
    out.insert(target, pending, at);
    out.copy(bestOffset, bestLength);
    at += bestLength;
    pending = at;
    if (at + BLOCK <= targetLength) hash = hashBlock(target, at);
  }
  out.insert(target, pending, targetLength);
  return out.finish();
}
