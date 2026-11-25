/**
 * Recording that a Terraform run is wanted: a plan for a pull request's new
 * head, an apply for a merge into a workspace's branch. Only the queued
 * `git_terraform_runs` row is written here; dispatching it to CI is a later
 * step, which reads these rows.
 *
 * Idempotent: one run per workspace, commit, kind and pull request, however
 * often the event is delivered.
 */
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { gitTerraformRuns, gitTerraformWorkspaces } from "@infrawrench/server-core/db/schema";
import { db, newId } from "../db/client";

type Workspace = typeof gitTerraformWorkspaces.$inferSelect;

const queue = async (
  workspace: Workspace,
  run: {
    readonly kind: "plan" | "apply";
    readonly trigger: "pull-request" | "push";
    readonly commitSha: string;
    readonly branch: string;
    readonly pullNumber: number | null;
    readonly startedByUserId: string | null;
  },
): Promise<boolean> =>
  db.transaction(async (tx) => {
    // The workspace's row is the lock: two deliveries of one event queue one run.
    await tx
      .select({ id: gitTerraformWorkspaces.id })
      .from(gitTerraformWorkspaces)
      .where(eq(gitTerraformWorkspaces.id, workspace.id))
      .for("update");
    const [existing] = await tx
      .select({ id: gitTerraformRuns.id })
      .from(gitTerraformRuns)
      .where(
        and(
          eq(gitTerraformRuns.workspaceId, workspace.id),
          eq(gitTerraformRuns.commitSha, run.commitSha),
          eq(gitTerraformRuns.kind, run.kind),
          run.pullNumber === null
            ? isNull(gitTerraformRuns.pullNumber)
            : eq(gitTerraformRuns.pullNumber, run.pullNumber),
        ),
      )
      .limit(1);
    if (existing) return false;
    if (run.pullNumber !== null) {
      // A newer head's plan replaces the plans of older heads nobody applied.
      await tx
        .update(gitTerraformRuns)
        .set({ status: "superseded", finishedAt: new Date() })
        .where(
          and(
            eq(gitTerraformRuns.workspaceId, workspace.id),
            eq(gitTerraformRuns.pullNumber, run.pullNumber),
            eq(gitTerraformRuns.kind, "plan"),
            inArray(gitTerraformRuns.status, ["queued", "planned"]),
            ne(gitTerraformRuns.commitSha, run.commitSha),
          ),
        );
    }
    await tx.insert(gitTerraformRuns).values({
      id: newId(),
      workspaceId: workspace.id,
      repositoryId: workspace.repositoryId,
      kind: run.kind,
      trigger: run.trigger,
      commitSha: run.commitSha,
      branch: run.branch,
      pullNumber: run.pullNumber,
      status: "queued",
      startedByUserId: run.startedByUserId,
    });
    return true;
  });

const workspacesOf = (repositoryId: string): Promise<Workspace[]> =>
  db
    .select()
    .from(gitTerraformWorkspaces)
    .where(eq(gitTerraformWorkspaces.repositoryId, repositoryId));

/** A pull request has a new head: a plan per workspace that plans pull requests into `baseRef`. */
export const queuePullRequestPlans = async (input: {
  readonly repositoryId: string;
  readonly defaultBranch: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly headOid: string;
  readonly pullNumber: number;
  readonly userId: string | null;
}): Promise<number> => {
  let queued = 0;
  for (const workspace of await workspacesOf(input.repositoryId)) {
    if (!workspace.planOnPullRequest) continue;
    if ((workspace.branch ?? input.defaultBranch) !== input.baseRef) continue;
    const added = await queue(workspace, {
      kind: "plan",
      trigger: "pull-request",
      commitSha: input.headOid,
      branch: input.headRef,
      pullNumber: input.pullNumber,
      startedByUserId: input.userId,
    });
    if (added) queued++;
  }
  return queued;
};

/** A workspace's branch moved: an apply per workspace that applies on merge. */
export const queueMergeApplies = async (input: {
  readonly repositoryId: string;
  readonly defaultBranch: string;
  readonly branch: string;
  readonly oid: string;
  readonly userId: string | null;
}): Promise<number> => {
  let queued = 0;
  for (const workspace of await workspacesOf(input.repositoryId)) {
    if (!workspace.applyOnMerge) continue;
    if ((workspace.branch ?? input.defaultBranch) !== input.branch) continue;
    const added = await queue(workspace, {
      kind: "apply",
      trigger: "push",
      commitSha: input.oid,
      branch: input.branch,
      pullNumber: null,
      startedByUserId: input.userId,
    });
    if (added) queued++;
  }
  return queued;
};
