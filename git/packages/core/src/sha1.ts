/**
 * SHA-1, incremental, with collision detection.
 *
 * `crypto.subtle.digest` is one-shot, and a pack's trailer and every object
 * in it are hashed as the bytes stream past, so the streaming paths use this.
 *
 * An object's id is its SHA-1, and two different files with one SHA-1 can be
 * made on purpose (SHAttered, 2017; chosen-prefix, 2020). Every known way of
 * making them leaves a mark in the blocks where the two files differ, and
 * this hasher looks for it the way git does (its `sha1dc`): the detection of
 * Marc Stevens and Dan Shumow, "Speeding up detection of SHA-1 collision
 * attacks using unavoidable attack conditions" (USENIX Security 2017),
 * ported from https://github.com/cr-marcstevens/sha1collisiondetection
 * (MIT; `LICENSE-sha1collisiondetection.txt` in this package).
 *
 * How it works, per 64-byte block:
 *
 * 1. Compress as usual, keeping the expanded message `W` and the working
 *    state before steps 58 and 65.
 * 2. `ubcCheck(W)` (generated, `sha1dc-ubc.gen.ts`) tests the "unavoidable
 *    bit conditions" of 32 disturbance vectors, the message differences a
 *    collision can be built on. For an ordinary block no vector survives,
 *    and that is the whole cost: about a hundred mask operations.
 * 3. For each vector that survives, the block's would-be twin is `W` XOR the
 *    vector's difference. From the kept state the twin is run backwards to
 *    the chaining value it would have started from, and forwards to the one
 *    it ends on. If that equals this block's own result, two different
 *    blocks from two different chaining values have met: a collision, and
 *    this input is one half of it.
 *
 * A file that is one half of a collision is refused (`GitError`, code
 * `sha1-collision`) as soon as the block is seen, as git refuses it. The
 * chance of refusing a file nobody built to collide is below 2^-90.
 */
import { GitError } from "./errors";
import { toHex } from "./hex";
import { DV_COUNT, DV_DM, DV_TEST_STEP, ubcCheck } from "./sha1dc-ubc.gen";

// Shared scratch: `compress` is synchronous and never re-enters.
const W = new Int32Array(80);
/** The twin block's expanded message, during a recompression. */
const W2 = new Int32Array(80);
/** Working state (a, b, c, d, e) before step 58, then before step 65. */
const STATES = new Int32Array(10);
// The tables as constants of this module: a test runner may turn each use of
// an import into a property read, which is slow inside a loop.
const DM = DV_DM;
const TEST_STEP = DV_TEST_STEP;
const VECTORS = DV_COUNT;
const unavoidableConditions = ubcCheck;

export interface Sha1Options {
  /**
   * Look for the mark of a collision in every block (the default). Turn it
   * off only for a checksum over bytes nobody chose, or to measure its cost;
   * never for an object id.
   */
  readonly detectCollisions?: boolean;
}

export const SHA1_COLLISION_MESSAGE =
  "SHA-1 collision detected: this content is one half of a pair made to share an id, and is refused";

export class Sha1 {
  private h0 = 0x67452301 | 0;
  private h1 = 0xefcdab89 | 0;
  private h2 = 0x98badcfe | 0;
  private h3 = 0x10325476 | 0;
  private h4 = 0xc3d2e1f0 | 0;
  private readonly block = new Uint8Array(64);
  private blockLength = 0;
  /** Bytes hashed so far. A double holds 2^53, far past any pack. */
  private length = 0;
  private finished = false;
  private readonly detect: boolean;
  private collided = false;

  constructor(options: Sha1Options = {}) {
    this.detect = options.detectCollisions ?? true;
  }

  reset(): this {
    this.h0 = 0x67452301 | 0;
    this.h1 = 0xefcdab89 | 0;
    this.h2 = 0x98badcfe | 0;
    this.h3 = 0x10325476 | 0;
    this.h4 = 0xc3d2e1f0 | 0;
    this.blockLength = 0;
    this.length = 0;
    this.finished = false;
    this.collided = false;
    return this;
  }

  /** Whether a block so far carried the mark of a collision. `update` and `digest` throw when it does. */
  get collision(): boolean {
    return this.collided;
  }

