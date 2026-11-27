/**
 * How long the storage code takes to serve a fetch of this repository when
 * every read of the bucket costs what an R2 read costs (issue #1447): the
 * shallow fetch of one commit that Infrawrench CI makes, a full clone, and
 * a fetch of the last 50 commits. Two repositories: this one's whole
 * history, and its newest tree as a single commit.
 *
 * Each line says how long the walk took (up to the pack's first byte), how
 * long the pack took, and how many reads of the bucket each made. The
 * reads are the number to watch: they are the same in production, where
 * the milliseconds are not.
 *
 * Opt-in: `GIT_WORKER_BENCH=1 pnpm --filter @infrawrench/git-worker test
 * test/pack-bench.test.ts`. `GIT_WORKER_BENCH_PROFILES` picks the bucket
 * profiles (`instant,issue` by default; `near` and `far` are the others),
 * `GIT_WORKER_BENCH_OUT` a file the report is appended to. A fetch is served
 * by a repository object that has just woken unless its line says `warm`,
 * which is the same fetch again from the same object.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, createReadStream, readdirSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { ZERO_OID, encodePktLine } from "@infrawrench/git-core";
import { newServeStats, serve } from "@infrawrench/git-protocol";
import { afterAll, describe, expect, it } from "vitest";
import { Repository } from "../src/repo/do/repository";
import { cleanupTempDirs, git, gitOut, hasGit, tempDir } from "./support/git";
import { type NodeStorage, nodeStorage } from "./support/node-platform";
import { type BucketProfile, INSTANT, SlowBucket } from "./support/slow-bucket";

const local = (args: string[]): string =>
  spawnSync("git", args, { encoding: "utf8" }).stdout.trim();
const source = hasGit ? local(["rev-parse", "--show-toplevel"]) : "";
const enabled =
  process.env.GIT_WORKER_BENCH === "1" &&
  hasGit &&
  Number(local(["rev-list", "--count", "HEAD"])) >= 200;

const MIB = 1024 * 1024;

/**
 * What a read of the bucket costs. `issue` is what #1447's own figures work
 * out to: its walk made 136 reads in about 8 seconds, 59 ms a read of
 * 256 KiB. `near` is half that, `far` an object an ocean away from its
 * bucket, which is where one made before the location hint lives.
 */
const PROFILES: Record<string, BucketProfile> = {
  instant: INSTANT,
  near: { firstByteMs: 25, bytesPerSecond: 60 * MIB },
  issue: { firstByteMs: 55, bytesPerSecond: 60 * MIB },
  far: { firstByteMs: 110, bytesPerSecond: 6 * MIB },
};

interface Stored {
  readonly bucket: SlowBucket;
  readonly storage: NodeStorage;
  readonly head: string;
  readonly objects: number;
  readonly packBytes: number;
}

interface Result {
  readonly walkSeconds: number;
  readonly packSeconds: number;
  readonly walkGets: number;
  readonly packGets: number;
  readonly readBytes: number;
  readonly sentBytes: number;
  readonly objects: number;
  readonly source: string | null;
  readonly inFlightPeak: number;
}

afterAll(cleanupTempDirs);

async function store(packFile: string, head: string): Promise<Stored> {
  const bucket = new SlowBucket();
  const storage = nodeStorage();
  const repository = new Repository({ bucket, storage, events: null });
  repository.open("repo-1");
  const pack = Readable.toWeb(createReadStream(packFile, { highWaterMark: 65536 }));
  const staged = await repository.ingest(pack as unknown as ReadableStream<Uint8Array>);
  const [result] = await repository.updateRefs(
    [{ name: "refs/heads/main", oldOid: ZERO_OID, newOid: head }],
    { atomic: false, pack: staged },
  );
  expect(result?.error).toBeNull();
  const stats = repository.stats();
  return { bucket, storage, head, objects: stats.objects, packBytes: stats.liveBytes };
}

/** A new object over the same storage: nothing is cached but what is written down. */
function wake(stored: Stored): Repository {
  const repository = new Repository({
    bucket: stored.bucket,
    storage: stored.storage,
    events: null,
  });
  repository.open("repo-1");
  return repository;
}

/** A protocol v2 `fetch`, against a repository object that has just woken unless one is given. */
async function fetchPack(
  stored: Stored,
  profile: BucketProfile,
  args: readonly string[],
  repository = wake(stored),
): Promise<Result> {
  const { bucket } = stored;
  bucket.profile = profile;
  bucket.resetRead();
  const stats = newServeStats();
  const request = [
    encodePktLine("command=fetch\n"),
    encodePktLine("object-format=sha1\n"),
    new TextEncoder().encode("0001"),
    encodePktLine("thin-pack\n"),
    encodePktLine("ofs-delta\n"),
    ...args.map((arg) => encodePktLine(`${arg}\n`)),
    encodePktLine("done\n"),
    new TextEncoder().encode("0000"),
  ];
  const started = performance.now();
  const output = serve({
    backend: repository.backend(),
    request: { service: "git-upload-pack", version: 2, statelessRpc: true, advertiseOnly: false },
    input: request,
    stats,
  });
  let sentBytes = 0;
  let walkEnded = 0;
  let walkGets = 0;
  const reader = output.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sentBytes += value.length;
    // Band 1 is the pack: `PACK` right after the four length digits and the band byte.
    if (walkEnded === 0 && value.length > 9 && value[4] === 1 && value[5] === 0x50) {
      walkEnded = performance.now();
      walkGets = bucket.read.gets;
    }
  }
  const ended = performance.now();
  bucket.profile = INSTANT;
  return {
    walkSeconds: (walkEnded - started) / 1000,
    packSeconds: (ended - walkEnded) / 1000,
    walkGets,
    packGets: bucket.read.gets - walkGets,
    readBytes: bucket.read.bytes,
    sentBytes,
    objects: stats.objectsSent,
    source: stats.packSource,
    inFlightPeak: bucket.read.inFlightPeak,
  };
}

