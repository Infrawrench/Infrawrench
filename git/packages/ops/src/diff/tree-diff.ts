/** Which paths differ between two trees, before any thought of renames. */
import {
  type ObjectId,
  type TreeEntry,
  type TreeEntryMode,
  compareTreeEntries,
} from "@infrawrench/git-core";
import type { EntryRef, ObjectCache } from "../objects";

/** One path that differs. `old` is null for an addition, `new` for a deletion. */
export interface TreeChange {
  readonly path: string;
  readonly old: EntryRef | null;
  readonly new: EntryRef | null;
}

export interface RawTreeDiff {
  /** In path order, the order git lists them in. */
  readonly changes: TreeChange[];
  /** True when the list stopped at the limit. */
  readonly truncated: boolean;
}

/** Regular file, symlink or submodule: a change between these is a change of type, not of content. */
export function entryKind(mode: TreeEntryMode): "file" | "symlink" | "gitlink" | "tree" {
  switch (mode) {
    case "120000":
      return "symlink";
    case "160000":
      return "gitlink";
    case "040000":
      return "tree";
    default:
      return "file";
  }
}

/**
 * Walks both trees side by side and lists every blob-level difference.
 * Subtrees with the same id are skipped unread, so the cost follows the
 * size of the change, not of the repository.
 */
export async function diffTreeEntries(
  cache: ObjectCache,
  oldTree: ObjectId | null,
  newTree: ObjectId | null,
  maxChanges: number = cache.limits.maxDiffEntries,
): Promise<RawTreeDiff> {
  const changes: TreeChange[] = [];
  let truncated = false;
  let trees = 0;
  const none: readonly TreeEntry[] = [];

  const add = (path: string, old: EntryRef | null, next: EntryRef | null): boolean => {
    if (changes.length >= maxChanges) {
      truncated = true;
      return false;
    }
    changes.push({ path, old, new: next });
    return true;
  };
  const ref = (entry: TreeEntry): EntryRef => ({ mode: entry.mode, oid: entry.oid });

  const walk = async (
    prefix: string,
    oldOid: ObjectId | null,
    newOid: ObjectId | null,
  ): Promise<boolean> => {
    // Subtrees whose ids differ can still hold the same things (a mode spelled `100664` on one
    // side), and those list nothing: the trees read are counted on their own.
    if (++trees > cache.limits.maxDiffTrees) {
      truncated = true;
      return false;
    }
    const olds = oldOid === null ? none : await cache.tree(oldOid);
    const news = newOid === null ? none : await cache.tree(newOid);
    let i = 0;
    let j = 0;
    while (i < olds.length || j < news.length) {
      const a = olds[i];
      const b = news[j];
      // A file and a directory of one name sort apart, so they come out as a delete and an add.
      const order = a === undefined ? 1 : b === undefined ? -1 : compareTreeEntries(a, b);
      if (order < 0) {
        const entry = a!;
        i++;
        if (entry.mode === "040000") {
          if (!(await walk(`${prefix}${entry.name}/`, entry.oid, null))) return false;
        } else if (!add(prefix + entry.name, ref(entry), null)) return false;
      } else if (order > 0) {
        const entry = b!;
        j++;
        if (entry.mode === "040000") {
          if (!(await walk(`${prefix}${entry.name}/`, null, entry.oid))) return false;
        } else if (!add(prefix + entry.name, null, ref(entry))) return false;
      } else {
        const from = a!;
        const to = b!;
        i++;
        j++;
        if (from.oid === to.oid && from.mode === to.mode) continue;
        if (from.mode === "040000") {
          if (!(await walk(`${prefix}${from.name}/`, from.oid, to.oid))) return false;
        } else if (!add(prefix + from.name, ref(from), ref(to))) return false;
      }
    }
    return true;
  };

  if (oldTree !== newTree) await walk("", oldTree, newTree);
  return { changes, truncated };
}
