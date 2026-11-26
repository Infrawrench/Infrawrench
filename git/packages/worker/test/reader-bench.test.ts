/**
 * How long the JSON API's reader takes on this repository's own history,
 * and how many R2 reads each request makes. The reader runs here as it does
 * in the Durable Object, on the Node stand-ins; `test/e2e/reader.test.ts`
 * measures the same requests through workerd.
 *
 * "Cold" is an object that has just woken: a new `Repository` and a new
 * `ReaderState` over the same bucket and tables, so pack indexes are loaded
 * again and nothing is cached in memory. "Warm" is the same request again.
 *
 * Opt-in: `GIT_WORKER_BENCH=1 pnpm --filter @infrawrench/git-worker test
 * test/reader-bench.test.ts`.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, createReadStream, readdirSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { ZERO_OID } from "@infrawrench/git-core";
import { afterAll, describe, expect, it } from "vitest";
import { Repository } from "../src/repo/do/repository";
import { ReaderState, localRepoReader } from "../src/repo/queries";
import type { RepoReader } from "../src/repo/reader";
import { cleanupTempDirs, git, gitOut, hasGit, tempDir } from "./support/git";
import { MemoryBucket, nodeStorage } from "./support/node-platform";

const local = (args: string[]): string =>
  spawnSync("git", args, { encoding: "utf8" }).stdout.trim();
const source = hasGit ? local(["rev-parse", "--show-toplevel"]) : "";
const enabled =
  process.env.GIT_WORKER_BENCH === "1" &&
  hasGit &&
  Number(local(["rev-list", "--count", "HEAD"])) >= 200;

afterAll(cleanupTempDirs);

describe.skipIf(!enabled)("the reader on this repository's history", () => {
  it("answers the code page's requests well inside a second", async () => {
    const mirror = join(tempDir("monorepo"), "mirror.git");
    await git(["clone", "-q", "--bare", "--no-local", "--single-branch", source, mirror]);
    const head = await gitOut(["rev-parse", "HEAD"], { cwd: mirror });
    const packDir = join(mirror, "objects/pack");
    const packFile = join(
      packDir,
      readdirSync(packDir).find((file) => file.endsWith(".pack"))!,
    );

    const bucket = new MemoryBucket();
    const storage = nodeStorage();
    const locator = { id: "repo-1", owner: "infrawrench", name: "infrawrench" };
    const wake = (): RepoReader => {
      const repository = new Repository({ bucket, storage, events: null });
      repository.open(locator.id);
      return localRepoReader(repository, new ReaderState(), locator);
    };
    {
      const repository = new Repository({ bucket, storage, events: null });
      repository.open(locator.id);
      const pack = Readable.toWeb(createReadStream(packFile, { highWaterMark: 65536 }));
      const staged = await repository.ingest(pack as unknown as ReadableStream<Uint8Array>);
      const [result] = await repository.updateRefs(
        [{ name: "refs/heads/main", oldOid: ZERO_OID, newOid: head }],
        { atomic: false, pack: staged },
      );
      expect(result?.error).toBeNull();
    }

    const rows: string[] = [];
    const timed = async <T>(name: string, work: () => Promise<T>): Promise<[T, number]> => {
      const reads = bucket.calls.rangeGet + bucket.calls.get;
      const started = performance.now();
      const value = await work();
      const millis = performance.now() - started;
      rows.push(
        `  ${name.padEnd(46)} ${millis.toFixed(1).padStart(8)} ms  ${String(
          bucket.calls.rangeGet + bucket.calls.get - reads,
        ).padStart(4)} R2 reads`,
      );
      return [value, millis];
    };

    // The code page, on an object that has just woken and has never walked this history.
    let reader = wake();
    const [first, firstTree] = await timed("cold: tree / with last commits (first ever)", () =>
      reader.tree({ ref: undefined, path: "", lastCommits: true }),
    );
    let complete = first.lastCommitsComplete;
    let rounds = 0;
    let slowestRound = 0;
    while (!complete) {
      const [more, millis] = await timed(`      treeLastCommits, round ${++rounds}`, () =>
        reader.treeLastCommits({ ref: undefined, path: "" }),
      );
      slowestRound = Math.max(slowestRound, millis);
      complete = more.complete;
      expect(rounds).toBeLessThan(50);
    }
    const [, coldReadme] = await timed("      readme /", () =>
      reader.readme({ ref: undefined, path: "" }),
    );

    // The same page once the walk has been written down: a woken object reads it back.
    reader = wake();
    const [second, wokenTree] = await timed("woken: tree / with last commits", () =>
      reader.tree({ ref: undefined, path: "", lastCommits: true }),
    );
    expect(second.lastCommitsComplete).toBe(true);
    expect(second.entries.every((entry) => entry.lastCommit !== null)).toBe(true);
    const [, wokenReadme] = await timed("woken: readme /", () =>
      reader.readme({ ref: undefined, path: "" }),
    );
    const [, warmTree] = await timed("warm: tree / with last commits", () =>
      reader.tree({ ref: undefined, path: "", lastCommits: true }),
    );
    const [, warmReadme] = await timed("warm: readme /", () =>
      reader.readme({ ref: undefined, path: "" }),
    );

    reader = wake();
    await timed("cold: tree / without last commits", () =>
      reader.tree({ ref: undefined, path: "", lastCommits: false }),
    );
    reader = wake();
    await timed("cold: tree app/packages/web/src (first ever)", () =>
      // ci-reads-ignore: a path inside the test repository, not a file this test reads
      reader.tree({ ref: undefined, path: "app/packages/web/src", lastCommits: true }),
    );
    reader = wake();
    await timed("cold: blob KNOWLEDGE.md", () =>
      reader.blob({ ref: undefined, path: "KNOWLEDGE.md" }),
    );
    reader = wake();
    await timed("cold: commits, first 30", () => reader.listCommits({ ref: undefined, limit: 30 }));
    await timed("warm: commits, next 30", () =>
      reader.listCommits({ ref: undefined, limit: 30, cursor: "30" }),
    );
    reader = wake();
    await timed("cold: commits of KNOWLEDGE.md, first 30", () =>
      reader.listCommits({ ref: undefined, limit: 30, path: "KNOWLEDGE.md" }),
    );
    reader = wake();
    await timed("cold: commits of git/, first 30", () =>
      reader.listCommits({ ref: undefined, limit: 30, path: "git" }),
    );
    reader = wake();
    await timed("cold: commit HEAD", () => reader.commit(head));
    await timed("warm: commit HEAD, diff", () => reader.commitDiff(head, { limit: 30 }));
    reader = wake();
    await timed("cold: compare HEAD~50...HEAD", () =>
      reader.compare({ base: `${head}`, head: `${head}` }).then(async () =>
        reader.compare({
          base: await gitOut(["rev-parse", "HEAD~50"], { cwd: mirror }),
          head,
        }),
      ),
    );
    reader = wake();
    await timed("cold: blame CLAUDE.md", () => reader.blame({ ref: undefined, path: "CLAUDE.md" }));
    reader = wake();
    await timed("cold: branches", () => reader.listBranches({ limit: 30 }));

    const report = [
      `git-worker reader on Node, this repository's history (${first.commitCount} commits):`,
      ...rows,
    ].join("\n");
    console.log(report);
    if (process.env.GIT_WORKER_BENCH_OUT) {
      appendFileSync(process.env.GIT_WORKER_BENCH_OUT, `${report}\n`);
    }

    // Every request of the code page, in every state, well under a second.
    for (const millis of [firstTree, slowestRound, coldReadme, wokenTree, wokenReadme]) {
      expect(millis).toBeLessThan(700);
    }
    expect(warmTree + warmReadme).toBeLessThan(100);
  });
});
