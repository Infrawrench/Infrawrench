/**
 * The review record of merged branch pages, as the default branch reads it:
 * the page a commit was merged as, and the pages that left findings on a
 * path. Everything here is rows that outlive the branch (`git_pull_requests`,
 * `git_review_findings`, `git_merge_overrides`, `git_branch_versions`, which
 * keeps its rows after pruning), so none of it asks the repository's storage.
 */
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  type GitMergeMethod,
  gitBranchVersions,
  gitIssues,
  gitMergeOverrides,
  gitPullRequests,
  gitReviewFindings,
  gitTraceEntries,
} from "@infrawrench/server-core/db/schema";
import { db } from "./client";
import type { FindingRow } from "./findings";

export interface MergedPageRow {
  readonly issueId: string;
  readonly title: string;
  readonly headRef: string;
  readonly headOid: string;
  readonly mergeCommitOid: string;
  readonly mergeMethod: GitMergeMethod | null;
  readonly mergedAt: Date;
  readonly mergedByUserId: string | null;
}

const pageColumns = {
  issueId: gitPullRequests.issueId,
  title: gitIssues.title,
  headRef: gitPullRequests.headRef,
  headOid: gitPullRequests.headOid,
  mergeCommitOid: gitPullRequests.mergeCommitOid,
  mergeMethod: gitPullRequests.mergeMethod,
  mergedAt: gitPullRequests.mergedAt,
  mergedByUserId: gitPullRequests.mergedByUserId,
};

/** A merged page's row has both; the columns are nullable for the pages that are not. */
const merged = (
  row: Omit<MergedPageRow, "mergeCommitOid" | "mergedAt"> & {
    readonly mergeCommitOid: string | null;
    readonly mergedAt: Date | null;
  },
): MergedPageRow | null =>
  row.mergeCommitOid === null || row.mergedAt === null
    ? null
    : { ...row, mergeCommitOid: row.mergeCommitOid, mergedAt: row.mergedAt };

/** The branch page a commit was merged as, in a repository: the newest when several name it. */
export const mergedPageOfCommit = async (
  repositoryId: string,
  oid: string,
): Promise<MergedPageRow | null> => {
  const [row] = await db
    .select(pageColumns)
    .from(gitPullRequests)
    .innerJoin(gitIssues, eq(gitIssues.id, gitPullRequests.issueId))
    .where(
      and(
        eq(gitPullRequests.repositoryId, repositoryId),
        eq(gitPullRequests.mergeCommitOid, oid),
        isNotNull(gitPullRequests.mergedAt),
      ),
    )
    .orderBy(desc(gitPullRequests.mergedAt))
    .limit(1);
  return row ? merged(row) : null;
};

/**
 * Merged pages that left a finding on a path, the newest merge first. The
 * findings are found by the path's index and the pages by their keys, so the
 * cost is the path's findings, not the repository's.
 */
export const mergedPagesWithFindingsOn = async (
  repositoryId: string,
  path: string,
  limit: number,
): Promise<{ readonly pages: MergedPageRow[]; readonly more: boolean }> => {
  const withFindings = db
    .select({ id: gitReviewFindings.pullRequestId })
    .from(gitReviewFindings)
    .where(and(eq(gitReviewFindings.repositoryId, repositoryId), eq(gitReviewFindings.path, path)));
  const rows = await db
    .select(pageColumns)
    .from(gitPullRequests)
    .innerJoin(gitIssues, eq(gitIssues.id, gitPullRequests.issueId))
    .where(
      and(
        eq(gitPullRequests.repositoryId, repositoryId),
        isNotNull(gitPullRequests.mergedAt),
        isNotNull(gitPullRequests.mergeCommitOid),
        inArray(gitPullRequests.issueId, withFindings),
      ),
    )
    .orderBy(desc(gitPullRequests.mergedAt), desc(gitPullRequests.issueId))
    .limit(limit + 1);
  const pages = rows.flatMap((row) => merged(row) ?? []);
  return { pages: pages.slice(0, limit), more: rows.length > limit };
};

export interface MergedPageRecord {
  readonly findings: FindingRow[];
  /** The newest override that names each finding, by finding id. */
  readonly overrides: Map<string, { readonly userId: string | null; readonly reason: string }>;
  /** Versions of the page's newest lineage. */
  versions: number;
}

/** What these pages' reviews left, by page: three reads however many pages. */
export const recordsOfPages = async (
  pageIds: readonly string[],
  options: { readonly path?: string } = {},
): Promise<Map<string, MergedPageRecord>> => {
  const out = new Map<string, MergedPageRecord>();
  if (pageIds.length === 0) return out;
  const ids = [...pageIds];
  const [findings, overrides, versions] = await Promise.all([
    db
      .select()
      .from(gitReviewFindings)
      .where(
        and(
          inArray(gitReviewFindings.pullRequestId, ids),
          options.path === undefined ? undefined : eq(gitReviewFindings.path, options.path),
        ),
      )
      .orderBy(
        sql`${gitReviewFindings.path} asc nulls first`,
        sql`${gitReviewFindings.startLine} asc nulls first`,
        asc(gitReviewFindings.createdAt),
        asc(gitReviewFindings.id),
      ),
    db
      .select({
        pullRequestId: gitMergeOverrides.pullRequestId,
        userId: gitMergeOverrides.userId,
        reason: gitMergeOverrides.reason,
        findingIds: gitMergeOverrides.findingIds,
      })
      .from(gitMergeOverrides)
      .where(inArray(gitMergeOverrides.pullRequestId, ids))
      .orderBy(asc(gitMergeOverrides.createdAt)),
    db
      .select({
        pullRequestId: gitBranchVersions.pullRequestId,
        lineage: gitBranchVersions.lineage,
        count: sql<number>`count(*)::int`,
      })
      .from(gitBranchVersions)
      .where(inArray(gitBranchVersions.pullRequestId, ids))
      .groupBy(gitBranchVersions.pullRequestId, gitBranchVersions.lineage)
      .orderBy(asc(gitBranchVersions.lineage)),
  ]);
  for (const id of ids) out.set(id, { findings: [], overrides: new Map(), versions: 0 });
  for (const finding of findings) out.get(finding.pullRequestId)?.findings.push(finding);
  // Oldest first, so the newest override of a finding is the one left.
  for (const override of overrides) {
    const record = out.get(override.pullRequestId);
    for (const findingId of override.findingIds) {
      record?.overrides.set(findingId, { userId: override.userId, reason: override.reason });
    }
  }
  // Ordered by lineage, so the newest lineage's count is the one left.
  for (const row of versions) {
    const record = row.pullRequestId === null ? undefined : out.get(row.pullRequestId);
    if (record) record.versions = row.count;
  }
  return out;
};

/** What the agent recorded as the ask on a page's versions: the first such entry. */
export const askOfPage = async (pullRequestId: string): Promise<string | null> => {
  const [row] = await db
    .select({ body: gitTraceEntries.body })
    .from(gitTraceEntries)
    .innerJoin(gitBranchVersions, eq(gitBranchVersions.id, gitTraceEntries.versionId))
    .where(and(eq(gitBranchVersions.pullRequestId, pullRequestId), eq(gitTraceEntries.kind, "ask")))
    .orderBy(asc(gitTraceEntries.createdAt), asc(gitTraceEntries.id))
    .limit(1);
  return row?.body ?? null;
};
