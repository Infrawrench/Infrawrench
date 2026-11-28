/**
 * The ways a pull request lands: a merge commit, a squash, or a rebase.
 * Each returns the objects to write and the commit the target ref should
 * move to, or the conflicts that stopped it. Nothing here writes or moves
 * anything.
 */
import {
  GitError,
  type GitObject,
  type ObjectId,
  type ObjectReader,
  type Signature,
  messageSubject,
} from "@infrawrench/git-core";
import { log } from "../history/log";
import { isAncestor, mergeBases } from "../history/merge-base";
import type { Limits } from "../limits";
import { ObjectCache, type SizedReader, cacheOf } from "../objects";
import { createCommit } from "./commit";
import type { NewObject } from "./sink";
import {
  type MergeConflict,
  type MergeTreesOptions,
  type MergeTreesResult,
  mergeTrees,
} from "./tree";

/** How deep a criss-cross history is unpicked before the base is taken to be empty. */
const MAX_VIRTUAL_DEPTH = 4;
/**
 * Merges of bases one merge may make on the way to its virtual base. Each
 * level can find several bases again, so without a total the work grows as
 * the number of bases to the power of the depth.
 */
const MAX_VIRTUAL_MERGES = 32;

/** A reader that also sees objects made earlier in the same operation and not yet stored. */
function overlay(cache: ObjectCache, extra: Map<ObjectId, GitObject>): ObjectCache {
  const reader: SizedReader = {
    read: async (oid) => extra.get(oid) ?? cache.read(oid),
    has: async (oid) => extra.has(oid) || cache.has(oid),
    // Sizes still come from storage's index for what is stored; a new object's is its length.
    size: async (oid) => extra.get(oid)?.data.length ?? cache.size(oid),
  };
  return new ObjectCache(reader, cache.limits);
}

interface Base {
  readonly tree: ObjectId | null;
  readonly bases: ObjectId[];
  readonly reader: ObjectCache;
}

/**
 * The tree two commits are merged against. With one merge base it is that
 * commit's tree. With several (a criss-cross), the bases are merged with
 * each other first and the result stands in as the base, as git's
 * recursive strategy does; conflicts between bases stay in that tree as
 * markers.
 */
async function baseFor(
  cache: ObjectCache,
  a: ObjectId,
  b: ObjectId,
  depth: number,
  spent: { merges: number } = { merges: 0 },
): Promise<Base> {
  const bases = await mergeBases(cache, a, b);
  if (bases.length === 0) return { tree: null, bases, reader: cache };
  if (bases.length === 1) return { tree: (await cache.node(bases[0]!)).tree, bases, reader: cache };
  const extra = new Map<ObjectId, GitObject>();
  const view = overlay(cache, extra);
  // Oldest first, the order git folds them in.
  const ordered = [...bases].reverse();
  let tree = (await view.node(ordered[0]!)).tree;
  for (let i = 1; i < ordered.length; i++) {
    const next = ordered[i]!;
    const inner: Base =
      depth >= MAX_VIRTUAL_DEPTH
        ? { tree: null, bases: [], reader: view }
        : await baseFor(view, ordered[i - 1]!, next, depth + 1, spent);
    if (++spent.merges > MAX_VIRTUAL_MERGES) {
      throw new GitError("limit", `more than ${MAX_VIRTUAL_MERGES} merges to make a base`);
    }
    const merged = await mergeTrees(inner.reader, inner.tree, tree, (await view.node(next)).tree, {
      ours: "Temporary merge branch 1",
      theirs: "Temporary merge branch 2",
      limits: cache.limits,
    });
    for (const object of merged.objects) extra.set(object.oid, object);
    tree = merged.tree;
  }
  return { tree, bases, reader: view };
}

export interface MergeCommitsResult extends MergeTreesResult {
  /** The merge bases found, newest first. */
  readonly bases: ObjectId[];
}

/** Merges the trees of two commits against their merge base (`git merge-tree --write-tree ours theirs`). */
export async function mergeCommits(
  reader: ObjectReader,
  ours: ObjectId,
  theirs: ObjectId,
  options: MergeTreesOptions = {},
): Promise<MergeCommitsResult> {
  const cache = cacheOf(reader, options.limits);
  const base = await baseFor(cache, ours, theirs, 0);
  const result = await mergeTrees(
    base.reader,
    base.tree,
    (await cache.node(ours)).tree,
    (await cache.node(theirs)).tree,
    { ...options, limits: cache.limits },
  );
  return { ...result, bases: base.bases };
}