  update(data: Uint8Array): this {
    if (this.finished) throw new Error("Sha1: update after digest");
    let offset = 0;
    const end = data.length;
    this.length += end;
    if (this.blockLength > 0) {
      const take = Math.min(64 - this.blockLength, end);
      this.block.set(data.subarray(0, take), this.blockLength);
      this.blockLength += take;
      offset = take;
      if (this.blockLength < 64) return this;
      this.compress(this.block, 0);
      this.blockLength = 0;
    }
    for (; offset + 64 <= end; offset += 64) this.compress(data, offset);
    if (offset < end) {
      this.block.set(data.subarray(offset, end), 0);
      this.blockLength = end - offset;
    }
    if (this.collided) throw new GitError("sha1-collision", SHA1_COLLISION_MESSAGE);
    return this;
  }

  /** Writes the 20-byte digest into `target`. The hasher is spent until `reset`. */
  digestInto(target: Uint8Array, offset = 0): void {
    if (this.finished) throw new Error("Sha1: digest called twice");
    this.finished = true;
    const block = this.block;
    let n = this.blockLength;
    block[n++] = 0x80;
    if (n > 56) {
      block.fill(0, n, 64);
      this.compress(block, 0);
      n = 0;
    }
    block.fill(0, n, 56);
    const bitsHigh = Math.floor(this.length / 0x20000000);
    const bitsLow = (this.length << 3) >>> 0;
    block[56] = bitsHigh >>> 24;
    block[57] = bitsHigh >>> 16;
    block[58] = bitsHigh >>> 8;
    block[59] = bitsHigh;
    block[60] = bitsLow >>> 24;
    block[61] = bitsLow >>> 16;
    block[62] = bitsLow >>> 8;
    block[63] = bitsLow;
    this.compress(block, 0);
    if (this.collided) throw new GitError("sha1-collision", SHA1_COLLISION_MESSAGE);
    const h = [this.h0, this.h1, this.h2, this.h3, this.h4];
    for (let i = 0; i < 5; i++) {
      const word = h[i]!;
      target[offset + i * 4] = word >>> 24;
      target[offset + i * 4 + 1] = word >>> 16;
      target[offset + i * 4 + 2] = word >>> 8;
      target[offset + i * 4 + 3] = word;
    }
  }

  digest(): Uint8Array {
    const out = new Uint8Array(20);
    this.digestInto(out);
    return out;
  }

  digestHex(): string {
    return toHex(this.digest());
  }

