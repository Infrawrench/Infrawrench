/** What needs no `git` binary: these run everywhere, including sandboxes where the interop suites skip. */
import { expect, it } from "vitest";
import {
  MemoryObjectStore,
  buildTree,
  decodeText,
  encodeText,
  serializeCommit,
} from "@infrawrench/git-core";
import {
  type CommitNode,
  Heap,
  type IgnoreWhitespace,
  ObjectCache,
  type SizedReader,
  aheadBehind,
  blame,
  diffFile,
  diffLines,
  fingerprint,
  formatMailDate,
  formatStat,
  isAncestor,
  isBinary,
  lastCommitsForEntries,
  lineBytes,
  log,
  mergeBases,
  mergeCommits,
  mergeText,
  normalizeMessage,
  parseCommitNode,
  quotePath,
  scanTree,
  splitLines,
} from "../src";
import { editLines, prng, sourceFile, text } from "./helpers";

interface Dag {
  readonly store: MemoryObjectStore;
  readonly oids: string[];
  /** For each commit, every commit it can reach, itself included. */
  readonly ancestors: Array<Set<number>>;
}

/** A random history built straight into a store. `skew` lets a commit be older than its parents. */
function randomDag(seed: number, size: number, skew: boolean): Dag {
  const next = prng(seed);
  const store = new MemoryObjectStore();
  const tree = store.write("tree", buildTree([]));
  const oids: string[] = [];
  const times: number[] = [];
  const ancestors: Array<Set<number>> = [];
  for (let i = 0; i < size; i++) {
    const parents = new Set<number>();
    if (i > 0) {
      const count = next() % 10 === 0 ? 0 : next() % 4 === 0 ? 2 : 1;
      // Mostly recent parents, so the history is deep rather than a star.
      for (let k = 0; k < count; k++) parents.add(Math.max(0, i - 1 - (next() % Math.min(i, 6))));
    }
    const newest = Math.max(0, ...[...parents].map((p) => times[p]!));
    // Steps of 0 make ties, which are common in real history (rebases, scripted commits).
    const time = skew ? 1000 + (next() % 50) : newest + (next() % 3);
    const who = { name: "N", email: "n@example.com", timestamp: time, timezoneOffset: 0 };
    oids.push(
      store.write(
        "commit",
        serializeCommit({
          tree,
          parents: [...parents].map((p) => oids[p]!),
          author: who,
          committer: who,
          message: `c${i}\n`,
          extraHeaders: [],
        }),
      ),
    );
    times.push(time);
    const reach = new Set<number>([i]);
    for (const parent of parents) for (const a of ancestors[parent]!) reach.add(a);
    ancestors.push(reach);
  }
  return { store, oids, ancestors };
}

it("merge bases and ancestry are exact, with or without sane clocks", async () => {
  for (const skew of [false, true]) {
    for (const seed of [1, 2, 3]) {
      const { store, oids, ancestors } = randomDag(seed * 7 + (skew ? 100 : 0), 120, skew);
      const next = prng(seed);
      for (let round = 0; round < 80; round++) {
        const a = next() % oids.length;
        const b = next() % oids.length;
        const common = [...ancestors[a]!].filter((c) => ancestors[b]!.has(c));
        // The lowest common ancestors: common ones that no other common one descends from.
        const lowest = common.filter(
          (c) => !common.some((other) => other !== c && ancestors[other]!.has(c)),
        );
        expect((await mergeBases(store, oids[a]!, oids[b]!)).sort(), `${a} ${b}`).toEqual(
          lowest.map((c) => oids[c]!).sort(),
        );
        expect(await isAncestor(store, oids[a]!, oids[b]!)).toBe(ancestors[b]!.has(a));
      }
    }
  }
});

