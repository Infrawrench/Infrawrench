/**
 * Terraform workspaces of git.infrawrench.com, run on Infrawrench CI.
 *
 * A workspace's plan or apply is a `git_terraform_runs` row (the forge's
 * Worker writes it: `git/packages/worker/src/events/terraform.ts`) and, once
 * it may run, a CI run of the forge repository: an ordinary `ci_runs` row
 * with `terraformRunId` set, dispatched, queued, billed and shown like any
 * other. Three things differ, and they are all here:
 *
 * - **Its pipeline is generated, never read from the repository**
 *   (`@infrawrench/git-terraform` `workspacePipelineYaml`) and sent as the
 *   request's `pipeline`. A repository cannot edit its own apply, and a
 *   workspace's settings take effect on the next run.
 * - **It gets a job token as a run secret** (`IW_GIT_JOB_TOKEN`): scoped to
 *   the repository, `write`, minted when the run is sent and never stored.
 *   The pipeline text only ever names the secret (`${{ secrets.… }}`); the
 *   value travels in the request's `secrets`, which the runner masks. The
 *   forge's state backend takes it for this run's workspace alone.
 * - **It is lent the workspace's linked accounts**, as CI connections. The
 *   link is the grant (an admin of the repository made it, with
 *   `accounts:read` in the organisation), so these do not need the
 *   per-connection CI opt-in (`lend.ts` `linkedAccounts`).
 *
 * **The gate on an apply is the dispatch.** A run that waits for approval has
 * no CI run; `approveTerraformRun` makes one. `terraformDispatch` refuses a
 * CI run whose Terraform run may not run (waiting, skipped, replaced), so a
 * retry from the CI tab cannot go around it.
 *
 * **Its status on the commit is the workspace's**: `Infrawrench Terraform /
 * <workspace>`, written here from the run's row, with the plan's line as its
 * description. The CI run writes no `Infrawrench CI / …` status of its own
 * (`status.ts`), so it never stands in for the repository's pipelines.
 *
 * Nothing here calls plugin code, so it runs on the edge. Lending does, and
 * `dispatchRun` already leaves such runs to the gateway's pass.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  PipelineInputError,
  SERVICE_TOKEN_PURPOSE,
  pinnedRelease,
  pinnedVersions,
  planLine,
  workspacePipelineYaml,
  type PlanSummary,
} from "@infrawrench/git-terraform";

import { db } from "../db/client.js";
import {
  accounts,
  ciRuns,
  gitIssues,
  gitNamespaces,
  gitRepositories,
  gitTerraformRuns,
  gitTerraformWorkspaceAccounts,
  gitTerraformWorkspaces,
  gitTimelineEvents,
  type GitTerraformRunStatus,
  type GitTimelineEventPayload,
} from "../db/schema.js";
import type { CheckUpdate } from "./checks.js";
import { repoKey } from "./events.js";
import { GIT_SOURCE_INSTALLATION_ID, gitBaseUrl, gitOwnerKey, mintGitJobToken } from "./source.js";
import { publishGitCommitStatus, type GitCommitStatusState } from "./status.js";

export type TerraformRunRow = typeof gitTerraformRuns.$inferSelect;
type WorkspaceRow = typeof gitTerraformWorkspaces.$inferSelect;

/** The run secret a workspace's pipeline reads the job token from. */
export const TERRAFORM_JOB_TOKEN_SECRET = "IW_GIT_JOB_TOKEN";
/** What the app's own read of a workspace's state or plan is minted for (`git-terraform/`). */
export const TERRAFORM_SERVICE_PURPOSE = SERVICE_TOKEN_PURPOSE;
/** A job runs for at most an hour, after waiting for a runner. */
const JOB_TOKEN_TTL_SECONDS = 2 * 60 * 60;

export const FORK_REASON =
  "Pull requests from forks are never planned: a plan runs the fork's code with the workspace's credentials.";
export const PERSONAL_REASON =
  "Plans and applies run for an organisation's repositories. A personal namespace has the state backend only.";

