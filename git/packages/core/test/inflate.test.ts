import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  GitError,
  Inflater,
  concatBytes,
  deflate,
  inflate,
  inflateSync,
  encodeLooseObject,
  decodeLooseObject,
} from "../src";
import { prng, randomBytes } from "./helpers";

/** Inputs chosen to reach every block type and both short and long matches. */
function samples(): Array<{ name: string; data: Uint8Array }> {
  const next = prng(7);
  const text = new TextEncoder().encode(
    Array.from({ length: 4000 }, (_, i) => `line ${i % 97} of some repetitive source text\n`).join(
      "",
    ),
  );
  const mixed = concatBytes([
    randomBytes(5000, next),
    text.subarray(0, 20_000),
    randomBytes(300, next),
  ]);
  // Bytes drawn from a skewed alphabet: compresses with long Huffman codes and few matches.
  const skewed = new Uint8Array(200_000);
  for (let i = 0; i < skewed.length; i++) {
    const r = next() % 1000;
    skewed[i] = r < 600 ? 0 : r < 850 ? 1 + (r % 3) : r % 256;
  }
  return [
    { name: "empty", data: new Uint8Array(0) },
    { name: "one byte", data: new Uint8Array([65]) },
    { name: "zeros", data: new Uint8Array(300_000) },
    { name: "text", data: text },
    { name: "random", data: randomBytes(150_000, next) },
    { name: "mixed", data: mixed },
    { name: "skewed", data: skewed },
    // The same 30 KB twice: matches reach back nearly the whole 32 KB window.
    {
      name: "far matches",
      data: concatBytes([
        randomBytes(30_000, prng(9)),
        randomBytes(30_000, prng(9)),
        randomBytes(1000, next),
      ]),
    },
  ];
}

const variants: Array<{ name: string; options: zlib.ZlibOptions }> = [
  { name: "stored", options: { level: 0 } },
  { name: "level 1", options: { level: 1 } },
  { name: "level 6", options: { level: 6 } },
  { name: "level 9", options: { level: 9 } },
  { name: "fixed huffman", options: { strategy: zlib.constants.Z_FIXED } },
  { name: "huffman only", options: { strategy: zlib.constants.Z_HUFFMAN_ONLY } },
  { name: "rle", options: { strategy: zlib.constants.Z_RLE } },
  { name: "small window", options: { windowBits: 9, level: 9 } },
];

describe("inflateSync", () => {
  for (const sample of samples()) {
    for (const variant of variants) {
      it(`inflates ${sample.name} compressed as ${variant.name}`, () => {
        const compressed = new Uint8Array(zlib.deflateSync(sample.data, variant.options));
        const result = inflateSync(compressed);
        expect(result.consumed).toBe(compressed.length);
        expect(Buffer.compare(result.data, sample.data)).toBe(0);
      });
    }
  }

  it("reports exactly where a stream ends when more data follows", () => {
    const next = prng(11);
    for (const sample of samples()) {
      for (const variant of variants) {
        const compressed = new Uint8Array(zlib.deflateSync(sample.data, variant.options));
        const trailing = randomBytes(1 + (next() % 40), next);
        const lead = randomBytes(next() % 9, next);
        const buffer = concatBytes([lead, compressed, trailing]);
        const result = inflateSync(buffer, { offset: lead.length, size: sample.data.length });
        expect(result.consumed).toBe(compressed.length);
        expect(Buffer.compare(result.data, sample.data)).toBe(0);
      }
    }
  });

  it("reads back-to-back streams the way a pack lays them out", () => {
    const parts = samples().map((sample) => new Uint8Array(zlib.deflateSync(sample.data)));
    const buffer = concatBytes(parts);
    let offset = 0;
    for (const [i, sample] of samples().entries()) {
      const result = inflateSync(buffer, { offset });
      expect(result.consumed).toBe(parts[i]!.length);
      expect(Buffer.compare(result.data, sample.data)).toBe(0);
      offset += result.consumed;
    }
    expect(offset).toBe(buffer.length);
  });

  it("handles raw deflate", () => {
    const data = samples()[3]!.data;
    const raw = new Uint8Array(zlib.deflateRawSync(data));
    const result = inflateSync(concatBytes([raw, new Uint8Array(5)]), { raw: true });
    expect(result.consumed).toBe(raw.length);
    expect(Buffer.compare(result.data, data)).toBe(0);
  });

  it("checks a declared size", () => {
    const compressed = new Uint8Array(zlib.deflateSync(new Uint8Array(1000)));
    expect(() => inflateSync(compressed, { size: 999 })).toThrow(GitError);
    expect(() => inflateSync(compressed, { size: 1001 })).toThrow(GitError);
    expect(() => inflateSync(compressed, { maxSize: 10 })).toThrow(/limit/);
  });
});