it("ahead and behind are exact when no commit is older than its parent", async () => {
  for (const seed of [11, 12, 13, 14]) {
    const { store, oids, ancestors } = randomDag(seed, 150, false);
    const next = prng(seed);
    for (let round = 0; round < 120; round++) {
      const a = next() % oids.length;
      const b = next() % oids.length;
      const ahead = [...ancestors[a]!].filter((c) => !ancestors[b]!.has(c)).length;
      const behind = [...ancestors[b]!].filter((c) => !ancestors[a]!.has(c)).length;
      expect(await aheadBehind(store, oids[a]!, oids[b]!), `${a} ${b}`).toEqual({ ahead, behind });
      const between = await log(store, oids[a]!, { exclude: [oids[b]!], limit: 10_000 });
      expect(between.entries).toHaveLength(ahead);
    }
  }
});

function apply(a: string[], b: string[], changes: ReturnType<typeof diffLines>["changes"]) {
  const out: string[] = [];
  let at = 0;
  let previousEnd = -1;
  for (const change of changes) {
    expect(change.i1).toBeGreaterThan(previousEnd);
    expect(change.chg1 + change.chg2).toBeGreaterThan(0);
    out.push(...a.slice(at, change.i1), ...b.slice(change.i2, change.i2 + change.chg2));
    at = change.i1 + change.chg1;
    previousEnd = at;
  }
  out.push(...a.slice(at));
  return out;
}

it("a line diff turns the old file into the new one", () => {
  const next = prng(404);
  for (let round = 0; round < 300; round++) {
    const a = sourceFile(next, next() % 60);
    const b = round % 5 === 0 ? sourceFile(next, next() % 60) : [...a];
    if (round % 5 !== 0) editLines(b, next, 1 + (next() % 6));
    const one = splitLines(encodeText(text(a)));
    const two = splitLines(encodeText(text(b)));
    for (const algorithm of ["myers", "histogram"] as const) {
      const { changes, added, removed } = diffLines(one, two, { algorithm });
      expect(apply(a, b, changes), `round ${round} ${algorithm}`).toEqual(b);
      expect(removed.reduce((sum, bit) => sum + bit, 0)).toBe(
        changes.reduce((sum, change) => sum + change.chg1, 0),
      );
      expect(added.reduce((sum, bit) => sum + bit, 0)).toBe(
        changes.reduce((sum, change) => sum + change.chg2, 0),
      );
    }
  }
  expect(diffLines(splitLines(new Uint8Array(0)), splitLines(new Uint8Array(0))).changes).toEqual(
    [],
  );
});

it("ignores exactly the whitespace it is told to", () => {
  const diff = (a: string, b: string, ignoreWhitespace: IgnoreWhitespace): number =>
    diffLines(splitLines(encodeText(a)), splitLines(encodeText(b)), { ignoreWhitespace }).changes
      .length;
  expect(diff("a b\n", "a  b\n", "none")).toBe(1);
  expect(diff("a b\n", "a  b\n", "change")).toBe(0);
  expect(diff("a b\n", "ab\n", "change")).toBe(1);
  expect(diff("a b\n", "ab\n", "all")).toBe(0);
  expect(diff("a b\n", "a b  \n", "eol")).toBe(0);
  expect(diff("a b\n", " a b\n", "eol")).toBe(1);
  expect(diff("a b\r\n", "a b\n", "eol")).toBe(0);
  // A missing final newline is whitespace at the end of a line too.
  expect(diff("a\nb", "a\nb\n", "eol")).toBe(0);
  expect(diff("a\nb", "a\nb\n", "none")).toBe(1);
});

it("splits lines without losing a byte", () => {
  for (const source of ["", "\n", "a", "a\n", "a\nb", "a\n\nb\n", "\r\n\r\n"]) {
    const lines = splitLines(encodeText(source));
    let joined = "";
    for (let i = 0; i < lines.count; i++) joined += decodeText(lineBytes(lines, i));
    expect(joined).toBe(source);
    expect(lines.count).toBe(
      source === "" ? 0 : source.split("\n").length - (source.endsWith("\n") ? 1 : 0),
    );
  }
  expect(isBinary(encodeText("plain"))).toBe(false);
  expect(isBinary(new Uint8Array([65, 0, 66]))).toBe(true);
  // Only the first 8000 bytes are looked at, as in git.
  const late = new Uint8Array(9000).fill(65);
  late[8500] = 0;
  expect(isBinary(late)).toBe(false);
});

