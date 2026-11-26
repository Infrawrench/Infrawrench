/**
 * Repositories made to cost as much as they can: trees of tens of thousands
 * of names, subtrees that differ only in how a mode is spelled, octopus
 * merges, messages of megabytes, names that leave the directory they are
 * unpacked into. Each test builds the input and asserts the bound as a
 * count (objects read, a refusal, entries left out), never as a time.
 */
import { describe, expect, it } from "vitest";
import {
  GitError,
  MemoryObjectStore,
  type ObjectId,
  type TreeEntry,
  buildTree,
  collectBytes,
  decodeText,
  encodeText,
  fromHex,
  serializeCommit,
} from "@infrawrench/git-core";
import {
  DEFAULT_LIMITS,
  ObjectCache,
  archiveEntries,
  blame,
  cutMessage,
  detectRenames,
  diffLines,
  diffTreeEntries,
  isSafeArchiveName,
  lastCommitsForEntries,
  log,
  mergeBases,
  mergeText,
  mergeTrees,
  splitLines,
  tarArchive,
} from "../src";

const who = (time: number) => ({
  name: "T",
  email: "t@example.com",
  timestamp: time,
  timezoneOffset: 0,
});

function commit(
  store: MemoryObjectStore,
  tree: ObjectId,
  parents: readonly ObjectId[],
  time: number,
  message = "change\n",
): ObjectId {
  return store.write(
    "commit",
    serializeCommit({
      tree,
      parents: [...parents],
      author: who(time),
      committer: who(time),
      message,
      extraHeaders: [],
    }),
  );
}

/** A tree written byte by byte, so names and modes git would never write can be in it. */
function rawTree(
  entries: ReadonlyArray<readonly [mode: string, name: string, oid: ObjectId]>,
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [mode, name, oid] of entries) {
    parts.push(encodeText(`${mode} ${name}\0`), fromHex(oid));
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const file = (name: string, oid: ObjectId): TreeEntry => ({ name, mode: "100644", oid });
const dir = (name: string, oid: ObjectId): TreeEntry => ({ name, mode: "040000", oid });

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GitError) return error.code;
    throw error;
  }
  return "none";
}

describe("line diffs", () => {
  // One file is the other with every second line moved to the end. Each histogram step finds a
  // single common line at the start of a region it scanned whole, which made 100 000 lines take
  // over three minutes; 50 000 were 50 seconds. With the work bound it is well under one.
  const lines = 50_000;
  const before = Array.from({ length: lines }, (_, i) => `y${i}\n`);
  const after = [...before.filter((_, i) => i % 2 === 0), ...before.filter((_, i) => i % 2 === 1)];
  const a = encodeText(before.join(""));
  const b = encodeText(after.join(""));

  it("hands a histogram diff that scans too much to Myers, and the result is still a diff", () => {
    const one = splitLines(a);
    const two = splitLines(b);
    const { removed, added } = diffLines(one, two, { algorithm: "histogram" });
    // What is left unmarked on each side is the same lines in the same order.
    const kept = (text: readonly string[], marks: Uint8Array) =>
      text.filter((_, i) => !marks[i]).join("");
    expect(kept(before, removed)).toBe(kept(after, added));
    expect(kept(before, removed).length).toBeGreaterThan(0);
  }, 20_000);

  it("merges such a file as text within the same bound", () => {
    const merged = mergeText(a, b, a);
    expect(merged.conflicts).toBe(0);
    expect(merged.data).toEqual(b);
  }, 20_000);
});

