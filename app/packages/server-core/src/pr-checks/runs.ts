/** Reads over `pr_check_runs`: the recent checks a settings page lists. */
import { and, desc, eq, lt } from "drizzle-orm";
import type { PrCheckConclusion, PrCheckRun } from "@infrawrench/client-core";

import { db } from "../db/client.js";
import { prCheckRepositories, prCheckRuns } from "../db/schema.js";

/** How long a run's report is kept. Long enough to review last quarter's merges. */
export const PR_CHECK_RUN_RETENTION_DAYS = 90;

export async function listPrCheckRuns(
  organizationId: string,
  opts: { repositoryId?: string | undefined; limit?: number | undefined } = {},
): Promise<PrCheckRun[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await db
    .select({ run: prCheckRuns, repo: prCheckRepositories.repo })
    .from(prCheckRuns)
    .innerJoin(prCheckRepositories, eq(prCheckRepositories.id, prCheckRuns.repositoryId))
    .where(
      and(
        eq(prCheckRuns.organizationId, organizationId),
        opts.repositoryId ? eq(prCheckRuns.repositoryId, opts.repositoryId) : undefined,
      ),
    )
    .orderBy(desc(prCheckRuns.createdAt))
    .limit(limit);
  return rows.map(({ run, repo }) => ({
    id: run.id,
    repositoryId: run.repositoryId,
    repo,
    pullNumber: run.pullNumber,
    pullTitle: run.pullTitle,
    pullUrl: run.pullUrl,
    headSha: run.headSha,
    status: run.status as PrCheckRun["status"],
    conclusion: (run.conclusion as PrCheckConclusion | null) ?? null,
    checkRunUrl: run.checkRunUrl,
    commentUrl: run.commentUrl,
    report: run.report ?? null,
    error: run.error,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  }));
}

/** Delete runs past retention. Returns how many went. */
export async function prunePrCheckRuns(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - PR_CHECK_RUN_RETENTION_DAYS * 86_400_000);
  const rows = await db
    .delete(prCheckRuns)
    .where(lt(prCheckRuns.createdAt, cutoff))
    .returning({ id: prCheckRuns.id });
  return rows.length;
}
