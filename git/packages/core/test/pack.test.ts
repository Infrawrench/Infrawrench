import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GitError,
  MemoryObjectStore,
  type ObjectId,
  type PackEntryWithData,
  type PackIndexResult,
  PackIndex,
  PackIndexer,
  PackParser,
  buildPack,
  cachedRangeReader,
  createDelta,
  decodeEntryHeader,
  encodeEntryHeader,
  hashObjectSync,
  indexPack,
  memoryRangeReader,
  packIndexSource,
  readPackEntries,
  readPackEntryAt,
  readPackObjectAt,
  writePackIndex,
} from "../src";
import {
  catFileBatch,
  chunked,
  cleanupTempDirs,
  describeGit,
  fileRangeReader,
  git,
  gitObjectReader,
  gitRaw,
  listObjects,
  makeFixtureRepo,
  packFiles,
  prng,
  randomBytes,
  readBytes,
  tempDir,
} from "./helpers";

afterAll(cleanupTempDirs);

interface VerifiedEntry {
  oid: ObjectId;
  type: string;
  offset: number;
  depth: number;
}

/** What `git verify-pack -v` says is in a pack: the reference every index is checked against. */
function verifyPack(idxPath: string): VerifiedEntry[] {
  const out = git(["verify-pack", "-v", idxPath]);
  const entries: VerifiedEntry[] = [];
  for (const line of out.split("\n")) {
    const match = /^([0-9a-f]{40}) (\w+)\s+(\d+) (\d+) (\d+)(?: (\d+) [0-9a-f]{40})?$/.exec(line);
    if (!match) continue;
    entries.push({
      oid: match[1]!,
      type: match[2]!,
      offset: Number(match[5]),
      depth: Number(match[6] ?? 0),
    });
  }
  return entries;
}

function sortedObjects(result: PackIndexResult): string[] {
  return [...result.objects].map((o) => `${o.oid} ${o.type} ${o.offset}`).sort();
}

// Not the size: for an object stored as a delta, verify-pack prints the delta's size.
function expectedObjects(entries: VerifiedEntry[]): string[] {
  return entries.map((e) => `${e.oid} ${e.type} ${e.offset}`).sort();
}

function sizedObjects(result: PackIndexResult): string[] {
  return [...result.objects].map((o) => `${o.oid} ${o.type} ${o.size}`).sort();
}

/** Writes pack bytes into a fresh directory and lets git index them, returning the paths. */
function gitIndexPack(pack: Uint8Array): { pack: string; idx: string } {
  const dir = tempDir("pack");
  const packPath = join(dir, "test.pack");
  writeFileSync(packPath, pack);
  git(["index-pack", packPath]);
  return { pack: packPath, idx: join(dir, "test.idx") };
}

function countTypes(pack: Uint8Array): Promise<Record<string, number>> {
  return (async () => {
    const counts: Record<string, number> = {};
    for await (const entry of readPackEntries([pack]))
      counts[entry.type] = (counts[entry.type] ?? 0) + 1;
    return counts;
  })();
}

