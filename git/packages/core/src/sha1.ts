/**
 * SHA-1, incremental. `crypto.subtle.digest` is one-shot, and a pack's
 * trailer and every object in it are hashed as the bytes stream past, so the
 * streaming paths use this; `sha1` below takes the native one-shot path.
 */
import { toHex } from "./hex";

// Shared scratch: `compress` is synchronous and never re-enters.
const W = new Int32Array(80);

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

  reset(): this {
    this.h0 = 0x67452301 | 0;
    this.h1 = 0xefcdab89 | 0;
    this.h2 = 0x98badcfe | 0;
    this.h3 = 0x10325476 | 0;
    this.h4 = 0xc3d2e1f0 | 0;
    this.blockLength = 0;
    this.length = 0;
    this.finished = false;
    return this;
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
    for (let i = 40; i < 60; i++) {
      t = (((a << 5) | (a >>> 27)) + ((b & c) | (b & d) | (c & d)) + e + W[i]! + 0x8f1bbcdc) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    for (let i = 60; i < 80; i++) {
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
  }
}

/** One-shot SHA-1 through WebCrypto. */
export async function sha1(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", data as Uint8Array<ArrayBuffer>));
}

/** One-shot SHA-1 without leaving the event loop turn. Faster than `sha1` for small inputs. */
export function sha1Sync(data: Uint8Array): Uint8Array {
  return new Sha1().update(data).digest();
}