describe("trees", () => {
  it("refuses to parse a tree over maxTreeBytes and still finds a name in it", async () => {
    const store = new MemoryObjectStore();
    const blob = store.write("blob", encodeText("x\n"));
    // 40 000 short names: about 1.3 MB raw, which parsed would be some 20 MB of heap.
    const names = Array.from({ length: 40_000 }, (_, i) => `n${i.toString(36)}`).sort();
    const tree = store.write("tree", buildTree(names.map((name) => file(name, blob))));
    const cache = new ObjectCache(store);
    expect((await store.read(tree))!.data.length).toBeGreaterThan(DEFAULT_LIMITS.maxTreeBytes);
    expect(await refusal(cache.tree(tree))).toBe("limit");
    expect(await cache.entryAt(tree, [names[12_345]!])).toEqual({ mode: "100644", oid: blob });
    // A diff that would have to list it is refused the same way rather than holding it.
    expect(await refusal(diffTreeEntries(cache, null, tree))).toBe("limit");
  });

  it("counts the trees a tree diff reads, not only the changes it lists", async () => {
    const store = new MemoryObjectStore();
    const blob = store.write("blob", encodeText("x\n"));
    const left: TreeEntry[] = [];
    const right: TreeEntry[] = [];
    for (let i = 0; i < 2000; i++) {
      const own = store.write("blob", encodeText(`${i}\n`));
      // The same file under a mode spelled two ways: different tree ids, nothing changed.
      const a = store.write(
        "tree",
        rawTree([
          ["100644", "f", blob],
          ["100644", `g${i}`, own],
        ]),
      );
      const b = store.write(
        "tree",
        rawTree([
          ["100664", "f", blob],
          ["100644", `g${i}`, own],
        ]),
      );
      const name = `d${String(i).padStart(5, "0")}`;
      left.push(dir(name, a));
      right.push(dir(name, b));
    }
    const a = store.write("tree", buildTree(left));
    const b = store.write("tree", buildTree(right));

    const whole = new ObjectCache(store);
    const all = await diffTreeEntries(whole, a, b);
    expect(all).toEqual({ changes: [], truncated: false });
    expect(whole.reads).toBe(2 + 2 * 2000);

    const bounded = new ObjectCache(store, { maxDiffTrees: 100 });
    const cut = await diffTreeEntries(bounded, a, b);
    expect(cut.truncated).toBe(true);
    expect(bounded.reads).toBeLessThanOrEqual(2 * 100);
  });
});

describe("rename detection", () => {
  /** Deletes `count` files and adds `count` others, each pair half alike. */
  function renames(count: number, lines: number) {
    const store = new MemoryObjectStore();
    const before: TreeEntry[] = [];
    const after: TreeEntry[] = [];
    for (let i = 0; i < count; i++) {
      const body = Array.from({ length: lines }, (_, k) => `file ${i} line ${k}\n`);
      const edited = body.map((line, k) => (k % 4 === 0 ? `edited ${line}` : line));
      before.push(file(`${i}.txt`, store.write("blob", encodeText(body.join("")))));
      after.push(file(`${i}-moved.txt`, store.write("blob", encodeText(edited.join("")))));
    }
    const tree = (entries: TreeEntry[], name: string) =>
      store.write("tree", buildTree([dir(name, store.write("tree", buildTree(entries)))]));
    return { store, a: tree(before, "old"), b: tree(after, "new") };
  }

  it("stops reading blobs once renameBudgetBytes is spent", async () => {
    const { store, a, b } = renames(40, 200);
    const whole = new ObjectCache(store);
    const found = await detectRenames(whole, (await diffTreeEntries(whole, a, b)).changes);
    expect(found.filter((change) => change.status === "renamed")).toHaveLength(40);

    const bounded = new ObjectCache(store, { renameBudgetBytes: 20_000 });
    const changes = (await diffTreeEntries(bounded, a, b)).changes;
    const treeReads = bounded.reads;
    const cut = await detectRenames(bounded, changes);
    // Each blob is about 4.5 KB with its fingerprint: a handful are read, not all eighty.
    expect(bounded.reads - treeReads).toBeLessThan(8);
    const renamed = cut.filter((change) => change.status === "renamed").length;
    expect(renamed).toBeLessThan(40);
    // The rest stay as the deletions and additions they are.
    expect(cut).toHaveLength(changes.length - renamed);
  });

  it("stops comparing once maxRenameWork is spent", async () => {
    const { store, a, b } = renames(20, 100);
    const cache = new ObjectCache(store, { maxRenameWork: 1 });
    const cut = await detectRenames(cache, (await diffTreeEntries(cache, a, b)).changes);
    expect(cut.some((change) => change.status === "renamed")).toBe(false);
  });
});