/** The commit status context of a workspace: what a protected branch requires. */
export function terraformStatusContext(workspace: string): string {
  return `Infrawrench Terraform / ${workspace}`;
}

/**
 * Why a run is recorded as `skipped` instead of being queued, or null when
 * it may run. Decided when the run is recorded, from what the event says.
 */
export function terraformSkipReason(input: {
  /** The pull request's head is in another repository, or in none. */
  fromFork: boolean;
  organizationId: string | null;
}): string | null {
  if (input.fromFork) return FORK_REASON;
  if (input.organizationId === null) return PERSONAL_REASON;
  return null;
}

/**
 * How a new apply starts: at once only when the workspace applies on merge
 * and does not ask for an approval; otherwise it waits for one.
 */
export function initialApplyStatus(workspace: {
  applyOnMerge: boolean;
  autoApply: boolean;
}): "queued" | "awaiting_approval" {
  return workspace.applyOnMerge && workspace.autoApply ? "queued" : "awaiting_approval";
}

/** Why a Terraform run in this status must not be sent to the runners, or null. */
export function terraformDispatchRefusal(status: GitTerraformRunStatus): string | null {
  switch (status) {
    case "awaiting_approval":
      return "This apply waits for an approval on git.infrawrench.com.";
    case "skipped":
      return "This run was skipped and never runs.";
    case "superseded":
      return "A newer run replaced this one.";
    case "cancelled":
      return "This run was cancelled.";
    default:
      return null;
  }
}

interface Loaded {
  run: TerraformRunRow;
  workspace: WorkspaceRow;
  repository: { id: string; name: string; defaultBranch: string };
  namespace: { slug: string; organizationId: string | null };
}

async function loadRun(runId: string): Promise<Loaded | null> {
  const [row] = await db
    .select({
      run: gitTerraformRuns,
      workspace: gitTerraformWorkspaces,
      repository: {
        id: gitRepositories.id,
        name: gitRepositories.name,
        defaultBranch: gitRepositories.defaultBranch,
      },
      namespace: { slug: gitNamespaces.slug, organizationId: gitNamespaces.organizationId },
    })
    .from(gitTerraformRuns)
    .innerJoin(gitTerraformWorkspaces, eq(gitTerraformWorkspaces.id, gitTerraformRuns.workspaceId))
    .innerJoin(gitRepositories, eq(gitRepositories.id, gitTerraformRuns.repositoryId))
    .innerJoin(gitNamespaces, eq(gitNamespaces.id, gitRepositories.namespaceId))
    .where(eq(gitTerraformRuns.id, runId))
    .limit(1);
  return row ?? null;
}

const path = (...segments: string[]): string => segments.map(encodeURIComponent).join("/");

/** `https://git.infrawrench.com/<owner>/<repo>/terraform/<workspace>`: the workspace's page. */
export function terraformWorkspaceUrl(owner: string, repo: string, workspace: string): string {
  return `${gitBaseUrl()}/${path(owner, repo, "terraform", workspace)}`;
}

/** The addresses a run's pipeline is given. Never a credential. */
export function terraformRunUrls(
  owner: string,
  repo: string,
  workspace: string,
  runId: string,
): { stateUrl: string; planUrl: string } {
  const base = terraformWorkspaceUrl(owner, repo, workspace);
  return { stateUrl: `${base}/state`, planUrl: `${base}/runs/${encodeURIComponent(runId)}/plan` };
}

/** What a run's CI row and pipeline are made from: `loadRun`'s answer, or a test's. */
export interface TerraformRunPlan {
  run: Pick<
    TerraformRunRow,
    "id" | "kind" | "trigger" | "commitSha" | "branch" | "pullNumber" | "startedByUserId"
  >;
  workspace: Pick<
    WorkspaceRow,
    "name" | "rootPath" | "branch" | "product" | "toolVersion" | "variables" | "secretVariables"
  >;
  repository: { id: string; name: string; defaultBranch: string };
  namespace: { slug: string };
  organizationId: string;
  /** The linked accounts' names, as `connections:` lists them. */
  connections: readonly string[];
}