describe.skipIf(!enabled)("serving a fetch when every bucket read has a price", () => {
  it("measures this repository's history and its newest tree", async () => {
    const mirror = join(tempDir("monorepo"), "mirror.git");
    await git(["clone", "-q", "--bare", "--no-local", "--single-branch", source, mirror]);
    const head = await gitOut(["rev-parse", "HEAD"], { cwd: mirror });
    const old = await gitOut(["rev-parse", "HEAD~50"], { cwd: mirror });
    const packDir = join(mirror, "objects/pack");
    const historyPack = join(
      packDir,
      readdirSync(packDir).find((file) => file.endsWith(".pack"))!,
    );
    // The newest tree as one commit: the repository the issue measured.
    const env = {
      GIT_AUTHOR_NAME: "bench",
      GIT_AUTHOR_EMAIL: "bench@example.com",
      GIT_COMMITTER_NAME: "bench",
      GIT_COMMITTER_EMAIL: "bench@example.com",
    };
    const snapshot = await gitOut(["commit-tree", "-m", "snapshot", `${head}^{tree}`], {
      cwd: mirror,
      env,
    });
    const snapshotPack = join(tempDir("snapshot"), "snapshot.pack");
    const packed = spawnSync(
      "sh",
      ["-c", `echo ${snapshot} | git pack-objects --revs --stdout -q > "${snapshotPack}"`],
      { cwd: mirror },
    );
    expect(packed.status).toBe(0);

    const history = await store(historyPack, head);
    const single = await store(snapshotPack, snapshot);

    const names = (process.env.GIT_WORKER_BENCH_PROFILES ?? "instant,issue")
      .split(",")
      .filter((name) => name in PROFILES);
    const lines: string[] = [];
    const describeRepo = (name: string, stored: Stored): string =>
      `${name}: ${stored.objects} objects, ${(stored.packBytes / MIB).toFixed(1)} MiB of pack and index`;
    const row = (name: string, profile: string, result: Result): string =>
      `  ${name.padEnd(36)} ${profile.padEnd(8)} ` +
      `walk ${result.walkSeconds.toFixed(2).padStart(7)} s ${String(result.walkGets).padStart(6)} reads   ` +
      `pack ${result.packSeconds.toFixed(2).padStart(7)} s ${String(result.packGets).padStart(6)} reads   ` +
      `${result.objects} objects, sent ${(result.sentBytes / MIB).toFixed(1)} MiB, ` +
      `read ${(result.readBytes / MIB).toFixed(1)} MiB, ${result.inFlightPeak} at once (${result.source})`;

    const previous = await gitOut(["rev-parse", "HEAD~1"], { cwd: mirror });
    const next = [`want ${history.head}`, `have ${previous}`, `shallow ${previous}`, "deepen 1"];
    const cases: Array<[string, Stored, string[], boolean]> = [
      ["one commit, shallow (CI, first)", single, [`want ${single.head}`, "deepen 1"], false],
      ["one commit, clone", single, [`want ${single.head}`], false],
      ["history, shallow (CI, first)", history, [`want ${history.head}`, "deepen 1"], false],
      ["history, shallow, next commit (CI)", history, next, false],
      ["history, shallow, next commit, warm", history, next, true],
      ["history, clone by walking", history, [`want ${history.head}`], false],
      ["history, last 50 commits", history, [`want ${history.head}`, `have ${old}`], false],
    ];
    lines.push(describeRepo("one commit", single), describeRepo("history", history));
    for (const [name, stored, args, warm] of cases) {
      for (const profile of names) {
        const repository = wake(stored);
        // The fetch a runner made of the commit before, from the same object.
        if (warm) await fetchPack(stored, INSTANT, [`want ${previous}`, "deepen 1"], repository);
        const result = await fetchPack(stored, PROFILES[profile]!, args, repository);
        expect(result.objects).toBeGreaterThan(0);
        lines.push(row(name, profile, result));
      }
    }
    const report = lines.join("\n");
    console.log(report);
    if (process.env.GIT_WORKER_BENCH_OUT) {
      appendFileSync(process.env.GIT_WORKER_BENCH_OUT, `${report}\n`);
    }
  }, 3_600_000);
});
