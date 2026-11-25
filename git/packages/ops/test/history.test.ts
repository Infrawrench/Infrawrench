import { afterAll, beforeAll, expect, it } from "vitest";
import type { MemoryObjectStore } from "@infrawrench/git-core";
import {
  ObjectCache,
  aheadBehind,
  commitsBetween,
  isAncestor,
  log,
  mergeBase,
  mergeBases,
} from "../src";
import {
  type HistoryFixture,
  Repo,
  cleanupTempDirs,
  describeGit,
  editLines,
  loadStore,
  makeHistory,
  prng,
  sourceFile,
  text,
} from "./helpers";

afterAll(cleanupTempDirs);

async function allOids(
  store: MemoryObjectStore,
  start: string,
  options: Parameters<typeof log>[2] = {},
): Promise<string[]> {
  const result = await log(store, start, { limit: 100_000, ...options });
  expect(result.truncated).toBe(false);
  return result.entries.map((entry) => entry.oid);
}

describeGit("history against git", () => {
  let fixture: HistoryFixture;
  let store: MemoryObjectStore;
  let head: string;

  beforeAll(() => {
    fixture = makeHistory(7, 160);
    store = loadStore(fixture.repo);
    head = fixture.repo.rev("main");
  });

  it("lists commits in git's order", async () => {
    const { repo } = fixture;
    expect(await allOids(store, head)).toEqual(repo.lines("log", "--format=%H", "main"));
    expect(await allOids(store, head, { firstParent: true })).toEqual(
      repo.lines("log", "--format=%H", "--first-parent", "main"),
    );
  });

  it("pages with skip and limit", async () => {
    const all = fixture.repo.lines("log", "--format=%H", "main");
    const page = await log(store, head, { skip: 10, limit: 7 });
    expect(page.entries.map((entry) => entry.oid)).toEqual(all.slice(10, 17));
    expect(page.hasMore).toBe(true);
    const last = await log(store, head, { skip: all.length - 3, limit: 7 });
    expect(last.entries).toHaveLength(3);
    expect(last.hasMore).toBe(false);
    expect(page.entries[0]!.commit.committer.email).toBe("cy@example.com");
  });

  it("limits history to a path the way git simplifies it", async () => {
    const { repo } = fixture;
    // Every path that ever existed, files and directories alike.
    const paths = new Set<string>(["src", "src/lib", "docs", "tools"]);
    for (const line of repo.lines("log", "--format=", "--name-only", "--all")) {
      if (line !== "") paths.add(line);
    }
    expect(paths.size).toBeGreaterThan(20);
    for (const path of paths) {
      expect(await allOids(store, head, { path }), path).toEqual(
        repo.lines("log", "--format=%H", "main", "--", path),
      );
    }
    for (const path of ["src", "docs", "src/file-0.txt"]) {
      expect(await allOids(store, head, { path, firstParent: true }), path).toEqual(
        repo.lines("log", "--format=%H", "--first-parent", "main", "--", path),
      );
    }
  });

  it("follows a file through its renames, on every branch", async () => {
    const { repo } = fixture;
    const moved = repo.lines("ls-files").filter((path) => path.includes("moved-"));
    expect(moved.length).toBeGreaterThan(0);
    for (const path of moved) {
      const ours = await log(store, head, { path, followRenames: true, limit: 10_000 });
      const oids = ours.entries.map((entry) => entry.oid);
      // With merges in the way there is no exact answer to compare with: under --follow the
      // reference implementation stops simplifying history and tracks one name for the whole
      // walk. What must hold: the history under the current name is all there, in order, and
      // the walk carries on past the rename, listing only commits that touch the name they
      // are listed under.
      const plain = repo.lines("log", "--format=%H", "main", "--", path);
      let at = 0;
      for (const oid of oids) if (oid === plain[at]) at++;
      expect(at, path).toBe(plain.length);
      expect(oids.length).toBeGreaterThan(plain.length);
      expect(ours.entries.at(-1)!.path).not.toBe(path);
      for (const entry of ours.entries) {
        if (entry.commit.parents.length > 1) continue;
        const touched = repo.lines("show", "--format=", "--name-only", "--no-renames", entry.oid);
        expect(touched, `${entry.oid} ${entry.path}`).toContain(entry.path);
      }
    }
  });

  it("finds every merge base", async () => {
    const { repo, commits } = fixture;
    const next = prng(99);
    const tips = [...commits.slice(-12), ...repo.lines("rev-parse", "--branches")];
    let checked = 0;
    for (let i = 0; i < 150; i++) {
      const a = i < 40 ? tips[next() % tips.length]! : commits[next() % commits.length]!;
      const b = commits[next() % commits.length]!;
      const expected = repo.lines("merge-base", "--all", a, b);
      expect((await mergeBases(store, a, b)).sort(), `${a} ${b}`).toEqual([...expected].sort());
      expect(await mergeBase(store, a, b)).toBe(repo.run("merge-base", a, b));
      const ancestor = repo.raw(["merge-base", "--is-ancestor", a, b], { allowFailure: true });
      expect(await isAncestor(store, a, b)).toBe(ancestor.status === 0);
      checked++;
    }
    expect(checked).toBe(150);
  });

  it("counts ahead and behind", async () => {
    const { repo, commits } = fixture;
    const next = prng(5);
    for (let i = 0; i < 150; i++) {
      const a = commits[next() % commits.length]!;
      const b = commits[next() % commits.length]!;
      const [ahead, behind] = repo
        .run("rev-list", "--count", "--left-right", `${a}...${b}`)
        .split("\t")
        .map(Number);
      expect(await aheadBehind(store, a, b), `${a} ${b}`).toEqual({ ahead, behind });
    }
  });

  it("lists the commits between two points", async () => {
    const { repo, commits } = fixture;
    const next = prng(11);
    for (let i = 0; i < 60; i++) {
      const base = commits[next() % commits.length]!;
      const tip = commits[next() % commits.length]!;
      const between = await commitsBetween(store, base, tip, { limit: 100_000 });
      expect(
        between.entries.map((entry) => entry.oid),
        `${base}..${tip}`,
      ).toEqual(repo.lines("log", "--format=%H", `${base}..${tip}`));
    }
  });

  it("reports a walk it had to cut short", async () => {
    const cache = new ObjectCache(store, { maxCommits: 20 });
    const cut = await log(cache, head, { limit: 1000 });
    expect(cut.truncated).toBe(true);
    expect(cut.entries.map((entry) => entry.oid)).toEqual(
      fixture.repo.lines("log", "--format=%H", "-20", "main"),
    );
    await expect(aheadBehind(cache, head, fixture.commits[0]!)).rejects.toMatchObject({
      code: "limit",
    });
  });
});

