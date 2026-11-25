/**
 * Poly1305 (RFC 8439, section 2.5), in plain TypeScript because WebCrypto
 * does not have it.
 *
 * The 130-bit accumulator is ten 13-bit limbs. Ten times thirteen is exactly
 * 130, so a product limb that overflows the top wraps to the bottom times
 * five (2^130 = 5 mod p), and every intermediate sum stays far below 2^53,
 * where a JavaScript number stops being exact. There are no data-dependent
 * branches or table lookups; the final reduction selects with a mask.
 *
 * The block function is written out limb by limb. It is the hot loop of
 * `chacha20-poly1305@openssh.com`, and the unrolled form runs several times
 * faster than loops over arrays.
 */

const LIMBS = 10;
const MASK = 0x1fff;
/** 2^13, the limb radix. */
const RADIX = 8192;
/** The 2^128 bit that every full block gets, as it sits in limb nine (bit 128 - 9 * 13). */
const HIGH_BIT = 1 << 11;

export class Poly1305 {
  private readonly r = new Uint16Array(LIMBS);
  private readonly h = new Float64Array(LIMBS);
  private readonly pad: Uint8Array;
  private readonly partial = new Uint8Array(16);
  private partialLength = 0;

  /** `key` is the 32-byte one-time key: `r` then `s`. */
  constructor(key: Uint8Array) {
    if (key.length !== 32) throw new Error("Poly1305 key must be 32 bytes");
    const r = key.slice(0, 16);
    // Clamp r as the RFC requires.
    r[3]! &= 15;
    r[7]! &= 15;
    r[11]! &= 15;
    r[15]! &= 15;
    r[4]! &= 252;
    r[8]! &= 252;
    r[12]! &= 252;
    for (let i = 0; i < LIMBS; i++) {
      // Limb i is the 13 bits from bit 13 * i. The top limb has only eleven
      // bits of r in it, and there is no third byte to read for it.
      const bit = i * 13;
      const at = bit >>> 3;
      const third = at + 2 < 16 ? r[at + 2]! << 16 : 0;
      this.r[i] = ((r[at]! | (r[at + 1]! << 8) | third) >>> (bit & 7)) & MASK;
    }
    this.pad = key.slice(16, 32);
  }

  update(data: Uint8Array): this {
    let offset = 0;
    if (this.partialLength > 0) {
      const take = Math.min(16 - this.partialLength, data.length);
      this.partial.set(data.subarray(0, take), this.partialLength);
      this.partialLength += take;
      offset = take;
      if (this.partialLength < 16) return this;
      this.blocks(this.partial, 0, 16, HIGH_BIT);
      this.partialLength = 0;
    }
    const full = (data.length - offset) & ~15;
    if (full > 0) {
      this.blocks(data, offset, full, HIGH_BIT);
      offset += full;
    }
    if (offset < data.length) {
      this.partial.set(data.subarray(offset), 0);
      this.partialLength = data.length - offset;
    }
    return this;
  }

  /** The 16-byte tag. The instance must not be used again. */
  finish(): Uint8Array {
    if (this.partialLength > 0) {
      // A short last block gets a one byte after it and zeros to sixteen,
      // and no extra high bit.
      this.partial[this.partialLength] = 1;
      this.partial.fill(0, this.partialLength + 1);
      this.blocks(this.partial, 0, 16, 0);
    }
    const h = this.h;

    // Carry until every limb is 13 bits. Each pass folds the overflow of the
    // top limb back in times five; three passes settle any state the block
    // function can leave.
    for (let pass = 0; pass < 3; pass++) {
      let carry = 0;
      for (let i = 0; i < LIMBS; i++) {
        const v = h[i]! + carry;
        h[i] = v & MASK;
        carry = v >>> 13;
      }
      h[0]! += carry * 5;
    }
    let carry = h[0]! >>> 13;
    h[0]! &= MASK;
    h[1]! += carry;

    // g = h + 5 - 2^130. If that does not go negative, h was at least p and
    // g is the reduced value.
    const g = new Uint16Array(LIMBS);
    carry = 5;
    for (let i = 0; i < LIMBS; i++) {
      const v = h[i]! + carry;
      g[i] = v & MASK;
      carry = v >>> 13;
    }
    const useG = -carry; // all ones when h + 5 carried out of bit 130
    const limbs = new Uint16Array(LIMBS);
    for (let i = 0; i < LIMBS; i++) limbs[i] = (h[i]! & ~useG) | (g[i]! & useG);

    // The low 128 bits, plus s, little-endian.
    const tag = new Uint8Array(16);
    let add = 0;
    for (let i = 0; i < 16; i++) {
      const bit = i * 8;
      const limb = Math.floor(bit / 13);
      const shift = bit % 13;
      const low = limbs[limb]! >>> shift;
      const high = limb + 1 < LIMBS ? limbs[limb + 1]! << (13 - shift) : 0;
      add += ((low | high) & 0xff) + this.pad[i]!;
      tag[i] = add & 0xff;
      add >>>= 8;
    }
    return tag;
  }

