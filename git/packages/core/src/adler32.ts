/** Adler-32, the checksum at the end of a zlib stream. Start from 1. */
export function adler32(data: Uint8Array, previous = 1): number {
  let a = previous & 0xffff;
  let b = previous >>> 16;
  let i = 0;
  const end = data.length;
  while (i < end) {
    // 5552 is the most bytes the sums can take before they pass 2^32.
    const stop = Math.min(end, i + 5552);
    for (; i < stop; i++) {
      a += data[i]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}
