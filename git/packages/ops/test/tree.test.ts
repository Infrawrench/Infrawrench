import { afterAll, beforeAll, expect, it } from "vitest";
import type { MemoryObjectStore } from "@infrawrench/git-core";
import {
  type LastCommitsContinuation,
  ObjectCache,
  lastCommitsForEntries,
  lsTree,
  resolvePath,
} from "../src";
import {
  type HistoryFixture,
  cleanupTempDirs,
  describeGit,
  loadStore,
  makeHistory,
} from "./helpers";

afterAll(cleanupTempDirs);

describeGit("trees against git", () => {
  let fixture: HistoryFixture;
  let store: MemoryObjectStore;
  let head: string;
  let tree: string;

  beforeAll(() => {
    fixture = makeHistory(33, 150);
    store = loadStore(fixture.repo);
    head = fixture.repo.rev("main");
    tree = fixture.repo.tree("main");
  });

  it("lists directories like git ls-tree", async () => {
    const { repo } = fixture;
    const format = (entries: Array<{ mode: string; oid: string; path: string }>): string[] =>
      entries.map((entry) => {
        const type = entry.mode === "040000" ? "tree" : entry.mode === "160000" ? "commit" : "blob";
        return `${entry.mode} ${type} ${entry.oid}\t${entry.path}`;
      });
    expect(format((await lsTree(store, tree)).entries)).toEqual(repo.lines("ls-tree", "main"));
    expect(format((await lsTree(store, tree, { path: "src" })).entries)).toEqual(
      repo.lines("ls-tree", "main", "src/"),
    );
    expect(format((await lsTree(store, tree, { path: "src/lib/" })).entries)).toEqual(
      repo.lines("ls-tree", "main", "src/lib/"),
    );
    expect(format((await lsTree(store, tree, { recursive: true })).entries)).toEqual(
      repo.lines("ls-tree", "-r", "main"),
    );
    const cut = await lsTree(store, tree, { recursive: true, maxEntries: 3 });
    expect(cut.entries).toHaveLength(3);
    expect(cut.truncated).toBe(true);
    await expect(lsTree(store, tree, { path: "no/such" })).rejects.toMatchObject({
      code: "missing-object",
    });
  });

  it("resolves paths", async () => {
    const { repo } = fixture;
    for (const line of repo.lines("ls-tree", "-r", "-t", "main")) {
      const [meta, path] = line.split("\t");
      const [mode, , oid] = meta!.split(" ");
      expect(await resolvePath(store, tree, path!)).toEqual({ mode, oid });
    }
    expect(await resolvePath(store, tree, "")).toEqual({ mode: "040000", oid: tree });
    expect(await resolvePath(store, tree, "src/nothing-here.txt")).toBeNull();
    const file = repo.lines("ls-files")[0]!;
    expect(await resolvePath(store, tree, `${file}/below`)).toBeNull();
  });

  it("finds the last commit for every entry of every directory", async () => {
    const { repo } = fixture;
    for (const dir of ["", "src", "src/lib", "docs", "tools"]) {
      const names = (await lsTree(store, tree, { path: dir })).entries.map((entry) => entry.name);
      const result = await lastCommitsForEntries(store, head, dir, names, { maxCommits: 100_000 });
      expect(result.continuation).toBeUndefined();
      for (const name of names) {
        const path = dir === "" ? name : `${dir}/${name}`;
        expect(result.resolved.get(name), path).toBe(
          repo.run("log", "-1", "--format=%H", "main", "--", path),
        );
      }
      expect(result.resolved.size).toBe(names.length);
    }
  });

  it("works within a budget and carries on from where it stopped", async () => {
    const { repo } = fixture;
    const names = (await lsTree(store, tree, { path: "src" })).entries.map((entry) => entry.name);
    const cache = new ObjectCache(store);
    const resolved = new Map<string, string>();
    let state: string | LastCommitsContinuation = head;
    let calls = 0;
    for (;;) {
      const step = await lastCommitsForEntries(cache, state, "src", names, { maxCommits: 5 });
      calls++;
      expect(step.walked).toBeLessThanOrEqual(5);
      for (const [name, oid] of step.resolved) {
        expect(resolved.has(name)).toBe(false);
        resolved.set(name, oid);
      }
      if (!step.continuation) break;
      // It is plain data: it survives a trip through JSON, as it would to a client and back.
      state = JSON.parse(JSON.stringify(step.continuation)) as LastCommitsContinuation;
    }
    expect(calls).toBeGreaterThan(2);
    for (const name of names) {
      expect(resolved.get(name), name).toBe(
        repo.run("log", "-1", "--format=%H", "main", "--", `src/${name}`),
      );
    }
  });
});
