/**
 * The object access every operation here goes through: an `ObjectReader`
 * with small caches in front, so one operation never reads or parses the
 * same commit or tree twice. Make one per request and pass it to every call
 * in that request; passing a bare `ObjectReader` makes a fresh one per call.
 */
import {
  ByteLru,
  type Commit,
  GitError,
  type GitObject,
  type ObjectId,
  type ObjectReader,
  type TreeEntry,
  type TreeEntryMode,
  encodeText,
  parseCommit,
  parseTree,
  readObjectOfType,
  toHex,
} from "@infrawrench/git-core";
import { type Limits, resolveLimits } from "./limits";

/** What a history walk needs from a commit, and nothing a walk over 100 000 of them cannot hold. */
export interface CommitNode {
  readonly oid: ObjectId;
  readonly tree: ObjectId;
  readonly parents: readonly ObjectId[];
  /** Committer time in seconds, 0 when the line is malformed, as git reads it. */
  readonly time: number;
}

/** A tree entry without its name: what a path resolves to. */
export interface EntryRef {
  readonly mode: TreeEntryMode;
  readonly oid: ObjectId;
}

/**
 * A reader that can say how big an object is without reading it. Storage
 * answers from the pack entry's header (and, for a delta, the first bytes of
 * its instructions), so asking costs a few dozen bytes where a read costs
 * the whole object. Optional: without it every size limit is enforced after
 * the read, as before.
 */
export interface SizedReader extends ObjectReader {
  /** The object's size in bytes, or null when the store does not have it. */
  size(oid: ObjectId): Promise<number | null>;
}

/**
 * A commit graph kept by whoever owns the storage (parents, tree and commit
 * time per commit), so walks that outlive one request do not parse the same
 * commits again. `ObjectCache.node` reads through it and fills it.
 */
export interface CommitGraphSource {
  get(oid: ObjectId): CommitNode | undefined;
  set(node: CommitNode): void;
}

export interface ObjectCacheOptions {
  readonly graph?: CommitGraphSource;
}

export const EMPTY_TREE_OID: ObjectId = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const EMPTY_BLOB_OID: ObjectId = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

const OID = /^[0-9a-f]{40}$/;

function latin1(data: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) out += String.fromCharCode(data[i]!);
  return out;
}

/**
 * Reads the tree, parents and committer time straight from the bytes. A
 * walk does this for every commit it visits, and the full parse (message,
 * signatures, extra headers) is several times the work and the garbage.
 */
export function parseCommitNode(oid: ObjectId, data: Uint8Array): CommitNode {
  let tree = "";
  const parents: ObjectId[] = [];
  let time = 0;
  let at = 0;
  while (at < data.length) {
    let end = data.indexOf(0x0a, at);
    if (end < 0) end = data.length;
    if (end === at) break;
    const first = data[at];
    if (first === 0x74 && tree === "" && data[at + 4] === 0x20) {
      tree = latin1(data, at + 5, end);
    } else if (first === 0x70 && data[at + 6] === 0x20) {
      parents.push(latin1(data, at + 7, end));
    } else if (first === 0x63 && latin1(data, at, at + 10) === "committer ") {
      // Git takes the number after the last `>` on the line; anything else is a date of zero.
      let close = end - 1;
      while (close > at && data[close] !== 0x3e) close--;
      if (close > at) {
        let digit = close + 1;
        while (digit < end && data[digit] === 0x20) digit++;
        let value = 0;
        let digits = 0;
        while (digit < end && data[digit]! >= 0x30 && data[digit]! <= 0x39 && digits < 15) {
          value = value * 10 + (data[digit]! - 0x30);
          digit++;
          digits++;
        }
        time = value;
      }
      // Nothing a walk needs comes after the committer line.
      break;
    }
    at = end + 1;
  }
  if (!OID.test(tree)) throw new GitError("bad-object", `commit ${oid} has no tree`);
  for (const parent of parents) {
    if (!OID.test(parent)) {
      throw new GitError("bad-object", `commit ${oid} has a malformed parent`);
    }
  }
  return { oid, tree, parents, time };
}

