/**
 * Versions of a branch, with the real `git` pushing: every push to a branch
 * that is not the default branch is a version, forced pushes and rebases
 * included; the refs that keep them are never shown to a client; and the
 * diffs between versions say what the author changed, not what a rebase
 * brought.
 */
import { join } from "node:path";
import { ZERO_OID } from "@infrawrench/git-core";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { VERSION_REF_PREFIX } from "../src/repo/do/versions";
import { ReaderState, localRepoReader } from "../src/repo/queries";
import type { RepoReader } from "../src/repo/reader";
import {
  cleanupTempDirs,
  commitFile,
  git,
  gitOut,
  hasGit,
  initRepo,
  resetClock,
  tempDir,
} from "./support/git";
import { type NodeRepo, startNodeRepo } from "./support/node-server";

afterAll(cleanupTempDirs);

const describeGit = describe.skipIf(!hasGit);

const lines = (count: number, changed: Record<number, string> = {}): string =>
  Array.from({ length: count }, (_, i) => changed[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

describeGit("versions of a branch", () => {
  let repo: NodeRepo;
  let reader: RepoReader;
  let work: string;
  let main: string;

  beforeEach(async () => {
    resetClock();
    repo = await startNodeRepo();
    reader = localRepoReader(repo.repository, new ReaderState(), {
      id: "repo-1",
      owner: "acme",
      name: "fixture",
    });
    work = await initRepo("versions");
    await commitFile(work, "a.txt", lines(20), "a");
    main = await commitFile(work, "b.txt", lines(10), "b");
    await git(["remote", "add", "origin", repo.url], { cwd: work });
    await git(["push", "-q", "origin", "main"], { cwd: work });
  });
  afterEach(async () => {
    expect(repo.errors).toEqual([]);
    await repo.close();
  });

  const push = (...args: string[]) => git(["push", "-q", ...args], { cwd: work });
  const checkout = (...args: string[]) => git(["checkout", "-q", ...args], { cwd: work });
  const versions = (branch = "feature") => repo.repository.versions(branch);
  const versionRefs = () =>
    repo.repository
      .listRefs()
      .filter((ref) => ref.name.startsWith(VERSION_REF_PREFIX))
      .map((ref) => `${ref.name.slice(VERSION_REF_PREFIX.length)} ${ref.oid}`);
  const clone = async (): Promise<string> => {
    const dir = join(tempDir("clone"), "clone");
    await git(["clone", "-q", repo.url, dir]);
    await git(["fsck", "--strict", "--full"], { cwd: dir });
    return dir;
  };
  const hasObject = async (cwd: string, oid: string): Promise<boolean> =>
    (await git(["cat-file", "-e", oid], { cwd, allowFailure: true })).status === 0;

  it("records one for every push, forced ones too, and none for the default branch", async () => {
    await commitFile(work, "c.txt", "c\n", "c");
    await push("origin", "main");
    expect(versions("main")).toEqual([]);

    await checkout("-b", "feature");
    const one = await commitFile(work, "a.txt", lines(20, { 5: "five" }), "feature: line 5");
    await push("origin", "feature");
    const two = await commitFile(work, "a.txt", lines(20, { 5: "five", 6: "six" }), "line 6");
    await push("origin", "feature");
    await git(["commit", "-q", "--amend", "-m", "line 6, reworded"], { cwd: work });
    const three = await gitOut(["rev-parse", "HEAD"], { cwd: work });
    await push("--force", "origin", "feature");

    expect(versions()).toEqual(
      [
        { branch: "feature", lineage: 1, number: 1, tipOid: one, previousOid: null, forced: false },
        { branch: "feature", lineage: 1, number: 2, tipOid: two, previousOid: one, forced: false },
        { branch: "feature", lineage: 1, number: 3, tipOid: three, previousOid: two, forced: true },
      ].map((version) => ({ ...version, at: expect.any(Number) })),
    );
    expect(versionRefs()).toEqual([
      `1/1/feature ${one}`,
      `1/2/feature ${two}`,
      `1/3/feature ${three}`,
    ]);
    // What the forced push took off the branch is still a version, and can be read.
    expect(await repo.repository.isReachable(two)).toBe(true);
    expect(versions("feature").length).toBe(3);
    // Asked for from a point, only what came after it.
    expect(
      repo.repository.versions("feature", { lineage: 1, number: 2 }).map((each) => each.number),
    ).toEqual([3]);
  });

  it("numbers a push once: a push that lost its race makes no version", async () => {
    await checkout("-b", "feature");
    const one = await commitFile(work, "c.txt", "c\n", "c");
    await push("origin", "feature");
    // The same update again, as a retry would send it: the branch is not where it says.
    const again = await repo.repository.applyUpdates([
      { name: "refs/heads/feature", oldOid: ZERO_OID, newOid: one },
    ]);
    expect(again[0]?.error).toBe("reference already exists");
    expect(versions().map((each) => each.number)).toEqual([1]);
  });

  it("starts a lineage when a branch is made again, and carries on when it is restored", async () => {
    await checkout("-b", "feature");
    const one = await commitFile(work, "c.txt", "c\n", "c");
    await push("origin", "feature");
    await push("origin", ":feature");
    // Restored at the commit it was deleted at: the same branch, and nothing was pushed.
    await repo.repository.applyUpdates([
      { name: "refs/heads/feature", oldOid: ZERO_OID, newOid: one },
    ]);
    expect(versions().map((each) => [each.lineage, each.number])).toEqual([[1, 1]]);
    const two = await commitFile(work, "c.txt", "c2\n", "c2");
    await push("origin", "feature");
    expect(versions().at(-1)).toMatchObject({ lineage: 1, number: 2, previousOid: one });

    // Deleted and made again with other work: a new lineage, numbered from 1.
    await push("origin", ":feature");
    await checkout("main");
    await git(["branch", "-q", "-D", "feature"], { cwd: work });
    await checkout("-b", "feature");
    const other = await commitFile(work, "d.txt", "d\n", "d");
    await push("origin", "feature");
    expect(versions().map((each) => [each.lineage, each.number, each.tipOid])).toEqual([
      [1, 1, one],
      [1, 2, two],
      [2, 1, other],
    ]);
    expect(versions().at(-1)?.previousOid).toBeNull();
  });

  it("makes no version of a branch that starts where the default branch is", async () => {
    await push("origin", "main:refs/heads/work/start");
    expect(versions("work/start")).toEqual([]);
    await checkout("-b", "work/start");
    const first = await commitFile(work, "c.txt", "c\n", "the work");
    await push("origin", "work/start");
    expect(versions("work/start")).toEqual([
      {
        branch: "work/start",
        lineage: 1,
        number: 1,
        tipOid: first,
        previousOid: main,
        forced: false,
        at: expect.any(Number),
      },
    ]);
  });

  it("never shows a client the refs that keep versions, and takes none from a push", async () => {
    await checkout("-b", "feature");
    const one = await commitFile(work, "secret.txt", "first draft\n", "draft");
    await push("origin", "feature");
    // Only fast-forwards so far: the stored packs still go out whole.
    await clone();
    expect(repo.requests.at(-1)?.packSource).toBe("everything");

    await git(["reset", "-q", "--hard", main], { cwd: work });
    const two = await commitFile(work, "kept.txt", "second draft\n", "redo");
    await push("--force", "origin", "feature");
    expect(versions().map((each) => each.tipOid)).toEqual([one, two]);

    for (const protocol of ["0", "2"]) {
      const listed = await gitOut(["-c", `protocol.version=${protocol}`, "ls-remote", repo.url], {
        cwd: work,
      });
      expect(listed).not.toContain("refs/infrawrench");
      expect(listed).toContain("refs/heads/feature");
    }
    // A clone of everything carries the branch, and nothing only a version holds.
    const cloned = await clone();
    expect(repo.requests.at(-1)?.packSource).toBe("objects");
    expect(await hasObject(cloned, two)).toBe(true);
    expect(await hasObject(cloned, one)).toBe(false);
    // Nor can it be asked for, by id or by the ref's name.
    for (const want of [one, `${VERSION_REF_PREFIX}1/1/feature`]) {
      const fetched = await git(["fetch", repo.url, want], { cwd: cloned, allowFailure: true });
      expect(fetched.status).not.toBe(0);
    }
    expect(await hasObject(cloned, one)).toBe(false);

    const pushed = await git(["push", "origin", `HEAD:${VERSION_REF_PREFIX}9/9/feature`], {
      cwd: work,
      allowFailure: true,
    });
    expect(pushed.status).not.toBe(0);
    expect(pushed.stderr).toContain("managed by the server");
    expect(versionRefs()).toHaveLength(2);
  });

  it("forgets pruned versions and their commits, and never reuses a number", async () => {
    await checkout("-b", "feature");
    const one = await commitFile(work, "c.txt", "c\n", "c");
    await push("origin", "feature");
    await git(["reset", "-q", "--hard", main], { cwd: work });
    const two = await commitFile(work, "d.txt", "d\n", "d");
    await push("--force", "origin", "feature");
    expect(await repo.repository.isReachable(one)).toBe(true);

    expect(
      await reader.pruneVersions({ branch: "feature", versions: [{ lineage: 1, number: 1 }] }),
    ).toEqual({ dropped: 1 });
    // Again changes nothing.
    expect(
      await reader.pruneVersions({ branch: "feature", versions: [{ lineage: 1, number: 1 }] }),
    ).toEqual({ dropped: 0 });
    expect((await reader.listVersions({ branch: "feature" })).map((each) => each.number)).toEqual([
      2,
    ]);
    expect(versionRefs()).toEqual([`1/2/feature ${two}`]);
    expect(await repo.repository.isReachable(one)).toBe(false);
    // A clone still walks: what the pruned version held is stored, and nothing reaches it.
    const cloned = await clone();
    expect(repo.requests.at(-1)?.packSource).toBe("objects");
    expect(await hasObject(cloned, one)).toBe(false);

    await commitFile(work, "e.txt", "e\n", "e");
    await push("origin", "feature");
    expect(versions().map((each) => each.number)).toEqual([2, 3]);
  });

  describe("diffs between versions", () => {
    let base1: string;
    let base2: string;
    let v1: string;
    let v2: string;

    /** A change, then the base moves, then the change is rebased and added to. */
    beforeEach(async () => {
      base1 = main;
      await checkout("-b", "feature");
      v1 = await commitFile(work, "a.txt", lines(20, { 5: "five" }), "a: line 5");
      await push("origin", "feature");

      await checkout("main");
      base2 = await commitFile(work, "b.txt", lines(10, { 2: "two" }), "b: line 2");
      await commitFile(work, "a.txt", lines(20, { 18: "eighteen" }), "a: line 18, on main");
      base2 = await gitOut(["rev-parse", "HEAD"], { cwd: work });
      await push("origin", "main");

      await checkout("feature");
      await git(["rebase", "-q", "main"], { cwd: work });
      v2 = await commitFile(
        work,
        "a.txt",
        lines(20, { 5: "five", 9: "nine", 18: "eighteen" }),
        "a: line 9",
      );
      await push("--force", "origin", "feature");
      expect(await gitOut(["merge-base", "main", "feature"], { cwd: work })).toBe(base2);
    });

    const page = { limit: 100 };

    it("answers a version's whole change as git does", async () => {
      const whole = await reader.versionDiff(
        { from: null, to: { tipOid: v2, baseOid: base2 } },
        page,
      );
      expect(whole).toMatchObject({ rebased: false, exact: true });
      const numstat = await gitOut(["diff", "--numstat", base2, v2], { cwd: work });
      expect(
        whole.diff.files.map((file) => `${file.additions}\t${file.deletions}\t${file.path}`),
      ).toEqual(numstat.split("\n"));
      expect(whole.diff).toMatchObject({ baseOid: base2, headOid: v2 });
    });

    it("shows what the author changed since a version, without what the rebase brought", async () => {
      const step = await reader.versionDiff(
        { from: { tipOid: v1, baseOid: base1 }, to: { tipOid: v2, baseOid: base2 } },
        page,
      );
      expect(step).toMatchObject({ rebased: true, exact: true });
      // Line 9 is the author's. Line 18 of a.txt and all of b.txt came with the new base.
      expect(step.diff.files.map((file) => file.path)).toEqual(["a.txt"]);
      expect(step.diff.stats).toEqual({ filesChanged: 1, additions: 1, deletions: 1 });
      const changed = step.diff.files[0]!.hunks.flatMap((hunk) =>
        hunk.lines.filter((line) => line.type !== "context").map((line) => line.content),
      );
      expect(changed).toEqual(["line 9", "nine"]);

      // The two tips compared as they are would show the rebase too.
      const tips = await gitOut(["diff", "--numstat", v1, v2], { cwd: work });
      expect(tips.split("\n")).toHaveLength(2);
    });

    it("is the plain comparison when the base did not move", async () => {
      const v3 = await commitFile(
        work,
        "a.txt",
        lines(20, { 5: "five", 9: "nine", 12: "twelve", 18: "eighteen" }),
        "a: line 12",
      );
      await push("origin", "feature");
      const step = await reader.versionDiff(
        { from: { tipOid: v2, baseOid: base2 }, to: { tipOid: v3, baseOid: base2 } },
        page,
      );
      expect(step).toMatchObject({ rebased: false, exact: true });
      expect(step.diff.stats).toEqual({ filesChanged: 1, additions: 1, deletions: 1 });
      expect(
        await reader.versionDiff(
          { from: { tipOid: v3, baseOid: base2 }, to: { tipOid: v3, baseOid: base2 } },
          page,
        ),
      ).toMatchObject({ diff: { files: [], stats: { filesChanged: 0 } } });
    });

    it("says so when the older version does not apply to the newer base", async () => {
      // The base rewrites the line the first version changed: carrying it over conflicts.
      await checkout("main");
      await commitFile(
        work,
        "a.txt",
        lines(20, { 5: "FIVE", 18: "eighteen" }),
        "a: line 5, on main",
      );
      const base3 = await gitOut(["rev-parse", "HEAD"], { cwd: work });
      await push("origin", "main");
      await checkout("-B", "feature", "main");
      const v3 = await commitFile(
        work,
        "a.txt",
        lines(20, { 5: "FIVE", 9: "nine", 18: "eighteen" }),
        "a: redone on the new base",
      );
      await push("--force", "origin", "feature");
      const step = await reader.versionDiff(
        { from: { tipOid: v1, baseOid: base1 }, to: { tipOid: v3, baseOid: base3 } },
        page,
      );
      expect(step).toMatchObject({ rebased: true, exact: false });
      expect(step.diff.files.map((file) => file.path).sort()).toEqual(["a.txt", "b.txt"]);
    });

    it("says where a comment's lines went, or that they changed", async () => {
      const anchors = [
        { key: "untouched", path: "a.txt", line: 3, startLine: null },
        { key: "the changed line", path: "a.txt", line: 9, startLine: null },
        { key: "a range across it", path: "a.txt", line: 10, startLine: 8 },
        { key: "a range that stands", path: "a.txt", line: 14, startLine: 12 },
        { key: "another file", path: "b.txt", line: 7, startLine: null },
        { key: "no such file", path: "gone.txt", line: 1, startLine: null },
      ];
      const mapped = await reader.mapLines({ fromOid: v1, toOid: v2, anchors });
      expect(Object.fromEntries(mapped.map(({ key, ...rest }) => [key, rest]))).toEqual({
        untouched: { line: 3, startLine: null },
        "the changed line": { changed: true },
        "a range across it": { changed: true },
        "a range that stands": { line: 14, startLine: 12 },
        "another file": { line: 7, startLine: null },
        "no such file": { changed: true },
      });

      // Lines put in above move what is below them.
      const v3 = await commitFile(
        work,
        "a.txt",
        "new first\nnew second\n" + lines(20, { 5: "five", 9: "nine", 18: "eighteen" }),
        "a: two lines on top",
      );
      await push("origin", "feature");
      expect(
        await reader.mapLines({
          fromOid: v2,
          toOid: v3,
          anchors: [{ key: "moved", path: "a.txt", line: 14, startLine: 12 }],
        }),
      ).toEqual([{ key: "moved", line: 16, startLine: 14 }]);
    });
  });
});
