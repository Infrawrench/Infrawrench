/**
 * Pruning versions: thirty days after a branch is merged or deleted
 * (`git_branch_versions.prune_after`) the refs that kept its versions'
 * commits readable go, which is the part that costs storage. The rows stay,
 * marked `pruned_at`: a version's number, its trace, the findings raised on
 * it and the review comments written on it are the record of the work, and
 * are read long after the branch is merged. Run from the Worker's cron
 * trigger.
 *
 * The refs go first and the mark after, a branch at a time, so a run that
 * stops halfway leaves rows whose refs are gone and no mark (the next run
 * finishes them: dropping a ref twice drops nothing) and never a marked row
 * whose ref is still there. Removing a version's ref clears the
 * repository's "everything is reachable" answer in the same transaction
 * (`Repository.pruneVersions`), so a full clone asks again.
 *
 * The same run drops trace entries that waited thirty days for a push that
 * never came ({@link pruneStaleTraces}): a branch need not exist to be
 * recorded on, so nothing else would ever remove them. An entry a push
 * claimed is never dropped here.
 */
import { locatorOf } from "../api/context";
import { getRepositoryById } from "../db/repositories";
import { type VersionRow, dueVersions, markVersionsPruned } from "../db/review";
import { deleteStalePendingTraces } from "../db/traces";
import type { Env } from "../env";
import { describeError } from "../http/log";
import { RepoReaderError } from "../repo/reader";
import { type RepoReaderFactory, repoReaderFor } from "../repo/select";
import { TRACE_LIMITS } from "./trace";

/** Versions one run takes. More wait for the next. */
const BATCH = 500;

export interface PruneResult {
  readonly pruned: number;
  /** Left for the next run: their repository's storage did not answer. */
  readonly deferred: number;
}

/** Trace entries no push claimed in {@link TRACE_LIMITS.pendingDays} days. Answers how many went. */
export const pruneStaleTraces = (now: Date = new Date()): Promise<number> =>
  deleteStalePendingTraces(
    new Date(now.getTime() - TRACE_LIMITS.pendingDays * 24 * 60 * 60 * 1000),
  );

export const pruneVersions = async (
  env: Env,
  options: { readonly now?: Date; readonly readers?: RepoReaderFactory } = {},
): Promise<PruneResult> => {
  const now = options.now ?? new Date();
  const due = await dueVersions(now, BATCH);
  const byBranch = new Map<string, VersionRow[]>();
  for (const row of due) {
    const key = `${row.repositoryId}\0${row.branch}`;
    byBranch.set(key, [...(byBranch.get(key) ?? []), row]);
  }
  let pruned = 0;
  let deferred = 0;
  for (const rows of byBranch.values()) {
    const first = rows[0]!;
    try {
      const repo = await getRepositoryById(first.repositoryId);
      // A repository's rows go with it by cascade; one found here still has its storage.
      if (repo) {
        await (options.readers ?? repoReaderFor)(env, locatorOf(repo)).pruneVersions({
          branch: first.branch,
          versions: rows.map((row) => ({ lineage: row.lineage, number: row.number })),
        });
      }
      await markVersionsPruned(
        rows.map((row) => row.id),
        now,
      );
      pruned += rows.length;
    } catch (error) {
      if (!(error instanceof RepoReaderError)) {
        console.error(`[git] pruning versions failed: ${describeError(error)}`);
      }
      deferred += rows.length;
    }
  }
  return { pruned, deferred };
};
