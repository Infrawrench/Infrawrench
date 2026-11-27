/**
 * How a fetch reads the bucket (#1447). A read of R2 is a round trip
 * whatever its size, so what a fetch costs in production is how many reads
 * it makes, how many of them overlap, and how much it reads that it does not
 * send. The real `git` is on the other end throughout: every pack these
 * reads produce is one it has to accept.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeLatin1, encodePktLine } from "@infrawrench/git-core";
import { newServeStats, serve } from "@infrawrench/git-protocol";
import { afterAll, afterEach, beforeEach, expect, it, describe } from "vitest";
import { READ_AHEAD_BYTES, SEGMENT_BYTES } from "../src/repo/do/pack-stream";
import { Repository } from "../src/repo/do/repository";
import {
  allObjects,
  cleanupTempDirs,
  git,
  gitOut,
  hasGit,
  initRepo,
  randomBytes,
  resetClock,
  tempDir,
} from "./support/git";
import { type NodeRepo, startNodeRepo } from "./support/node-server";
import { SlowBucket } from "./support/slow-bucket";

afterAll(cleanupTempDirs);

const MIB = 1024 * 1024;
const describeGit = describe.skipIf(!hasGit);

describeGit("how a fetch reads the bucket", () => {
  let repo: NodeRepo;
  let bucket: SlowBucket;
  let work: string;

  beforeEach(async () => {
    resetClock();
    bucket = new SlowBucket();
    repo = await startNodeRepo("repo-1", { bucket });
    work = await initRepo("work");
    await git(["remote", "add", "origin", repo.url], { cwd: work });
  });
  afterEach(async () => {
    expect(repo.errors).toEqual([]);
    await repo.close();
  });

  const clone = async (...args: string[]): Promise<string> => {
    const dir = join(tempDir("clone"), "clone");
    await git(["clone", "-q", ...args, repo.url, dir]);
    return dir;
  };
  /** A read costs a few milliseconds from here on, so reads made together overlap. */
  const measure = (): void => {
    bucket.profile = { firstByteMs: 3, bytesPerSecond: Infinity };
    bucket.resetRead();
  };
  const packBytes = (): number =>
    [...bucket.objects.entries()]
      .filter(([key]) => key.endsWith(".pack"))
      .reduce((sum, [, bytes]) => sum + bytes.length, 0);

  it("reads a shallow fetch as a few ranges, several at once, and only around what it sends", async () => {
    // Three pushes, so three packs, each mostly old versions of one file that neither
    // compresses nor deltas. The newest commit is a small part of each of them.
    const big = (name: string, seed: number): void =>
      writeFileSync(join(work, name), randomBytes(600 * 1024, seed));
    for (let dir = 0; dir < 20; dir++) {
      for (let file = 0; file < 10; file++) {
        writeFile(work, `src/d${dir}/f${file}.txt`, `${dir}/${file}\n`.repeat(40));
      }
    }
    for (let push = 0; push < 3; push++) {
      if (push < 2) big(`once-${push}.bin`, 1000 + push);
      for (let version = 0; version < 9; version++) {
        big("often.bin", push * 100 + version + 1);
        await git(["add", "."], { cwd: work });
        await git(["commit", "-q", "-m", `push ${push} version ${version}`], { cwd: work });
      }
      await git(["push", "-q", "origin", "main"], { cwd: work });
    }
    expect(repo.repository.stats().livePacks).toBe(3);
    expect(packBytes()).toBeGreaterThan(16 * MIB);

    measure();
    const shallow = await clone("--depth", "1");
    const fetched = repo.requests.at(-1)!;
    expect(fetched.packSource).toBe("objects");
    await git(["fsck", "--strict"], { cwd: shallow });
    expect(await gitOut(["rev-parse", "HEAD^{tree}"], { cwd: shallow })).toBe(
      await gitOut(["rev-parse", "HEAD^{tree}"], { cwd: work }),
    );
    // 200 files, their 21 directories and the root, the three large files, the commit.
    expect(fetched.objectsSent).toBe(200 + 22 + 3 + 1);
    expect(fetched.packBytesSent).toBeLessThan(2 * MIB);
    // Each pack is asked for its part at the same time as the others.
    expect(bucket.read.inFlightPeak).toBeGreaterThan(1);
    expect(bucket.read.gets).toBeLessThan(30);
    // The newest version of each file and what lies beside it, not the twenty-six older ones.
    expect(bucket.read.bytes).toBeLessThan(6 * MIB);
  });

  it("has a pushed branch's trees in memory by the time the fetch that follows asks", async () => {
    // Large enough that the pack is read from the bucket, not kept in memory.
    for (let dir = 0; dir < 30; dir++) {
      for (let file = 0; file < 5; file++) {
        writeFile(work, `src/d${dir}/sub/f${file}.txt`, `${dir}/${file}\n`.repeat(30));
      }
    }
    writeFileSync(join(work, "big.bin"), randomBytes(6 * MIB, 5));
    await git(["add", "."], { cwd: work });
    await git(["commit", "-q", "-m", "files"], { cwd: work });
    await git(["push", "-q", "origin", "main"], { cwd: work });
    const head = await gitOut(["rev-parse", "HEAD"], { cwd: work });

    // A read of a whole block is the walk's: the pack's own reads are runs of other sizes.
    let blocks = 0;
    const get = bucket.get.bind(bucket);
    bucket.get = async (key, options) => {
      if (options?.range?.length === 256 * 1024) blocks++;
      return get(key, options);
    };
    /** Blocks a shallow fetch of the head reads from the bucket to choose its objects. */
    const readsToChoose = async (repository: Repository): Promise<number> => {
      blocks = 0;
      const stats = newServeStats();
      const output = serve({
        backend: repository.backend(),
        request: {
          service: "git-upload-pack",
          version: 2,
          statelessRpc: true,
          advertiseOnly: false,
        },
        input: [
          encodePktLine("command=fetch\n"),
          new TextEncoder().encode("0001"),
          encodePktLine("ofs-delta\n"),
          encodePktLine(`want ${head}\n`),
          encodePktLine("deepen 1\n"),
          encodePktLine("done\n"),
          new TextEncoder().encode("0000"),
        ],
        stats,
      });
      const reader = output.getReader();
      while (!(await reader.read()).done);
      // 150 files, 61 directories and the root, the large file, the commit.
      expect(stats.objectsSent).toBe(150 + 62 + 1 + 1);
      return blocks;
    };

    // The object that took the push read the trees while the push was being answered.
    await repo.repository.warmed();
    expect(await readsToChoose(repo.repository)).toBe(0);
    // One that has just woken reads them from the bucket, once: the second fetch finds them kept.
    const woken = new Repository({ bucket, storage: repo.storage, events: null });
    woken.open("repo-1");
    expect(await readsToChoose(woken)).toBeGreaterThan(0);
    expect(await readsToChoose(woken)).toBe(0);
  });

  it("makes whole objects of deltas whose bases stay behind, many at once", async () => {
    const lines = (file: number, round: number): string =>
      Array.from({ length: 300 }, (_, line) =>
        line % 50 === round
          ? `file ${file} changed in round ${round}\n`
          : `file ${file} line ${line}\n`,
      ).join("");
    for (let file = 0; file < 60; file++) {
      writeFile(work, `src/f${file}.txt`, lines(file, -1));
    }
    await git(["add", "."], { cwd: work });
    await git(["commit", "-q", "-m", "base"], { cwd: work });
    await git(["push", "-q", "origin", "main"], { cwd: work });
    // Each push changes every file a little: a thin pack of deltas on what the last one brought.
    for (let round = 0; round < 3; round++) {
      for (let file = 0; file < 60; file++) {
        writeFile(work, `src/f${file}.txt`, lines(file, round));
      }
      await git(["commit", "-q", "-a", "-m", `round ${round}`], { cwd: work });
      await git(["push", "-q", "origin", "main"], { cwd: work });
    }
    expect(repo.repository.stats().livePacks).toBe(4);

    const shallow = await clone("--depth", "1");
    expect(repo.requests.at(-1)?.packSource).toBe("objects");
    await git(["fsck", "--strict"], { cwd: shallow });
    expect(await gitOut(["rev-parse", "HEAD^{tree}"], { cwd: shallow })).toBe(
      await gitOut(["rev-parse", "HEAD^{tree}"], { cwd: work }),
    );
    expect(await gitOut(["status", "--porcelain"], { cwd: shallow })).toBe("");
    // The sixty files, `src`, the root and the commit, and nothing a base would be missing for.
    expect(repo.requests.at(-1)?.objectsSent).toBe(63);

    // A client that has the base commit gets the same files as deltas on what it has.
    const early = join(tempDir("early"), "early");
    await git(["init", "-q", early]);
    const base = await gitOut(["rev-list", "--max-parents=0", "HEAD"], { cwd: work });
    await git(["fetch", "-q", work, base], { cwd: early });
    await git(["fetch", "-q", repo.url, "main"], { cwd: early });
    await git(["fsck", "--strict"], { cwd: early });
    expect(await gitOut(["rev-parse", "FETCH_HEAD"], { cwd: early })).toBe(
      await gitOut(["rev-parse", "HEAD"], { cwd: work }),
    );
  });

  it("sends an entry too large to hold in pieces, and a stored pack as ranges in order", async () => {
    writeFileSync(join(work, "huge.bin"), randomBytes(9 * MIB + 321, 77));
    writeFile(work, "README.md", "a large file lives here\n");
    await git(["add", "."], { cwd: work });
    await git(["commit", "-q", "-m", "huge"], { cwd: work });
    await git(["push", "-q", "origin", "main"], { cwd: work });
    const stored = packBytes();
    expect(stored).toBeGreaterThan(9 * MIB);

    // Chosen by walking: the large entry is read a piece at a time.
    measure();
    const shallow = await clone("--depth", "1");
    expect(repo.requests.at(-1)?.packSource).toBe("objects");
    await git(["fsck", "--strict"], { cwd: shallow });
    expect(await gitOut(["status", "--porcelain"], { cwd: shallow })).toBe("");
    expect(bucket.read.gets).toBeLessThan(12);

    // A clone of everything is the stored pack, read as ranges with several in flight.
    measure();
    const whole = await clone();
    expect(repo.requests.at(-1)?.packSource).toBe("everything");
    await git(["fsck", "--strict", "--full"], { cwd: whole });
    expect(await allObjects(whole)).toBe(await allObjects(work));
    expect(bucket.read.gets).toBe(Math.ceil(stored / SEGMENT_BYTES));
    expect(bucket.read.bytes).toBe(stored);
    expect(bucket.read.inFlightPeak).toBeGreaterThan(1);
    expect(bucket.read.inFlightPeak).toBeLessThanOrEqual(READ_AHEAD_BYTES / SEGMENT_BYTES);
  });

  it("ends the fetch with an error when the bucket stops answering, and leaves nothing running", async () => {
    for (let file = 0; file < 12; file++) {
      writeFileSync(join(work, `f${file}.bin`), randomBytes(600 * 1024, file + 1));
    }
    await git(["add", "."], { cwd: work });
    await git(["commit", "-q", "-m", "files"], { cwd: work });
    await git(["push", "-q", "origin", "main"], { cwd: work });
    const head = await gitOut(["rev-parse", "HEAD"], { cwd: work });

    // An object that has just woken, over a bucket that fails once the pack is under way:
    // the second of its runs, which is being read while the first goes out.
    const repository = new Repository({ bucket, storage: repo.storage, events: null });
    repository.open("repo-1");
    const get = bucket.get.bind(bucket);
    bucket.get = async (key, options) => {
      if (options?.range && options.range.offset >= 3 * MIB && options.range.length > MIB) {
        throw new Error("the bucket is away");
      }
      return get(key, options);
    };
    const errors: unknown[] = [];
    const output = serve({
      backend: repository.backend(),
      request: { service: "git-upload-pack", version: 2, statelessRpc: true, advertiseOnly: false },
      input: [
        encodePktLine("command=fetch\n"),
        new TextEncoder().encode("0001"),
        encodePktLine("ofs-delta\n"),
        encodePktLine(`want ${head}\n`),
        encodePktLine("deepen 1\n"),
        encodePktLine("done\n"),
        new TextEncoder().encode("0000"),
      ],
      stats: newServeStats(),
      onError: (error) => errors.push(error),
    });
    let tail = "";
    let bytes = 0;
    const reader = output.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      tail = decodeLatin1(value.subarray(Math.max(0, value.length - 64)));
    }
    // Some of the pack had gone out; the last packet is the error, on its own band.
    expect(bytes).toBeGreaterThan(MIB);
    expect(tail).toContain("\u0003internal error");
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("the bucket is away");
    // Reads begun ahead of the failure settle by themselves; a rejection nobody handles fails this test.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});

/** Writes a file, making its directory, without committing it. */
function writeFile(cwd: string, path: string, content: string): void {
  mkdirSync(join(cwd, path, ".."), { recursive: true });
  writeFileSync(join(cwd, path), content);
}
