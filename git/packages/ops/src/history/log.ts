/**
 * `git log`: commits newest first, optionally only those that touch a
 * path, with git's default history simplification.
 */
import type { Commit, ObjectId, ObjectReader } from "@infrawrench/git-core";
import { findRenameSource } from "../diff/renames";
import type { Limits } from "../limits";
import { type EntryRef, cacheOf, sameEntry, splitPath } from "../objects";
import { DateQueue } from "./queue";
import { exclusiveCommits } from "./range";

export interface LogOptions {
  /** Only commits that change this file or directory. */
  readonly path?: string;
  /** Commits to pass over before the first one returned. */
  readonly skip?: number;
  /** Most commits to return. Default 30. */
  readonly limit?: number;
  /** Follow only the first parent of each merge (`--first-parent`). */
  readonly firstParent?: boolean;
  /** With `path` naming a file: keep following it under its earlier names (`--follow`). */
  readonly followRenames?: boolean;
  /** Leave out everything reachable from these (`exclude..start`). */
  readonly exclude?: readonly ObjectId[];
  readonly limits?: Partial<Limits>;
}

export interface LogEntry {
  readonly oid: ObjectId;
  readonly commit: Commit;
  /** With a path: the name the file had at this commit, which differs from the one asked for after a rename. */
  readonly path?: string;
}

export interface LogResult {
  readonly entries: LogEntry[];
  /** At least one more commit follows the last one returned. */
  readonly hasMore: boolean;
  /** The walk hit `maxCommits` before it could answer; the entries are a correct prefix. */
  readonly truncated: boolean;
  /** Commits visited, for callers that meter work. */
  readonly walked: number;
}

/**
 * Lists history from one or more starting commits.
 *
 * With a path, a commit is listed when the path differs from every parent.
 * A merge that matches one parent on the path is not listed, and only that
 * parent is followed: this is git's default simplification, and it is why
 * a file's history does not show every merge that happened elsewhere.
 */
export async function log(
  reader: ObjectReader,
  start: ObjectId | readonly ObjectId[],
  options: LogOptions = {},
): Promise<LogResult> {
  const cache = cacheOf(reader, options.limits);
  const starts = typeof start === "string" ? [start] : start;
  const limit = options.limit ?? 30;
  const skip = options.skip ?? 0;
  const firstParent = options.firstParent === true;
  const limited = options.path !== undefined && splitPath(options.path).length > 0;
  const follow = limited && options.followRenames === true;
  const allowed =
    options.exclude && options.exclude.length > 0
      ? await exclusiveCommits(cache, starts, options.exclude)
      : null;

  const queue = new DateQueue();
  const seen = new Set<string>();
  // The path travels with the commit, because after a rename two branches know the file under
  // different names, and a commit reached from both has to be looked at under each. A commit
  // queued twice comes out in the order it went in, so its paths are a queue of their own.
  const paths = new Map<ObjectId, string[]>();
  const enqueue = async (oid: ObjectId, path: string | undefined): Promise<void> => {
    if (allowed !== null && !allowed.has(oid)) return;
    const visit = path === undefined || !follow ? oid : `${oid}\0${path}`;
    if (seen.has(visit)) return;
    seen.add(visit);
    if (path !== undefined) {
      const waiting = paths.get(oid);
      if (waiting) waiting.push(path);
      else paths.set(oid, [path]);
    }
    queue.push(await cache.node(oid));
  };
  const listed = new Set<ObjectId>();
  for (const oid of starts) await enqueue(oid, limited ? options.path : undefined);

  const entries: LogEntry[] = [];
  let skipped = 0;
  let walked = 0;
  let hasMore = false;
  let truncated = false;

  for (let node = queue.pop(); node !== undefined; node = queue.pop()) {
    if (walked >= cache.limits.maxCommits) {
      truncated = true;
      break;
    }
    walked++;
    const waiting = paths.get(node.oid);
    const path = waiting?.shift();
    if (waiting?.length === 0) paths.delete(node.oid);
    const parents = firstParent ? node.parents.slice(0, 1) : node.parents;
    let shown = true;

    if (path === undefined) {
      for (const parent of parents) await enqueue(parent, undefined);
    } else {
      const parts = splitPath(path);
      const here: EntryRef | null = await cache.entryAt(node.tree, parts);
      if (parents.length === 0) {
        shown = here !== null;
      } else {
        let same: ObjectId | null = null;
        const missing = new Set<ObjectId>();
        for (const parent of parents) {
          const there = await cache.entryAt((await cache.node(parent)).tree, parts);
          if (there === null) missing.add(parent);
          if (sameEntry(here, there)) {
            same = parent;
            break;
          }
        }
        if (same !== null) {
          shown = false;
          await enqueue(same, path);
        } else {
          for (const parent of parents) {
            let from = path;
            if (follow && here !== null && here.mode !== "040000" && missing.has(parent)) {
              // The name is new relative to this parent. If the parent had the content under
              // another name, carry on there under that name.
              const source = await findRenameSource(
                cache,
                (await cache.node(parent)).tree,
                node.tree,
                path,
              );
              if (source) from = source.path;
            }
            await enqueue(parent, from);
          }
        }
      }
    }

    // Reached under two names that both changed here: it is still one commit.
    if (!shown || listed.has(node.oid)) continue;
    if (follow) listed.add(node.oid);
    if (skipped < skip) {
      skipped++;
      continue;
    }
    if (entries.length >= limit) {
      hasMore = true;
      break;
    }
    const commit = await cache.commit(node.oid);
    entries.push(path === undefined ? { oid: node.oid, commit } : { oid: node.oid, commit, path });
  }
  return { entries, hasMore, truncated, walked };
}

/**
 * The commits `head` has that `base` does not (`git log base..head`),
 * newest first: what a pull request or a compare page lists.
 */
export async function commitsBetween(
  reader: ObjectReader,
  base: ObjectId,
  head: ObjectId,
  options: Omit<LogOptions, "exclude"> = {},
): Promise<LogResult> {
  return log(reader, head, { limit: 250, ...options, exclude: [base] });
}
