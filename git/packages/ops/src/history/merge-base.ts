/**
 * Merge bases, the way git finds them: paint ancestors of each side, newest
 * first, until everything still queued is known to be below a common
 * commit, then drop the candidates that are ancestors of other candidates.
 */
import { GitError, type ObjectId, type ObjectReader } from "@infrawrench/git-core";
import type { Limits } from "../limits";
import { type CommitNode, type ObjectCache, cacheOf } from "../objects";
import { DateQueue } from "./queue";

const PARENT1 = 1;
const PARENT2 = 2;
const STALE = 4;
const RESULT = 8;

export interface HistoryOptions {
  readonly limits?: Partial<Limits>;
}

interface Painted {
  readonly flags: Map<ObjectId, number>;
  readonly results: CommitNode[];
}

/**
 * Git's `paint_down_to_common`. A commit reached from both sides is a
 * candidate, and its ancestors are stale: they are common too, but never
 * the best. The walk ends when only stale commits are queued.
 */
async function paint(
  cache: ObjectCache,
  one: ObjectId,
  twos: readonly ObjectId[],
  stopWhenOneIsCommon = false,
): Promise<Painted> {
  const flags = new Map<ObjectId, number>();
  const results: CommitNode[] = [];
  const queue = new DateQueue();
  // Git asks "is anything queued not stale" of the flags as they are now, not as they were
  // when the commit was queued, so the count follows a commit's entries when it turns stale.
  const queued = new Map<ObjectId, number>();
  let nonStale = 0;
  const push = (node: CommitNode): void => {
    queue.push(node);
    queued.set(node.oid, (queued.get(node.oid) ?? 0) + 1);
    if (!(flags.get(node.oid)! & STALE)) nonStale++;
  };

  flags.set(one, PARENT1);
  push(await cache.node(one));
  for (const two of twos) {
    const before = flags.get(two) ?? 0;
    flags.set(two, before | PARENT2);
    // A repeated start is already queued, and is read with both flags when it comes out.
    if (before === 0) push(await cache.node(two));
  }

  let walked = 0;
  while (nonStale > 0) {
    const commit = queue.pop()!;
    queued.set(commit.oid, queued.get(commit.oid)! - 1);
    const all = flags.get(commit.oid)!;
    if (!(all & STALE)) nonStale--;
    if (++walked > cache.limits.maxCommits) {
      throw new GitError("limit", `history is too large to walk (${cache.limits.maxCommits})`);
    }
    let own = all & (PARENT1 | PARENT2 | STALE);
    if (own === (PARENT1 | PARENT2)) {
      if (!(all & RESULT)) {
        flags.set(commit.oid, all | RESULT);
        results.push(commit);
      }
      if (stopWhenOneIsCommon && commit.oid === one) break;
      own |= STALE;
    }
    for (const parent of commit.parents) {
      const had = flags.get(parent) ?? 0;
      if ((had & own) === own) continue;
      if (!(had & STALE) && own & STALE) nonStale -= queued.get(parent) ?? 0;
      flags.set(parent, had | own);
      push(await cache.node(parent));
    }
  }
  return { flags, results };
}

async function mergeBasesMany(
  cache: ObjectCache,
  one: ObjectId,
  twos: readonly ObjectId[],
): Promise<CommitNode[]> {
  if (twos.includes(one)) return [await cache.node(one)];
  const { flags, results } = await paint(cache, one, twos);
  return results.filter((node) => !(flags.get(node.oid)! & STALE));
}

/** Drops every candidate that another candidate can reach: only the lowest common ancestors stay. */
async function removeRedundant(
  cache: ObjectCache,
  candidates: CommitNode[],
): Promise<CommitNode[]> {
  const redundant = candidates.map(() => false);
  for (let i = 0; i < candidates.length; i++) {
    if (redundant[i]) continue;
    const others: number[] = [];
    for (let j = 0; j < candidates.length; j++) if (j !== i && !redundant[j]) others.push(j);
    if (others.length === 0) break;
    const { flags } = await paint(
      cache,
      candidates[i]!.oid,
      others.map((j) => candidates[j]!.oid),
    );
    if (flags.get(candidates[i]!.oid)! & PARENT2) redundant[i] = true;
    for (const j of others) if (flags.get(candidates[j]!.oid)! & PARENT1) redundant[j] = true;
  }
  return candidates.filter((_, index) => !redundant[index]);
}

/**
 * Every merge base of the two commits (`git merge-base --all`), newest
 * first. More than one means a criss-cross history. Empty when the commits
 * share no history.
 */
export async function mergeBases(
  reader: ObjectReader,
  a: ObjectId,
  b: ObjectId,
  options: HistoryOptions = {},
): Promise<ObjectId[]> {
  const cache = cacheOf(reader, options.limits);
  let bases = await mergeBasesMany(cache, a, [b]);
  if (bases.length > 1) bases = await removeRedundant(cache, bases);
  // Stable, so equal dates keep the order the walk found them in.
  return bases.sort((x, y) => y.time - x.time).map((node) => node.oid);
}

/** The merge base git would pick (`git merge-base a b`): the newest one. Null when there is none. */
export async function mergeBase(
  reader: ObjectReader,
  a: ObjectId,
  b: ObjectId,
  options: HistoryOptions = {},
): Promise<ObjectId | null> {
  return (await mergeBases(reader, a, b, options))[0] ?? null;
}

/** True when `ancestor` is `descendant` or can be reached from it. */
export async function isAncestor(
  reader: ObjectReader,
  ancestor: ObjectId,
  descendant: ObjectId,
  options: HistoryOptions = {},
): Promise<boolean> {
  if (ancestor === descendant) return true;
  const cache = cacheOf(reader, options.limits);
  const { flags } = await paint(cache, ancestor, [descendant], true);
  return ((flags.get(ancestor) ?? 0) & PARENT2) !== 0;
}