export interface MergeAnalysis {
  readonly bases: ObjectId[];
  /** The target already contains the source: there is nothing to merge. */
  readonly upToDate: boolean;
  /** The source contains the target: the target ref can simply move to the source. */
  readonly fastForward: boolean;
}

export async function analyzeMerge(
  reader: ObjectReader,
  target: ObjectId,
  source: ObjectId,
  options: { limits?: Partial<Limits> } = {},
): Promise<MergeAnalysis> {
  const cache = cacheOf(reader, options.limits);
  const bases = await mergeBases(cache, target, source);
  return {
    bases,
    upToDate: bases.length === 1 && bases[0] === source,
    fastForward: bases.length === 1 && bases[0] === target && target !== source,
  };
}

/**
 * How a source's changes already are in a target:
 *
 * - `contained`: the source commit is in the target's history (a merge, a
 *   fast-forward, or a rebase that kept its commits).
 * - `applied`: it is not, but merging it would leave the target's tree as it
 *   is (a squash, a cherry-pick, or a rebase that rewrote the commits).
 */
export type Landing = "contained" | "applied";

/**
 * Whether everything `source` changes is already in `target`, without
 * writing anything. Null when something of it is not, when merging it
 * conflicts (a squash whose lines the target has changed again since reads
 * as not landed), and when the source changes nothing since its merge base,
 * so a source with nothing of its own is never `applied`. A source that is an
 * ancestor of the target is `contained` whatever it changes: the caller
 * decides whether a branch that never had commits of its own counts.
 */
export async function landedIn(
  reader: ObjectReader,
  target: ObjectId,
  source: ObjectId,
  options: MergeTreesOptions = {},
): Promise<Landing | null> {
  const cache = cacheOf(reader, options.limits);
  const analysis = await analyzeMerge(cache, target, source);
  if (analysis.upToDate || target === source) return "contained";
  if (analysis.bases.length === 0) return null;
  const sourceTree = (await cache.node(source)).tree;
  if (analysis.bases.length === 1 && (await cache.node(analysis.bases[0]!)).tree === sourceTree) {
    return null;
  }
  const merged = await mergeCommits(cache, target, source, options);
  if (merged.conflicts.length > 0) return null;
  return merged.tree === (await cache.node(target)).tree ? "applied" : null;
}

export type MergeOutcome =
  /** Write `objects`, then move the target ref to `commit`. */
  | {
      readonly status: "merged";
      readonly commit: ObjectId;
      readonly tree: ObjectId;
      /** In write order: blobs, then trees children first, then commits oldest first. */
      readonly objects: NewObject[];
    }
  /** Nothing to write: move the target ref to `commit`, which already exists. */
  | { readonly status: "fast-forward"; readonly commit: ObjectId }
  /** The target already has everything. */
  | { readonly status: "up-to-date"; readonly commit: ObjectId }
  | {
      readonly status: "conflicts";
      readonly conflicts: MergeConflict[];
      /** The tree with conflict markers, and the objects it needs, for showing the conflicts. */
      readonly tree: ObjectId;
      readonly objects: NewObject[];
      /** For a rebase: the commit that could not be replayed. */
      readonly stoppedAt?: ObjectId;
    };

export interface CommitInput {
  readonly author: Signature;
  readonly committer: Signature;
  readonly message: string;
}

export interface MergeOptions extends MergeTreesOptions {
  /** `allow` moves the ref without a merge commit when it can; `never` always makes one. Default `never`, as forges do. */
  readonly fastForward?: "allow" | "never";
}

/** A merge commit on the target with the source as second parent. */
export async function mergeWithCommit(
  reader: ObjectReader,
  target: ObjectId,
  source: ObjectId,
  input: CommitInput,
  options: MergeOptions = {},
): Promise<MergeOutcome> {
  const cache = cacheOf(reader, options.limits);
  const analysis = await analyzeMerge(cache, target, source);
  if (analysis.upToDate || target === source) return { status: "up-to-date", commit: target };
  if (analysis.fastForward && options.fastForward === "allow") {
    return { status: "fast-forward", commit: source };
  }
  const merged = await mergeCommits(cache, target, source, options);
  if (merged.conflicts.length > 0) {
    return {
      status: "conflicts",
      conflicts: merged.conflicts,
      tree: merged.tree,
      objects: merged.objects,
    };
  }
  const commit = createCommit({ ...input, tree: merged.tree, parents: [target, source] });
  return {
    status: "merged",
    commit: commit.oid,
    tree: merged.tree,
    objects: [...merged.objects, commit],
  };
}

