/**
 * The JSON API's reader in workerd: the Worker's `RepoReader`, the real
 * `RepoDO` behind it, local R2 and the events queue. What `test/reader.test.ts`
 * proves about answers on Node, this proves about the path they travel in
 * production: one call from the Worker into the object, values and refusals
 * back across it, one object reaching another for a fork, and the API's own
 * routes on top.
 *
 * Opt-in, because it starts workerd: `GIT_WORKER_E2E=1 pnpm --filter
 * @infrawrench/git-worker test test/e2e/reader.test.ts`. With
 * `GIT_WORKER_BENCH=1` as well it also pushes this repository's history and
 * times the code page's requests.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupTempDirs,
  commitFile,
  git,
  gitOut,
  hasGit,
  initRepo,
  tempDir,
} from "../support/git";
import { type TestWorker, hasSsh, startWorker } from "./harness";

const enabled = process.env.GIT_WORKER_E2E === "1" && hasGit && hasSsh;
const local = (args: string[]): string =>
  spawnSync("git", args, { encoding: "utf8" }).stdout.trim();
const source = hasGit ? local(["rev-parse", "--show-toplevel"]) : "";
const bench =
  enabled &&
  process.env.GIT_WORKER_BENCH === "1" &&
  Number(local(["rev-list", "--count", "HEAD"])) >= 200;

const ALICE = "iwg_test_alice_0000000000000000000000000000";
const BOB = "iwg_test_bob_000000000000000000000000000000";
const basic = (token: string): string[] => [
  "-c",
  `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
];
const ACTOR = { kind: "user", userId: "alice", credentialId: null };
const MERGER = { name: "Alice", email: "alice@example.com" };

const DEMO = { id: "repo-demo", owner: "alice", name: "demo" };
const FORK = { id: "repo-fork", owner: "bob", name: "demo" };
const STARTED = { id: "repo-started", owner: "alice", name: "started" };
const MONO = { id: "repo-mono", owner: "alice", name: "mono" };

interface Entry {
  name: string;
  size: number | null;
  lastCommit: { oid: string } | null;
}
interface Listing {
  ref: { commitOid: string };
  entries: Entry[];
  lastCommitsComplete: boolean;
  commitCount: number | null;
  readmePath: string | null;
}

describe.skipIf(!enabled)("the reader against the worker in workerd", () => {
  let worker: TestWorker;
  let work: string;
  let main: string;
  let feature: string;

  const url = (path: string): string => `${worker.httpUrl}/${path}`;
  const api = async (path: string): Promise<{ status: number; body: any }> => {
    const response = await fetch(url(`api/repos/${path}`));
    const text = await response.text();
    return { status: response.status, body: text === "" ? null : JSON.parse(text) };
  };

  beforeAll(async () => {
    worker = await startWorker({
      tokens: {
        [ALICE]: { userId: "alice", scopes: ["repo:read", "repo:write"] },
        [BOB]: { userId: "bob", scopes: ["repo:read", "repo:write"] },
      },
      keys: {},
      users: { alice: "alice", bob: "bob" },
      repositories: [DEMO, STARTED, MONO]
        .map((each) => ({
          ...each,
          ownerUserId: "alice",
          visibility: "public" as const,
        }))
        .concat([{ ...FORK, ownerUserId: "bob", visibility: "public" as const }]),
    });
    work = await initRepo("e2e-reader");
    await commitFile(work, "README.md", "# Demo\n", "add a readme");
    await commitFile(work, "src/a.txt", "one\ntwo\nthree\n", "add a");
    main = await commitFile(work, "src/b.txt", "bee\n", "add b");
    await git(["checkout", "-q", "-b", "feature"], { cwd: work });
    feature = await commitFile(work, "src/a.txt", "one\n2\nthree\n", "a: two becomes 2");
    await git(["checkout", "-q", "main"], { cwd: work });
    await worker.reader(DEMO, "init", { defaultBranch: "main" });
    await git([...basic(ALICE), "push", "-q", url("alice/demo.git"), "--all"], { cwd: work });
  }, 240_000);

  afterAll(async () => {
    await worker?.stop();
    cleanupTempDirs();
  });

  it("answers the reader's methods from the repository's object", async () => {
    const listing = await worker.reader<Listing>(DEMO, "tree", {
      path: "",
      lastCommits: true,
    });
    expect(listing.ref.commitOid).toBe(main);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["src", "README.md"]);
    expect(listing.lastCommitsComplete).toBe(true);
    expect(listing.commitCount).toBe(3);
    expect(listing.readmePath).toBe("README.md");
    for (const entry of listing.entries) {
      const path = entry.name;
      expect(entry.lastCommit?.oid, path).toBe(
        await gitOut(["log", "-1", "--format=%H", "main", "--", path], { cwd: work }),
      );
    }
    expect(listing.entries[1]!.size).toBe(7);

    const commits = await worker.reader<{ items: Array<{ oid: string }> }>(DEMO, "listCommits", {
      limit: 10,
      path: "src",
    });
    expect(commits.items.map((commit) => commit.oid)).toEqual(
      (await gitOut(["log", "--format=%H", "main", "--", "src"], { cwd: work })).split("\n"),
    );
    const comparison = await worker.reader<{
      ahead: number;
      behind: number;
      mergeable: boolean;
      files: Array<{ path: string; additions: number }>;
    }>(DEMO, "compare", { base: "main", head: "feature" });
    expect(comparison).toMatchObject({ ahead: 1, behind: 0, mergeable: true });
    expect(comparison.files).toMatchObject([{ path: "src/a.txt", additions: 1 }]);
    const blame = await worker.reader<{ ranges: Array<{ commitOid: string; startLine: number }> }>(
      DEMO,
      "blame",
      { ref: "feature", path: "src/a.txt" },
    );
    expect(blame.ranges.find((range) => range.startLine === 2)?.commitOid).toBe(feature);

    // A refusal crosses the object's boundary with its code.
    await expect(worker.reader(DEMO, "blob", { path: "nope" })).rejects.toMatchObject({
      code: "path_not_found",
    });
    await expect(worker.reader(DEMO, "resolveRef", "gone")).rejects.toMatchObject({
      code: "ref_not_found",
    });
  });

  it("serves the API's content routes from the same storage", async () => {
    const refs = await api("alice/demo/refs");
    expect(refs.status).toBe(200);
    expect(refs.body).toMatchObject({
      defaultBranch: "main",
      branches: [
        { name: "main", oid: main },
        { name: "feature", oid: feature },
      ],
    });
    const blob = await api("alice/demo/blob?path=src/a.txt&ref=feature");
    expect(blob.body).toMatchObject({
      text: "one\n2\nthree\n",
      rawUrl: `/alice/demo/raw/${feature}/src/a.txt`,
      ref: { kind: "branch", name: "feature" },
    });
    expect((await api("alice/demo/readme")).body.readme).toMatchObject({ text: "# Demo\n" });
    const diff = await api(`alice/demo/commits/${feature.slice(0, 9)}/diff`);
    expect(diff.body).toMatchObject({
      baseOid: main,
      headOid: feature,
      stats: { filesChanged: 1, additions: 1, deletions: 1 },
    });
    expect(
      diff.body.files[0].hunks[0].lines.map((line: { content: string }) => line.content),
    ).toEqual(["one", "two", "2", "three"]);
    const compared = await api("alice/demo/compare/diff?base=main&head=feature");
    expect(compared.body.files[0].path).toBe("src/a.txt");

    // Refusals are the API's own errors.
    expect(await api("alice/demo/blob?path=nope")).toMatchObject({
      status: 404,
      body: { code: "path_not_found" },
    });
    expect((await api("alice/demo/blob?path=src")).status).toBe(422);
    expect((await api("alice/demo/compare/diff?base=main&head=gone")).status).toBe(422);
    // A repository whose storage was never made is unavailable, not empty.
    expect((await api("alice/mono/refs")).status).toBe(503);
  });

  it("starts a repository with a first commit and keeps its sizes", async () => {
    const started = await worker.reader<{ headOid: string }>(STARTED, "init", {
      defaultBranch: "main",
      initialize: {
        readme: true,
        gitignore: "Terraform",
        license: "MIT",
        author: MERGER,
        title: "started",
        description: null,
      },
    });
    const clone = join(tempDir("started"), "repo");
    await git(["clone", "-q", url("alice/started.git"), clone]);
    expect(await gitOut(["rev-parse", "HEAD"], { cwd: clone })).toBe(started.headOid);
    expect((await gitOut(["ls-tree", "--name-only", "HEAD"], { cwd: clone })).split("\n")).toEqual([
      ".gitignore",
      "LICENSE",
      "README.md",
    ]);
    const stats = await worker.reader<{ sizeBytes: number; branchCount: number }>(STARTED, "stats");
    expect(stats.branchCount).toBe(1);
    expect(stats.sizeBytes).toBeGreaterThan(0);
  });

  it("moves refs from the API's side, and tells the queue who did", async () => {
    await worker.reader(DEMO, "createBranch", { name: "release", from: "main", actor: ACTOR });
    await expect(
      worker.reader(DEMO, "createBranch", { name: "release", from: "main", actor: ACTOR }),
    ).rejects.toMatchObject({ code: "ref_exists" });
    const outcome = await worker.reader<{ merged: boolean; commitOid: string }>(DEMO, "merge", {
      baseRef: "release",
      headRepositoryId: DEMO.id,
      headOid: feature,
      method: "squash",
      title: "Squashed (#1)",
      message: "",
      committer: MERGER,
      actor: ACTOR,
    });
    expect(outcome.merged).toBe(true);
    const clone = join(tempDir("merged"), "repo");
    await git(["clone", "-q", "-b", "release", url("alice/demo.git"), clone]);
    await git(["fsck", "--strict", "--full"], { cwd: clone });
    expect(await gitOut(["rev-parse", "HEAD"], { cwd: clone })).toBe(outcome.commitOid);
    expect(await gitOut(["log", "-1", "--format=%P|%s|%cn", "HEAD"], { cwd: clone })).toBe(
      `${main}|Squashed (#1)|Alice`,
    );
    expect(await gitOut(["rev-parse", "HEAD^{tree}"], { cwd: clone })).toBe(
      await gitOut(["rev-parse", `${feature}^{tree}`], { cwd: work }),
    );

    // The queue hears of both, as it hears of a push.
    let events: Awaited<ReturnType<TestWorker["events"]>> = [];
    for (let i = 0; i < 40; i++) {
      events = (await worker.events()).filter((event) =>
        event.updates.some((update) => update.name === "refs/heads/release"),
      );
      if (events.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.repoId === DEMO.id)).toBe(true);
    expect((events as unknown as Array<{ actor: unknown }>).map((event) => event.actor)).toEqual([
      ACTOR,
      ACTOR,
    ]);
  });

  it("merges a pull request from a fork, one object reading from the other", async () => {
    const stats = await worker.reader<{ branchCount: number }>(FORK, "forkFrom", DEMO.id, {
      defaultBranchOnly: true,
    });
    expect(stats.branchCount).toBe(1);
    const clone = join(tempDir("fork"), "repo");
    await git(["clone", "-q", url("bob/demo.git"), clone]);
    await git(["checkout", "-q", "-b", "patch"], { cwd: clone });
    const head = await commitFile(clone, "src/c.txt", "sea\n", "fork: add c");
    await git([...basic(BOB), "push", "-q", "origin", "patch"], { cwd: clone });

    const comparison = await worker.reader<{ ahead: number; head: { commitOid: string } }>(
      DEMO,
      "compare",
      { base: "main", head: "patch", headRepositoryId: FORK.id },
    );
    expect(comparison).toMatchObject({ ahead: 1, head: { commitOid: head } });
    await worker.reader(DEMO, "setPullRef", { number: 7, headRepositoryId: FORK.id, oid: head });
    // CI's way in: the fork's commit, fetched from the base by the pull request's ref.
    const ci = join(tempDir("ci"), "repo");
    await git(["init", "-q", ci]);
    await git(["fetch", "-q", "--depth", "1", url("alice/demo.git"), "refs/pull/7/head"], {
      cwd: ci,
    });
    expect(await gitOut(["rev-parse", "FETCH_HEAD"], { cwd: ci })).toBe(head);

    expect(
      await worker.reader(DEMO, "mergeability", {
        baseRef: "main",
        headRepositoryId: FORK.id,
        headOid: head,
      }),
    ).toMatchObject({ state: "clean", aheadBy: 1, behindBy: 0 });
    const outcome = await worker.reader<{ merged: boolean; commitOid: string }>(DEMO, "merge", {
      baseRef: "main",
      headRepositoryId: FORK.id,
      headOid: head,
      method: "merge",
      title: "Merge pull request #7",
      message: "",
      committer: MERGER,
      actor: ACTOR,
    });
    expect(outcome.merged).toBe(true);
    const merged = join(tempDir("merged-fork"), "repo");
    await git(["clone", "-q", url("alice/demo.git"), merged]);
    await git(["fsck", "--strict", "--full"], { cwd: merged });
    expect(await gitOut(["log", "-1", "--format=%H|%P", "HEAD"], { cwd: merged })).toBe(
      `${outcome.commitOid}|${main} ${head}`,
    );
    expect(await gitOut(["show", "HEAD:src/c.txt"], { cwd: merged })).toBe("sea");

    // Deleting the fork leaves the base whole.
    await worker.reader(FORK, "destroy");
    await expect(worker.reader(FORK, "stats")).rejects.toMatchObject({ code: "unavailable" });
    expect((await api("alice/demo/blob?path=src/c.txt")).body.text).toBe("sea\n");
  });

  it.skipIf(!bench)(
    "answers the code page of this repository well inside a second",
    async () => {
      const mirror = join(tempDir("monorepo"), "mirror.git");
      await git(["clone", "-q", "--bare", "--no-local", "--single-branch", source, mirror]);
      const head = await gitOut(["rev-parse", "HEAD"], { cwd: mirror });
      await worker.reader(MONO, "init", { defaultBranch: "main" });
      await git([...basic(ALICE), "push", "-q", url("alice/mono.git"), "HEAD:refs/heads/main"], {
        cwd: mirror,
      });

      const rows: string[] = [];
      const timed = async <T>(
        name: string,
        method: string,
        ...args: unknown[]
      ): Promise<[T, number]> => {
        const { result, millis } = await worker.timedReader<T>(MONO, method, ...args);
        rows.push(`  ${name.padEnd(48)} ${millis.toFixed(0).padStart(6)} ms`);
        return [result, millis];
      };
      const root = { path: "", lastCommits: true };
      const [first, firstTree] = await timed<Listing>(
        "tree / with last commits (first ever)",
        "tree",
        root,
      );
      let complete = first.lastCommitsComplete;
      let slowest = 0;
      for (let round = 1; !complete; round++) {
        const [more, millis] = await timed<{ complete: boolean }>(
          `  treeLastCommits, round ${round}`,
          "treeLastCommits",
          { path: "" },
        );
        slowest = Math.max(slowest, millis);
        complete = more.complete;
        expect(round).toBeLessThan(50);
      }
      const [, readme] = await timed("readme /", "readme", { path: "" });
      const [again, warmTree] = await timed<Listing>(
        "tree / with last commits (again)",
        "tree",
        root,
      );
      expect(again.lastCommitsComplete).toBe(true);
      expect(again.entries.every((entry) => entry.lastCommit !== null)).toBe(true);
      expect(again.commitCount).toBe(
        Number(await gitOut(["rev-list", "--count", head], { cwd: mirror })),
      );
      const [, warmReadme] = await timed("readme / (again)", "readme", { path: "" });
      await timed("tree app/packages/web/src (first ever)", "tree", {
        path: "app/packages/web/src",
        lastCommits: true,
      });
      await timed("blob KNOWLEDGE.md", "blob", { path: "KNOWLEDGE.md" });
      await timed("commits, first 30", "listCommits", { limit: 30 });
      await timed("commits of KNOWLEDGE.md, first 30", "listCommits", {
        limit: 30,
        path: "KNOWLEDGE.md",
      });
      await timed("commit HEAD", "commit", head);
      await timed("commit HEAD, diff", "commitDiff", head, { limit: 30 });
      await timed("compare HEAD~50...HEAD", "compare", {
        base: await gitOut(["rev-parse", "HEAD~50"], { cwd: mirror }),
        head,
      });
      await timed("blame CLAUDE.md", "blame", { path: "CLAUDE.md" });

      // The same walks run in the Worker instead, an object a call.
      const workerSide = async (name: string, body: Record<string, unknown>): Promise<void> => {
        const response = await fetch(url("__test/worker-side"), {
          method: "POST",
          body: JSON.stringify({ repoId: MONO.id, commit: head, ...body }),
        });
        const { millis, reads } = (await response.json()) as { millis: number; reads: number };
        rows.push(
          `  ${name.padEnd(48)} ${millis.toFixed(0).padStart(6)} ms  (${reads} calls to the object)`,
        );
      };
      await workerSide("in the Worker: commits, first 30", { op: "log" });
      await workerSide("in the Worker: commits of KNOWLEDGE.md, first 30", {
        op: "log",
        path: "KNOWLEDGE.md",
      });
      await workerSide("in the Worker: last commits of /, 300 commits", { op: "last-commits" });

      const report = [
        `git-worker reader in workerd, this repository's history (${again.commitCount} commits), timed in the Worker around each call:`,
        ...rows,
      ].join("\n");
      console.log(report);
      if (process.env.GIT_WORKER_BENCH_OUT) {
        appendFileSync(process.env.GIT_WORKER_BENCH_OUT, `${report}\n`);
      }
      for (const millis of [firstTree, slowest, readme]) expect(millis).toBeLessThan(900);
      expect(warmTree + warmReadme).toBeLessThan(300);
    },
    900_000,
  );
});