describe("entry headers", () => {
  it("round-trip sizes and offsets of every magnitude", () => {
    const sizes = [
      0,
      1,
      15,
      16,
      17,
      127,
      128,
      2047,
      2048,
      65535,
      2 ** 31,
      2 ** 32 + 5,
      2 ** 45 + 3,
    ];
    for (const size of sizes) {
      const plain = encodeEntryHeader("blob", size);
      expect(decodeEntryHeader(plain, 0, 100)).toEqual({
        offset: 100,
        type: "blob",
        size,
        headerLength: plain.length,
      });
      for (const distance of [
        1,
        127,
        128,
        129,
        16383,
        16384,
        16511,
        16512,
        2 ** 21 + 7,
        2 ** 33 + 9,
      ]) {
        const offset = 2 ** 40;
        const header = encodeEntryHeader("ofs-delta", size, { distance });
        expect(decodeEntryHeader(header, 0, offset)).toEqual({
          offset,
          type: "ofs-delta",
          size,
          headerLength: header.length,
          baseOffset: offset - distance,
        });
        // Every strict prefix is "need more bytes", never a wrong answer.
        for (let cut = 0; cut < header.length; cut++) {
          expect(decodeEntryHeader(header.subarray(0, cut), 0, offset)).toBeNull();
        }
      }
      const oid = "ce013625030ba8dba906f756967f9e9ca394464a";
      const ref = encodeEntryHeader("ref-delta", size, { oid });
      expect(decodeEntryHeader(ref, 0, 50)?.baseOid).toBe(oid);
    }
  });

  it("refuses a delta that points outside the pack", () => {
    const header = encodeEntryHeader("ofs-delta", 10, { distance: 500 });
    expect(() => decodeEntryHeader(header, 0, 400)).toThrow(GitError);
    expect(() => decodeEntryHeader(header, 0, 505)).toThrow(GitError);
    expect(() => decodeEntryHeader(new Uint8Array([0x50]), 0, 12)).toThrow(GitError);
    expect(() => encodeEntryHeader("ref-delta", 10, { oid: "abcd" })).toThrow(GitError);
    expect(() => encodeEntryHeader("ofs-delta", 10)).toThrow(GitError);
  });
});