  private compress(data: Uint8Array, offset: number): void {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      W[i] = (data[j]! << 24) | (data[j + 1]! << 16) | (data[j + 2]! << 8) | data[j + 3]!;
    }
    for (let i = 16; i < 80; i++) {
      const x = W[i - 3]! ^ W[i - 8]! ^ W[i - 14]! ^ W[i - 16]!;
      W[i] = (x << 1) | (x >>> 31);
    }
    let a = this.h0;
    let b = this.h1;
    let c = this.h2;
    let d = this.h3;
    let e = this.h4;
    let t = 0;
    for (let i = 0; i < 20; i++) {
      t = (((a << 5) | (a >>> 27)) + ((b & c) | (~b & d)) + e + W[i]! + 0x5a827999) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    for (let i = 20; i < 40; i++) {
      t = (((a << 5) | (a >>> 27)) + (b ^ c ^ d) + e + W[i]! + 0x6ed9eba1) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    for (let i = 40; i < 58; i++) {
      t = (((a << 5) | (a >>> 27)) + ((b & c) | (b & d) | (c & d)) + e + W[i]! + 0x8f1bbcdc) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    // The state before step 58, kept in locals: writing it down is only
    // needed for the rare block that passes `ubcCheck`.
    const a58 = a;
    const b58 = b;
    const c58 = c;
    const d58 = d;
    const e58 = e;
    for (let i = 58; i < 60; i++) {
      t = (((a << 5) | (a >>> 27)) + ((b & c) | (b & d) | (c & d)) + e + W[i]! + 0x8f1bbcdc) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    for (let i = 60; i < 65; i++) {
      t = (((a << 5) | (a >>> 27)) + (b ^ c ^ d) + e + W[i]! + 0xca62c1d6) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    const a65 = a;
    const b65 = b;
    const c65 = c;
    const d65 = d;
    const e65 = e;
    for (let i = 65; i < 80; i++) {
      t = (((a << 5) | (a >>> 27)) + (b ^ c ^ d) + e + W[i]! + 0xca62c1d6) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    this.h0 = (this.h0 + a) | 0;
    this.h1 = (this.h1 + b) | 0;
    this.h2 = (this.h2 + c) | 0;
    this.h3 = (this.h3 + d) | 0;
    this.h4 = (this.h4 + e) | 0;

    if (!this.detect) return;
    const mask = unavoidableConditions(W);
    if (mask === 0) return;
    STATES[0] = a58;
    STATES[1] = b58;
    STATES[2] = c58;
    STATES[3] = d58;
    STATES[4] = e58;
    STATES[5] = a65;
    STATES[6] = b65;
    STATES[7] = c65;
    STATES[8] = d65;
    STATES[9] = e65;
    if (twinMeets(mask, this.h0, this.h1, this.h2, this.h3, this.h4)) this.collided = true;
  }
}

/**
 * Step 3 of the detection, for each disturbance vector in `mask`: whether
 * the twin of the block in `W` (with the states in `STATES`) ends on the
 * chaining value `h0..h4` that the block itself ended on.
 */
function twinMeets(
  mask: number,
  h0: number,
  h1: number,
  h2: number,
  h3: number,
  h4: number,
): boolean {
  for (let dv = 0; dv < VECTORS; dv++) {
    if ((mask & (1 << dv)) === 0) continue;
    const dm = dv * 80;
    for (let i = 0; i < 80; i++) W2[i] = W[i]! ^ DM[dm + i]!;
    const step = TEST_STEP[dv]!;
    const at = step === 58 ? 0 : 5;
    const sa = STATES[at]!;
    const sb = STATES[at + 1]!;
    const sc = STATES[at + 2]!;
    const sd = STATES[at + 3]!;
    const se = STATES[at + 4]!;

    // Backwards from the state before `step` to the chaining value the twin
    // would have started from. Undoing step i: the new `a` was computed from
    // the old five, and the other four only moved along. `step` is 58 or 65,
    // so the walk starts in the fourth or third round and crosses the rest.
    let a = sa;
    let b = sb;
    let c = sc;
    let d = sd;
    let e = se;
    let t = 0;
    for (let i = step - 1; i >= 60; i--) {
      t = b;
      b = (c << 2) | (c >>> 30);
      c = d;
      d = e;
      e = (a - (((t << 5) | (t >>> 27)) + (b ^ c ^ d) + 0xca62c1d6 + W2[i]!)) | 0;
      a = t;
    }
    for (let i = Math.min(step, 60) - 1; i >= 40; i--) {
      t = b;
      b = (c << 2) | (c >>> 30);
      c = d;
      d = e;
      e = (a - (((t << 5) | (t >>> 27)) + ((b & c) | (b & d) | (c & d)) + 0x8f1bbcdc + W2[i]!)) | 0;
      a = t;
    }
    for (let i = 39; i >= 20; i--) {
      t = b;
      b = (c << 2) | (c >>> 30);
      c = d;
      d = e;
      e = (a - (((t << 5) | (t >>> 27)) + (b ^ c ^ d) + 0x6ed9eba1 + W2[i]!)) | 0;
      a = t;
    }
    for (let i = 19; i >= 0; i--) {
      t = b;
      b = (c << 2) | (c >>> 30);
      c = d;
      d = e;
      e = (a - (((t << 5) | (t >>> 27)) + ((b & c) | (~b & d)) + 0x5a827999 + W2[i]!)) | 0;
      a = t;
    }
    const in0 = a;
    const in1 = b;
    const in2 = c;
    const in3 = d;
    const in4 = e;

    // Forwards from the same state to the end.
    a = sa;
    b = sb;
    c = sc;
    d = sd;
    e = se;
    for (let i = step; i < 60; i++) {
      t = (((a << 5) | (a >>> 27)) + ((b & c) | (b & d) | (c & d)) + e + W2[i]! + 0x8f1bbcdc) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    for (let i = Math.max(step, 60); i < 80; i++) {
      t = (((a << 5) | (a >>> 27)) + (b ^ c ^ d) + e + W2[i]! + 0xca62c1d6) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    if (
      ((in0 + a) | 0) === h0 &&
      ((in1 + b) | 0) === h1 &&
      ((in2 + c) | 0) === h2 &&
      ((in3 + d) | 0) === h3 &&
      ((in4 + e) | 0) === h4
    ) {
      return true;
    }
  }
  return false;
}

/**
 * One-shot SHA-1 through WebCrypto. It has no collision detection, so it is
 * for checksums and comparisons only, never for an object's id: use `Sha1`,
 * `sha1Sync` or `hashObject` for those.
 */
export async function sha1(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", data as Uint8Array<ArrayBuffer>));
}

/** One-shot SHA-1 without leaving the event loop turn, with collision detection. */
export function sha1Sync(data: Uint8Array): Uint8Array {
  return new Sha1().update(data).digest();
}
