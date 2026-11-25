/**
 * Budgets, not benchmarks: each figure is several times what the operation
 * takes on a laptop that is also doing other work, so a failure here means
 * something became quadratic, not that the machine was busy.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { type MemoryObjectStore, encodeText } from "@infrawrench/git-core";
import {
  ObjectCache,
  aheadBehind,
  blame,
  diffLines,
  lastCommitsForEntries,
  log,
  mergeBases,
  mergeText,
  splitLines,
} from "../src";
import {
  Repo,
  cleanupTempDirs,
  describeGit,
  editLines,
  loadStore,
  prng,
  sourceFile,
  text,
} from "./helpers";

afterAll(cleanupTempDirs);

function timed<T>(label: string, budget: number, run: () => T): T {
  const start = performance.now();
  const result = run();
  const took = performance.now() - start;
  console.info(`git-ops perf: ${label}: ${took.toFixed(1)} ms (budget ${budget} ms)`);
  expect(took, label).toBeLessThan(budget);
  return result;
}

async function timedAsync<T>(label: string, budget: number, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await run();
  const took = performance.now() - start;
  console.info(`git-ops perf: ${label}: ${took.toFixed(1)} ms (budget ${budget} ms)`);
  expect(took, label).toBeLessThan(budget);
  return result;
}

it("diffs and merges a 10 000-line file within budget", () => {
  const next = prng(2024);
  const base = sourceFile(next, 10_000);
  const edited = [...base];
  editLines(edited, next, 300);
  const other = [...base];
  editLines(other, next, 300);
  const a = splitLines(encodeText(text(base)));
  const b = splitLines(encodeText(text(edited)));
  expect(a.count).toBe(10_000);

  const myers = timed("diff 10k lines, 300 edits, myers", 250, () => diffLines(a, b));
  expect(myers.changes.length).toBeGreaterThan(100);
  timed("diff 10k lines, 300 edits, histogram", 250, () =>
    diffLines(a, b, { algorithm: "histogram" }),
  );
  // Nothing in common at all: the worst case for a search that looks for common lines.
  const unrelated = splitLines(
    encodeText(text(sourceFile(prng(1), 10_000).map((l, i) => `${i} ${l}`))),
  );
  timed("diff 10k lines against 10k unrelated lines", 250, () => diffLines(a, unrelated));
  // Very repetitive input, where most lines match many others.
  const dull = (seed: number): string =>
    text(sourceFile(prng(seed), 10_000).map((line) => line.trim().split(" ")[0] ?? ""));
  timed("diff 10k repetitive lines", 750, () =>
    diffLines(splitLines(encodeText(dull(3))), splitLines(encodeText(dull(4)))),
  );
  const merged = timed("three-way merge of 10k lines, 300 edits a side", 500, () =>
    mergeText(encodeText(text(base)), encodeText(text(edited)), encodeText(text(other))),
  );
  expect(merged.data.length).toBeGreaterThan(100_000);
});

describeGit("history of 5 000 commits", () => {
  let repo: Repo;
  let store: MemoryObjectStore;
  let head: string;
  const COMMITS = 5000;
  const FILES = 40;

  beforeAll(() => {
    repo = new Repo("perf");
    // One fast-import stream: five thousand `git commit` calls would take minutes.
    const next = prng(55);
    const lines = new Map<string, string[]>();
    const chunks: string[] = [];
    const data = (value: string): string => `data ${Buffer.byteLength(value)}\n${value}\n`;
    for (let i = 0; i < COMMITS; i++) {
      const file = i < FILES ? i : next() % FILES;
      const path = `dir${file % 5}/file-${file}.txt`;
      const content = lines.get(path) ?? sourceFile(next, 40);
      if (lines.has(path)) editLines(content, next, 1);
      lines.set(path, content);
      const when = 1_700_000_000 + i * 60;
      chunks.push(
        `commit refs/heads/main\nmark :${i + 1}\n` +
          `author Ada Author <ada@example.com> ${when} +0000\n` +
          `committer Cy Committer <cy@example.com> ${when} +0000\n` +
          data(`change ${i}`) +
          (i > 0 ? `from :${i}\n` : "") +
          `M 100644 inline ${path}\n${data(text(content))}`,
      );
      // A side branch every so often, for merge bases far back in history.
      if (i % 500 === 250) {
        chunks.push(
          `commit refs/heads/side-${i}\nmark :${COMMITS + i}\n` +
            `author Ada Author <ada@example.com> ${when} +0000\n` +
            `committer Cy Committer <cy@example.com> ${when} +0000\n` +
            data(`side ${i}`) +
            `from :${i}\nM 100644 inline side/s-${i}.txt\n${data("side\n")}`,
        );
      }
    }
    repo.raw(["fast-import", "--quiet"], { input: chunks.join("") });
    head = repo.rev("main");
    store = loadStore(repo);
  });

  it("walks, filters and counts within budget", async () => {
    const path = "dir3/file-13.txt";
    const all = await timedAsync("log, all 5 000 commits", 1000, () =>
      log(new ObjectCache(store), head, { limit: 100_000 }),
    );
    expect(all.entries).toHaveLength(COMMITS);

    const limited = await timedAsync("log over 5 000 commits, one file", 1000, () =>
      log(new ObjectCache(store), head, { path, limit: 100_000 }),
    );
    expect(limited.entries.map((entry) => entry.oid)).toEqual(
      repo.lines("log", "--format=%H", "main", "--", path),
    );
    expect(limited.walked).toBe(COMMITS);

    // The usual request: the first page, which must not walk the whole history.
    const page = await timedAsync("log, first 30 for one directory", 100, () =>
      log(new ObjectCache(store), head, { path: "dir2", limit: 30 }),
    );
    expect(page.entries).toHaveLength(30);
    expect(page.walked).toBeLessThan(400);

    const old = repo.rev("main~4000");
    const counts = await timedAsync("ahead/behind across 4 000 commits", 750, () =>
      aheadBehind(new ObjectCache(store), head, old),
    );
    expect(counts).toEqual({ ahead: 4000, behind: 0 });
    const side = repo.rev("side-250");
    await timedAsync("merge base with a branch 4 750 commits back", 750, async () => {
      expect(await mergeBases(new ObjectCache(store), head, side)).toEqual([
        repo.run("merge-base", head, side),
      ]);
    });

    const names = repo.lines("ls-tree", "--name-only", "main", "dir1/").map((p) => p.slice(5));
    const last = await timedAsync("last commit for the 8 files of a directory", 750, () =>
      lastCommitsForEntries(new ObjectCache(store), head, "dir1", names, { maxCommits: 100_000 }),
    );
    expect(last.resolved.size).toBe(names.length);
    expect(last.resolved.get(names[0]!)).toBe(
      repo.run("log", "-1", "--format=%H", "main", "--", `dir1/${names[0]}`),
    );

    const blamed = await timedAsync("blame through 5 000 commits of history", 1000, () =>
      blame(new ObjectCache(store), head, path, { maxCommits: 100_000 }),
    );
    expect(blamed.complete).toBe(true);
    expect(blamed.walked).toBeLessThanOrEqual(COMMITS);
  });
});