describeGit("packs written by git", () => {
  let repo = "";
  let all: ReturnType<typeof listObjects> = [];

  beforeAll(() => {
    repo = makeFixtureRepo({ commits: 120 });
    all = listObjects(repo);
  });

  it("indexes a repacked repository: ids, types, sizes, offsets and an identical .idx", async () => {
    git(["repack", "-adfq", "--depth=50", "--window=50"], { cwd: repo });
    const [files] = packFiles(repo);
    const pack = readBytes(files!.pack);
    const result = await indexPack([pack], { readRange: memoryRangeReader(pack) });

    const verified = verifyPack(files!.idx);
    expect(result.objectCount).toBe(all.length);
    expect(sortedObjects(result)).toEqual(expectedObjects(verified));
    expect(sizedObjects(result)).toEqual(all.map((o) => `${o.oid} ${o.type} ${o.size}`).sort());
    expect(result.externalBases).toEqual([]);
    // The fixture is built to make chains: without them this would prove little.
    expect(Math.max(...verified.map((e) => e.depth))).toBeGreaterThan(20);
    const types = await countTypes(pack);
    expect(types["ofs-delta"]).toBeGreaterThan(200);

    const idx = writePackIndex(result.objects, result.checksum);
    expect(Buffer.compare(idx, readBytes(files!.idx))).toBe(0);
  });

  it("indexes a `gc --aggressive` pack with deeper chains", async () => {
    git(["gc", "--aggressive", "--quiet", "--prune=now"], { cwd: repo });
    const [files] = packFiles(repo);
    const pack = readBytes(files!.pack);
    const result = await indexPack(chunked(pack, 4096), { readRange: memoryRangeReader(pack) });
    expect(sortedObjects(result)).toEqual(expectedObjects(verifyPack(files!.idx)));
    expect(sizedObjects(result)).toEqual(all.map((o) => `${o.oid} ${o.type} ${o.size}`).sort());
    expect(
      Buffer.compare(writePackIndex(result.objects, result.checksum), readBytes(files!.idx)),
    ).toBe(0);
  });

  it("gives the same index for any chunking and any cache size", async () => {
    const [files] = packFiles(repo);
    const pack = readBytes(files!.pack);
    const expected = readBytes(files!.idx);
    const next = prng(5);
    const cases: Array<{
      size: number | (() => number);
      cacheBytes: number;
      heldDeltaBytes: number;
      nativeHashBytes?: number;
      hashQueueBytes?: number;
    }> = [
      { size: () => 1 + (next() % 50), cacheBytes: 32 << 20, heldDeltaBytes: 8 << 20 },
      { size: () => 1 + (next() % 70_000), cacheBytes: 256 << 10, heldDeltaBytes: 16 << 10 },
      // No cache at all: every delta is resolved from range reads in the second pass.
      { size: 65536, cacheBytes: 0, heldDeltaBytes: 0 },
      { size: 1 << 20, cacheBytes: 1 << 20, heldDeltaBytes: 0 },
      // Every object hashed here, every object hashed by WebCrypto, and a queue too small to use.
      { size: 65536, cacheBytes: 32 << 20, heldDeltaBytes: 8 << 20, nativeHashBytes: Infinity },
      {
        size: 65536,
        cacheBytes: 32 << 20,
        heldDeltaBytes: 8 << 20,
        nativeHashBytes: 0,
        hashQueueBytes: 1 << 30,
      },
      {
        size: 65536,
        cacheBytes: 1 << 20,
        heldDeltaBytes: 0,
        nativeHashBytes: 0,
        hashQueueBytes: 1 << 30,
      },
      {
        size: 65536,
        cacheBytes: 32 << 20,
        heldDeltaBytes: 8 << 20,
        nativeHashBytes: 1,
        hashQueueBytes: 100,
      },
    ];
    for (const options of cases) {
      const source = await fileRangeReader(files!.pack);
      try {
        const result = await indexPack(chunked(pack, options.size), {
          readRange: source.read,
          cacheBytes: options.cacheBytes,
          heldDeltaBytes: options.heldDeltaBytes,
          ...(options.nativeHashBytes !== undefined
            ? { nativeHashBytes: options.nativeHashBytes }
            : {}),
          ...(options.hashQueueBytes !== undefined
            ? { hashQueueBytes: options.hashQueueBytes }
            : {}),
        });
        expect(Buffer.compare(writePackIndex(result.objects, result.checksum), expected)).toBe(0);
        expect(result.stats.resolvedInline + result.stats.resolvedLater).toBeGreaterThan(200);
        if (options.cacheBytes === 0) {
          expect(result.stats.resolvedInline).toBe(0);
          expect(result.stats.rangeReads).toBeGreaterThan(0);
          expect(result.stats.rangeReads).toBe(source.calls());
        }
      } finally {
        await source.close();
      }
    }
  });

  it("resolves a pack of REF_DELTA entries", async () => {
    const objects = git(["rev-list", "--objects", "--all"], { cwd: repo });
    const pack = new Uint8Array(
      gitRaw(["pack-objects", "--stdout", "--depth=50", "--window=20"], {
        cwd: repo,
        input: `${objects}\n`,
      }).stdout,
    );
    const types = await countTypes(pack);
    expect(types["ref-delta"]).toBeGreaterThan(200);
    expect(types["ofs-delta"]).toBeUndefined();
    const files = gitIndexPack(pack);
    // The last round hashes everything through WebCrypto, so ids arrive late while later
    // ref-deltas are already asking for bases by id.
    for (const [cacheBytes, nativeHashBytes] of [
      [32 << 20, 32 << 10],
      [0, 32 << 10],
      [32 << 20, 0],
    ] as const) {
      const result = await indexPack(chunked(pack, 30_000), {
        readRange: memoryRangeReader(pack),
        cacheBytes,
        heldDeltaBytes: cacheBytes === 0 ? 0 : 8 << 20,
        nativeHashBytes,
        hashQueueBytes: 1 << 30,
      });
      expect(sortedObjects(result)).toEqual(expectedObjects(verifyPack(files.idx)));
      expect(sizedObjects(result)).toEqual(all.map((o) => `${o.oid} ${o.type} ${o.size}`).sort());
      expect(
        Buffer.compare(writePackIndex(result.objects, result.checksum), readBytes(files.idx)),
      ).toBe(0);
    }
  });

  it("indexes a thin pack with bases from the repository", async () => {
    const pack = new Uint8Array(
      gitRaw(["pack-objects", "--stdout", "--thin", "--revs", "--delta-base-offset"], {
        cwd: repo,
        input: "main\n^main~8\n",
      }).stdout,
    );
    const expected = git(["rev-list", "--objects", "main", "^main~8"], { cwd: repo })
      .split("\n")
      .map((line) => line.split(" ")[0]!)
      .sort();

    // With no base reader the pack cannot be completed, and says which object it lacks.
    await expect(indexPack([pack], { readRange: memoryRangeReader(pack) })).rejects.toThrow(
      /delta base [0-9a-f]{40}/,
    );

    for (const cacheBytes of [32 << 20, 0]) {
      const bases = gitObjectReader(repo);
      const result = await indexPack(chunked(pack, 1000), {
        readRange: memoryRangeReader(pack),
        bases,
        cacheBytes,
        heldDeltaBytes: cacheBytes === 0 ? 0 : 8 << 20,
      });
      expect([...result.objects].map((o) => o.oid).sort()).toEqual(expected);
      expect(result.externalBases.length).toBeGreaterThan(0);
      for (const base of result.externalBases) expect(expected).not.toContain(base);
      const sizes = new Map(all.map((o) => [o.oid, o]));
      for (const object of result.objects) {
        expect(object.size).toBe(sizes.get(object.oid)!.size);
        expect(object.type).toBe(sizes.get(object.oid)!.type);
      }
    }
    // git completes the same pack against the same repository without complaint.
    const copy = join(tempDir("thin"), "copy.git");
    git(["clone", "-q", "--bare", repo, copy]);
    gitRaw(["index-pack", "--fix-thin", "--stdin"], { cwd: copy, input: pack });
  });

  it("needs no range reads for a small thin pack, as a push sends", async () => {
    const pack = new Uint8Array(
      gitRaw(["pack-objects", "--stdout", "--thin", "--revs"], {
        cwd: repo,
        input: "main\n^main~2\n",
      }).stdout,
    );
    const result = await indexPack([pack], { bases: gitObjectReader(repo) });
    expect(result.stats.rangeReads).toBe(0);
    expect(result.stats.resolvedLater).toBeGreaterThan(0);
    expect(result.externalBases.length).toBeGreaterThan(0);
  });

  it("asks storage once for a block that several reads miss at the same time", async () => {
    const bytes = randomBytes(10_000, prng(21));
    let calls = 0;
    let failing = false;
    const read = cachedRangeReader(
      async (offset, length) => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (failing) throw new Error("storage is away");
        return bytes.subarray(offset, offset + length);
      },
      { blockSize: 4096, maxBlocks: 2 },
    );
    const got = await Promise.all([read(0, 100), read(50, 100), read(4000, 200), read(4100, 10)]);
    // Two blocks, however many reads wanted them.
    expect(calls).toBe(2);
    expect(Buffer.compare(got[2]!, bytes.subarray(4000, 4200))).toBe(0);
    expect(Buffer.compare(await read(9990, 100), bytes.subarray(9990))).toBe(0);
    expect(calls).toBe(3);
    // A read that fails is not remembered: the next one asks again.
    failing = true;
    await expect(Promise.all([read(0, 10), read(20, 10)])).rejects.toThrow("storage is away");
    failing = false;
    expect(Buffer.compare(await read(0, 10), bytes.subarray(0, 10))).toBe(0);
  });

  it("reads any object back by offset, following its delta chain", async () => {
    const [files] = packFiles(repo);
    const source = await fileRangeReader(files!.pack);
    try {
      const index = new PackIndex(readBytes(files!.idx));
      expect(index.verify()).toBe(true);
      expect(index.count).toBe(all.length);
      const read = cachedRangeReader(source.read);
      const lengths = index.entryLengths(readBytes(files!.pack).length);
      let checked = 0;
      for await (const object of catFileBatch(
        repo,
        all.map((o) => o.oid),
      )) {
        const record = index.lookup(object.oid);
        expect(record).not.toBeNull();
        // Alternate between knowing the entry's length and discovering it.
        const ours = await readPackObjectAt(
          read,
          record!.offset,
          checked % 2 === 0 ? { lengthAt: (offset) => lengths.get(offset) } : { firstRead: 64 },
        );
        expect(ours.type).toBe(object.type);
        expect(Buffer.compare(ours.data, object.data), object.oid).toBe(0);
        checked++;
      }
      expect(checked).toBe(all.length);
    } finally {
      await source.close();
    }
  });

  it("reports each entry's CRC and extent while reading by offset", async () => {
    const [files] = packFiles(repo);
    const pack = readBytes(files!.pack);
    const index = new PackIndex(readBytes(files!.idx));
    const read = memoryRangeReader(pack);
    for (let position = 0; position < index.count; position += 13) {
      const record = index.at(position);
      const entry = await readPackEntryAt(read, record.offset, { firstRead: 100 });
      expect(entry.crc32).toBe(record.crc32);
    }
  });

  it("yields every entry with its data from the streaming reader", async () => {
    const [files] = packFiles(repo);
    const pack = readBytes(files!.pack);
    const index = new PackIndex(readBytes(files!.idx));
    const byOffset = new Map([...index].map((record) => [record.offset, record]));
    const entries: PackEntryWithData[] = [];
    const reader = readPackEntries(chunked(pack, 9999));
    let step = await reader.next();
    while (!step.done) {
      entries.push(step.value);
      step = await reader.next();
    }
    expect(step.value.objectCount).toBe(all.length);
    expect(step.value.checksum).toBe(index.packChecksum);
    expect(step.value.size).toBe(pack.length);
    expect(entries).toHaveLength(all.length);
    let previousEnd = 12;
    for (const entry of entries) {
      expect(entry.offset).toBe(previousEnd);
      expect(entry.crc32).toBe(byOffset.get(entry.offset)!.crc32);
      expect(entry.data.length).toBe(entry.size);
      if (entry.type !== "ofs-delta" && entry.type !== "ref-delta") {
        expect(hashObjectSync(entry.type, entry.data)).toBe(byOffset.get(entry.offset)!.oid);
      }
      previousEnd = entry.offset + entry.length;
    }
    expect(previousEnd).toBe(pack.length - 20);
  });

  it("calls onObject once per object with content for everything but large whole blobs", async () => {
    const [files] = packFiles(repo);
    const pack = readBytes(files!.pack);
    const seen = new Map<string, boolean>();
    await indexPack([pack], {
      readRange: memoryRangeReader(pack),
      cacheBytes: 4 << 20,
      onObject(object, data) {
        expect(seen.has(object.oid)).toBe(false);
        seen.set(object.oid, data !== null);
        if (data !== null) expect(hashObjectSync(object.type, data)).toBe(object.oid);
        else expect(object.type).toBe("blob");
      },
    });
    expect(seen.size).toBe(all.length);
    // The 3 MiB blob is over a quarter of the 4 MiB cache, so at least one came without data.
    expect([...seen.values()].filter((has) => !has).length).toBeGreaterThan(0);
  });

  it("looks ids up in an index, including by prefix", () => {
    const [files] = packFiles(repo);
    const index = new PackIndex(readBytes(files!.idx));
    const verified = verifyPack(files!.idx);
    for (const entry of verified) {
      expect(index.lookup(entry.oid)?.offset).toBe(entry.offset);
      expect(index.findByPrefix(entry.oid.slice(0, 12))).toEqual([entry.oid]);
    }
    expect(index.has("0123456789012345678901234567890123456789")).toBe(false);
    expect(index.lookup("ffffffffffffffffffffffffffffffffffffffff")).toBeNull();
    expect(index.lookup("0000000000000000000000000000000000000000")).toBeNull();
    const sorted = verified.map((e) => e.oid).sort();
    expect([...index].map((record) => record.oid)).toEqual(sorted);
    const prefix = sorted[0]!.slice(0, 2);
    const matching = sorted.filter((oid) => oid.startsWith(prefix));
    expect(index.findByPrefix(prefix, 1000)).toEqual(matching);
    expect(index.findByPrefix(sorted[5]!.slice(0, 7))).toContain(sorted[5]);
    expect(index.findByPrefix("zz")).toEqual([]);
  });
});