/** Headers a commit shown with a cut message may have; past it the commit is refused rather than parsed. */
const SHOWN_HEADER_BYTES = 1024 * 1024;

/**
 * A commit's bytes with the message cut to `max` bytes at a character
 * boundary, so it still decodes as the UTF-8 it was. Unchanged when the
 * message fits.
 */
export function cutMessage(data: Uint8Array, max: number): Uint8Array {
  if (!(max < data.length)) return data;
  let blank = -1;
  for (let at = data.indexOf(0x0a); at >= 0; at = data.indexOf(0x0a, at + 1)) {
    if (data[at + 1] === 0x0a) {
      blank = at + 1;
      break;
    }
  }
  const start = blank < 0 ? data.length : blank + 1;
  if (start > SHOWN_HEADER_BYTES) {
    throw new GitError("limit", `commit headers are ${start} bytes, too many to show`);
  }
  if (data.length - start <= max) return data;
  let end = start + max;
  while (end > start && (data[end]! & 0xc0) === 0x80) end--;
  return data.subarray(0, end);
}

function modeOf(value: number): TreeEntryMode | null {
  switch (value & 0o170000) {
    case 0o040000:
      return "040000";
    case 0o100000:
      return value & 0o111 ? "100755" : "100644";
    case 0o120000:
      return "120000";
    case 0o160000:
      return "160000";
    default:
      return null;
  }
}

/**
 * Finds one name in a raw tree without building an entry for every other
 * one. Path-limited history asks this of two trees per commit.
 */
export function scanTree(data: Uint8Array, name: Uint8Array): EntryRef | null {
  let at = 0;
  const length = name.length;
  while (at < data.length) {
    let mode = 0;
    let byte = data[at]!;
    while (byte !== 0x20) {
      if (!(byte >= 0x30 && byte <= 0x37)) {
        throw new GitError("bad-object", "tree entry has no mode");
      }
      mode = (mode << 3) | (byte - 0x30);
      byte = data[++at]!;
    }
    const start = at + 1;
    const nul = data.indexOf(0, start);
    if (nul < 0 || nul + 21 > data.length) {
      throw new GitError("bad-object", "tree entry is cut short");
    }
    if (nul - start === length) {
      let same = true;
      for (let i = 0; i < length; i++) {
        if (data[start + i] !== name[i]) {
          same = false;
          break;
        }
      }
      if (same) {
        const known = modeOf(mode);
        if (known === null) throw new GitError("bad-object", "tree entry has an unknown mode");
        return { mode: known, oid: toHex(data, nul + 1, nul + 21) };
      }
    }
    at = nul + 21;
  }
  return null;
}

/** A path as the components a tree walk follows. An empty path is the root. */
export function splitPath(path: string): string[] {
  return path.split("/").filter((part) => part !== "");
}

export function sameEntry(a: EntryRef | null, b: EntryRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.oid === b.oid && a.mode === b.mode;
}

export class ObjectCache implements ObjectReader {
  readonly limits: Limits;
  private readonly rawTrees: ByteLru<ObjectId>;
  private readonly nodes = new Map<ObjectId, CommitNode>();
  private readonly graph: CommitGraphSource | null;
  private readonly sizer: ((oid: ObjectId) => Promise<number | null>) | null;
  private readonly parsedTrees = new Map<ObjectId, readonly TreeEntry[]>();
  private parsedEntries = 0;
  /** Objects read from the underlying reader, for tests and for callers that meter work. */
  reads = 0;

  constructor(
    private readonly reader: ObjectReader,
    limits?: Partial<Limits>,
    options: ObjectCacheOptions = {},
  ) {
    this.limits = resolveLimits(limits);
    this.rawTrees = new ByteLru(this.limits.treeCacheBytes);
    this.graph = options.graph ?? null;
    const size = (reader as Partial<SizedReader>).size;
    this.sizer = typeof size === "function" ? (oid) => size.call(reader, oid) : null;
  }

  /** The object's size when the reader can say without reading it; null when it cannot. */
  size(oid: ObjectId): Promise<number | null> {
    return this.sizer ? this.sizer(oid) : Promise.resolve(null);
  }

