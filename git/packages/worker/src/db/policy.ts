/**
 * What gates a ref change: protected-branch rules and commit statuses.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  type GitStatusState,
  gitCommitStatuses,
  gitProtectedBranches,
} from "@infrawrench/server-core/db/schema";
import { db, isUniqueViolation, newId } from "./client";
import { combinedState } from "./policy-rules";

export {
  type BranchProtection,
  combinedState,
  matchesBranchPattern,
  protectionFor,
} from "./policy-rules";

export type ProtectedBranchRow = typeof gitProtectedBranches.$inferSelect;
export type CommitStatusRow = typeof gitCommitStatuses.$inferSelect;

export const listProtectedBranches = (repositoryId: string): Promise<ProtectedBranchRow[]> =>
  db
    .select()
    .from(gitProtectedBranches)
    .where(eq(gitProtectedBranches.repositoryId, repositoryId))
    .orderBy(asc(gitProtectedBranches.pattern));

export type ProtectedBranchSettings = Partial<
  Pick<
    ProtectedBranchRow,
    | "pattern"
    | "requirePullRequest"
    | "requiredApprovals"
    | "dismissStaleApprovals"
    | "requiredStatusContexts"
    | "allowForcePush"
    | "allowDeletion"
    | "restrictPushers"
    | "pusherUserIds"
    | "enforceAdmins"
  >
>;

/** Create a rule. Null when the repository already has one for the pattern. */
export const createProtectedBranch = async (
  repositoryId: string,
  settings: ProtectedBranchSettings & { readonly pattern: string },
  createdByUserId: string | null,
): Promise<ProtectedBranchRow | null> => {
  try {
    const [row] = await db
      .insert(gitProtectedBranches)
      .values({ id: newId(), repositoryId, createdByUserId, ...settings })
      .returning();
    return row!;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return null;
  }
};

/** Change a rule. `conflict` when its new pattern is another rule's, null when the rule is gone. */
export const updateProtectedBranch = async (
  repositoryId: string,
  ruleId: string,
  settings: ProtectedBranchSettings,
): Promise<ProtectedBranchRow | "conflict" | null> => {
  try {
    const [row] = await db
      .update(gitProtectedBranches)
      .set({ ...settings, updatedAt: new Date() })
      .where(
        and(
          eq(gitProtectedBranches.id, ruleId),
          eq(gitProtectedBranches.repositoryId, repositoryId),
        ),
      )
      .returning();
    return row ?? null;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return "conflict";
  }
};

export const deleteProtectedBranch = async (
  repositoryId: string,
  ruleId: string,
): Promise<boolean> => {
  const deleted = await db
    .delete(gitProtectedBranches)
    .where(
      and(eq(gitProtectedBranches.id, ruleId), eq(gitProtectedBranches.repositoryId, repositoryId)),
    )
    .returning({ id: gitProtectedBranches.id });
  return deleted.length > 0;
};

/**
 * Report a status. One row per context per commit: reporting again replaces
 * the state, description and link, and keeps the row's id and `createdAt`.
 */
export const upsertCommitStatus = async (status: {
  readonly repositoryId: string;
  readonly sha: string;
  readonly context: string;
  readonly state: GitStatusState;
  readonly description?: string | null;
  readonly targetUrl?: string | null;
  readonly creatorUserId?: string | null;
  readonly ciRunId?: string | null;
}): Promise<CommitStatusRow> => {
  const now = new Date();
  const values = {
    state: status.state,
    description: status.description ?? null,
    targetUrl: status.targetUrl ?? null,
    creatorUserId: status.creatorUserId ?? null,
    ciRunId: status.ciRunId ?? null,
  };
  const [row] = await db
    .insert(gitCommitStatuses)
    .values({
      id: newId(),
      repositoryId: status.repositoryId,
      sha: status.sha,
      context: status.context,
      ...values,
    })
    .onConflictDoUpdate({
      target: [gitCommitStatuses.repositoryId, gitCommitStatuses.sha, gitCommitStatuses.context],
      set: { ...values, updatedAt: now },
    })
    .returning();
  return row!;
};

export const statusesForCommit = (repositoryId: string, sha: string): Promise<CommitStatusRow[]> =>
  db
    .select()
    .from(gitCommitStatuses)
    .where(and(eq(gitCommitStatuses.repositoryId, repositoryId), eq(gitCommitStatuses.sha, sha)))
    .orderBy(asc(gitCommitStatuses.context));

/** The combined status of each of these commits, for a history page: one query. */
export const combinedStatesFor = async (
  repositoryId: string,
  shas: readonly string[],
): Promise<Map<string, GitStatusState>> => {
  const combined = new Map<string, GitStatusState>();
  if (shas.length === 0) return combined;
  const rows = await db
    .select({ sha: gitCommitStatuses.sha, state: gitCommitStatuses.state })
    .from(gitCommitStatuses)
    .where(
      and(
        eq(gitCommitStatuses.repositoryId, repositoryId),
        inArray(gitCommitStatuses.sha, [...shas]),
      ),
    );
  const bySha = new Map<string, GitStatusState[]>();
  for (const row of rows) bySha.set(row.sha, [...(bySha.get(row.sha) ?? []), row.state]);
  for (const [sha, states] of bySha) {
    const state = combinedState(states);
    if (state !== null) combined.set(sha, state);
  }
  return combined;
};

/** Contexts reported on the repository's most recent statuses, for the required-checks picker. */
export const recentStatusContexts = async (
  repositoryId: string,
  limit = 500,
): Promise<string[]> => {
  const rows = await db
    .select({ context: gitCommitStatuses.context })
    .from(gitCommitStatuses)
    .where(eq(gitCommitStatuses.repositoryId, repositoryId))
    .orderBy(desc(gitCommitStatuses.updatedAt))
    .limit(limit);
  return [...new Set(rows.map((row) => row.context))].sort();
};
