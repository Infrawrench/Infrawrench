import { afterAll, beforeAll, expect, it } from "vitest";
import type { MemoryObjectStore } from "@infrawrench/git-core";
import { type BlameResult, blame } from "../src";
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

interface PorcelainLine {
  readonly commit: string;
  readonly original: number;
  readonly path: string;
}

/** `git blame --porcelain`, one record per line of the file. */
function gitBlame(repo: Repo, rev: string, path: string): PorcelainLine[] {
  const out = repo.raw(["blame", "--porcelain", rev, "--", path]).stdout.toString();
  const lines: PorcelainLine[] = [];
  const names = new Map<string, string>();
  let current: { commit: string; original: number } | null = null;
  for (const line of out.split("\n")) {
    const header = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(line);
    if (header && current === null) {
      current = { commit: header[1]!, original: Number(header[2]) };
    } else if (line.startsWith("filename ") && current) {
      names.set(current.commit, line.slice(9));
    } else if (line.startsWith("\t") && current) {
      lines.push({ ...current, path: "" });
      current = null;
    }
  }
  return lines.map((line) => ({ ...line, path: names.get(line.commit)! }));
}

function perLine(result: BlameResult): PorcelainLine[] {
  const lines: PorcelainLine[] = [];
  for (const range of result.ranges) {
    expect(range.start).toBe(lines.length + 1);
    for (let i = 0; i < range.lines; i++) {
      lines.push({ commit: range.commit, original: range.originalStart + i, path: range.path });
    }
  }
  return lines;
}

describeGit("blame against git", () => {
  let fixture: HistoryFixture;
  let store: MemoryObjectStore;
  let head: string;

  beforeAll(() => {
    fixture = makeHistory(58, 170);
    store = loadStore(fixture.repo);
    head = fixture.repo.rev("main");
  });

  it("attributes every line of every file to the commit git names", async () => {
    const { repo } = fixture;
    const files = repo.lines("ls-files");
    expect(files.length).toBeGreaterThan(8);
    let viaRename = 0;
    for (const path of files) {
      const result = await blame(store, head, path, { maxCommits: 100_000 });
      expect(result.complete).toBe(true);
      const expected = gitBlame(repo, "main", path);
      expect(result.lineCount).toBe(expected.length);
      expect(perLine(result), path).toEqual(expected);
      if (result.ranges.some((range) => range.path !== path)) viaRename++;
    }
    // Some of these files were renamed along the way, and their older lines carry the old name.
    expect(viaRename).toBeGreaterThan(0);
  });

  it("does the same from older commits", async () => {
    const { repo, commits } = fixture;
    for (const rev of [commits[40]!, commits[90]!, commits[130]!]) {
      for (const path of repo.lines("ls-tree", "-r", "--name-only", rev).slice(0, 6)) {
        const result = await blame(store, rev, path, { maxCommits: 100_000 });
        expect(perLine(result), `${rev} ${path}`).toEqual(gitBlame(repo, rev, path));
      }
    }
  });

  it("stops at its budget and says which lines are unsettled", async () => {
    const { repo } = fixture;
    const path = repo.lines("ls-files")[0]!;
    const full = await blame(store, head, path, { maxCommits: 100_000 });
    const cut = await blame(store, head, path, { maxCommits: 3 });
    expect(cut.complete).toBe(false);
    expect(cut.walked).toBe(3);
    expect(cut.ranges.some((range) => !range.settled)).toBe(true);
    expect(cut.ranges.reduce((sum, range) => sum + range.lines, 0)).toBe(full.lineCount);
    // What it did settle, it settled correctly.
    const truth = perLine(full);
    for (const range of cut.ranges.filter((item) => item.settled)) {
      for (let i = 0; i < range.lines; i++) {
        expect(truth[range.start - 1 + i]!.commit).toBe(range.commit);
      }
    }
  });
});

describeGit("blame special cases", () => {
  it("handles binary, large, empty and missing files, and a missing final newline", async () => {
    const repo = new Repo("blame-special");
    const next = prng(17);
    const lines = sourceFile(next, 30);
    repo.write("text.txt", text(lines));
    repo.write("binary.bin", new Uint8Array([1, 0, 2]));
    repo.write("empty.txt", "");
    repo.write("dir/inner.txt", "x\n");
    repo.commit("first");
    editLines(lines, next, 3);
    repo.write("text.txt", lines.join("\n"));
    repo.commit("second, without the final newline");
    lines.push("a last line;");
    repo.write("text.txt", text(lines));
    const head = repo.commit("third");
    const store = loadStore(repo);

    expect(perLine(await blame(store, head, "text.txt"))).toEqual(gitBlame(repo, head, "text.txt"));
    expect(await blame(store, head, "binary.bin")).toMatchObject({ binary: true, ranges: [] });
    expect(await blame(store, head, "empty.txt")).toMatchObject({ lineCount: 0, ranges: [] });
    expect(await blame(store, head, "text.txt", { limits: { maxTextBytes: 10 } })).toMatchObject({
      tooLarge: true,
      ranges: [],
    });
    await expect(blame(store, head, "nope.txt")).rejects.toMatchObject({ code: "missing-object" });
    await expect(blame(store, head, "dir")).rejects.toMatchObject({ code: "missing-object" });
  });
});
