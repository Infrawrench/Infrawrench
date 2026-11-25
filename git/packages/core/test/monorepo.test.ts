/**
 * The same checks as the fixture suites, against a real history: this
 * repository's own, cloned over the local git transport so nothing touches
 * the network and the clone is one pack exactly as upload-pack sends it.
 */
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PackIndex,
  PackIndexer,
  cachedRangeReader,
  hashObjectSync,
  parseCommit,
  parseTag,
  parseTree,
  readPackObjectAt,
  serializeCommit,
  serializeTag,
  serializeTree,
  writePackIndex,
} from "../src";
import {
  catFileBatch,
  cleanupTempDirs,
  fileRangeReader,
  git,
  listObjects,
  packFiles,
  prng,
  readBytes,
  tempDir,
} from "./helpers";

afterAll(cleanupTempDirs);

const source = git(["rev-parse", "--show-toplevel"]);
// A shallow CI checkout has too little history to say anything; the fixture suites cover it there.
const enough = Number(git(["rev-list", "--count", "HEAD"])) >= 200;

describe.skipIf(!enough)("this repository's history", () => {
  let clone = "";
  let pack = "";
  let idx = "";

  beforeAll(() => {
    clone = join(tempDir("monorepo"), "clone.git");
    git(["clone", "-q", "--bare", "--no-local", "--single-branch", source, clone]);
    const files = packFiles(clone);
    expect(files).toHaveLength(1);
    pack = files[0]!.pack;
    idx = files[0]!.idx;
  });

  it("indexes the whole pack to the .idx git wrote, in bounded memory", async () => {
    const size = (await stat(pack)).size;
    const collect = globalThis.gc!;
    const live = async (): Promise<number> => {
      collect();
      await new Promise((resolve) => setTimeout(resolve, 2));
      collect();
      const usage = process.memoryUsage();
      return usage.heapUsed + usage.arrayBuffers;
    };
    const ranges = await fileRangeReader(pack);
    const handle = await open(pack, "r");
    try {
      const baseline = await live();
      const cacheBytes = 32 * 1024 * 1024;
      const indexer = new PackIndexer({ readRange: ranges.read, cacheBytes });
      const chunk = new Uint8Array(64 * 1024);
      let position = 0;
      let reads = 0;
      let peak = 0;
      let sampling = 0;
      const started = performance.now();
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) break;
        expect(indexer.write(chunk.subarray(0, bytesRead))).toBe(0);
        await indexer.settle();
        position += bytesRead;
        if (++reads % 512 === 0) {
          const before = performance.now();
          peak = Math.max(peak, (await live()) - baseline);
          sampling += performance.now() - before;
        }
      }
      const streamed = performance.now();
      const result = await indexer.finish();
      const finished = performance.now();
      peak = Math.max(peak, (await live()) - baseline);
      let inflated = 0;
      for (let i = 0; i < result.objects.count; i++) inflated += result.objects.size(i);
      const seconds = (finished - started - sampling) / 1000;
      const mib = (bytes: number): string => (bytes / 2 ** 20).toFixed(1);
      console.log(
        `monorepo: ${mib(size)} MiB pack, ${result.objectCount} objects, ${mib(inflated)} MiB of objects; ` +
          `stream ${((streamed - started - sampling) / 1000).toFixed(2)} s, finish ${((finished - streamed) / 1000).toFixed(2)} s; ` +
          `${mib(size / seconds)} MiB/s of pack, ${mib(inflated / seconds)} MiB/s of objects, ` +
          `${Math.round(result.objectCount / seconds)} objects/s; ` +
          `${result.stats.resolvedInline} deltas inline, ${result.stats.resolvedLater} later, ` +
          `${result.stats.rangeReads} range reads; peak ${mib(peak)} MiB over baseline`,
      );
      expect(result.objectCount).toBe(new PackIndex(readBytes(idx)).count);
      const started2 = performance.now();
      const ours = writePackIndex(result.objects, result.checksum);
      console.log(
        `monorepo: .idx of ${mib(ours.length)} MiB written in ${(performance.now() - started2).toFixed(0)} ms`,
      );
      expect(Buffer.compare(ours, readBytes(idx))).toBe(0);
      // For scale only: the C implementation doing the same job on one thread.
      const theirs = performance.now();
      git(["index-pack", "--threads=1", "-o", join(tempDir("scale"), "scale.idx"), pack]);
      console.log(
        `monorepo: git index-pack --threads=1 took ${((performance.now() - theirs) / 1000).toFixed(2)} s`,
      );
      // The table (about 55 bytes an object) and the cache; the pack itself is never held.
      expect(peak).toBeLessThan(cacheBytes + result.objectCount * 64 + 16 * 1024 * 1024);
    } finally {
      await handle.close();
      await ranges.close();
    }
  });

  it("round-trips every commit, tree and tag byte for byte", async () => {
    const wanted = listObjects(clone).filter((object) => object.type !== "blob");
    const counts = { commit: 0, tree: 0, tag: 0 };
    let bytes = 0;
    const started = performance.now();
    for await (const object of catFileBatch(
      clone,
      wanted.map((o) => o.oid),
    )) {
      let again: Uint8Array;
      if (object.type === "commit") again = serializeCommit(parseCommit(object.data));
      else if (object.type === "tree") again = serializeTree(parseTree(object.data));
      else again = serializeTag(parseTag(object.data));
      if (Buffer.compare(again, object.data) !== 0) {
        throw new Error(`${object.type} ${object.oid} does not round-trip`);
      }
      if (counts.commit % 50 === 0) expect(hashObjectSync(object.type, again)).toBe(object.oid);
      counts[object.type as "commit" | "tree" | "tag"]++;
      bytes += object.data.length;
    }
    console.log(
      `monorepo: round-tripped ${counts.commit} commits, ${counts.tree} trees, ${counts.tag} tags ` +
        `(${(bytes / 2 ** 20).toFixed(1)} MiB) in ${((performance.now() - started) / 1000).toFixed(1)} s, git included`,
    );
    expect(counts.commit + counts.tree + counts.tag).toBe(wanted.length);
    expect(counts.commit).toBeGreaterThanOrEqual(200);
  });

  it("reads objects back by offset through range reads", async () => {
    const index = new PackIndex(readBytes(idx));
    const next = prng(99);
    const picked = new Set<string>();
    while (picked.size < Math.min(1500, index.count)) picked.add(index.oidAt(next() % index.count));
    const ranges = await fileRangeReader(pack);
    try {
      const read = cachedRangeReader(ranges.read);
      const started = performance.now();
      let bytes = 0;
      const ours = new Map<string, { type: string; data: Uint8Array }>();
      for (const oid of picked) {
        const object = await readPackObjectAt(read, index.lookup(oid)!.offset);
        ours.set(oid, object);
        bytes += object.data.length;
      }
      const seconds = (performance.now() - started) / 1000;
      console.log(
        `monorepo: ${picked.size} random objects (${(bytes / 2 ** 20).toFixed(1)} MiB) read by offset in ` +
          `${seconds.toFixed(2)} s, ${ranges.calls()} range reads`,
      );
      for await (const object of catFileBatch(clone, [...picked])) {
        const mine = ours.get(object.oid)!;
        expect(mine.type).toBe(object.type);
        if (Buffer.compare(mine.data, object.data) !== 0) throw new Error(`${object.oid} differs`);
      }
    } finally {
      await ranges.close();
    }
  });
});
