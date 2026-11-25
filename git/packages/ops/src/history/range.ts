/**
 * Which commits one side has that the other does not: the answer behind
 * ahead/behind counts and `base..head` listings.
 */
import { GitError, type ObjectId, type ObjectReader } from "@infrawrench/git-core";
import { type CommitNode, type ObjectCache, cacheOf } from "../objects";
import type { HistoryOptions } from "./merge-base";
import { DateQueue } from "./queue";

export const LEFT = 1;
export const RIGHT = 2;
const BOTH = 3;

/**
 * Marks every commit reachable from `lefts` or `rights` with the sides that
 * reach it, visiting only as much common history as it takes to be sure.
 *
 * Both sides are walked newest first. Once nothing one-sided is queued, a
 * common commit only passes its marks on to parents that are already
 * marked (they were wrongly thought one-sided) or that are no older than
 * the oldest one-sided commit seen (one of their ancestors could be). That
 * is exact whenever no commit is older than its own ancestor; with clocks
 * that far off it can count a common commit as one-sided, as git's own
 * walk can without a commit-graph.
 */
export async function paintSides(
  cache: ObjectCache,
  lefts: readonly ObjectId[],
  rights: readonly ObjectId[],
): Promise<Map<ObjectId, number>> {
  const flags = new Map<ObjectId, number>();
  const queue = new DateQueue();
  const queued = new Set<ObjectId>();
  let oneSidedQueued = 0;
  let oldestOneSided = Number.POSITIVE_INFINITY;

  const start = async (oid: ObjectId, side: number): Promise<void> => {
    flags.set(oid, (flags.get(oid) ?? 0) | side);
    if (queued.has(oid)) return;
    queued.add(oid);
    queue.push(await cache.node(oid));
  };
  for (const oid of lefts) await start(oid, LEFT);
  for (const oid of rights) await start(oid, RIGHT);
  for (const oid of queued) {
    if (flags.get(oid) !== BOTH) {
      oneSidedQueued++;
      oldestOneSided = Math.min(oldestOneSided, (await cache.node(oid)).time);
    }
  }

  let walked = 0;
  for (let commit = queue.pop(); commit !== undefined; commit = queue.pop()) {
    queued.delete(commit.oid);
    const own = flags.get(commit.oid)!;
    if (own !== BOTH) oneSidedQueued--;
    if (++walked > cache.limits.maxCommits) {
      throw new GitError("limit", `history is too large to walk (${cache.limits.maxCommits})`);
    }
    for (const parentOid of commit.parents) {
      const had = flags.get(parentOid) ?? 0;
      if ((had & own) === own) continue;
      const parent: CommitNode = await cache.node(parentOid);
      if (had === 0 && own === BOTH && oneSidedQueued === 0 && parent.time < oldestOneSided) {
        continue;
      }
      const now = had | own;
      flags.set(parentOid, now);
      if (now !== BOTH) oldestOneSided = Math.min(oldestOneSided, parent.time);
      if (queued.has(parentOid)) {
        if (had !== BOTH && now === BOTH) oneSidedQueued--;
      } else {
        queued.add(parentOid);
        queue.push(parent);
        if (now !== BOTH) oneSidedQueued++;
      }
    }
  }
  return flags;
}

export interface AheadBehind {
  /** Commits `a` has that `b` does not. */
  readonly ahead: number;
  /** Commits `b` has that `a` does not. */
  readonly behind: number;
}

/** `git rev-list --count --left-right a...b`. */
export async function aheadBehind(
  reader: ObjectReader,
  a: ObjectId,
  b: ObjectId,
  options: HistoryOptions = {},
): Promise<AheadBehind> {
  if (a === b) return { ahead: 0, behind: 0 };
  const flags = await paintSides(cacheOf(reader, options.limits), [a], [b]);
  let ahead = 0;
  let behind = 0;
  for (const value of flags.values()) {
    if (value === LEFT) ahead++;
    else if (value === RIGHT) behind++;
  }
  return { ahead, behind };
}

/** The commits reachable from `heads` and from none of `excludes`, in no particular order. */
export async function exclusiveCommits(
  cache: ObjectCache,
  heads: readonly ObjectId[],
  excludes: readonly ObjectId[],
): Promise<Set<ObjectId>> {
  const flags = await paintSides(cache, heads, excludes);
  const only = new Set<ObjectId>();
  for (const [oid, value] of flags) if (value === LEFT) only.add(oid);
  return only;
}