describe("commits", () => {
  it("refuses a commit with more parents than maxParents", async () => {
    const store = new MemoryObjectStore();
    const tree = store.write("tree", buildTree([]));
    const roots = Array.from({ length: 1025 }, (_, i) => commit(store, tree, [], i));
    const octopus = commit(store, tree, roots, 5000);
    const cache = new ObjectCache(store);
    expect(await refusal(cache.node(octopus))).toBe("limit");
    expect(await refusal(log(cache, octopus))).toBe("limit");
    // One under the bound is walked as ever.
    const smaller = commit(store, tree, roots.slice(0, 1024), 5001);
    expect((await log(new ObjectCache(store), smaller, { limit: 2000 })).entries).toHaveLength(
      1025,
    );
  });

  it("cuts a long message for showing at a character boundary, and reads it whole when asked", async () => {
    const store = new MemoryObjectStore();
    const tree = store.write("tree", buildTree([]));
    const message = `subject\n\n${"é".repeat(1_000_000)}\n`;
    const oid = commit(store, tree, [], 1, message);
    const shown = await new ObjectCache(store, { maxMessageBytes: 1001 }).commit(oid);
    // 1001 bytes of two-byte characters, after the subject and blank line: never half a character.
    expect(shown.message.startsWith("subject\n\n")).toBe(true);
    expect(shown.message.length).toBeLessThan(1001);
    expect(shown.message.endsWith("é")).toBe(true);
    expect(shown.latin1).toBeUndefined();
    expect((await new ObjectCache(store, { maxMessageBytes: 1001 }).fullCommit(oid)).message).toBe(
      message,
    );
    expect((await new ObjectCache(store).commit(oid)).message).toBe(message);
  });

  it("refuses to show a commit whose headers alone are over a megabyte", () => {
    const head = encodeText(
      `tree ${"0".repeat(40)}\nx-filler ${"a".repeat(1_100_000)}\n\nmessage\n`,
    );
    expect(() => cutMessage(head, 10)).toThrow(GitError);
    expect(cutMessage(head, Number.POSITIVE_INFINITY)).toBe(head);
  });

  it("refuses a merge base search with more candidates than it sorts out", async () => {
    const store = new MemoryObjectStore();
    const tree = store.write("tree", buildTree([]));
    const roots = Array.from({ length: 20 }, (_, i) => commit(store, tree, [], i + 1));
    // Two merges of the same twenty unrelated commits: every one of them is a merge base.
    const a = commit(store, tree, roots, 100);
    const b = commit(store, tree, [...roots].reverse(), 101);
    expect(await refusal(mergeBases(store, a, b))).toBe("limit");
    expect(await mergeBases(store, a, commit(store, tree, roots.slice(0, 3), 102))).toHaveLength(3);
  });
});

describe("blame", () => {
  it("does not diff a parent's version over maxTextLines", async () => {
    const store = new MemoryObjectStore();
    const lines = (count: number) =>
      Array.from({ length: count }, (_, i) => `line ${i}\n`).join("");
    const treeOf = (text: string) =>
      store.write("tree", buildTree([file("f", store.write("blob", encodeText(text)))]));
    const parent = commit(store, treeOf(lines(50)), [], 1);
    const child = commit(store, treeOf(lines(5)), [parent], 2);
    const kept = await blame(store, child, "f", { limits: { maxTextLines: 10 } });
    expect(kept.ranges).toEqual([
      { start: 1, lines: 5, commit: child, path: "f", originalStart: 1, settled: true },
    ]);
    const passed = await blame(store, child, "f");
    expect(passed.ranges.every((range) => range.commit === parent)).toBe(true);
  });

  it("counts the parents of an octopus merge against its budget", async () => {
    const store = new MemoryObjectStore();
    const roots: ObjectId[] = [];
    for (let i = 0; i < 60; i++) {
      const blob = store.write("blob", encodeText(`root ${i}\n`));
      roots.push(commit(store, store.write("tree", buildTree([file("f", blob)])), [], i + 1));
    }
    // Every root's line is in the merge, so each root is left holding one.
    const all = Array.from({ length: 60 }, (_, i) => `root ${i}\n`).join("");
    const blob = store.write("blob", encodeText(all));
    const octopus = commit(store, store.write("tree", buildTree([file("f", blob)])), roots, 100);
    const whole = await blame(store, octopus, "f", { maxCommits: 1000 });
    expect(whole.walked).toBe(61);
    expect(whole.complete).toBe(true);
    // The octopus's 58 parents past the second spend the budget of 20: no root is looked at.
    const cut = await blame(store, octopus, "f", { maxCommits: 20 });
    expect(cut.walked).toBe(1);
    expect(cut.complete).toBe(false);
    expect(cut.ranges.every((range) => !range.settled)).toBe(true);
  });
});