describe("Inflater", () => {
  it("gives the same output and end position for any chunking", () => {
    const next = prng(13);
    for (const sample of samples()) {
      for (const variant of variants) {
        const compressed = new Uint8Array(zlib.deflateSync(sample.data, variant.options));
        const trailing = randomBytes(17, next);
        const buffer = concatBytes([compressed, trailing]);
        for (const pace of [1, 2, 3, 7, 61, 1000, 0]) {
          // A whole run of single bytes is slow on the big samples; the small ones cover it.
          if (pace <= 3 && compressed.length > 40_000) continue;
          const inflater = new Inflater();
          const out: Uint8Array[] = [];
          let at = 0;
          let unused = 0;
          while (at < buffer.length && !inflater.done) {
            const take = pace === 0 ? 1 + (next() % 5000) : pace;
            const chunk = buffer.subarray(at, Math.min(buffer.length, at + take));
            unused = inflater.push(chunk, (piece) => out.push(piece.slice()));
            at += chunk.length;
          }
          expect(inflater.done).toBe(true);
          expect(at - unused).toBe(compressed.length);
          expect(inflater.bytesIn).toBe(compressed.length);
          expect(inflater.bytesOut).toBe(sample.data.length);
          expect(Buffer.compare(concatBytes(out), sample.data)).toBe(0);
        }
      }
    }
  });

  it("can be reset and reused", () => {
    const inflater = new Inflater();
    for (const sample of samples()) {
      const compressed = new Uint8Array(zlib.deflateSync(sample.data));
      const out: Uint8Array[] = [];
      inflater.reset();
      expect(inflater.push(compressed, (piece) => out.push(piece.slice()))).toBe(0);
      expect(inflater.done).toBe(true);
      expect(Buffer.compare(concatBytes(out), sample.data)).toBe(0);
    }
  });

  it("returns everything as unused once the stream is over", () => {
    const inflater = new Inflater();
    inflater.push(new Uint8Array(zlib.deflateSync(new Uint8Array(10))), () => undefined);
    expect(inflater.push(new Uint8Array(33), () => undefined)).toBe(33);
  });
});

describe("damaged input", () => {
  const original = samples()[5]!.data;
  const compressed = new Uint8Array(zlib.deflateSync(original));

  it("is not done when the stream is truncated", () => {
    for (const cut of [0, 1, 2, 3, 10, compressed.length - 5, compressed.length - 1]) {
      expect(() => inflateSync(compressed.subarray(0, cut))).toThrow(/truncated/);
    }
  });

  it("never returns wrong data for a corrupted stream", () => {
    const next = prng(17);
    let rejected = 0;
    for (let round = 0; round < 400; round++) {
      const damaged = compressed.slice();
      const at = next() % damaged.length;
      damaged[at] = damaged[at]! ^ (1 << (next() % 8));
      try {
        const result = inflateSync(damaged);
        // A flipped bit can only pass if it changed nothing that matters.
        expect(Buffer.compare(result.data, original)).toBe(0);
      } catch (error) {
        expect(error).toBeInstanceOf(GitError);
        rejected++;
      }
    }
    expect(rejected).toBeGreaterThan(390);
  });

  it("agrees with zlib about which random inputs are streams at all", () => {
    const next = prng(19);
    for (let round = 0; round < 3000; round++) {
      const garbage = randomBytes(1 + (next() % 200), next);
      // A valid two-byte header, so the fuzz reaches the block decoder instead of stopping at once.
      garbage[0] = 0x78;
      garbage[1] = 0x9c;
      let theirs: Buffer | null = null;
      try {
        theirs = zlib.inflateSync(garbage);
      } catch {
        theirs = null;
      }
      let ours: Uint8Array | null = null;
      try {
        ours = inflateSync(garbage).data;
      } catch (error) {
        expect(error).toBeInstanceOf(GitError);
      }
      // zlib refusing while this accepts is the dangerous direction: a pack git cannot read.
      if (ours !== null) {
        expect(theirs).not.toBeNull();
        expect(Buffer.compare(ours, theirs!)).toBe(0);
      }
    }
  });

  it("refuses the same malformed raw streams zlib refuses", () => {
    const next = prng(23);
    let accepted = 0;
    for (let round = 0; round < 20_000; round++) {
      const garbage = randomBytes(1 + (next() % 60), next);
      let theirs: Buffer | null = null;
      try {
        theirs = zlib.inflateRawSync(garbage);
      } catch {
        theirs = null;
      }
      let ours: Uint8Array | null = null;
      try {
        ours = inflateSync(garbage, { raw: true }).data;
      } catch (error) {
        expect(error).toBeInstanceOf(GitError);
      }
      if (ours !== null) {
        accepted++;
        expect(theirs).not.toBeNull();
        expect(Buffer.compare(ours, theirs!)).toBe(0);
      }
    }
    // Some random inputs are real streams (a stored or fixed block is easy to hit by chance).
    expect(accepted).toBeGreaterThan(0);
  });

  it("rejects a preset dictionary and a bad header", () => {
    expect(() => inflateSync(new Uint8Array([0x78, 0xbb, 0, 0, 0, 0]))).toThrow(GitError);
    expect(() => inflateSync(new Uint8Array([0x00, 0x00, 0, 0]))).toThrow(GitError);
  });
});

describe("zlib through the platform streams", () => {
  it("round-trips and interoperates with zlib", async () => {
    for (const sample of samples()) {
      const compressed = await deflate(sample.data);
      expect(Buffer.compare(zlib.inflateSync(compressed), sample.data)).toBe(0);
      expect(Buffer.compare(await inflate(compressed), sample.data)).toBe(0);
      expect(Buffer.compare(inflateSync(compressed).data, sample.data)).toBe(0);
      expect(Buffer.compare(await inflate(zlib.deflateSync(sample.data)), sample.data)).toBe(0);
    }
  });

  it("rejects damaged input with a GitError", async () => {
    await expect(inflate(new Uint8Array([1, 2, 3, 4]))).rejects.toBeInstanceOf(GitError);
  });

  it("encodes and decodes loose objects", async () => {
    const data = new TextEncoder().encode("hello\n");
    const loose = await encodeLooseObject({ type: "blob", data });
    expect(zlib.inflateSync(loose).toString("latin1")).toBe("blob 6\0hello\n");
    expect(await decodeLooseObject(loose)).toEqual({ type: "blob", data });
    await expect(
      decodeLooseObject(new Uint8Array(zlib.deflateSync("blob 7\0hello\n"))),
    ).rejects.toBeInstanceOf(GitError);
    await expect(
      decodeLooseObject(new Uint8Array(zlib.deflateSync("nope 6\0hello\n"))),
    ).rejects.toBeInstanceOf(GitError);
  });
});