describeGit("following renames in a straight line", () => {
  it("matches git log --follow exactly", async () => {
    const repo = new Repo("follow");
    const next = prng(3);
    const lines = sourceFile(next, 60);
    let path = "one.txt";
    repo.write(path, text(lines));
    repo.write("other.txt", "unrelated\n");
    repo.commit("add");
    const names = ["dir/two.txt", "dir/sub/three.txt", "four.txt", "five/five.txt"];
    for (let step = 0; step < 24; step++) {
      if (step % 6 === 3) {
        const to = names.shift()!;
        repo.remove(path);
        // Every other rename also edits the file, so it has to be found by similarity.
        if (step % 12 === 3) editLines(lines, next, 2);
        path = to;
      } else if (step % 4 === 1) {
        repo.write("other.txt", `unrelated ${step}\n`);
      } else editLines(lines, next);
      repo.write(path, text(lines));
      repo.commit(`step ${step}`);
    }
    const store = loadStore(repo);
    const head = repo.rev("HEAD");
    const followed = await log(store, head, { path, followRenames: true, limit: 1000 });
    expect(followed.entries.map((entry) => entry.oid)).toEqual(
      repo.lines("log", "--format=%H", "--follow", "--", path),
    );
    expect(new Set(followed.entries.map((entry) => entry.path))).toEqual(
      new Set(["one.txt", "dir/two.txt", "dir/sub/three.txt", "four.txt", "five/five.txt"]),
    );
    // Without following, history stops at the last rename.
    const plain = await log(store, head, { path, limit: 1000 });
    expect(plain.entries.map((entry) => entry.oid)).toEqual(
      repo.lines("log", "--format=%H", "--", path),
    );
    expect(plain.entries.length).toBeLessThan(followed.entries.length);
  });
});

describeGit("criss-cross history", () => {
  it("returns both merge bases, and none for unrelated histories", async () => {
    const repo = new Repo("criss");
    repo.write("a.txt", "a\n");
    const root = repo.commit("root");
    repo.run("checkout", "-q", "-b", "left");
    repo.write("left.txt", "left\n");
    const left = repo.commit("left");
    repo.run("checkout", "-q", "-b", "right", root);
    repo.write("right.txt", "right\n");
    const right = repo.commit("right");
    repo.clock += 60;
    repo.run("merge", "-q", "--no-ff", "-m", "right takes left", left);
    const rightTip = repo.rev("HEAD");
    repo.run("checkout", "-q", "left");
    repo.clock += 60;
    repo.run("merge", "-q", "--no-ff", "-m", "left takes right", right);
    const leftTip = repo.rev("HEAD");
    repo.run("checkout", "-q", "--orphan", "island");
    repo.write("island.txt", "island\n");
    const island = repo.commit("island");

    const store = loadStore(repo);
    const expected = repo.lines("merge-base", "--all", leftTip, rightTip).sort();
    expect(expected).toHaveLength(2);
    expect((await mergeBases(store, leftTip, rightTip)).sort()).toEqual(expected);
    expect(await mergeBases(store, leftTip, island)).toEqual([]);
    expect(await mergeBase(store, leftTip, island)).toBeNull();
    expect(await aheadBehind(store, leftTip, island)).toEqual({ ahead: 4, behind: 1 });
  });
});
