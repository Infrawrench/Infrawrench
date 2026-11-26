/**
 * The last commit that touched each entry of a directory: the column a
 * forge's file table shows beside every name.
 *
 * Asking `log -1 -- dir/name` once per name would walk the same history
 * once per name. Instead the names travel through history together: each
 * commit holds the names still unattributed on its line of history, hands a
 * name to the parent in which the entry is unchanged, and keeps the names
 * that differ from every parent. A name is only ever held by one commit, so
 * the answer for each is exactly what the per-name log would say.
 */
import type { ObjectId, ObjectReader } from "@infrawrench/git-core";
import { Heap } from "../heap";
import type { Limits } from "../limits";
import { type CommitNode, type EntryRef, type ObjectCache, cacheOf, splitPath } from "../objects";

export interface LastCommitsBudget {
  /** Commits to visit in this call. Default 500. */
  readonly maxCommits?: number;
  /** Stop after this long, checked between commits. */
  readonly maxMillis?: number;
  /**
   * Directory entries and parents looked at in this call, checked between
   * commits. Each commit that changed the directory reads it in itself and
   * in every parent, so a directory of a hundred thousand names makes one
   * commit cost what thousands of small ones do. Default 1 000 000.
   */
  readonly maxEntries?: number;
  /**
   * Answers already worked out for this directory at some commit (a cache
   * the caller keeps): name to the commit that last changed it. A walk that
   * reaches such a commit settles every name it holds from the answer and
   * goes no further down that line, which is exact, because a name is only
   * handed to a commit in which its entry is unchanged.
   */
  readonly known?: (commit: ObjectId) => ReadonlyMap<string, ObjectId> | undefined;
  readonly limits?: Partial<Limits>;
}

/** Where a walk stopped. Plain data: store it or send it to the client and pass it back to carry on. */
export interface LastCommitsContinuation {
  readonly dirPath: string;
  /** Each commit still holding names, with those names. */
  readonly pending: ReadonlyArray<readonly [ObjectId, readonly string[]]>;
}

export interface LastCommitsResult {
  /** Entry name to the commit that last changed it, for the names settled in this call. */
  readonly resolved: Map<string, ObjectId>;
  /** Present when names are left: call again with it. */
  readonly continuation?: LastCommitsContinuation;
  readonly walked: number;
}

function refKey(ref: EntryRef | undefined): string {
  return ref === undefined ? "" : `${ref.mode}${ref.oid}`;
}

async function directory(
  cache: ObjectCache,
  tree: ObjectId,
  parts: readonly string[],
): Promise<ObjectId | null> {
  const at = await cache.entryAt(tree, parts);
  return at !== null && at.mode === "040000" ? at.oid : null;
}

async function entryMap(
  cache: ObjectCache,
  tree: ObjectId | null,
  cost: { scanned: number },
): Promise<Map<string, EntryRef>> {
  const map = new Map<string, EntryRef>();
  if (tree === null) return map;
  const entries = await cache.tree(tree);
  cost.scanned += entries.length;
  for (const entry of entries) map.set(entry.name, entry);
  return map;
}

/**
 * Starts from a commit and the names to attribute, or carries on from a
 * continuation. Names that the directory does not have at `start` settle on
 * the commit that removed them, or stay unresolved if they never existed.
 */
export async function lastCommitsForEntries(
  reader: ObjectReader,
  start: ObjectId | LastCommitsContinuation,
  dirPath: string,
  entryNames: readonly string[],
  budget: LastCommitsBudget = {},
): Promise<LastCommitsResult> {
  const cache = cacheOf(reader, budget.limits);
  const resumed = typeof start !== "string";
  const parts = splitPath(resumed ? start.dirPath : dirPath);
  const maxCommits = budget.maxCommits ?? 500;
  const maxEntries = budget.maxEntries ?? 1_000_000;
  const cost = { scanned: 0 };
  const deadline = budget.maxMillis === undefined ? null : Date.now() + budget.maxMillis;

  const held = new Map<ObjectId, Set<string>>();
  const queue = new Heap<CommitNode>((a, b) => a.time > b.time);
  const hold = async (oid: ObjectId, names: Iterable<string>): Promise<void> => {
    let set = held.get(oid);
    if (!set) {
      held.set(oid, (set = new Set()));
      queue.push(await cache.node(oid));
    }
    for (const name of names) set.add(name);
  };
  if (resumed) for (const [oid, names] of start.pending) await hold(oid, names);
  else if (entryNames.length > 0) await hold(start, entryNames);

  const resolved = new Map<string, ObjectId>();
  let walked = 0;
  while (queue.size > 0) {
    if (
      walked >= maxCommits ||
      cost.scanned >= maxEntries ||
      (deadline !== null && Date.now() >= deadline)
    ) {
      break;
    }
    const node = queue.pop()!;
    const names = held.get(node.oid)!;
    held.delete(node.oid);
    const answers = budget.known?.(node.oid);
    if (answers) {
      for (const name of names) {
        const last = answers.get(name);
        if (last !== undefined) resolved.set(name, last);
      }
      continue;
    }
    walked++;

    const hereTree = await directory(cache, node.tree, parts);
    if (node.parents.length === 0) {
      const here = await entryMap(cache, hereTree, cost);
      // A root commit introduced whatever it has. A name it lacks never existed on this line.
      for (const name of names) if (here.has(name)) resolved.set(name, node.oid);
      continue;
    }

    const parentTrees: Array<ObjectId | null> = [];
    let wholesale: ObjectId | null = null;
    for (const parent of node.parents) {
      cost.scanned++;
      const tree = await directory(cache, (await cache.node(parent)).tree, parts);
      parentTrees.push(tree);
      // The directory is untouched relative to this parent: every name goes there, unread.
      if (tree === hereTree && wholesale === null) wholesale = parent;
    }
    if (wholesale !== null) {
      await hold(wholesale, names);
      continue;
    }

    const here = await entryMap(cache, hereTree, cost);
    const parentMaps: Array<Map<string, EntryRef>> = [];
    for (const tree of parentTrees) parentMaps.push(await entryMap(cache, tree, cost));
    const pass = node.parents.map(() => [] as string[]);
    for (const name of names) {
      const key = refKey(here.get(name));
      let passed = false;
      for (let p = 0; p < parentMaps.length; p++) {
        if (refKey(parentMaps[p]!.get(name)) === key) {
          pass[p]!.push(name);
          passed = true;
          break;
        }
      }
      if (!passed) resolved.set(name, node.oid);
    }
    for (let p = 0; p < pass.length; p++) {
      if (pass[p]!.length > 0) await hold(node.parents[p]!, pass[p]!);
    }
  }

  if (held.size === 0) return { resolved, walked };
  return {
    resolved,
    walked,
    continuation: {
      dirPath: parts.join("/"),
      pending: [...held].map(([oid, names]) => [oid, [...names]] as const),
    },
  };
}
