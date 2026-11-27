/**
 * Where an operation puts the objects it makes. Nothing in this package
 * writes to storage: a merge or a rebase collects its new blobs, trees and
 * commits here, and the caller stores them (as one pack) before it moves a
 * ref. The list is in dependency order: an object comes after everything
 * it points at that is also new.
 */
import {
  type GitObject,
  type ObjectId,
  type ObjectReader,
  type ObjectType,
  type TreeEntry,
  hashObjectSync,
  parseTree,
  serializeTree,
  sortTreeEntries,
} from "@infrawrench/git-core";
import { EMPTY_TREE_OID, type EntryRef, type ObjectCache, splitPath } from "../objects";

export interface NewObject extends GitObject {
  readonly oid: ObjectId;
}

export class ObjectSink implements ObjectReader {
  private readonly made = new Map<ObjectId, NewObject>();

  constructor(private readonly cache: ObjectCache) {}

  /** The new objects, each after the new objects it refers to. */
  get objects(): NewObject[] {
    return [...this.made.values()];
  }

  /**
   * Records an object and returns its id. `known` are ids the caller
   * already has for objects that exist: content that hashes to one of them
   * is not new, which keeps a merge that changed nothing from listing anything.
   */
  write(type: ObjectType, data: Uint8Array, known: ReadonlyArray<ObjectId | null> = []): ObjectId {
    const oid = hashObjectSync(type, data);
    if (!this.made.has(oid) && !known.includes(oid)) this.made.set(oid, { oid, type, data });
    return oid;
  }

  async read(oid: ObjectId): Promise<GitObject | null> {
    return this.made.get(oid) ?? this.cache.read(oid);
  }

  async has(oid: ObjectId): Promise<boolean> {
    return this.made.has(oid) || this.cache.has(oid);
  }

  async tree(oid: ObjectId): Promise<readonly TreeEntry[]> {
    const made = this.made.get(oid);
    return made ? parseTree(made.data) : this.cache.tree(oid);
  }

  /** Writes a tree from entries in any order. An empty one is not written: git has no empty directories. */
  writeTree(entries: readonly TreeEntry[], known: ReadonlyArray<ObjectId | null> = []): ObjectId {
    if (entries.length === 0) return EMPTY_TREE_OID;
    // Not `buildTree`: entries carried over from existing trees keep whatever names history gave them.
    return this.write("tree", serializeTree(sortTreeEntries(entries)), known);
  }
}

/**
 * Applies path edits to a tree and returns the new root. Only the
 * directories on the way to an edit are rewritten. An edit to null removes
 * the path; a directory left empty disappears with it.
 */
export async function editTree(
  sink: ObjectSink,
  root: ObjectId,
  edits: ReadonlyMap<string, EntryRef | null>,
): Promise<ObjectId> {
  interface Node {
    entry?: EntryRef | null;
    children: Map<string, Node>;
  }
  const top: Node = { children: new Map() };
  for (const [path, entry] of edits) {
    let node = top;
    for (const part of splitPath(path)) {
      let child = node.children.get(part);
      if (!child) node.children.set(part, (child = { children: new Map() }));
      node = child;
    }
    node.entry = entry;
  }
  const apply = async (oid: ObjectId | null, node: Node): Promise<ObjectId | null> => {
    const entries = new Map<string, TreeEntry>();
    if (oid !== null) for (const entry of await sink.tree(oid)) entries.set(entry.name, entry);
    for (const [name, child] of node.children) {
      if (child.entry !== undefined) {
        if (child.entry === null) entries.delete(name);
        else entries.set(name, { name, mode: child.entry.mode, oid: child.entry.oid });
        continue;
      }
      const existing = entries.get(name);
      const below = await apply(existing?.mode === "040000" ? existing.oid : null, child);
      if (below === null) entries.delete(name);
      else entries.set(name, { name, mode: "040000", oid: below });
    }
    if (entries.size === 0) return null;
    return sink.writeTree([...entries.values()], [oid]);
  };
  return (await apply(root === EMPTY_TREE_OID ? null : root, top)) ?? EMPTY_TREE_OID;
}