describeGit("damaged and hostile packs", () => {
  let pack: Uint8Array = new Uint8Array(0);

  beforeAll(() => {
    const repo = makeFixtureRepo({ commits: 12, largeBytes: 50_000 });
    git(["repack", "-adfq"], { cwd: repo });
    pack = readBytes(packFiles(repo)[0]!.pack);
  });

  const index = (bytes: Uint8Array): Promise<PackIndexResult> =>
    indexPack(chunked(bytes, 5000), { readRange: memoryRangeReader(bytes) });

  it("rejects a pack cut short anywhere", async () => {
    for (const cut of [
      0,
      4,
      11,
      12,
      13,
      500,
      pack.length - 21,
      pack.length - 20,
      pack.length - 1,
    ]) {
      await expect(index(pack.subarray(0, cut))).rejects.toThrow(GitError);
    }
  });

  it("rejects any flipped bit", async () => {
    const next = prng(31);
    for (let round = 0; round < 60; round++) {
      const damaged = pack.slice();
      const at = next() % damaged.length;
      damaged[at] = damaged[at]! ^ (1 << (next() % 8));
      await expect(index(damaged)).rejects.toThrow(GitError);
    }
  });

  it("rejects a bad signature, a bad version and data after the end", async () => {
    const signature = pack.slice();
    signature[0] = 0x51;
    await expect(index(signature)).rejects.toThrow(/signature/);
    const version = pack.slice();
    version[7] = 9;
    await expect(index(version)).rejects.toThrow(/version/);
    const trailing = new Uint8Array(pack.length + 3);
    trailing.set(pack);
    await expect(index(trailing)).rejects.toThrow(/follows the end/);
  });

  it("says how many bytes followed the pack when written to directly", () => {
    const indexer = new PackIndexer();
    const padded = new Uint8Array(pack.length + 7);
    padded.set(pack);
    expect(indexer.write(padded.subarray(0, 100))).toBe(0);
    expect(indexer.write(padded.subarray(100))).toBe(7);
    expect(indexer.done).toBe(true);
    const parser = new PackParser();
    expect(parser.write(padded)).toBe(7);
    expect(parser.finish().size).toBe(pack.length);
  });

  it("enforces its limits", async () => {
    await expect(indexPack([pack], { maxObjects: 3 })).rejects.toThrow(/over the limit/);
    await expect(
      indexPack([pack], { maxObjectBytes: 100, readRange: memoryRangeReader(pack) }),
    ).rejects.toThrow(/over the limit/);
  });

  it("fails clearly when deltas need a range reader that was not given", async () => {
    await expect(indexPack([pack], { cacheBytes: 0, heldDeltaBytes: 0 })).rejects.toThrow(
      /readRange/,
    );
  });

  it("does not trust the object count for its allocation", () => {
    const header = new Uint8Array(12);
    header.set([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0xff, 0xff, 0xff, 0xff]);
    const before = process.memoryUsage().arrayBuffers;
    const indexer = new PackIndexer();
    indexer.write(header);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(8 << 20);
  });

  it("resolves a ref-delta whose base comes later in the pack, and refuses a cycle", async () => {
    const base = new TextEncoder().encode("base content ".repeat(200));
    const target = new TextEncoder().encode(`${"base content ".repeat(200)}and a tail`);
    const baseOid = hashObjectSync("blob", base);
    const targetOid = hashObjectSync("blob", target);
    const forward = await buildPack([
      { type: "ref-delta", base: baseOid, data: createDelta(base, target) },
      { type: "blob", data: base },
    ]);
    const result = await indexPack([forward.pack], { readRange: memoryRangeReader(forward.pack) });
    expect([...result.objects].map((o) => o.oid)).toEqual([targetOid, baseOid]);
    expect(result.stats.resolvedLater).toBe(1);

    const cycle = await buildPack([
      { type: "ref-delta", base: baseOid, data: createDelta(base, target) },
      { type: "ref-delta", base: targetOid, data: createDelta(target, base) },
    ]);
    await expect(
      indexPack([cycle.pack], {
        readRange: memoryRangeReader(cycle.pack),
        bases: new MemoryObjectStore(),
      }),
    ).rejects.toThrow(/delta base/);
  });
});

