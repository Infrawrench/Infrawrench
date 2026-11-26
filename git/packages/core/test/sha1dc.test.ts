import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitError,
  PackIndexer,
  Sha1,
  buildPack,
  hashObject,
  hashObjectBytes,
  hashObjectSync,
  sha1Sync,
  toHex,
} from "../src/index";
import { DV_COUNT, DV_DM, DV_TEST_STEP, ubcCheck } from "../src/sha1dc-ubc.gen";
import {
  SHAMBLES_1,
  SHAMBLES_2,
  SHAMBLES_SHA1,
  SHATTERED_1,
  SHATTERED_2,
} from "./fixtures/sha1-collisions";
import { prng, randomBytes } from "./helpers";

const nodeSha1 = (data: Uint8Array): string => createHash("sha1").update(data).digest("hex");
const plain = (data: Uint8Array): string =>
  new Sha1({ detectCollisions: false }).update(data).digestHex();

const collisions = [
  ["SHAttered, first file", SHATTERED_1],
  ["SHAttered, second file", SHATTERED_2],
  ["Shambles, first message", SHAMBLES_1],
  ["Shambles, second message", SHAMBLES_2],
] as const;

function refusal(run: () => unknown): GitError {
  try {
    run();
  } catch (error) {
    if (error instanceof GitError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the published collisions", () => {
  it("are collisions: each pair differs and has one SHA-1", () => {
    expect(toHex(SHATTERED_1)).not.toBe(toHex(SHATTERED_2));
    expect(plain(SHATTERED_1)).toBe(plain(SHATTERED_2));
    expect(plain(SHATTERED_1)).toBe(nodeSha1(SHATTERED_1));
    expect(toHex(SHAMBLES_1)).not.toBe(toHex(SHAMBLES_2));
    expect(plain(SHAMBLES_1)).toBe(SHAMBLES_SHA1);
    expect(plain(SHAMBLES_2)).toBe(SHAMBLES_SHA1);
  });

  it.each(collisions)("%s is refused", (_name, data) => {
    const error = refusal(() => new Sha1().update(data).digest());
    expect(error.code).toBe("sha1-collision");
    expect(error.message).toMatch(/collision/);
    expect(refusal(() => sha1Sync(data)).code).toBe("sha1-collision");
  });

  it.each(collisions)(
    "%s is refused however it is split, and with anything after it",
    (_name, data) => {
      const next = prng(7);
      for (let round = 0; round < 40; round++) {
        const hash = new Sha1();
        const tail = randomBytes(next() % 500, next);
        const whole = new Uint8Array(data.length + tail.length);
        whole.set(data, 0);
        whole.set(tail, data.length);
        const error = refusal(() => {
          let at = 0;
          while (at < whole.length) {
            const take = Math.min(whole.length - at, 1 + (next() % 97));
            hash.update(whole.subarray(at, at + take));
            at += take;
          }
          hash.digest();
        });
        expect(error.code).toBe("sha1-collision");
        expect(hash.collision).toBe(true);
      }
    },
  );

  it("is refused at the block that completes it, and the hasher stays refused until reset", () => {
    // SHAttered's two differing blocks are bytes 192..319; the second completes the collision.
    const hash = new Sha1();
    hash.update(SHATTERED_1.subarray(0, 256));
    expect(hash.collision).toBe(false);
    expect(() => hash.update(SHATTERED_1.subarray(256, 320))).toThrow(GitError);
    expect(hash.collision).toBe(true);
    expect(() => hash.update(new Uint8Array(10))).toThrow(GitError);
    expect(() => hash.digest()).toThrow(GitError);
    expect(hash.reset().collision).toBe(false);
    expect(hash.update(new TextEncoder().encode("abc")).digestHex()).toBe(
      "a9993e364706816aba3e25717850c26c9cd0d89d",
    );
  });

  it("is not refused once a byte of the colliding blocks is changed", () => {
    for (const at of [192, 200, 255, 256, 300, 319]) {
      const changed = SHATTERED_1.slice();
      changed[at] = changed[at]! ^ 0x01;
      expect(new Sha1().update(changed).digestHex()).toBe(nodeSha1(changed));
    }
    // The same bytes behind a different beginning are not a collision either:
    // this is why the two PDFs have different ids as git blobs.
    expect(hashObjectSync("blob", SHATTERED_1)).not.toBe(hashObjectSync("blob", SHATTERED_2));
  });
});

describe("ordinary input", () => {
  it("is never refused, and hashes as it always did", () => {
    const next = prng(11);
    const inputs: Uint8Array[] = [
      new Uint8Array(0),
      new Uint8Array(1 << 20),
      new Uint8Array(1 << 20).fill(0xff),
      new TextEncoder().encode("the quick brown fox jumps over the lazy dog\n".repeat(20_000)),
      randomBytes(4 << 20, next),
    ];
    for (let i = 0; i < 300; i++) inputs.push(randomBytes(next() % 4096, next));
    for (const data of inputs) {
      const hash = new Sha1().update(data);
      expect(hash.digestHex()).toBe(nodeSha1(data));
      expect(hash.collision).toBe(false);
    }
  });
});

describe("the disturbance vector table", () => {
  it("has 32 vectors, each a message difference that follows the SHA-1 expansion", () => {
    expect(DV_COUNT).toBe(32);
    expect(DV_DM.length).toBe(32 * 80);
    expect([...new Set(DV_TEST_STEP)].sort()).toEqual([58, 65]);
    // A difference of expanded messages is itself an expanded message
    // (the expansion is linear), which pins every word of the table.
    for (let dv = 0; dv < DV_COUNT; dv++) {
      for (let i = 16; i < 80; i++) {
        const at = dv * 80 + i;
        const x = DV_DM[at - 3]! ^ DV_DM[at - 8]! ^ DV_DM[at - 14]! ^ DV_DM[at - 16]!;
        expect(DV_DM[at]).toBe((x << 1) | (x >>> 31));
      }
    }
  });

  it("passes no vector for an ordinary block, and passes one for a colliding block", () => {
    const expand = (block: Uint8Array): Int32Array => {
      const W = new Int32Array(80);
      const view = new DataView(block.buffer, block.byteOffset, 64);
      for (let i = 0; i < 16; i++) W[i] = view.getInt32(i * 4);
      for (let i = 16; i < 80; i++) {
        const x = W[i - 3]! ^ W[i - 8]! ^ W[i - 14]! ^ W[i - 16]!;
        W[i] = (x << 1) | (x >>> 31);
      }
      return W;
    };
    expect(ubcCheck(expand(new Uint8Array(64)))).toBe(0);
    // SHAttered was built on the vector II(52,0), bit 27 of the mask.
    expect(ubcCheck(expand(SHATTERED_1.subarray(256, 320))) & (1 << 27)).not.toBe(0);
    expect(ubcCheck(expand(SHATTERED_2.subarray(256, 320))) & (1 << 27)).not.toBe(0);
  });
});

describe("object ids", () => {
  it("never come from a hash without collision detection", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    const next = prng(3);
    const large = randomBytes(300_000, next);
    const small = new TextEncoder().encode("small\n");

    expect(await hashObject("blob", large)).toBe(hashObjectSync("blob", large));
    expect(toHex(await hashObjectBytes("blob", small))).toBe(hashObjectSync("blob", small));

    // A pack with an object large enough for the indexer's deferred path.
    const { pack } = await buildPack([
      { type: "blob", data: large },
      { type: "blob", data: small },
    ]);
    for (const options of [{}, { nativeHashBytes: 0, hashQueueBytes: 1 << 30 }]) {
      const indexer = new PackIndexer(options);
      for (let at = 0; at < pack.length; at += 4096) {
        indexer.write(pack.subarray(at, at + 4096));
        await indexer.settle();
      }
      const result = await indexer.finish();
      expect([...result.objects].map((object) => object.oid).sort()).toEqual(
        [hashObjectSync("blob", large), hashObjectSync("blob", small)].sort(),
      );
    }
    expect(digest.mock.calls.filter(([algorithm]) => algorithm === "SHA-1")).toEqual([]);
  });

  it("a pack with an object the hasher refuses is refused, streamed or deferred", async () => {
    // No git object that collides is public (the header in front of the
    // content changes every block), so the hasher is made to refuse one
    // object's bytes, and the pack that carries it must be refused with it.
    const marked = new TextEncoder().encode(`${"x".repeat(100_000)} refuse this object`);
    const update = Sha1.prototype.update;
    vi.spyOn(Sha1.prototype, "update").mockImplementation(function (this: Sha1, data: Uint8Array) {
      if (
        data.length >= 18 &&
        new TextDecoder().decode(data.subarray(-18)) === "refuse this object"
      ) {
        throw new GitError("sha1-collision", "SHA-1 collision detected");
      }
      return update.call(this, data);
    });
    const { pack } = await buildPack([
      { type: "blob", data: new TextEncoder().encode("fine\n") },
      { type: "blob", data: marked },
    ]);
    for (const options of [{}, { nativeHashBytes: 0, hashQueueBytes: 1 << 30 }]) {
      const run = async (): Promise<void> => {
        const indexer = new PackIndexer(options);
        indexer.write(pack);
        await indexer.settle();
        await indexer.finish();
      };
      await expect(run()).rejects.toMatchObject({ name: "GitError", code: "sha1-collision" });
    }
    expect(() => hashObjectSync("blob", marked)).toThrow(GitError);
    await expect(hashObject("blob", marked)).rejects.toMatchObject({ code: "sha1-collision" });
  });
});
