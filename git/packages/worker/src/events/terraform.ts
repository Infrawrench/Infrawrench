/**
 * Recording that a Terraform run is wanted, and starting it: a plan for a
 * pull request's new head, an apply for a move of a workspace's branch, a run
 * someone asked for by hand.
 *
 * The row is written here; what happens to it next is server-core's
 * (`ci/terraform.ts`): a queued run becomes an Infrawrench CI run, an apply
 * that waits for approval is shown on its commit, a skipped one is noted on
 * its pull request.
 *
 * - **A fork's pull request is never planned.** A plan runs the head's code
 *   (providers, `external` data sources) with the workspace's credentials. Its
 *   run is recorded `skipped`, with the reason: not failed, and never sent.
 * - **A personal namespace has the state backend only**: nothing is recorded.
 * - **A pull request plans the workspaces it touches** (`rootsTouchedBy`):
 *   files under the root or under a module the root reaches. When the storage
 *   cannot say what changed, every workspace of the base branch is planned.
 * - **An apply waits for approval** unless the workspace applies on merge
 *   without one (`initialApplyStatus`). A newer push replaces applies of
 *   older commits that are still waiting.
 *
 * Idempotent: one run per workspace, commit, kind and pull request, however
 * often the event is delivered. A run asked for by hand is always a new one.
 */
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { discoverTerraformDirectories, rootsTouchedBy } from "@infrawrench/git-terraform";
import {
  type GitTerraformRunStatus,
  gitTerraformRuns,
  gitTerraformWorkspaces,
} from "@infrawrench/server-core/db/schema";
import { db, newId } from "../db/client";
import { type CompareInput, type RepoReader, RepoReaderError } from "../repo/reader";
import { treeReaderOf } from "../terraform/tree";

type Workspace = typeof gitTerraformWorkspaces.$inferSelect;

/** Server-core's side, which reaches most of CI: loaded when a run is first recorded. */
const terraformCi = () => import("@infrawrench/server-core/ci/terraform");

interface NewRun {
  readonly kind: "plan" | "apply";
  readonly trigger: "pull-request" | "push" | "manual";
  readonly commitSha: string;
  readonly branch: string;
  readonly pullNumber: number | null;
  readonly startedByUserId: string | null;
  readonly status: Extract<GitTerraformRunStatus, "queued" | "awaiting_approval" | "skipped">;
  /** Why it is skipped. */
  readonly reason?: string | undefined;
  /** Set when whoever asked may approve it, and so already has. */
  readonly approvedByUserId?: string | null | undefined;
}

/** Records a run. Null when this event's run exists already (a redelivery). */
const record = async (workspace: Workspace, run: NewRun): Promise<string | null> =>
  db.transaction(async (tx) => {
    // The workspace's row is the lock: two deliveries of one event record one run.
    await tx
      .select({ id: gitTerraformWorkspaces.id })
      .from(gitTerraformWorkspaces)
      .where(eq(gitTerraformWorkspaces.id, workspace.id))
      .for("update");
    if (run.trigger !== "manual") {
      const [existing] = await tx
        .select({ id: gitTerraformRuns.id })
        .from(gitTerraformRuns)
        .where(
          and(
            eq(gitTerraformRuns.workspaceId, workspace.id),
            eq(gitTerraformRuns.commitSha, run.commitSha),
            eq(gitTerraformRuns.kind, run.kind),
            ne(gitTerraformRuns.trigger, "manual"),
            run.pullNumber === null
              ? isNull(gitTerraformRuns.pullNumber)
              : eq(gitTerraformRuns.pullNumber, run.pullNumber),
          ),
        )
        .limit(1);
      if (existing) return null;
    }
    const finishedAt = new Date();
    if (run.pullNumber !== null && run.kind === "plan") {
      // A newer head's plan replaces the plans of older heads.
      await tx
        .update(gitTerraformRuns)
        .set({ status: "superseded", finishedAt })
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
    if (run.kind === "apply" && run.trigger === "push") {
      // Nobody approved the older commit's apply; the newer one stands in for it.
      await tx
        .update(gitTerraformRuns)
        .set({ status: "superseded", finishedAt })
        .where(
          and(
            eq(gitTerraformRuns.workspaceId, workspace.id),
            eq(gitTerraformRuns.kind, "apply"),
            eq(gitTerraformRuns.status, "awaiting_approval"),
            ne(gitTerraformRuns.commitSha, run.commitSha),
          ),
        );
    }
    const id = newId();
    await tx.insert(gitTerraformRuns).values({
      id,
      workspaceId: workspace.id,
      repositoryId: workspace.repositoryId,
      kind: run.kind,
      trigger: run.trigger,
      commitSha: run.commitSha,
      branch: run.branch,
      pullNumber: run.pullNumber,
      status: run.status,
      error: run.reason ?? null,
      startedByUserId: run.startedByUserId,
      ...(run.approvedByUserId
        ? { approvedByUserId: run.approvedByUserId, approvedAt: new Date() }
        : {}),
      ...(run.status === "skipped" ? { finishedAt } : {}),
    });
    return id;
  });

/** Records a run and does what its first status asks. Null for a redelivery. */
export const recordRun = async (workspace: Workspace, run: NewRun): Promise<string | null> => {
  const id = await record(workspace, run);
  if (id === null) return null;
  try {
    const ci = await terraformCi();
    if (run.status === "queued") await ci.startTerraformRun(id);
    else if (run.status === "skipped") await ci.announceSkippedTerraformRun(id);
    else await ci.announceTerraformRun(id);
  } catch (error) {
    // Recorded: a queued run that did not start is started by the app's pass.
    console.warn(`[terraform] run ${id} was recorded but not started:`, error);
  }
  return id;
};

const workspacesOf = (repositoryId: string): Promise<Workspace[]> =>
  db
    .select()
    .from(gitTerraformWorkspaces)
    .where(eq(gitTerraformWorkspaces.repositoryId, repositoryId));

/** The most files of a comparison that are read to decide what it touches. */
const MAX_CHANGED_FILES = 2000;

/**
 * The roots a comparison touches, or null when that cannot be said (the
 * storage does not answer, or the change is larger than is read): the caller
 * then plans every workspace.
 */
export const touchedRoots = async (
  reader: RepoReader,
  comparison: CompareInput,
  rootPaths: readonly string[],
): Promise<Set<string> | null> => {
  try {
    const changed: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await reader.compareDiff(comparison, { limit: 100, cursor, context: 0 });
      for (const file of page.files) {
        changed.push(file.path);
        if (file.oldPath !== null) changed.push(file.oldPath);
      }
      cursor = page.nextCursor ?? undefined;
      if (changed.length > MAX_CHANGED_FILES) return null;
    } while (cursor !== undefined);
    const { directories, truncated } = await discoverTerraformDirectories(
      treeReaderOf(reader, comparison.head),
    );
    if (truncated) return null;
    return rootsTouchedBy(rootPaths, changed, directories);
  } catch (error) {
    if (error instanceof RepoReaderError) return null;
    throw error;
  }
};

