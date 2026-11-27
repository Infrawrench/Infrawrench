/**
 * ChaCha20 (the 20-round stream cipher), in plain TypeScript because
 * WebCrypto does not have it.
 *
 * The four words after the key are passed in as they sit in the state, which
 * covers both layouts in use: the original one OpenSSH speaks (a 64-bit block
 * counter in words 12 and 13, a 64-bit nonce in 14 and 15) and RFC 8439's
 * (a 32-bit counter in word 12, a 96-bit nonce in 13 to 15), which the test
 * vectors use.
 */

// "expand 32-byte k", little-endian.
const C0 = 0x61707865;
const C1 = 0x3320646e;
const C2 = 0x79622d32;
const C3 = 0x6b206574;

/** A 32-byte key as the eight little-endian words the block function works on. */
export function chachaKey(key: Uint8Array): Uint32Array {
  if (key.length !== 32) throw new Error("ChaCha20 key must be 32 bytes");
  const words = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    const o = i * 4;
    words[i] = (key[o]! | (key[o + 1]! << 8) | (key[o + 2]! << 16) | (key[o + 3]! << 24)) >>> 0;
  }
  return words;
}

/**
 * XOR `src` with the keystream into `dst` (which may be `src`). `counter` is
 * state word 12 for the first block and goes up by one per 64 bytes; it must
 * not wrap, which the SSH packet size limit guarantees by a wide margin.
 */