/**
 * The CI run of a Terraform run: the `ci_runs` values, with the generated
 * pipeline as `pipelineText`. Pure, and the one place the two are tied: the
 * text names secrets and never holds one. Throws `PipelineInputError` for a
 * workspace whose settings cannot be a pipeline, and for a version with no
 * pinned release.
 */
export function terraformCiRun(plan: TerraformRunPlan): typeof ciRuns.$inferInsert {
  const { run, workspace, repository, namespace } = plan;
  const release = pinnedRelease(workspace.product, workspace.toolVersion);
  if (!release) {
    throw new PipelineInputError([
      `${workspace.product} ${workspace.toolVersion ?? ""} has no pinned release here. Choose one of ${pinnedVersions(workspace.product).join(", ")}, or leave the version empty.`,
    ]);
  }
  const branch = workspace.branch ?? repository.defaultBranch;
  const pipelineText = workspacePipelineYaml({
    kind: run.kind,
    workspace: { name: workspace.name, rootPath: workspace.rootPath },
    ...terraformRunUrls(namespace.slug, repository.name, workspace.name, run.id),
    release,
    defaultBranch: branch,
    connections: plan.connections,
    variables: workspace.variables,
    secretVariables: workspace.secretVariables,
    tokenSecret: TERRAFORM_JOB_TOKEN_SECRET,
  });
  const repoFullName = `${namespace.slug}/${repository.name}`;
  const isPull = run.pullNumber !== null && run.trigger === "pull-request";
  const headRef = run.branch ?? branch;
  return {
    id: crypto.randomUUID(),
    organizationId: plan.organizationId,
    installationId: GIT_SOURCE_INSTALLATION_ID,
    gitRepositoryId: repository.id,
    repoFullName,
    ownerKey: gitOwnerKey(namespace.slug),
    repoKey: repoKey(repoFullName),
    event: isPull ? "pull-request" : run.trigger === "manual" ? "manual" : "push",
    pipelineText,
    terraformRunId: run.id,
    startedByUserId: run.startedByUserId,
    branch: isPull ? `pull/${run.pullNumber}` : headRef,
    headRef,
    defaultBranch: repository.defaultBranch,
    sha: run.commitSha,
    baseSha: null,
    pullNumber: isPull ? run.pullNumber : null,
    headRepoFullName: isPull ? repoFullName : null,
    // A fork's pull request never gets this far (`terraformSkipReason`).
    fromFork: false,
    status: "queued",
    dedupeKey: `terraform:${run.id}`,
  };
}

function clean(text: string, max = 300): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

const count = (n: number | null): number => n ?? 0;

/** A run's commit status, from its row. Null for a state that says nothing on the commit. */
export function terraformCommitStatus(
  run: Pick<
    TerraformRunRow,
    | "kind"
    | "status"
    | "error"
    | "planSummary"
    | "resourcesToAdd"
    | "resourcesToChange"
    | "resourcesToDestroy"
  >,
): { state: GitCommitStatusState; description: string } | null {
  const totals = `${count(run.resourcesToAdd)} to add, ${count(run.resourcesToChange)} to change, ${count(run.resourcesToDestroy)} to destroy`;
  const summary = run.planSummary as unknown as PlanSummary | null;
  switch (run.status) {
    case "queued":
      return { state: "pending", description: "Queued" };
    case "running":
      return {
        state: "pending",
        description:
          run.kind === "plan" ? "Planning" : summary ? `Applying: ${totals}` : "Applying",
      };
    case "planned":
      return { state: "success", description: summary ? planLine(summary) : `Plan: ${totals}.` };
    case "awaiting_approval":
      return { state: "pending", description: "Waiting for an approval to apply" };
    case "applied":
      return {
        state: "success",
        description: summary
          ? `Applied: ${count(run.resourcesToAdd)} added, ${count(run.resourcesToChange)} changed, ${count(run.resourcesToDestroy)} destroyed.`
          : "Applied.",
      };
    case "failed":
      return { state: "failure", description: clean(run.error ?? "Failed", 140) };
    case "cancelled":
      return { state: "error", description: "Cancelled" };
    // A replaced run's commit has a newer run, or is no longer the head; a
    // skipped run made no plan, and a status would say one passed or failed.
    case "superseded":
    case "skipped":
      return null;
  }
}