describe("tree merges", () => {
  function sides(count: number, size: number) {
    const store = new MemoryObjectStore();
    const make = (tag: string) =>
      store.write(
        "tree",
        buildTree(
          Array.from({ length: count }, (_, i) => {
            const body = Array.from({ length: size }, (_, k) =>
              k === 0 ? `${tag} ${i}\n` : `shared ${i} ${k}\n`,
            ).join("");
            return file(`f${String(i).padStart(4, "0")}`, store.write("blob", encodeText(body)));
          }),
        ),
      );
    return { store, base: make("base"), ours: make("ours"), theirs: make("theirs") };
  }

  it("leaves files past maxMergeTextBytes as too-large conflicts, unread", async () => {
    const { store, base, ours, theirs } = sides(50, 100);
    const cache = new ObjectCache(store, { maxMergeTextBytes: 20_000 });
    const before = cache.reads;
    const merged = await mergeTrees(cache, base, ours, theirs, { renames: false });
    const tooLarge = merged.conflicts.filter((conflict) => conflict.kind === "too-large");
    // Each file is about 1.6 KB, three of them a merge: some 4 merges fit, the other 46 do not.
    expect(tooLarge.length).toBeGreaterThan(40);
    expect(cache.reads - before).toBeLessThan(3 + 3 * 10);
  });

  it("refuses a merge that has to read more than maxDiffTrees directories", async () => {
    const store = new MemoryObjectStore();
    const nest = (tag: string) => {
      let tree = store.write("tree", buildTree([file("f", store.write("blob", encodeText(tag)))]));
      for (let depth = 0; depth < 50; depth++)
        tree = store.write("tree", buildTree([dir("d", tree)]));
      return tree;
    };
    const [base, ours, theirs] = [nest("a\n"), nest("b\n"), nest("c\n")];
    expect(
      await refusal(mergeTrees(store, base, ours, theirs, { limits: { maxDiffTrees: 20 } })),
    ).toBe("limit");
    const merged = await mergeTrees(store, base, ours, theirs);
    expect(merged.conflicts.map((conflict) => conflict.kind)).toEqual(["content"]);
  });
});

describe("archives", () => {
  it("leaves out names that would unpack outside the directory, and repeated names", async () => {
    const store = new MemoryObjectStore();
    const blob = store.write("blob", encodeText("data\n"));
    const target = store.write("blob", encodeText("/etc"));
    const inner = store.write("tree", buildTree([file("passwd", blob)]));
    const tree = store.write(
      "tree",
      rawTree([
        ["100644", "..", blob],
        ["40000", "..\\..\\up", inner],
        ["120000", "a", target],
        ["40000", "a", inner],
        ["100644", "b\\c", blob],
        ["100644", "ok", blob],
      ]),
    );
    const paths: string[] = [];
    for await (const entry of archiveEntries(new ObjectCache(store), tree, "p/")) {
      paths.push(entry.path);
    }
    expect(paths).toEqual(["p/", "p/a", "p/b\\c", "p/ok"]);
    expect(isSafeArchiveName("..")).toBe(false);
    expect(isSafeArchiveName("x/y")).toBe(false);
    expect(isSafeArchiveName("\\x")).toBe(false);
    expect(isSafeArchiveName("x\\..")).toBe(false);
    expect(isSafeArchiveName(".hidden")).toBe(true);
    const tar = decodeText(await collectBytes(tarArchive(store, tree, { prefix: "p/", time: 0 })));
    expect(tar.includes("passwd")).toBe(false);
  });

  it("walks a tree thousands of directories deep, each directory read once", async () => {
    const store = new MemoryObjectStore();
    const blob = store.write("blob", encodeText("deep\n"));
    let tree = store.write("tree", buildTree([file("f", blob)]));
    for (let depth = 0; depth < 3000; depth++)
      tree = store.write("tree", buildTree([dir("d", tree)]));
    const cache = new ObjectCache(store);
    let count = 0;
    let last = "";
    for await (const entry of archiveEntries(cache, tree, "")) {
      count++;
      last = entry.path;
    }
    expect(count).toBe(3001);
    expect(last).toBe(`${"d/".repeat(3000)}f`);
    expect(cache.reads).toBe(3001);
  });
});

describe("the file table's walk", () => {
  it("stops at maxEntries with a continuation that finishes the same answer", async () => {
    const store = new MemoryObjectStore();
    const names = Array.from({ length: 400 }, (_, i) => `n${String(i).padStart(3, "0")}`);
    const commits: ObjectId[] = [];
    for (let step = 0; step < 10; step++) {
      // Every commit changes one name, so no commit leaves the directory as its parent had it.
      const entries = names.map((name, i) =>
        file(name, store.write("blob", encodeText(`${name} ${i % 10 === step ? step : -1}\n`))),
      );
      commits.push(
        commit(store, store.write("tree", buildTree(entries)), commits.slice(-1), step + 1),
      );
    }
    const head = commits.at(-1)!;
    const whole = await lastCommitsForEntries(store, head, "", names, { maxCommits: 1000 });
    expect(whole.continuation).toBeUndefined();

    let step = await lastCommitsForEntries(store, head, "", names, { maxEntries: 1000 });
    // 400 names in the commit and 400 in its parent: the second commit is already over 1 000.
    expect(step.walked).toBe(2);
    expect(step.continuation).toBeDefined();
    const resolved = new Map(step.resolved);
    for (let calls = 0; step.continuation && calls < 20; calls++) {
      step = await lastCommitsForEntries(store, step.continuation, "", [], { maxEntries: 1000 });
      for (const [name, oid] of step.resolved) resolved.set(name, oid);
    }
    expect(resolved).toEqual(whole.resolved);
  });
});