/** One new commit on the target carrying everything the source adds. The source is not a parent. */
export async function squashMerge(
  reader: ObjectReader,
  target: ObjectId,
  source: ObjectId,
  input: CommitInput,
  options: MergeTreesOptions = {},
): Promise<MergeOutcome> {
  const cache = cacheOf(reader, options.limits);
  const analysis = await analyzeMerge(cache, target, source);
  if (analysis.upToDate || target === source) return { status: "up-to-date", commit: target };
  const merged = await mergeCommits(cache, target, source, options);
  if (merged.conflicts.length > 0) {
    return {
      status: "conflicts",
      conflicts: merged.conflicts,
      tree: merged.tree,
      objects: merged.objects,
    };
  }
  const commit = createCommit({ ...input, tree: merged.tree, parents: [target] });
  return {
    status: "merged",
    commit: commit.oid,
    tree: merged.tree,
    objects: [...merged.objects, commit],
  };
}

export interface RebaseOptions extends MergeTreesOptions {
  /** Most commits to replay. Default 250; more is refused with a `limit` error. */
  readonly maxCommits?: number;
  /**
   * Leave a commit as it is when it already sits on the new base, so a
   * source that is simply ahead of the target fast-forwards. Default true.
   * False rewrites every commit with the new committer.
   */
  readonly reuseUnchanged?: boolean;
}

export interface RebaseOutcomeExtra {
  /** Source commit to the commit that replaced it, for the ones replayed. */
  readonly rewritten: Map<ObjectId, ObjectId>;
}

/**
 * Replays the source's commits, oldest first, onto the target. Merge
 * commits are left out, as `git rebase` does, and a commit whose change
 * the target already has is dropped. Stops at the first commit that
 * conflicts.
 */
export async function rebaseMerge(
  reader: ObjectReader,
  target: ObjectId,
  source: ObjectId,
  committer: Signature,
  options: RebaseOptions = {},
): Promise<MergeOutcome & Partial<RebaseOutcomeExtra>> {
  const base = cacheOf(reader, options.limits);
  if (target === source || (await isAncestor(base, source, target))) {
    return { status: "up-to-date", commit: target };
  }
  const max = options.maxCommits ?? 250;
  const listed = await log(base, source, { exclude: [target], limit: max + 1 });
  if (listed.truncated || listed.entries.length > max) {
    throw new GitError("limit", `more than ${max} commits to rebase`);
  }
  const todo = listed.entries.reverse().filter((entry) => entry.commit.parents.length <= 1);

  const extra = new Map<ObjectId, GitObject>();
  const cache = overlay(base, extra);
  const objects: NewObject[] = [];
  const rewritten = new Map<ObjectId, ObjectId>();
  let tip = target;
  let tipTree = (await cache.node(target)).tree;
  let wrote = false;

  for (const { oid } of todo) {
    // Read whole: the listing's copy may have its message cut for showing, and this one is written again.
    const commit = await cache.fullCommit(oid);
    const parent = commit.parents[0];
    if (parent === tip && options.reuseUnchanged !== false) {
      tip = oid;
      tipTree = commit.tree;
      continue;
    }
    const parentTree = parent ? (await cache.node(parent)).tree : null;
    const merged = await mergeTrees(cache, parentTree, tipTree, commit.tree, {
      ...options,
      ours: options.ours ?? "HEAD",
      theirs: options.theirs ?? `${oid.slice(0, 7)} (${messageSubject(commit.message)})`,
      limits: base.limits,
    });
    if (merged.conflicts.length > 0) {
      return {
        status: "conflicts",
        conflicts: merged.conflicts,
        tree: merged.tree,
        objects: [...objects, ...merged.objects],
        stoppedAt: oid,
        rewritten,
      };
    }
    // The target already has this change: replaying it would make an empty commit.
    if (merged.tree === tipTree && commit.tree !== parentTree) continue;
    const made = createCommit({
      tree: merged.tree,
      parents: [tip],
      author: commit.author,
      committer,
      message: commit.message,
      // A signature covers the old commit's bytes and would be wrong on the new one.
      extraHeaders: commit.extraHeaders.filter(([key]) => !key.startsWith("gpgsig")),
      ...(commit.latin1 ? { latin1: true } : {}),
    });
    for (const object of [...merged.objects, made]) {
      if (!extra.has(object.oid)) {
        extra.set(object.oid, object);
        objects.push(object);
      }
    }
    rewritten.set(oid, made.oid);
    tip = made.oid;
    tipTree = merged.tree;
    wrote = true;
  }

  if (tip === target) return { status: "up-to-date", commit: target, rewritten };
  if (!wrote) return { status: "fast-forward", commit: tip, rewritten };
  return { status: "merged", commit: tip, tree: tipTree, objects, rewritten };
}
