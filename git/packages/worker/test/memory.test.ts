/**
 * How much memory the repository's storage code holds while this
 * repository's history is pushed, cloned, fetched from and repacked. A
 * Durable Object has 128 MB, and workerd does not report an isolate's
 * heap, so the same code is measured here on the Node stand-ins: live heap
 * plus array buffers, less what the in-memory bucket itself is holding (in
 * production that is R2's).
 *
 * The operations are called directly, the way the protocol calls them,
 * with no HTTP server or git client in the process to be measured with
 * them.
 *
 * Opt-in: `GIT_WORKER_BENCH=1 pnpm --filter @infrawrench/git-worker test
 * test/memory.test.ts`.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { ZERO_OID, encodePktLine } from "@infrawrench/git-core";
import { type ServeStats, newServeStats, serve } from "@infrawrench/git-protocol";
import { afterAll, describe, expect, it } from "vitest";
import { Repository } from "../src/repo/do/repository";
import { cleanupTempDirs, git, gitOut, hasGit, tempDir } from "./support/git";
import { MemoryBucket, nodeStorage } from "./support/node-platform";

const local = (args: string[]): string =>
  spawnSync("git", args, { encoding: "utf8" }).stdout.trim();
const source = hasGit ? local(["rev-parse", "--show-toplevel"]) : "";
const enabled =
  process.env.GIT_WORKER_BENCH === "1" &&
  hasGit &&
  Number(local(["rev-list", "--count", "HEAD"])) >= 200;

const MIB = 1024 * 1024;

afterAll(cleanupTempDirs);

describe.skipIf(!enabled)("memory held by the storage code", () => {
  it("stays inside a Durable Object's 128 MB for this repository's history", async () => {
    const mirror = join(tempDir("monorepo"), "mirror.git");
    await git(["clone", "-q", "--bare", "--no-local", "--single-branch", source, mirror]);
    const head = await gitOut(["rev-parse", "HEAD"], { cwd: mirror });
    const old = await gitOut(["rev-parse", "HEAD~50"], { cwd: mirror });
    // The branch's own objects as one pack. The pack a clone leaves can hold more (a tag's
    // object, whatever the source sent along), and a repository that holds an object no
    // branch reaches is cloned by walking, which is not the clone measured here.
    const packFile = join(tempDir("history"), "history.pack");
    const packed = spawnSync(
      "sh",
      [
        "-c",
        `echo ${head} | git pack-objects --revs --stdout -q --delta-base-offset > "${packFile}"`,
      ],
      { cwd: mirror },
    );
    expect(packed.status).toBe(0);

    const bucket = new MemoryBucket();
    const storage = nodeStorage();
    const repository = new Repository({ bucket, storage, events: null });
    repository.open("repo-1");

    const bucketBytes = (): number => {
      let total = 0;
      for (const bytes of bucket.objects.values()) total += bytes.length;
      for (const upload of bucket.openUploads.values()) {
        for (const part of upload.parts.values()) total += part.length;
      }
      return total;
    };
    const collect = globalThis.gc!;
    const live = (): number => {
      collect();
      const usage = process.memoryUsage();
      return usage.heapUsed + usage.arrayBuffers - bucketBytes();
    };
    interface Measured {
      readonly seconds: number;
      readonly peak: number;
    }
    const measured = async (work: () => Promise<unknown>): Promise<Measured> => {
      // Twice, a turn apart: V8 frees array buffers on a background sweeper.
      collect();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const baseline = live();
      let peak = baseline;
      const timer = setInterval(() => {
        peak = Math.max(peak, live());
      }, 100);
      const started = performance.now();
      try {
        await work();
      } finally {
        clearInterval(timer);
      }
      return { seconds: (performance.now() - started) / 1000, peak: (peak - baseline) / MIB };
    };

    /** A protocol v2 `fetch`, served in this process and read to the end. */
    const fetchPack = async (haves: string[]): Promise<ServeStats & { bytes: number }> => {
      const stats = newServeStats();
      const request = [
        encodePktLine("command=fetch\n"),
        encodePktLine("object-format=sha1\n"),
        new TextEncoder().encode("0001"),
        encodePktLine("thin-pack\n"),
        encodePktLine("ofs-delta\n"),
        encodePktLine("no-progress\n"),
        encodePktLine(`want ${head}\n`),
        ...haves.map((oid) => encodePktLine(`have ${oid}\n`)),
        encodePktLine("done\n"),
        new TextEncoder().encode("0000"),
      ];
      const output = serve({
        backend: repository.backend(),
        request: {
          service: "git-upload-pack",
          version: 2,
          statelessRpc: true,
          advertiseOnly: false,
        },
        input: request,
        stats,
      });
      let bytes = 0;
      const reader = output.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
      }
      return { ...stats, bytes };
    };

    const push = await measured(async () => {
      const pack = Readable.toWeb(createReadStream(packFile, { highWaterMark: 65536 }));
      const staged = await repository.ingest(pack as unknown as ReadableStream<Uint8Array>);
      const [result] = await repository.updateRefs(
        [{ name: "refs/heads/main", oldOid: ZERO_OID, newOid: head }],
        { atomic: false, pack: staged },
      );
      expect(result?.error).toBeNull();
    });
    const stats = repository.stats();
    const writes = storage.writes;
    const parts = bucket.calls.uploadPart;
    const rangeReads = bucket.calls.rangeGet;

    let cloneStats = await fetchPack([]);
    const cloned = await measured(async () => {
      cloneStats = await fetchPack([]);
    });
    expect(cloneStats.packSource).toBe("everything");
    expect(cloneStats.bytes).toBeGreaterThan(stats.liveBytes * 0.9);

    let fetchStats = cloneStats;
    const fetched = await measured(async () => {
      fetchStats = await fetchPack([old]);
    });
    expect(fetchStats.packSource).toBe("objects");

    // A second pack holding an object no branch reaches. The stored packs may no longer go out
    // as they are: the clone walks the whole history, and leaves the object behind.
    await repository.writeObjects([
      { type: "blob", data: new TextEncoder().encode("second pack\n") },
    ]);
    let assembledStats = cloneStats;
    const assembled = await measured(async () => {
      assembledStats = await fetchPack([]);
    });
    expect(assembledStats.packSource).toBe("objects");
    expect(assembledStats.objectsSent).toBe(stats.objects);

    const repacked = await measured(() => repository.repack());
    expect(repository.stats().livePacks).toBe(1);

    const packMib = stats.liveBytes / MIB;
    const line = (name: string, result: Measured, note = ""): string =>
      `  ${name.padEnd(30)} ${result.seconds.toFixed(1).padStart(5)} s  ` +
      `${(packMib / result.seconds).toFixed(0).padStart(5)} MiB/s  peak +${result.peak.toFixed(0)} MiB${note}`;
    const report = [
      `git-worker storage on Node: ${stats.objects} objects, ${packMib.toFixed(1)} MiB of pack and index; ` +
        `the push made ${writes} SQL writes, uploaded ${parts} parts and read back ${rangeReads} ranges`,
      line("push (ingest, verify, publish)", push),
      line("clone (the stored pack)", cloned),
      line(
        "fetch of the last 50 commits",
        fetched,
        `, ${fetchStats.objectsSent} objects, ${(fetchStats.bytes / MIB).toFixed(1)} MiB`,
      ),
      line("clone (by walking, 2 packs)", assembled),
      line("repack (2 packs into one)", repacked),
    ].join("\n");
    console.log(report);
    // Vitest keeps a passing test's console output to itself under some reporters.
    if (process.env.GIT_WORKER_BENCH_OUT) {
      appendFileSync(process.env.GIT_WORKER_BENCH_OUT, `${report}\n`);
    }

    for (const result of [push, cloned, fetched, assembled, repacked]) {
      expect(result.peak).toBeLessThan(100);
    }
  });
});