  /**
   * For each 16-byte block in `length` bytes from `offset`:
   * h = (h + block) * r mod 2^130 - 5. `highBit` is the 2^128 bit of each
   * block, already shifted into limb nine.
   */
  private blocks(m: Uint8Array, offset: number, length: number, highBit: number): void {
    const { h, r } = this;
    const r0 = r[0]!;
    const r1 = r[1]!;
    const r2 = r[2]!;
    const r3 = r[3]!;
    const r4 = r[4]!;
    const r5 = r[5]!;
    const r6 = r[6]!;
    const r7 = r[7]!;
    const r8 = r[8]!;
    const r9 = r[9]!;
    const s1 = r1 * 5;
    const s2 = r2 * 5;
    const s3 = r3 * 5;
    const s4 = r4 * 5;
    const s5 = r5 * 5;
    const s6 = r6 * 5;
    const s7 = r7 * 5;
    const s8 = r8 * 5;
    const s9 = r9 * 5;
    let h0 = h[0]!;
    let h1 = h[1]!;
    let h2 = h[2]!;
    let h3 = h[3]!;
    let h4 = h[4]!;
    let h5 = h[5]!;
    let h6 = h[6]!;
    let h7 = h[7]!;
    let h8 = h[8]!;
    let h9 = h[9]!;
    let c = 0;

    for (const end = offset + length; offset < end; offset += 16) {
      // The block as eight 16-bit words, dealt out into 13-bit limbs.
      const t0 = m[offset + 0]! | (m[offset + 1]! << 8);
      const t1 = m[offset + 2]! | (m[offset + 3]! << 8);
      const t2 = m[offset + 4]! | (m[offset + 5]! << 8);
      const t3 = m[offset + 6]! | (m[offset + 7]! << 8);
      const t4 = m[offset + 8]! | (m[offset + 9]! << 8);
      const t5 = m[offset + 10]! | (m[offset + 11]! << 8);
      const t6 = m[offset + 12]! | (m[offset + 13]! << 8);
      const t7 = m[offset + 14]! | (m[offset + 15]! << 8);
      h0 += t0 & MASK;
      h1 += ((t0 >>> 13) | (t1 << 3)) & MASK;
      h2 += ((t1 >>> 10) | (t2 << 6)) & MASK;
      h3 += ((t2 >>> 7) | (t3 << 9)) & MASK;
      h4 += ((t3 >>> 4) | (t4 << 12)) & MASK;
      h5 += (t4 >>> 1) & MASK;
      h6 += ((t4 >>> 14) | (t5 << 2)) & MASK;
      h7 += ((t5 >>> 11) | (t6 << 5)) & MASK;
      h8 += ((t6 >>> 8) | (t7 << 8)) & MASK;
      h9 += (t7 >>> 5) | highBit;

      // Schoolbook multiplication; a term past limb nine wraps round times five.
      const d0 =
        h0 * r0 +
        h1 * s9 +
        h2 * s8 +
        h3 * s7 +
        h4 * s6 +
        h5 * s5 +
        h6 * s4 +
        h7 * s3 +
        h8 * s2 +
        h9 * s1;
      const d1 =
        h0 * r1 +
        h1 * r0 +
        h2 * s9 +
        h3 * s8 +
        h4 * s7 +
        h5 * s6 +
        h6 * s5 +
        h7 * s4 +
        h8 * s3 +
        h9 * s2;
      const d2 =
        h0 * r2 +
        h1 * r1 +
        h2 * r0 +
        h3 * s9 +
        h4 * s8 +
        h5 * s7 +
        h6 * s6 +
        h7 * s5 +
        h8 * s4 +
        h9 * s3;
      const d3 =
        h0 * r3 +
        h1 * r2 +
        h2 * r1 +
        h3 * r0 +
        h4 * s9 +
        h5 * s8 +
        h6 * s7 +
        h7 * s6 +
        h8 * s5 +
        h9 * s4;
      const d4 =
        h0 * r4 +
        h1 * r3 +
        h2 * r2 +
        h3 * r1 +
        h4 * r0 +
        h5 * s9 +
        h6 * s8 +
        h7 * s7 +
        h8 * s6 +
        h9 * s5;
      const d5 =
        h0 * r5 +
        h1 * r4 +
        h2 * r3 +
        h3 * r2 +
        h4 * r1 +
        h5 * r0 +
        h6 * s9 +
        h7 * s8 +
        h8 * s7 +
        h9 * s6;
      const d6 =
        h0 * r6 +
        h1 * r5 +
        h2 * r4 +
        h3 * r3 +
        h4 * r2 +
        h5 * r1 +
        h6 * r0 +
        h7 * s9 +
        h8 * s8 +
        h9 * s7;
      const d7 =
        h0 * r7 +
        h1 * r6 +
        h2 * r5 +
        h3 * r4 +
        h4 * r3 +
        h5 * r2 +
        h6 * r1 +
        h7 * r0 +
        h8 * s9 +
        h9 * s8;
      const d8 =
        h0 * r8 +
        h1 * r7 +
        h2 * r6 +
        h3 * r5 +
        h4 * r4 +
        h5 * r3 +
        h6 * r2 +
        h7 * r1 +
        h8 * r0 +
        h9 * s9;
      const d9 =
        h0 * r9 +
        h1 * r8 +
        h2 * r7 +
        h3 * r6 +
        h4 * r5 +
        h5 * r4 +
        h6 * r3 +
        h7 * r2 +
        h8 * r1 +
        h9 * r0;

      // One pass of carries leaves every limb but the second under 2^13,
      // and that one only slightly over, which the next round absorbs.
      c = Math.floor(d0 / RADIX);
      h0 = d0 - c * RADIX;
      const e1 = d1 + c;
      c = Math.floor(e1 / RADIX);
      h1 = e1 - c * RADIX;
      const e2 = d2 + c;
      c = Math.floor(e2 / RADIX);
      h2 = e2 - c * RADIX;
      const e3 = d3 + c;
      c = Math.floor(e3 / RADIX);
      h3 = e3 - c * RADIX;
      const e4 = d4 + c;
      c = Math.floor(e4 / RADIX);
      h4 = e4 - c * RADIX;
      const e5 = d5 + c;
      c = Math.floor(e5 / RADIX);
      h5 = e5 - c * RADIX;
      const e6 = d6 + c;
      c = Math.floor(e6 / RADIX);
      h6 = e6 - c * RADIX;
      const e7 = d7 + c;
      c = Math.floor(e7 / RADIX);
      h7 = e7 - c * RADIX;
      const e8 = d8 + c;
      c = Math.floor(e8 / RADIX);
      h8 = e8 - c * RADIX;
      const e9 = d9 + c;
      c = Math.floor(e9 / RADIX);
      h9 = e9 - c * RADIX;
      h0 += c * 5;
      c = Math.floor(h0 / RADIX);
      h0 -= c * RADIX;
      h1 += c;
    }

    h[0] = h0;
    h[1] = h1;
    h[2] = h2;
    h[3] = h3;
    h[4] = h4;
    h[5] = h5;
    h[6] = h6;
    h[7] = h7;
    h[8] = h8;
    h[9] = h9;
  }
}

export function poly1305(key: Uint8Array, message: Uint8Array): Uint8Array {
  return new Poly1305(key).update(message).finish();
}