async function publish(loaded: Loaded): Promise<void> {
  const status = terraformCommitStatus(loaded.run);
  if (!status) return;
  try {
    await publishGitCommitStatus({
      repositoryId: loaded.repository.id,
      sha: loaded.run.commitSha,
      context: terraformStatusContext(loaded.workspace.name),
      targetUrl: terraformWorkspaceUrl(
        loaded.namespace.slug,
        loaded.repository.name,
        loaded.workspace.name,
      ),
      ...status,
    });
  } catch (err) {
    console.warn(`[terraform] could not write the status of run ${loaded.run.id}:`, err);
  }
}

type Outcome = NonNullable<GitTimelineEventPayload["terraformOutcome"]>;

/** The pull request's timeline entry for a run's result: one per run and outcome. */
async function noteOnPullRequest(loaded: Loaded, outcome: Outcome): Promise<void> {
  const { run, workspace } = loaded;
  if (run.pullNumber === null) return;
  try {
    const [issue] = await db
      .select({ id: gitIssues.id })
      .from(gitIssues)
      .where(
        and(eq(gitIssues.repositoryId, run.repositoryId), eq(gitIssues.number, run.pullNumber)),
      )
      .limit(1);
    if (!issue) return;
    const [existing] = await db
      .select({ id: gitTimelineEvents.id })
      .from(gitTimelineEvents)
      .where(
        and(
          eq(gitTimelineEvents.issueId, issue.id),
          eq(gitTimelineEvents.type, "terraform_run"),
          sql`${gitTimelineEvents.payload}->>'terraformRunId' = ${run.id}`,
          sql`${gitTimelineEvents.payload}->>'terraformOutcome' = ${outcome}`,
        ),
      )
      .limit(1);
    if (existing) return;
    await db.insert(gitTimelineEvents).values({
      id: crypto.randomUUID(),
      issueId: issue.id,
      repositoryId: run.repositoryId,
      actorUserId: null,
      type: "terraform_run",
      payload: {
        terraformRunId: run.id,
        terraformWorkspace: workspace.name,
        terraformKind: run.kind,
        terraformOutcome: outcome,
        ...(run.resourcesToAdd !== null
          ? {
              terraformAdd: run.resourcesToAdd,
              terraformChange: count(run.resourcesToChange),
              terraformDestroy: count(run.resourcesToDestroy),
            }
          : {}),
        ...(outcome === "failed" || outcome === "skipped" ? { reason: run.error } : {}),
      },
    });
  } catch (err) {
    console.warn(`[terraform] could not note run ${run.id} on its pull request:`, err);
  }
}

/** Ends a run that will never reach the runners, and says so on the commit and the pull request. */
async function settle(loaded: Loaded, status: "failed" | "skipped", reason: string): Promise<void> {
  const [row] = await db
    .update(gitTerraformRuns)
    .set({ status, error: clean(reason, 1000), finishedAt: new Date() })
    .where(
      and(
        eq(gitTerraformRuns.id, loaded.run.id),
        inArray(gitTerraformRuns.status, ["queued", "running"]),
      ),
    )
    .returning();
  if (!row) return;
  const settled = { ...loaded, run: row };
  await publish(settled);
  await noteOnPullRequest(settled, status);
}

/** Says a skipped run on its pull request. The Worker calls it after recording one. */
export async function announceSkippedTerraformRun(runId: string): Promise<void> {
  const loaded = await loadRun(runId);
  if (loaded?.run.status === "skipped") await noteOnPullRequest(loaded, "skipped");
}

