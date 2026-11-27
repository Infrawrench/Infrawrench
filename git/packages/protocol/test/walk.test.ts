/**
 * Choosing a fetch's objects when every read of storage has a price: a
 * commit's trees are read many at once, not one after another, and what is
 * chosen is the same either way.
 */
import {
  GitError,
  type GitObject,
  type ObjectId,
  type ObjectReader,
  type TreeEntry,
  hashObjectSync,
  serializeCommit,
  serializeTree,
} from "@infrawrench/git-core";
import { describe, expect, it } from "vitest";
import { CommitGraph, selectObjects } from "../src";

const who = { name: "T", email: "t@example.com", timestamp: 1_700_000_000, timezoneOffset: 0 };

class Store implements ObjectReader {
  readonly objects = new Map<ObjectId, GitObject>();
  reads = 0;
  inFlight = 0;
  peak = 0;

  put(type: GitObject["type"], data: Uint8Array): ObjectId {
    const oid = hashObjectSync(type, data);
    this.objects.set(oid, { type, data });
    return oid;
  }

  async read(oid: ObjectId): Promise<GitObject | null> {
    this.reads++;
    this.inFlight++;
    this.peak = Math.max(this.peak, this.inFlight);
    // A round trip to an object store.
    await new Promise((resolve) => setTimeout(resolve, 2));
    this.inFlight--;
    return this.objects.get(oid) ?? null;
  }

  async has(oid: ObjectId): Promise<boolean> {
    return this.objects.has(oid);
  }
}

/** A tree `width` wide and `depth` deep with a blob in every directory; `salt` changes one leaf. */
function makeTree(store: Store, width: number, depth: number, salt: string, path = ""): ObjectId {
  const entries: TreeEntry[] = [];
  const text = path === "0/0" ? `${path} ${salt}` : path;
  const blob = store.put("blob", new TextEncoder().encode(`file at ${text}\n`));
  entries.push({ mode: "100644", name: "file.txt", oid: blob });
  if (depth > 0) {
    for (let i = 0; i < width; i++) {
      const child = makeTree(store, width, depth - 1, salt, path === "" ? `${i}` : `${path}/${i}`);
      entries.push({ mode: "040000", name: `d${i}`, oid: child });
    }
  }
  return store.put("tree", serializeTree(entries));
}

function makeCommit(store: Store, tree: ObjectId, parents: ObjectId[]): ObjectId {
  return store.put(
    "commit",
    serializeCommit({
      tree,
      parents,
      author: who,
      committer: who,
      message: "c\n",
      extraHeaders: [],
    }),
  );
}

describe("selecting a commit's objects", () => {
  it("reads trees many at once and selects every tree and blob once", async () => {
    const store = new Store();
    // 1 + 6 + 36 + 216 trees, each with a blob. The blobs' text differs by path, so none repeat.
    const tree = makeTree(store, 6, 3, "a");
    const commit = makeCommit(store, tree, []);
    const trees = [...store.objects.values()].filter((object) => object.type === "tree").length;
    expect(trees).toBe(259);

    store.reads = 0;
    const started = performance.now();
    const { objects } = await selectObjects(new CommitGraph(store), {
      commits: [commit],
      edges: [],
      tags: [],
      trees: [],
      blobs: [],
    });
    const elapsed = performance.now() - started;
    expect(new Set(objects).size).toBe(objects.size);
    expect(objects.size).toBe(store.objects.size);
    for (const oid of store.objects.keys()) expect(objects.has(oid)).toBe(true);
    // The commit and every tree, once each, and never a blob.
    expect(store.reads).toBe(1 + trees);
    expect(store.peak).toBeGreaterThan(8);
    expect(store.peak).toBeLessThanOrEqual(32);
    // One after another this is 260 round trips of two milliseconds and more.
    expect(elapsed).toBeLessThan(400);
  });

  it("leaves out what an edge commit's tree shows the client has", async () => {
    const store = new Store();
    const older = makeCommit(store, makeTree(store, 4, 2, "old"), []);
    const before = new Set(store.objects.keys());
    const newer = makeCommit(store, makeTree(store, 4, 2, "new"), [older]);
    const added = [...store.objects.keys()].filter((oid) => !before.has(oid));
    // The commit, the changed blob, and the three trees on the way down to it.
    expect(added).toHaveLength(5);

    const selection = await selectObjects(new CommitGraph(store), {
      commits: [newer],
      edges: [older],
      tags: [],
      trees: [],
      blobs: [],
    });
    expect([...selection.objects].sort()).toEqual([...added].sort());
    expect(selection.have.size).toBe(before.size - 1);
  });

  it("refuses a tree that is missing, whichever read finds it", async () => {
    const store = new Store();
    const tree = makeTree(store, 5, 2, "a");
    const commit = makeCommit(store, tree, []);
    const victim = [...store.objects.entries()].find(
      ([oid, object]) => object.type === "tree" && oid !== tree,
    )![0];
    store.objects.delete(victim);
    await expect(
      selectObjects(new CommitGraph(store), {
        commits: [commit],
        edges: [],
        tags: [],
        trees: [],
        blobs: [],
      }),
    ).rejects.toThrow(GitError);
  });
});