  /** True when the reader knows, before any read, that a blob is over the text limit. */
  async overTextLimit(oid: ObjectId, limit = this.limits.maxTextBytes): Promise<boolean> {
    if (!this.sizer) return false;
    const size = await this.sizer(oid);
    return size !== null && size > limit;
  }

  read(oid: ObjectId): Promise<GitObject | null> {
    this.reads++;
    return this.reader.read(oid);
  }

  has(oid: ObjectId): Promise<boolean> {
    return this.reader.has(oid);
  }

  async node(oid: ObjectId): Promise<CommitNode> {
    const known = this.graph ? this.graph.get(oid) : this.nodes.get(oid);
    if (known) return known;
    const node = parseCommitNode(oid, await readObjectOfType(this, oid, "commit"));
    // Every walk reads each parent it follows, so the parents of one commit are reads a single
    // step would make; a commit made to list a hundred thousand of them is refused instead.
    if (node.parents.length > this.limits.maxParents) {
      throw new GitError(
        "limit",
        `commit ${oid} has ${node.parents.length} parents, more than ${this.limits.maxParents}`,
      );
    }
    if (this.graph) {
      this.graph.set(node);
      return node;
    }
    if (this.nodes.size >= this.limits.commitCacheEntries) {
      // Dropping the oldest half at once is cheaper than tracking recency on every hit.
      let drop = this.nodes.size >> 1;
      for (const key of this.nodes.keys()) {
        if (drop-- <= 0) break;
        this.nodes.delete(key);
      }
    }
    this.nodes.set(oid, node);
    return node;
  }

  /**
   * The commit with its message cut to `maxMessageBytes`, for showing. A
   * message can be tens of megabytes, and a page lists thirty commits.
   */
  async commit(oid: ObjectId): Promise<Commit> {
    const data = await readObjectOfType(this, oid, "commit");
    return parseCommit(cutMessage(data, this.limits.maxMessageBytes));
  }

  /** The commit as stored, message and all: for writing it again (a rebase, a patch). */
  async fullCommit(oid: ObjectId): Promise<Commit> {
    return parseCommit(await readObjectOfType(this, oid, "commit"));
  }

  async rawTree(oid: ObjectId): Promise<Uint8Array> {
    if (oid === EMPTY_TREE_OID) return new Uint8Array(0);
    const known = this.rawTrees.get(oid);
    if (known) return known;
    const data = await readObjectOfType(this, oid, "tree");
    this.rawTrees.set(oid, data);
    return data;
  }

  /** The parsed entries of a tree. The array is shared: do not change it. */
  async tree(oid: ObjectId): Promise<readonly TreeEntry[]> {
    const known = this.parsedTrees.get(oid);
    if (known) return known;
    const raw = await this.rawTree(oid);
    if (raw.length > this.limits.maxTreeBytes) {
      throw new GitError(
        "limit",
        `tree ${oid} is ${raw.length} bytes, more than ${this.limits.maxTreeBytes} to list`,
      );
    }
    const entries = parseTree(raw);
    // Bounded by entries rather than trees: one tree can hold tens of thousands of names.
    if (this.parsedEntries + entries.length > this.limits.treeCacheEntries) {
      this.parsedTrees.clear();
      this.parsedEntries = 0;
    }
    this.parsedTrees.set(oid, entries);
    this.parsedEntries += entries.length;
    return entries;
  }

  async blob(oid: ObjectId): Promise<Uint8Array> {
    return readObjectOfType(this, oid, "blob");
  }

  /** What `path` is in the tree, or null. The root itself is the tree. */
  async entryAt(tree: ObjectId, path: readonly string[]): Promise<EntryRef | null> {
    let current: EntryRef = { mode: "040000", oid: tree };
    for (const part of path) {
      if (current.mode !== "040000") return null;
      const found = scanTree(await this.rawTree(current.oid), encodeText(part));
      if (found === null) return null;
      current = found;
    }
    return current;
  }
}

/** The cache to work through: the one passed in, or a new one around a plain reader. */
export function cacheOf(reader: ObjectReader, limits?: Partial<Limits>): ObjectCache {
  return reader instanceof ObjectCache ? reader : new ObjectCache(reader, limits);
}
