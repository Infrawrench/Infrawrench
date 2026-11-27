/** Looking things up in trees: one path, or the listing of a directory. */
import { GitError, type ObjectId, type ObjectReader, type TreeEntry } from "@infrawrench/git-core";
import type { Limits } from "../limits";
import { type EntryRef, cacheOf, splitPath } from "../objects";

export interface TreeOptions {
  readonly limits?: Partial<Limits>;
}

/** What `path` is in the tree (its mode and id), or null when nothing is there. `""` is the tree itself. */
export async function resolvePath(
  reader: ObjectReader,
  rootTree: ObjectId,
  path: string,
  options: TreeOptions = {},
): Promise<EntryRef | null> {
  return cacheOf(reader, options.limits).entryAt(rootTree, splitPath(path));
}

export interface ListedEntry extends TreeEntry {
  /** The path from the root of the tree that was listed. */
  readonly path: string;
}

export interface LsTreeOptions extends TreeOptions {
  /** List the directory at this path rather than the root. */
  readonly path?: string;
  /** Descend into subdirectories and list only what is not a directory (`git ls-tree -r`). */
  readonly recursive?: boolean;
  /** Most entries to return. Default 10 000. */
  readonly maxEntries?: number;
}

export interface LsTreeResult {
  /** In tree order, which is what `git ls-tree` prints. */
  readonly entries: ListedEntry[];
  readonly truncated: boolean;
}

/** Lists a directory. Throws `missing-object` when the path is not a directory in this tree. */
export async function lsTree(
  reader: ObjectReader,
  rootTree: ObjectId,
  options: LsTreeOptions = {},
): Promise<LsTreeResult> {
  const cache = cacheOf(reader, options.limits);
  const parts = splitPath(options.path ?? "");
  const at = await cache.entryAt(rootTree, parts);
  if (at === null || at.mode !== "040000") {
    throw new GitError("missing-object", `no directory at ${JSON.stringify(parts.join("/"))}`);
  }
  const max = options.maxEntries ?? 10_000;
  const entries: ListedEntry[] = [];
  let truncated = false;
  const walk = async (tree: ObjectId, prefix: string): Promise<boolean> => {
    for (const entry of await cache.tree(tree)) {
      const path = prefix + entry.name;
      if (options.recursive && entry.mode === "040000") {
        if (!(await walk(entry.oid, `${path}/`))) return false;
        continue;
      }
      if (entries.length >= max) {
        truncated = true;
        return false;
      }
      entries.push({ ...entry, path });
    }
    return true;
  };
  await walk(at.oid, parts.length === 0 ? "" : `${parts.join("/")}/`);
  return { entries, truncated };
}