/** Shows a run that waits (queued, or for an approval) on its commit. */
export async function announceTerraformRun(runId: string): Promise<void> {
  const loaded = await loadRun(runId);
  if (loaded) await publish(loaded);
}

/**
 * Starts a queued Terraform run: records its CI run and sends it. Safe to
 * call again (the CI run's dedupe key is the Terraform run), and never
 * throws for a dispatch that did not go through: the `ci` pass retries
 * those. Returns the CI run's id, or null when the run does not start.
 */
export async function startTerraformRun(runId: string): Promise<string | null> {
  const loaded = await loadRun(runId);
  if (!loaded || loaded.run.status !== "queued") return null;
  const { run, workspace, repository, namespace } = loaded;
  const organizationId = workspace.organizationId ?? namespace.organizationId;
  if (organizationId === null) {
    await settle(loaded, "skipped", PERSONAL_REASON);
    return null;
  }

  const linked = await db
    .select({ name: accounts.displayName })
    .from(gitTerraformWorkspaceAccounts)
    .innerJoin(accounts, eq(accounts.id, gitTerraformWorkspaceAccounts.accountId))
    .where(
      and(
        eq(gitTerraformWorkspaceAccounts.workspaceId, workspace.id),
        eq(accounts.organizationId, organizationId),
      ),
    );

  let values: typeof ciRuns.$inferInsert;
  try {
    values = terraformCiRun({
      run,
      workspace,
      repository,
      namespace,
      organizationId,
      connections: [...new Set(linked.map((account) => account.name))].sort(),
    });
  } catch (err) {
    if (!(err instanceof PipelineInputError)) throw err;
    await settle(loaded, "failed", err.message);
    return null;
  }

  const [inserted] = await db
    .insert(ciRuns)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: ciRuns.id });
  let ciRunId = inserted?.id ?? null;
  if (ciRunId === null) {
    const [known] = await db
      .select({ id: ciRuns.id })
      .from(ciRuns)
      .where(eq(ciRuns.dedupeKey, values.dedupeKey))
      .limit(1);
    ciRunId = known?.id ?? null;
  }
  if (ciRunId === null) return null;
  await db
    .update(gitTerraformRuns)
    .set({ ciRunId })
    .where(and(eq(gitTerraformRuns.id, run.id), eq(gitTerraformRuns.status, "queued")));
  await publish({ ...loaded, run: { ...run, ciRunId } });
  if (inserted) {
    try {
      const { dispatchRun } = await import("./runs.js");
      await dispatchRun(ciRunId);
    } catch (err) {
      console.warn(`[terraform] starting CI run ${ciRunId} failed; the poller will retry:`, err);
    }
  }
  return ciRunId;
}

/** Queued runs nothing has started yet (a dispatch that threw, a Worker cut off): the pass starts them. */
export async function startStrandedTerraformRuns(limit = 20): Promise<number> {
  const rows = await db
    .select({ id: gitTerraformRuns.id })
    .from(gitTerraformRuns)
    .where(
      and(
        eq(gitTerraformRuns.status, "queued"),
        sql`${gitTerraformRuns.ciRunId} is null`,
        sql`${gitTerraformRuns.createdAt} < now() - interval '1 minute'`,
      ),
    )
    .limit(limit);
  for (const row of rows) {
    try {
      await startTerraformRun(row.id);
    } catch (err) {
      console.warn(`[terraform] could not start run ${row.id}:`, err);
    }
  }
  return rows.length;
}

/**
 * Approves an apply that waits: it is queued, and started. Null when it was
 * not waiting any more, so two people approving make one run. Who may
 * approve is the caller's to check (a repository admin, or `ci:approve`).
 */