it("merges text: the trivial cases and a conflict", () => {
  const base = encodeText("one\ntwo\nthree\nfour\nfive\n");
  const ours = encodeText("one\nTWO\nthree\nfour\nfive\n");
  const theirs = encodeText("one\ntwo\nthree\nfour\nFIVE\n");
  expect(mergeText(base, base, theirs)).toEqual({ data: theirs, conflicts: 0 });
  expect(mergeText(base, ours, base)).toEqual({ data: ours, conflicts: 0 });
  expect(mergeText(base, ours, ours).conflicts).toBe(0);
  const both = mergeText(base, ours, theirs);
  expect(both.conflicts).toBe(0);
  expect(decodeText(both.data)).toBe("one\nTWO\nthree\nfour\nFIVE\n");
  const clash = mergeText(base, ours, encodeText("one\n2\nthree\nfour\nfive\n"), {
    ours: "a",
    theirs: "b",
    base: "o",
    style: "diff3",
  });
  expect(clash.conflicts).toBe(1);
  expect(decodeText(clash.data)).toBe(
    "one\n<<<<<<< a\nTWO\n||||||| o\ntwo\n=======\n2\n>>>>>>> b\nthree\nfour\nfive\n",
  );
});

it("reads what a walk needs from a commit, however odd the commit", () => {
  const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const parent = "1234567890123456789012345678901234567890";
  const oid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const make = (committer: string): Uint8Array =>
    encodeText(
      `tree ${tree}\nparent ${parent}\nparent ${tree}\nauthor A <a@b> 1 +0000\n` +
        `committer ${committer}\ngpgsig -----BEGIN\n tree not-a-tree\n\nparent in the message\n`,
    );
  expect(parseCommitNode(oid, make("C <c@d> 1700000000 +0100"))).toEqual({
    oid,
    tree,
    parents: [parent, tree],
    time: 1_700_000_000,
  });
  // Git reads the number after the last `>`, and calls anything else zero.
  expect(parseCommitNode(oid, make("C <c@d> <e@f> 42 +0000")).time).toBe(42);
  expect(parseCommitNode(oid, make("no email or date")).time).toBe(0);
  expect(parseCommitNode(oid, make("C <c@d> soon +0000")).time).toBe(0);
  expect(() => parseCommitNode(oid, encodeText("author A <a@b> 1 +0000\n\nmessage\n"))).toThrow();
});

