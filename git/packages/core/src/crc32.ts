/** CRC-32 (IEEE), the checksum a pack index keeps for each entry's packed bytes. */

let tables: Int32Array[] | null = null;

// Slicing-by-8: eight tables let the loop take eight bytes per step.
function build(): Int32Array[] {
  const t: Int32Array[] = [];
  for (let k = 0; k < 8; k++) t.push(new Int32Array(256));
  const t0 = t[0]!;
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t0[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    let c = t0[n]!;
    for (let k = 1; k < 8; k++) {
      c = t0[c & 0xff]! ^ (c >>> 8);
      t[k]![n] = c;
    }
  }
  return t;
}

/**
 * Updates a running CRC-32 with `data`. Start from 0 and pass each result
 * back in; the value returned is always the finished, unsigned checksum.
 */
export function crc32(data: Uint8Array, previous = 0): number {
  const t = (tables ??= build());
  const t0 = t[0]!;
  const t1 = t[1]!;
  const t2 = t[2]!;
  const t3 = t[3]!;
  const t4 = t[4]!;
  const t5 = t[5]!;
  const t6 = t[6]!;
  const t7 = t[7]!;
  let c = ~previous;
  let i = 0;
  const end = data.length;
  for (; i + 8 <= end; i += 8) {
    c ^= data[i]! | (data[i + 1]! << 8) | (data[i + 2]! << 16) | (data[i + 3]! << 24);
    c =
      t7[c & 0xff]! ^
      t6[(c >>> 8) & 0xff]! ^
      t5[(c >>> 16) & 0xff]! ^
      t4[c >>> 24]! ^
      t3[data[i + 4]!]! ^
      t2[data[i + 5]!]! ^
      t1[data[i + 6]!]! ^
      t0[data[i + 7]!]!;
  }
  for (; i < end; i++) c = t0[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}