describeGit("pack index edge cases", () => {
  it("writes and reads 64-bit offsets", () => {
    const records = [
      { oid: "ff00000000000000000000000000000000000001", offset: 12, crc32: 1 },
      { oid: "0000000000000000000000000000000000000002", offset: 2 ** 31 - 1, crc32: 0xffffffff },
      { oid: "8000000000000000000000000000000000000003", offset: 2 ** 31, crc32: 3 },
      { oid: "8000000000000000000000000000000000000004", offset: 2 ** 40 + 12345, crc32: 4 },
    ];
    const checksum = "ce013625030ba8dba906f756967f9e9ca394464a";
    const bytes = writePackIndex(packIndexSource(records), checksum);
    expect(bytes.length).toBe(8 + 1024 + 4 * 28 + 2 * 8 + 40);
    const index = new PackIndex(bytes);
    expect(index.verify()).toBe(true);
    expect(index.packChecksum).toBe(checksum);
    for (const record of records) expect(index.lookup(record.oid)).toEqual(record);
    expect([...index].map((r) => r.oid)).toEqual(records.map((r) => r.oid).sort());
    // git reads the same table: verify-pack is not available without the pack, show-index is.
    const shown = git(["show-index"], { input: bytes });
    expect(shown.split("\n").sort()).toEqual(
      records.map((r) => `${r.offset} ${r.oid} (${r.crc32.toString(16).padStart(8, "0")})`).sort(),
    );
  });

  it("handles an empty pack", async () => {
    const built = await buildPack([]);
    expect(built.checksum).toBe("029d08823bd8a8eab510ad6ac75c823cfd3ed31e");
    const result = await indexPack([built.pack]);
    expect(result.objectCount).toBe(0);
    const index = new PackIndex(writePackIndex(result.objects, result.checksum));
    expect(index.count).toBe(0);
    expect(index.lookup("ce013625030ba8dba906f756967f9e9ca394464a")).toBeNull();
    const files = gitIndexPack(built.pack);
    expect(
      Buffer.compare(writePackIndex(result.objects, result.checksum), readBytes(files.idx)),
    ).toBe(0);
  });

  it("rejects a damaged index", () => {
    const bytes = writePackIndex(packIndexSource([]), "ce013625030ba8dba906f756967f9e9ca394464a");
    expect(() => new PackIndex(bytes.subarray(0, 100))).toThrow(GitError);
    const magic = bytes.slice();
    magic[0] = 0;
    expect(() => new PackIndex(magic)).toThrow(GitError);
    const fanout = bytes.slice();
    fanout[8 + 3] = 5;
    expect(() => new PackIndex(fanout)).toThrow(GitError);
    const flipped = bytes.slice();
    flipped[bytes.length - 30] = 1;
    expect(new PackIndex(flipped).verify()).toBe(false);
  });
});

