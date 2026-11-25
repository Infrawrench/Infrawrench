import { createHash } from "node:crypto";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  Sha1,
  adler32,
  crc32,
  fromHex,
  hashObject,
  hashObjectSync,
  isObjectId,
  sha1,
  sha1Sync,
  toHex,
} from "../src";
import { prng, randomBytes } from "./helpers";

const nodeSha1 = (data: Uint8Array): string => createHash("sha1").update(data).digest("hex");

describe("sha1", () => {
  it("matches the known vectors", () => {
    expect(toHex(sha1Sync(new Uint8Array(0)))).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(toHex(sha1Sync(new TextEncoder().encode("abc")))).toBe(
      "a9993e364706816aba3e25717850c26c9cd0d89d",
    );
  });

  it("matches node for every length around the block boundaries", async () => {
    const next = prng(1);
    for (let length = 0; length <= 260; length++) {
      const data = randomBytes(length, next);
      expect(toHex(sha1Sync(data))).toBe(nodeSha1(data));
    }
    const data = randomBytes(100_000, next);
    expect(toHex(await sha1(data))).toBe(nodeSha1(data));
  });

  it("gives the same digest however the input is split", () => {
    const next = prng(2);
    const data = randomBytes(50_000, next);
    const expected = nodeSha1(data);
    for (let round = 0; round < 50; round++) {
      const hash = new Sha1();
      let at = 0;
      while (at < data.length) {
        const take = Math.min(data.length - at, next() % 300);
        hash.update(data.subarray(at, at + take));
        at += take;
      }
      expect(hash.digestHex()).toBe(expected);
    }
  });

  it("can be reset and reused, and refuses use after digest", () => {
    const hash = new Sha1().update(new Uint8Array([1, 2, 3]));
    hash.digest();
    expect(() => hash.update(new Uint8Array(1))).toThrow();
    expect(hash.reset().update(new TextEncoder().encode("abc")).digestHex()).toBe(
      "a9993e364706816aba3e25717850c26c9cd0d89d",
    );
  });

  it("hashes a length that needs more than 32 bits of bit count", () => {
    // 600 MiB is past 2^32 bits, which is where a 32-bit length field would wrap.
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    const ours = new Sha1();
    const theirs = createHash("sha1");
    for (let i = 0; i < 600; i++) {
      ours.update(chunk);
      theirs.update(chunk);
    }
    expect(ours.digestHex()).toBe(theirs.digest("hex"));
  });
});

describe("object ids", () => {
  it("hashes the way git does", async () => {
    const empty = new Uint8Array(0);
    expect(hashObjectSync("blob", empty)).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(await hashObject("blob", empty)).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(hashObjectSync("tree", empty)).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    const hello = new TextEncoder().encode("hello\n");
    expect(await hashObject("blob", hello)).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(hashObjectSync("blob", hello)).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("round-trips hex and rejects what is not hex", () => {
    const bytes = randomBytes(20, prng(3));
    expect(fromHex(toHex(bytes))).toEqual(bytes);
    expect(isObjectId(toHex(bytes))).toBe(true);
    expect(isObjectId(toHex(bytes).toUpperCase())).toBe(false);
    expect(isObjectId("abc")).toBe(false);
    expect(() => fromHex("zz")).toThrow();
    expect(() => fromHex("abc")).toThrow();
  });
});

describe("crc32 and adler32", () => {
  it("match zlib, in one piece and in parts", () => {
    const next = prng(4);
    for (const length of [0, 1, 7, 8, 9, 63, 64, 65, 1000, 5552, 5553, 70_000]) {
      const data = randomBytes(length, next);
      expect(crc32(data)).toBe(zlib.crc32(data));
      const cut = length === 0 ? 0 : next() % length;
      expect(crc32(data.subarray(cut), crc32(data.subarray(0, cut)))).toBe(zlib.crc32(data));
      // The last four bytes of a zlib stream are the Adler-32 of what it holds.
      const deflated = zlib.deflateSync(data);
      const expected = deflated.readUInt32BE(deflated.length - 4);
      expect(adler32(data)).toBe(expected);
      expect(adler32(data.subarray(cut), adler32(data.subarray(0, cut)))).toBe(expected);
    }
  });
});