export function chacha20Xor(
  key: Uint32Array,
  counter: number,
  w13: number,
  w14: number,
  w15: number,
  src: Uint8Array,
  dst: Uint8Array,
): void {
  const k0 = key[0]! | 0;
  const k1 = key[1]! | 0;
  const k2 = key[2]! | 0;
  const k3 = key[3]! | 0;
  const k4 = key[4]! | 0;
  const k5 = key[5]! | 0;
  const k6 = key[6]! | 0;
  const k7 = key[7]! | 0;
  const length = src.length;
  let ctr = counter | 0;

  for (let offset = 0; offset < length; offset += 64) {
    let x0 = C0;
    let x1 = C1;
    let x2 = C2;
    let x3 = C3;
    let x4 = k0;
    let x5 = k1;
    let x6 = k2;
    let x7 = k3;
    let x8 = k4;
    let x9 = k5;
    let x10 = k6;
    let x11 = k7;
    let x12 = ctr;
    let x13 = w13 | 0;
    let x14 = w14 | 0;
    let x15 = w15 | 0;

    for (let round = 0; round < 10; round++) {
      // Column round.
      x0 = (x0 + x4) | 0;
      x12 ^= x0;
      x12 = (x12 << 16) | (x12 >>> 16);
      x8 = (x8 + x12) | 0;
      x4 ^= x8;
      x4 = (x4 << 12) | (x4 >>> 20);
      x0 = (x0 + x4) | 0;
      x12 ^= x0;
      x12 = (x12 << 8) | (x12 >>> 24);
      x8 = (x8 + x12) | 0;
      x4 ^= x8;
      x4 = (x4 << 7) | (x4 >>> 25);

      x1 = (x1 + x5) | 0;
      x13 ^= x1;
      x13 = (x13 << 16) | (x13 >>> 16);
      x9 = (x9 + x13) | 0;
      x5 ^= x9;
      x5 = (x5 << 12) | (x5 >>> 20);
      x1 = (x1 + x5) | 0;
      x13 ^= x1;
      x13 = (x13 << 8) | (x13 >>> 24);
      x9 = (x9 + x13) | 0;
      x5 ^= x9;
      x5 = (x5 << 7) | (x5 >>> 25);

      x2 = (x2 + x6) | 0;
      x14 ^= x2;
      x14 = (x14 << 16) | (x14 >>> 16);
      x10 = (x10 + x14) | 0;
      x6 ^= x10;
      x6 = (x6 << 12) | (x6 >>> 20);
      x2 = (x2 + x6) | 0;
      x14 ^= x2;
      x14 = (x14 << 8) | (x14 >>> 24);
      x10 = (x10 + x14) | 0;
      x6 ^= x10;
      x6 = (x6 << 7) | (x6 >>> 25);

      x3 = (x3 + x7) | 0;
      x15 ^= x3;
      x15 = (x15 << 16) | (x15 >>> 16);
      x11 = (x11 + x15) | 0;
      x7 ^= x11;
      x7 = (x7 << 12) | (x7 >>> 20);
      x3 = (x3 + x7) | 0;
      x15 ^= x3;
      x15 = (x15 << 8) | (x15 >>> 24);
      x11 = (x11 + x15) | 0;
      x7 ^= x11;
      x7 = (x7 << 7) | (x7 >>> 25);

      // Diagonal round.
      x0 = (x0 + x5) | 0;
      x15 ^= x0;
      x15 = (x15 << 16) | (x15 >>> 16);
      x10 = (x10 + x15) | 0;
      x5 ^= x10;
      x5 = (x5 << 12) | (x5 >>> 20);
      x0 = (x0 + x5) | 0;
      x15 ^= x0;
      x15 = (x15 << 8) | (x15 >>> 24);
      x10 = (x10 + x15) | 0;
      x5 ^= x10;
      x5 = (x5 << 7) | (x5 >>> 25);

      x1 = (x1 + x6) | 0;
      x12 ^= x1;
      x12 = (x12 << 16) | (x12 >>> 16);
      x11 = (x11 + x12) | 0;
      x6 ^= x11;
      x6 = (x6 << 12) | (x6 >>> 20);
      x1 = (x1 + x6) | 0;
      x12 ^= x1;
      x12 = (x12 << 8) | (x12 >>> 24);
      x11 = (x11 + x12) | 0;
      x6 ^= x11;
      x6 = (x6 << 7) | (x6 >>> 25);

      x2 = (x2 + x7) | 0;
      x13 ^= x2;
      x13 = (x13 << 16) | (x13 >>> 16);
      x8 = (x8 + x13) | 0;
      x7 ^= x8;
      x7 = (x7 << 12) | (x7 >>> 20);
      x2 = (x2 + x7) | 0;
      x13 ^= x2;
      x13 = (x13 << 8) | (x13 >>> 24);
      x8 = (x8 + x13) | 0;
      x7 ^= x8;
      x7 = (x7 << 7) | (x7 >>> 25);

      x3 = (x3 + x4) | 0;
      x14 ^= x3;
      x14 = (x14 << 16) | (x14 >>> 16);
      x9 = (x9 + x14) | 0;
      x4 ^= x9;
      x4 = (x4 << 12) | (x4 >>> 20);
      x3 = (x3 + x4) | 0;
      x14 ^= x3;
      x14 = (x14 << 8) | (x14 >>> 24);
      x9 = (x9 + x14) | 0;
      x4 ^= x9;
      x4 = (x4 << 7) | (x4 >>> 25);
    }

    x0 = (x0 + C0) | 0;
    x1 = (x1 + C1) | 0;
    x2 = (x2 + C2) | 0;
    x3 = (x3 + C3) | 0;
    x4 = (x4 + k0) | 0;
    x5 = (x5 + k1) | 0;
    x6 = (x6 + k2) | 0;
    x7 = (x7 + k3) | 0;
    x8 = (x8 + k4) | 0;
    x9 = (x9 + k5) | 0;
    x10 = (x10 + k6) | 0;
    x11 = (x11 + k7) | 0;
    x12 = (x12 + ctr) | 0;
    x13 = (x13 + w13) | 0;
    x14 = (x14 + w14) | 0;
    x15 = (x15 + w15) | 0;
    ctr = (ctr + 1) | 0;

    if (offset + 64 <= length) {
      xorWord(src, dst, offset, x0);
      xorWord(src, dst, offset + 4, x1);
      xorWord(src, dst, offset + 8, x2);
      xorWord(src, dst, offset + 12, x3);
      xorWord(src, dst, offset + 16, x4);
      xorWord(src, dst, offset + 20, x5);
      xorWord(src, dst, offset + 24, x6);
      xorWord(src, dst, offset + 28, x7);
      xorWord(src, dst, offset + 32, x8);
      xorWord(src, dst, offset + 36, x9);
      xorWord(src, dst, offset + 40, x10);
      xorWord(src, dst, offset + 44, x11);
      xorWord(src, dst, offset + 48, x12);
      xorWord(src, dst, offset + 52, x13);
      xorWord(src, dst, offset + 56, x14);
      xorWord(src, dst, offset + 60, x15);
    } else {
      const words = [x0, x1, x2, x3, x4, x5, x6, x7, x8, x9, x10, x11, x12, x13, x14, x15];
      for (let i = offset; i < length; i++) {
        const j = i - offset;
        dst[i] = src[i]! ^ ((words[j >>> 2]! >>> ((j & 3) * 8)) & 0xff);
      }
    }
  }
}

function xorWord(src: Uint8Array, dst: Uint8Array, at: number, word: number): void {
  dst[at] = src[at]! ^ (word & 0xff);
  dst[at + 1] = src[at + 1]! ^ ((word >>> 8) & 0xff);
  dst[at + 2] = src[at + 2]! ^ ((word >>> 16) & 0xff);
  dst[at + 3] = src[at + 3]! ^ (word >>> 24);
}