describeGit("memory", () => {
  it("indexes a pack of more than 50 MiB without holding it", async () => {
    const repo = tempDir("big");
    git(["init", "-q", "-b", "main"], { cwd: repo });
    const next = prng(77);
    const files: Uint8Array[] = [];
    mkdirSync(join(repo, "data"));
    // Random bytes do not compress, so the pack is about as large as the files.
    for (let i = 0; i < 58; i++) {
      const bytes = new Uint8Array(1024 * 1024);
      for (let k = 0; k < bytes.length; k += 4) {
        const r = next();
        bytes[k] = r;
        bytes[k + 1] = r >>> 8;
        bytes[k + 2] = r >>> 16;
        bytes[k + 3] = r >>> 24;
      }
      files.push(bytes);
      writeFileSync(join(repo, "data", `file-${i}.bin`), bytes);
    }
    git(["add", "-A"], { cwd: repo });
    git(["commit", "-q", "-m", "big files"], { cwd: repo });
    // A second version of some files, so megabyte-sized bases have to be found again for deltas.
    for (let i = 0; i < 20; i++) {
      const bytes = files[i * 2]!;
      bytes.set(new TextEncoder().encode(`edit ${i} `.repeat(300)), 1000 * i);
      writeFileSync(join(repo, "data", `file-${i * 2}.bin`), bytes);
    }
    git(["add", "-A"], { cwd: repo });
    git(["commit", "-q", "-m", "edits"], { cwd: repo });
    files.length = 0;
    git(["repack", "-adq", "--window=30", "--depth=10"], { cwd: repo });
    const [packed] = packFiles(repo);
    const copy = join(tempDir("big-pack"), "big.pack");
    copyFileSync(packed!.pack, copy);

    const collect = globalThis.gc;
    expect(collect, "run with --expose-gc").toBeTypeOf("function");
    // Twice, with a turn of the event loop between: V8 frees array buffers on a
    // background sweeper, so right after one collection they still count.
    const live = async (): Promise<number> => {
      collect!();
      await new Promise((resolve) => setTimeout(resolve, 2));
      collect!();
      const usage = process.memoryUsage();
      return usage.heapUsed + usage.arrayBuffers;
    };

    const source = await fileRangeReader(copy);
    const handle = await open(copy, "r");
    try {
      const size = (await handle.stat()).size;
      expect(size).toBeGreaterThan(50 * 1024 * 1024);
      const baseline = await live();
      let peak = 0;
      const cacheBytes = 8 * 1024 * 1024;
      const indexer = new PackIndexer({
        readRange: source.read,
        cacheBytes,
        heldDeltaBytes: 1 << 20,
      });
      const chunk = new Uint8Array(64 * 1024);
      let position = 0;
      let reads = 0;
      const started = performance.now();
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) break;
        expect(indexer.write(chunk.subarray(0, bytesRead))).toBe(0);
        await indexer.settle();
        position += bytesRead;
        if (++reads % 32 === 0) peak = Math.max(peak, (await live()) - baseline);
      }
      const result = await indexer.finish();
      peak = Math.max(peak, (await live()) - baseline);
      const seconds = (performance.now() - started) / 1000;
      console.log(
        `memory test: ${(size / 2 ** 20).toFixed(1)} MiB pack, ${result.objectCount} objects, ` +
          `peak ${(peak / 2 ** 20).toFixed(1)} MiB over baseline, ` +
          `${result.stats.resolvedInline} deltas inline, ${result.stats.resolvedLater} later, ` +
          `${result.stats.rangeReads} range reads, ${seconds.toFixed(2)} s (gc sampling included)`,
      );
      // The cache budget plus the window, tables and one object in flight; nowhere near the pack.
      expect(peak).toBeLessThan(cacheBytes + 12 * 1024 * 1024);
      expect(result.stats.resolvedInline + result.stats.resolvedLater).toBeGreaterThan(10);
      expect(
        Buffer.compare(writePackIndex(result.objects, result.checksum), readBytes(packed!.idx)),
      ).toBe(0);
    } finally {
      await handle.close();
      await source.close();
    }
  });
});