/** A pull request has a new head: a plan per workspace it touches that plans pull requests into `baseRef`. */
export const queuePullRequestPlans = async (input: {
  readonly repositoryId: string;
  /** The base repository's organisation; null for a personal namespace. */
  readonly organizationId: string | null;
  readonly defaultBranch: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly headOid: string;
  readonly pullNumber: number;
  readonly userId: string | null;
  /** The head is in another repository, or in none. */
  readonly fromFork: boolean;
  /** The base repository's reader, to see what the pull request changes. */
  readonly reader?: RepoReader | undefined;
  /** The head's repository, when it is not the base (a fork). */
  readonly headRepositoryId?: string | undefined;
}): Promise<number> => {
  if (input.organizationId === null) return 0;
  const workspaces = (await workspacesOf(input.repositoryId)).filter(
    (workspace) =>
      workspace.planOnPullRequest && (workspace.branch ?? input.defaultBranch) === input.baseRef,
  );
  if (workspaces.length === 0) return 0;
  const { terraformSkipReason } = await terraformCi();
  const reason = terraformSkipReason({
    fromFork: input.fromFork,
    organizationId: input.organizationId,
  });
  // A fork's change is not read either: every workspace says it was skipped.
  const touched =
    reason === null && input.reader
      ? await touchedRoots(
          input.reader,
          { base: input.baseRef, head: input.headOid, headRepositoryId: input.headRepositoryId },
          workspaces.map((workspace) => workspace.rootPath),
        )
      : null;
  let queued = 0;
  for (const workspace of workspaces) {
    if (touched !== null && !touched.has(workspace.rootPath)) continue;
    const added = await recordRun(workspace, {
      kind: "plan",
      trigger: "pull-request",
      commitSha: input.headOid,
      branch: input.headRef,
      pullNumber: input.pullNumber,
      startedByUserId: input.userId,
      status: reason === null ? "queued" : "skipped",
      reason: reason ?? undefined,
    });
    if (added !== null) queued++;
  }
  return queued;
};

/** A workspace's branch moved: an apply per workspace on it. */
export const queueMergeApplies = async (input: {
  readonly repositoryId: string;
  readonly organizationId: string | null;
  readonly defaultBranch: string;
  readonly branch: string;
  readonly oid: string;
  readonly userId: string | null;
}): Promise<number> => {
  if (input.organizationId === null) return 0;
  const { initialApplyStatus } = await terraformCi();
  let queued = 0;
  for (const workspace of await workspacesOf(input.repositoryId)) {
    if ((workspace.branch ?? input.defaultBranch) !== input.branch) continue;
    const added = await recordRun(workspace, {
      kind: "apply",
      trigger: "push",
      commitSha: input.oid,
      branch: input.branch,
      pullNumber: null,
      startedByUserId: input.userId,
      status: initialApplyStatus(workspace),
    });
    if (added !== null) queued++;
  }
  return queued;
};