it("finds a name in a raw tree", () => {
  const blob = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
  const data = buildTree([
    { mode: "100644", name: "a", oid: blob },
    { mode: "100755", name: "ab", oid: blob },
    { mode: "040000", name: "dir", oid: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" },
    { mode: "120000", name: "link", oid: blob },
  ]);
  expect(scanTree(data, encodeText("ab"))).toEqual({ mode: "100755", oid: blob });
  expect(scanTree(data, encodeText("dir"))?.mode).toBe("040000");
  expect(scanTree(data, encodeText("link"))?.mode).toBe("120000");
  expect(scanTree(data, encodeText("b"))).toBeNull();
  expect(scanTree(data, encodeText(""))).toBeNull();
  expect(() => scanTree(data.subarray(0, data.length - 3), encodeText("zzz"))).toThrow();
});

it("normalises messages, quotes paths and formats the small things", () => {
  expect(normalizeMessage("")).toBe("");
  expect(normalizeMessage("\n\n  \n")).toBe("");
  expect(normalizeMessage("a")).toBe("a\n");
  expect(normalizeMessage("a\t \n\n\n\nb\n\n")).toBe("a\n\nb\n");
  expect(quotePath("plain/path.txt")).toBe("plain/path.txt");
  expect(quotePath("with space")).toBe("with space");
  expect(quotePath("café")).toBe('"caf\\303\\251"');
  expect(quotePath('q"\\\n')).toBe('"q\\"\\\\\\n"');
  expect(formatMailDate(1_700_000_000, 0)).toBe("Tue, 14 Nov 2023 22:13:20 +0000");
  expect(formatMailDate(1_700_000_000, -330)).toBe("Tue, 14 Nov 2023 16:43:20 -0530");
  expect(
    formatStat([
      { path: "a.txt", additions: 3, deletions: 1, binary: false },
      { path: "img.png", additions: 0, deletions: 0, binary: true },
    ]),
  ).toBe(" a.txt   |   4 +++-\n img.png | Bin\n 2 files changed, 3 insertions(+), 1 deletion(-)\n");
  expect(formatStat([])).toBe("");
  // The same chunks give the same fingerprint, whatever the line endings.
  const lf = fingerprint(encodeText("one\ntwo\nthree\n"));
  const crlf = fingerprint(encodeText("one\r\ntwo\r\nthree\r\n"));
  expect([...lf.hashes]).toEqual([...crlf.hashes]);
});

it("pops a heap in order", () => {
  const next = prng(6);
  const heap = new Heap<number>((a, b) => a < b);
  const values: number[] = [];
  for (let i = 0; i < 500; i++) {
    const value = next() % 1000;
    values.push(value);
    heap.push(value);
  }
  const out: number[] = [];
  while (heap.size > 0) out.push(heap.pop()!);
  expect(out).toEqual(values.sort((a, b) => a - b));
  expect(heap.pop()).toBeUndefined();
});

/** A linear history of one file, `a.txt`, with the given versions, oldest first. */
function linear(versions: readonly string[]): { store: MemoryObjectStore; commits: string[] } {
  const store = new MemoryObjectStore();
  const who = { name: "T", email: "t@example.com", timestamp: 0, timezoneOffset: 0 };
  const commits: string[] = [];
  versions.forEach((content, index) => {
    const blob = store.write("blob", encodeText(content));
    const tree = store.write(
      "tree",
      buildTree([
        { mode: "100644", name: "a.txt", oid: blob },
        { mode: "100644", name: "fixed.txt", oid: store.write("blob", encodeText("same\n")) },
      ]),
    );
    commits.push(
      store.write(
        "commit",
        serializeCommit({
          tree,
          parents: commits.length > 0 ? [commits.at(-1)!] : [],
          author: { ...who, timestamp: 1000 + index },
          committer: { ...who, timestamp: 1000 + index },
          message: `c${index}\n`,
          extraHeaders: [],
        }),
      ),
    );
  });
  return { store, commits };
}

it("asks a reader that knows sizes before reading, and never reads a file over the limit", async () => {
  const big = "x".repeat(3000);
  const { store, commits } = linear([`${big}\nold\n`, `${big}\nnew\n`]);
  const read: string[] = [];
  const sized: SizedReader = {
    read: async (oid) => {
      read.push(oid);
      return store.read(oid);
    },
    has: (oid) => store.has(oid),
    size: async (oid) => (await store.read(oid))?.data.length ?? null,
  };
  const limits = { maxTextBytes: 1000 };
  const cache = new ObjectCache(sized, limits);
  const [older, newer] = [await cache.node(commits[0]!), await cache.node(commits[1]!)];
  const oldEntry = (await cache.entryAt(older.tree, ["a.txt"]))!;
  const newEntry = (await cache.entryAt(newer.tree, ["a.txt"]))!;
  read.length = 0;
  const change = {
    status: "modified" as const,
    oldPath: "a.txt",
    newPath: "a.txt",
    old: oldEntry,
    new: newEntry,
  };
  expect((await diffFile(cache, change)).tooLarge).toBe(true);
  expect((await blame(cache, commits[1]!, "a.txt")).tooLarge).toBe(true);
  expect(read).not.toContain(oldEntry.oid);
  expect(read).not.toContain(newEntry.oid);

  // Without the hook the answer is the same, found out after the read.
  const plain = new ObjectCache(store, limits);
  expect((await diffFile(plain, change)).tooLarge).toBe(true);
  expect(await plain.size(newEntry.oid)).toBeNull();
  expect(await cache.size(newEntry.oid)).toBe(3005);

  // A merge of two sides that both changed an oversized file is a conflict, with nothing read.
  const fork = linear([`${big}\nold\n`]);
  const who = { name: "T", email: "t@example.com", timestamp: 5000, timezoneOffset: 0 };
  const side = (content: string): string =>
    fork.store.write(
      "commit",
      serializeCommit({
        tree: fork.store.write(
          "tree",
          buildTree([
            { mode: "100644", name: "a.txt", oid: fork.store.write("blob", encodeText(content)) },
          ]),
        ),
        parents: [fork.commits[0]!],
        author: who,
        committer: who,
        message: "side\n",
        extraHeaders: [],
      }),
    );
  const ours = side(`${big}\nours\n`);
  const theirs = side(`${big}\ntheirs\n`);
  const blobsRead: number[] = [];
  const sizedFork: SizedReader = {
    read: async (oid) => {
      const object = await fork.store.read(oid);
      if (object?.type === "blob") blobsRead.push(object.data.length);
      return object;
    },
    has: (oid) => fork.store.has(oid),
    size: async (oid) => (await fork.store.read(oid))?.data.length ?? null,
  };
  const merged = await mergeCommits(new ObjectCache(sizedFork, limits), ours, theirs);
  expect(merged.conflicts.map((conflict) => conflict.kind)).toEqual(["too-large"]);
  expect(blobsRead).toEqual([]);
});

it("reads commits through a graph the caller keeps, and fills it", async () => {
  const { store, commits } = linear(["1\n", "2\n", "3\n", "4\n"]);
  const nodes = new Map<string, CommitNode>();
  const graph = {
    get: (oid: string) => nodes.get(oid),
    set: (node: CommitNode) => void nodes.set(node.oid, node),
  };
  const first = new ObjectCache(store, undefined, { graph });
  expect((await log(first, commits[3]!, { limit: 10 })).entries).toHaveLength(4);
  expect(nodes.size).toBe(4);
  // A second request's cache walks without reading a commit for the graph again.
  let commitReads = 0;
  const second = new ObjectCache(
    {
      read: async (oid) => {
        const object = await store.read(oid);
        if (object?.type === "commit") commitReads++;
        return object;
      },
      has: (oid) => store.has(oid),
    },
    undefined,
    { graph },
  );
  expect(await aheadBehind(second, commits[3]!, commits[0]!)).toEqual({ ahead: 3, behind: 0 });
  expect(await isAncestor(second, commits[1]!, commits[3]!)).toBe(true);
  expect(commitReads).toBe(0);
});

it("settles last commits from answers the caller already has for an older commit", async () => {
  const { store, commits } = linear(["1\n", "2\n", "3\n", "4\n"]);
  const names = ["a.txt", "fixed.txt"];
  const whole = await lastCommitsForEntries(store, commits[3]!, "", names);
  expect(Object.fromEntries(whole.resolved)).toEqual({
    "a.txt": commits[3],
    "fixed.txt": commits[0],
  });
  expect(whole.walked).toBe(4);

  // Known at the third commit: the walk from the fourth stops there.
  const earlier = await lastCommitsForEntries(store, commits[2]!, "", names);
  const seeded = await lastCommitsForEntries(store, commits[3]!, "", names, {
    known: (commit) => (commit === commits[2] ? earlier.resolved : undefined),
  });
  expect(Object.fromEntries(seeded.resolved)).toEqual(Object.fromEntries(whole.resolved));
  expect(seeded.walked).toBe(1);
  expect(seeded.continuation).toBeUndefined();
});