export async function approveTerraformRun(
  runId: string,
  userId: string | null,
): Promise<TerraformRunRow | null> {
  const [approved] = await db
    .update(gitTerraformRuns)
    .set({ status: "queued", approvedByUserId: userId, approvedAt: new Date() })
    .where(and(eq(gitTerraformRuns.id, runId), eq(gitTerraformRuns.status, "awaiting_approval")))
    .returning();
  if (!approved) return null;
  await startTerraformRun(runId);
  const [row] = await db
    .select()
    .from(gitTerraformRuns)
    .where(eq(gitTerraformRuns.id, runId))
    .limit(1);
  return row ?? approved;
}

/** What `dispatchRun` adds to a Terraform run's request, or why it must not be sent. */
export type TerraformDispatch =
  | { refuse: string }
  | {
      /** The request's `secrets`: masked by the runner, never stored. */
      secrets: Record<string, string>;
      /** Account id to who linked it: lent without the per-connection CI opt-in. */
      linkedAccounts: Map<string, string | null>;
    };

/**
 * A Terraform CI run, as it is about to be sent: the job token minted for
 * this CI run and the accounts its workspace links. Throws when a token
 * cannot be signed, which the caller retries like any other token failure.
 */
export async function terraformDispatch(row: {
  id: string;
  terraformRunId: string | null;
  gitRepositoryId: string | null;
}): Promise<TerraformDispatch> {
  if (!row.terraformRunId || !row.gitRepositoryId) {
    return { refuse: "This is not a Terraform run." };
  }
  const [run] = await db
    .select()
    .from(gitTerraformRuns)
    .where(eq(gitTerraformRuns.id, row.terraformRunId))
    .limit(1);
  if (!run || run.repositoryId !== row.gitRepositoryId) {
    return { refuse: "The Terraform run this belongs to is gone." };
  }
  const refusal = terraformDispatchRefusal(run.status);
  if (refusal) return { refuse: refusal };

  const token = await mintGitJobToken(row.gitRepositoryId, row.id, {
    access: "write",
    ttlSeconds: JOB_TOKEN_TTL_SECONDS,
  });
  // The forge checks the token against this: a retried CI run is the run's CI run now.
  if (run.ciRunId !== row.id) {
    await db
      .update(gitTerraformRuns)
      .set({ ciRunId: row.id, finishedAt: null })
      .where(eq(gitTerraformRuns.id, run.id));
  }
  const linked = await db
    .select({
      accountId: gitTerraformWorkspaceAccounts.accountId,
      addedByUserId: gitTerraformWorkspaceAccounts.addedByUserId,
    })
    .from(gitTerraformWorkspaceAccounts)
    .where(eq(gitTerraformWorkspaceAccounts.workspaceId, run.workspaceId));
  return {
    secrets: { [TERRAFORM_JOB_TOKEN_SECRET]: token },
    linkedAccounts: new Map(linked.map((l) => [l.accountId, l.addedByUserId])),
  };
}

/**
 * What a CI run's check says, applied to its Terraform run: `status.ts` hands
 * every update of a run with `terraformRunId` here instead of writing
 * `Infrawrench CI / <event>`.
 */
