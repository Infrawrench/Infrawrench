/**
 * Every bound in one place. The package runs inside a Durable Object with
 * 128 MB and a CPU budget per request, so nothing here walks, reads or
 * allocates without one of these saying when to stop.
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
  /** Most files whose content is diffed in one call; the rest are listed without hunks. */
  readonly maxDiffFiles: number;
  /** Most hunk lines one call renders across all files. */
  readonly maxDiffLines: number;
  /** Inexact rename detection is skipped when sources times destinations is over this squared, as git does. */
  readonly renameLimit: number;
  /** Largest blob considered for inexact rename detection. */
  readonly maxRenameBytes: number;
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
  maxDiffFiles: 300,
  maxDiffLines: 50_000,
  renameLimit: 400,
  maxRenameBytes: 1024 * 1024,
  treeCacheBytes: 8 * 1024 * 1024,
  commitCacheEntries: 50_000,
};

export function resolveLimits(limits: Partial<Limits> | undefined): Limits {
  return limits === undefined ? DEFAULT_LIMITS : { ...DEFAULT_LIMITS, ...limits };
}
