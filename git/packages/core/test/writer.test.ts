import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GitError,
  type GitObject,
  type ObjectId,
  type PackInput,
  applyDelta,
  buildPack,
  collectBytes,
  createDelta,
  indexPack,
  memoryRangeReader,
  packIndexSource,
  readDeltaHeader,
  readPackEntries,
  writePack,
  writePackIndex,
} from "../src";
import {
  catFileBatch,
  cleanupTempDirs,
  git,
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

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("applyDelta", () => {
  const base = text("0123456789abcdefghij");

  it("applies copies and inserts", () => {
    // base 20, result 13: copy 4 bytes from offset 2, insert "XY", copy 7 from offset 10.
    const delta = Uint8Array.from([20, 13, 0x91, 2, 4, 2, 0x58, 0x59, 0x91, 10, 7]);
    expect(new TextDecoder().decode(applyDelta(base, delta))).toBe("2345XYabcdefg");
    expect(readDeltaHeader(delta)).toEqual({ baseSize: 20, resultSize: 13, headerLength: 2 });
  });

  it("reads a copy with no size bytes as 64 KiB", () => {
    const big = randomBytes(0x10000 + 10, prng(1));
    // Sizes are little-endian base-128: 0x1000a and 0x10000.
    const delta = Uint8Array.from([0x8a, 0x80, 0x04, 0x80, 0x80, 0x04, 0x80]);
    expect(Buffer.compare(applyDelta(big, delta), big.subarray(0, 0x10000))).toBe(0);
  });

  it("refuses every way a delta can lie", () => {
    const cases: Array<[string, number[]]> = [
      ["wrong base size", [19, 4, 0x91, 0, 4]],
      ["copy past the base", [20, 4, 0x91, 18, 4]],
      ["copy offset past the base", [20, 4, 0x93, 0, 1, 4]],
      ["write past the result", [20, 3, 0x91, 0, 4]],
      ["insert past the result", [20, 1, 2, 65, 66]],
      ["short of the result", [20, 9, 0x91, 0, 4]],
      ["reserved instruction", [20, 4, 0, 0x91, 0, 4]],
      ["insert cut short", [20, 4, 4, 65]],
      ["copy cut short", [20, 4, 0x91, 0]],
      ["no header", [20]],
      ["empty", []],
    ];
    for (const [name, bytes] of cases) {
      expect(() => applyDelta(base, Uint8Array.from(bytes)), name).toThrow(GitError);
    }
  });
});

describe("createDelta", () => {
  it("round-trips arbitrary edits", () => {
    const next = prng(3);
    for (let round = 0; round < 300; round++) {
      const base = randomBytes(next() % 6000, next);
      // The target is the base with pieces removed, repeated, moved and replaced.
      const parts: Uint8Array[] = [];
      for (let piece = 0; piece < 1 + (next() % 8); piece++) {
        if (next() % 3 === 0 || base.length === 0) parts.push(randomBytes(next() % 300, next));
        else {
          const start = next() % base.length;
          parts.push(base.subarray(start, start + (next() % (base.length - start + 1))));
        }
      }
      const target = Buffer.concat(parts);
      const delta = createDelta(base, target);
      expect(Buffer.compare(applyDelta(base, delta), target)).toBe(0);
    }
  });

  it("handles the degenerate shapes", () => {
    const next = prng(4);
    const data = randomBytes(5000, next);
    const cases: Array<[Uint8Array, Uint8Array]> = [
      [new Uint8Array(0), new Uint8Array(0)],
      [new Uint8Array(0), data],
      [data, new Uint8Array(0)],
      [data, data],
      [data.subarray(0, 15), data.subarray(0, 15)],
      [data.subarray(0, 16), data.subarray(0, 16)],
      [new Uint8Array(100_000), new Uint8Array(70_000)],
      [new Uint8Array(100_000).fill(7), new Uint8Array(300_000).fill(7)],
      [data, Buffer.concat([data, data, data])],
    ];
    for (const [base, target] of cases) {
      expect(Buffer.compare(applyDelta(base, createDelta(base, target)), target)).toBe(0);
    }
  });

  it("stays small for a small change to a large file", () => {
    const next = prng(5);
    const base = randomBytes(400_000, next);
    const target = base.slice();
    target.set(randomBytes(50, next), 123_456);
    const inserted = Buffer.concat([
      target.subarray(0, 300_000),
      text("inserted"),
      target.subarray(300_000),
    ]);
    expect(createDelta(base, target).length).toBeLessThan(200);
    const delta = createDelta(base, inserted);
    expect(delta.length).toBeLessThan(300);
    expect(Buffer.compare(applyDelta(base, delta), inserted)).toBe(0);
    // Identical input is a handful of copy instructions.
    expect(createDelta(base, base).length).toBeLessThan(40);
  });

  it("does not degrade on input where every block hashes alike", () => {
    const base = new Uint8Array(2_000_000);
    const target = new Uint8Array(2_000_000);
    target[1_000_000] = 1;
    const started = performance.now();
    const delta = createDelta(base, target);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(Buffer.compare(applyDelta(base, delta), target)).toBe(0);
  });
});

describe("packs written here", () => {
  let repo = "";
  let objects: Array<GitObject & { oid: ObjectId }> = [];

  beforeAll(async () => {
    repo = makeFixtureRepo({ commits: 40, largeBytes: 600_000 });
    for await (const object of catFileBatch(
      repo,
      listObjects(repo).map((o) => o.oid),
    )) {
      objects.push(object);
    }
    // History order for commits, then trees, then blobs, like git lays a pack out.
    const rank = { commit: 0, tag: 1, tree: 2, blob: 3 };
    objects = objects.sort((a, b) => rank[a.type] - rank[b.type] || a.data.length - b.data.length);
  });

  /** Unpacks `pack` into a fresh repository with git and returns it, having run fsck. */
  function acceptedByGit(pack: Uint8Array): string {
    const target = join(tempDir("accept"), "repo.git");
    git(["init", "-q", "--bare", target]);
    const packPath = join(target, "incoming.pack");
    writeFileSync(packPath, pack);
    git(["index-pack", "--strict", "--stdin"], { cwd: target, input: pack });
    for (const line of git(["for-each-ref", "--format=%(refname) %(objectname)"], {
      cwd: repo,
    }).split("\n")) {
      const [name, oid] = line.split(" ");
      git(["update-ref", name!, oid!], { cwd: target });
    }
    git(["fsck", "--strict", "--full"], { cwd: target });
    return target;
  }

  function sameObjects(target: string): void {
    expect(
      listObjects(target)
        .map((o) => `${o.oid} ${o.type} ${o.size}`)
        .sort(),
    ).toEqual(
      listObjects(repo)
        .map((o) => `${o.oid} ${o.type} ${o.size}`)
        .sort(),
    );
    expect(git(["rev-parse", "main^{tree}"], { cwd: target })).toBe(
      git(["rev-parse", "main^{tree}"], { cwd: repo }),
    );
    expect(git(["log", "--format=%H", "main"], { cwd: target })).toBe(
      git(["log", "--format=%H", "main"], { cwd: repo }),
    );
  }

  it("writes whole objects that git indexes, fscks and reads back", async () => {
    const built = await buildPack(objects.map((o) => ({ type: o.type, data: o.data, oid: o.oid })));
    const target = acceptedByGit(built.pack);
    sameObjects(target);
    // And the index built from what the writer reported is the one git wrote.
    const idx = writePackIndex(
      packIndexSource(
        built.entries.map((e) => ({ oid: e.oid!, offset: e.offset, crc32: e.crc32 })),
      ),
      built.checksum,
    );
    expect(Buffer.compare(idx, readBytes(packFiles(target)[0]!.idx))).toBe(0);
  });

  /** Deltas each object against the previous one of its type when that saves space. */
  function deltified(kind: (index: number) => "ofs-delta" | "ref-delta"): {
    inputs: PackInput[];
    deltas: number;
  } {
    const inputs: PackInput[] = [];
    let deltas = 0;
    let previous: (GitObject & { oid: ObjectId }) | null = null;
    for (const [index, object] of objects.entries()) {
      const base = previous?.type === object.type ? previous : null;
      const delta = base ? createDelta(base.data, object.data) : null;
      if (base && delta && delta.length < object.data.length * 0.6) {
        inputs.push({ type: kind(index), base: base.oid, data: delta, oid: object.oid });
        deltas++;
      } else {
        inputs.push({ type: object.type, data: object.data, oid: object.oid });
      }
      previous = object;
    }
    return { inputs, deltas };
  }

  it("writes deltas made here, as OFS_DELTA and REF_DELTA, that git accepts", async () => {
    for (const kind of [
      (): "ofs-delta" => "ofs-delta",
      (): "ref-delta" => "ref-delta",
      (index: number): "ofs-delta" | "ref-delta" => (index % 2 === 0 ? "ofs-delta" : "ref-delta"),
    ]) {
      const { inputs, deltas } = deltified(kind);
      expect(deltas).toBeGreaterThan(100);
      const built = await buildPack(inputs);
      const whole = await buildPack(objects.map((o) => ({ type: o.type, data: o.data })));
      expect(built.pack.length).toBeLessThan(whole.pack.length);
      sameObjects(acceptedByGit(built.pack));
      // Our own indexer reads its own writer's output to the same ids.
      const result = await indexPack([built.pack], { readRange: memoryRangeReader(built.pack) });
      expect([...result.objects].map((o) => o.oid)).toEqual(objects.map((o) => o.oid));
      expect(result.checksum).toBe(built.checksum);
    }
  });

  it("streams the same bytes it builds in memory", async () => {
    const { inputs } = deltified((index) => (index % 3 === 0 ? "ref-delta" : "ofs-delta"));
    const built = await buildPack(inputs);
    for (const chunkSize of [100, 65536, 1 << 22]) {
      const streamed = await collectBytes(writePack(inputs, { count: inputs.length, chunkSize }));
      expect(Buffer.compare(streamed, built.pack)).toBe(0);
    }
    async function* later(): AsyncGenerator<PackInput> {
      for (const input of inputs) {
        await Promise.resolve();
        yield input;
      }
    }
    const fromAsync = await collectBytes(writePack(later(), { count: inputs.length }));
    expect(Buffer.compare(fromAsync, built.pack)).toBe(0);
  });

  it("passes stored entries through without recompressing them", async () => {
    git(["repack", "-adfq"], { cwd: repo });
    const source = readBytes(packFiles(repo)[0]!.pack);
    const inputs: PackInput[] = [];
    for await (const entry of readPackEntries([source])) {
      const compressed = source.subarray(
        entry.offset + entry.headerLength,
        entry.offset + entry.length,
      );
      if (entry.type === "ofs-delta") {
        inputs.push({ type: "ofs-delta", base: entry.baseOffset!, size: entry.size, compressed });
      } else if (entry.type === "ref-delta") {
        inputs.push({ type: "ref-delta", base: entry.baseOid!, size: entry.size, compressed });
      } else {
        inputs.push({ type: entry.type, size: entry.size, compressed });
      }
    }
    // Same entries in the same order at the same offsets: the copy is the original, byte for byte.
    const copy = await buildPack(inputs);
    expect(Buffer.compare(copy.pack, source)).toBe(0);
  });

  it("refuses a pack that does not match its declared count or its bases", async () => {
    const blob: PackInput = { type: "blob", data: text("x") };
    await expect(collectBytes(writePack([blob], { count: 2 }))).rejects.toThrow(GitError);
    await expect(collectBytes(writePack([blob, blob], { count: 1 }))).rejects.toThrow(GitError);
    await expect(
      buildPack([
        { type: "ofs-delta", base: "ce013625030ba8dba906f756967f9e9ca394464a", data: text("x") },
      ]),
    ).rejects.toThrow(/earlier in the same pack/);
    await expect(buildPack([{ type: "ofs-delta", base: 9999, data: text("x") }])).rejects.toThrow(
      GitError,
    );
  });

  it("lets git apply a delta made here over the wire format", async () => {
    // unpack-objects applies each delta itself and writes loose objects: a second reader of our deltas.
    const { inputs } = deltified(() => "ref-delta");
    const built = await buildPack(inputs);
    const target = join(tempDir("unpack"), "repo.git");
    git(["init", "-q", "--bare", target]);
    gitRaw(["unpack-objects", "-q", "--strict"], { cwd: target, input: built.pack });
    for (const object of objects.filter((_, index) => index % 9 === 0)) {
      const stored = gitRaw(["cat-file", object.type, object.oid], { cwd: target }).stdout;
      expect(Buffer.compare(stored, object.data)).toBe(0);
    }
  });
});
