/**
 * Every bound in one place. The package runs inside a Durable Object with
 * 128 MB and a CPU budget per request, so nothing here walks, reads or
 * allocates without one of these saying when to stop.
 *
 * Every bound is a count (commits, trees, bytes, lines), never only a time:
 * in workerd the clock does not move while code runs, only across I/O, so a
 * walk over objects already in memory never reaches a deadline.
 */
export interface Limits {
  /** Commits a history walk may visit before it gives up (or reports `truncated`). */
  readonly maxCommits: number;
  /** Largest blob that is diffed, blamed or merged as text. Larger ones are reported as too large. */
  readonly maxTextBytes: number;
  /** Most lines one side of a text operation may have. */
  readonly maxTextLines: number;
  /** Most changed paths a tree diff lists before it reports `truncated`. */
  readonly maxDiffEntries: number;
  /**
   * Most pairs of trees a tree diff reads before it reports `truncated`. Two
   * subtrees can differ in id and not in what they hold (a mode spelled two
   * ways), so the changes listed alone do not bound the reading.
   */
  readonly maxDiffTrees: number;
  /** Most files whose content is diffed in one call; the rest are listed without hunks. */
  readonly maxDiffFiles: number;
  /** Most hunk lines one call renders across all files. */
  readonly maxDiffLines: number;
  /** Inexact rename detection is skipped when sources times destinations is over this squared, as git does. */
  readonly renameLimit: number;
  /** Largest blob considered for inexact rename detection. */
  readonly maxRenameBytes: number;
  /**
   * Bytes one rename detection may read and hold for inexact matching: each
   * blob read counts, and so does the fingerprint kept of it. A file not yet
   * read when it runs out is only ever matched exactly.
   */
  readonly renameBudgetBytes: number;
  /** Fingerprint entries compared across all candidate pairs of one rename detection; past it, no pair scores. */
  readonly maxRenameWork: number;
  /**
   * Largest tree object that is parsed into entries. A parsed entry costs
   * the heap about 17 times its bytes, so a tree of a million names (32 MB
   * raw) would take some 540 MB. Larger trees are refused with a `limit`
   * error; looking one name up in them (`entryAt`) still works.
   */
  readonly maxTreeBytes: number;
  /**
   * Bytes of files one tree merge reads to merge as text (all three
   * versions count). The merged blobs are held until the caller writes
   * them; files reached after it are `too-large` conflicts.
   */
  readonly maxMergeTextBytes: number;
  /** Parsed tree entries kept by an `ObjectCache`. */
  readonly treeCacheEntries: number;
  /** Most parents a commit may have for a walk to read it: each parent is a read, a merge with thousands is refused. */
  readonly maxParents: number;
  /**
   * Bytes of a commit's message `ObjectCache.commit` parses; the rest is cut
   * at a character boundary. For pages that show commits. Operations that
   * write a commit's message again read it whole (`ObjectCache.fullCommit`).
   */
  readonly maxMessageBytes: number;
  /** Bytes of raw tree objects kept in an `ObjectCache`. */
  readonly treeCacheBytes: number;
  /** Commit graph nodes (tree, parents, date) kept in an `ObjectCache`. */
  readonly commitCacheEntries: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxCommits: 100_000,
  maxTextBytes: 1024 * 1024,
  maxTextLines: 100_000,
  maxDiffEntries: 10_000,
  maxDiffTrees: 50_000,
  maxDiffFiles: 300,
  maxDiffLines: 50_000,
  renameLimit: 400,
  maxRenameBytes: 1024 * 1024,
  renameBudgetBytes: 32 * 1024 * 1024,
  maxRenameWork: 100_000_000,
  maxTreeBytes: 1024 * 1024,
  maxMergeTextBytes: 32 * 1024 * 1024,
  treeCacheEntries: 50_000,
  maxParents: 1024,
  maxMessageBytes: Number.POSITIVE_INFINITY,
  treeCacheBytes: 8 * 1024 * 1024,
  commitCacheEntries: 50_000,
};

export function resolveLimits(limits: Partial<Limits> | undefined): Limits {
  return limits === undefined ? DEFAULT_LIMITS : { ...DEFAULT_LIMITS, ...limits };
}