export async function reportTerraformCheck(
  target: { id: string; terraformRunId?: string | null | undefined },
  update: CheckUpdate,
): Promise<void> {
  if (!target.terraformRunId) return;
  const loaded = await loadRun(target.terraformRunId);
  // An older CI run of it (retried since) says nothing about it any more.
  if (!loaded || loaded.run.ciRunId !== target.id) return;
  const { run } = loaded;
  const now = new Date();
  let next: Partial<typeof gitTerraformRuns.$inferInsert> | null = null;
  let from: GitTerraformRunStatus[] = [];
  let outcome: Outcome | null = null;

  if (update.status === "in_progress") {
    from = ["queued", "failed", "cancelled"];
    next = { status: "running", startedAt: run.startedAt ?? now, error: null, finishedAt: null };
  } else if (update.status === "completed") {
    const passed = update.conclusion === "success";
    if (passed && run.kind === "apply") {
      from = ["queued", "running"];
      next = { status: "applied", finishedAt: now };
      outcome = "applied";
    } else if (passed) {
      // A plan is `planned` from the moment its document arrives.
      if (run.status === "planned") {
        next = { finishedAt: run.finishedAt ?? now };
        from = ["planned"];
      } else {
        from = ["queued", "running"];
        next = {
          status: "failed",
          error: "The job finished without posting a plan.",
          finishedAt: now,
        };
        outcome = "failed";
      }
    } else if (run.kind === "plan" && run.status === "planned") {
      // Its plan is in; what went wrong after it (clean-up, a cancel) changes nothing.
      next = { finishedAt: run.finishedAt ?? now };
      from = ["planned"];
    } else {
      from = ["queued", "running"];
      const cancelled = update.conclusion === "cancelled";
      next = {
        status: cancelled ? "cancelled" : "failed",
        error: clean([update.title, update.summary].filter(Boolean).join(": "), 1000),
        finishedAt: now,
      };
      outcome = cancelled ? null : "failed";
    }
  }
  if (!next) {
    await publish(loaded);
    return;
  }
  const [row] = await db
    .update(gitTerraformRuns)
    .set(next)
    .where(and(eq(gitTerraformRuns.id, run.id), inArray(gitTerraformRuns.status, from)))
    .returning();
  if (!row) return;
  const updated = { ...loaded, run: row };
  await publish(updated);
  if (outcome) await noteOnPullRequest(updated, outcome);
}

/**
 * Stores a plan's summary on its run, from the job that made it. `ciRunId` is
 * the job token's claim: the plan of another run, or of one that is over, is
 * refused (null). The document itself is the caller's to drop.
 */
export async function recordTerraformPlan(input: {
  runId: string;
  ciRunId: string;
  summary: PlanSummary;
}): Promise<TerraformRunRow | null> {
  const loaded = await loadRun(input.runId);
  if (!loaded || loaded.run.ciRunId !== input.ciRunId) return null;
  const { summary } = input;
  const isPlan = loaded.run.kind === "plan";
  const [row] = await db
    .update(gitTerraformRuns)
    .set({
      planSummary: summary as unknown as Record<string, unknown>,
      resourcesToAdd: summary.add,
      resourcesToChange: summary.change,
      resourcesToDestroy: summary.destroy,
      costDelta: null,
      costPricedAt: null,
      startedAt: loaded.run.startedAt ?? new Date(),
      // An apply goes on to apply this plan; a plan is done.
      status: isPlan ? "planned" : "running",
    })
    .where(
      and(
        eq(gitTerraformRuns.id, input.runId),
        inArray(gitTerraformRuns.status, ["queued", "running", "planned"]),
      ),
    )
    .returning();
  if (!row) return null;
  const updated = { ...loaded, run: row };
  await publish(updated);
  if (isPlan) await noteOnPullRequest(updated, summary.hasChanges ? "planned" : "no_changes");
  return row;
}

/**
 * Stops a run: cancelled when nothing came of it, and its CI run cancelled
 * with it. Null when it had already ended.
 */
export async function cancelTerraformRun(runId: string): Promise<TerraformRunRow | null> {
  const loaded = await loadRun(runId);
  if (!loaded) return null;
  const [row] = await db
    .update(gitTerraformRuns)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(
      and(
        eq(gitTerraformRuns.id, runId),
        inArray(gitTerraformRuns.status, ["queued", "running", "awaiting_approval"]),
      ),
    )
    .returning();
  if (!row) return null;
  const organizationId = loaded.workspace.organizationId ?? loaded.namespace.organizationId;
  if (row.ciRunId && organizationId) {
    try {
      const { cancelRun } = await import("./runs.js");
      await cancelRun(organizationId, row.ciRunId);
    } catch (err) {
      // Already over, or not there: the run's row is what the forge shows.
      console.warn(`[terraform] could not cancel CI run ${row.ciRunId}:`, err);
    }
  }
  await publish({ ...loaded, run: row });
  return row;
}
