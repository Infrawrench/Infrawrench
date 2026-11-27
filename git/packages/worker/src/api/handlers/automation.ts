/**
 * What runs on a repository's commits: commit statuses, Infrawrench CI's runs
 * (read here, driven from the app) and Terraform workspaces.
 */
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  type CiBlockedCode,
  type CiRun,
  type TerraformRun,
  type TerraformRunStatus,
  type TerraformWorkspace,
  GitApi,
  PaymentRequired,
  accessAtLeast,
  badRequest,
  conflict,
  forbidden,
  isValidRefName,
  notFound,
  ok,
  terraformStatePath,
  unprocessable,
} from "@infrawrench/git-contract";
import {
  type ConfigurationEstimate,
  type PlanSummary,
  isWorkspaceName,
  rootsTouchedBy,
} from "@infrawrench/git-terraform";
import { setCiGitRepository } from "@infrawrench/server-core/ci/git-repositories";
import type { GitTerraformRunStatus } from "@infrawrench/server-core/db/schema";
import { planAccess } from "@infrawrench/server-core/entitlements";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import {
  type CiRunRow,
  type StateVersionRow,
  type TerraformRunRow,
  type WorkspaceRow,
  type WorkspaceSettings,
  accountsOfOrganization,
  allAccountsOfOrganization,
  ciKnownPipelines,
  ciRetriesOf,
  ciSwitchedOff,
  createWorkspace,
  deleteWorkspace,
  getCiRun,
  getTerraformRun,
  getWorkspace,
  lastRunsOf,
  listCiRuns,
  listManagedResources,
  listStateVersions,
  listTerraformRuns,
  listWorkspaces,
  moveTerraformRun,
  stateVersionsById,
  updateWorkspace,
  workspaceAccounts,
} from "../../db/automation";
import { pageKeysByNumber, pageNumberOf, resolveBranchKey } from "../../db/branch-pages";
import { combinedState, statusesForCommit, upsertCommitStatus } from "../../db/policy";
import { runsInOrganization } from "../../db/repositories";
import { userByUsername } from "../../db/users";
import { hasAccess } from "../../auth/access";
import { appOrigin, siteOrigin } from "../../env";
import { changedPaths, recordRun } from "../../events/terraform";
import { RepoReaderError } from "../../repo/reader";
import { principalName } from "../../terraform/access";
import { type StateClientFactory, stateClient } from "../../terraform/client";
import { recordStateHead } from "../../terraform/directory-db";
import { type ScanRow, scanAt, summaryOf } from "../../terraform/scan";
import {
  type ScanRowView,
  rootChangeView,
  rootsPlannedAtHead,
  scanView,
} from "../../terraform/scan-views";
import { RepoRef, type RepoCx, inScope, repoOp } from "../context";
import { statusViews } from "../views/branch-pages";
import { iso, isoOrNull, peopleById, toUserRef } from "../views/repositories";
import { describeError } from "../../http/log";

const OID = /^[0-9a-f]{40}$/;

export const StatusesHandlers = HttpApiBuilder.group(GitApi, "statuses", (handlers) =>
  handlers
    .handle(
      "forRef",
      repoOp(async (cx, { query }) => {
        // A full commit id needs no storage to name its statuses.
        const sha =
          query.ref !== undefined && OID.test(query.ref)
            ? query.ref
            : (await cx.git.resolveRef(query.ref)).commitOid;
        const rows = await statusesForCommit(cx.repo.repository.id, sha);
        return {
          sha,
          state: combinedState(rows.map((row) => row.state)),
          statuses: await statusViews(rows),
        };
      }),
    )
    .handle(
      "create",
      repoOp(async (cx, { params, payload }) => {
        const sha = params.sha.toLowerCase();
        if (!OID.test(sha)) throw unprocessable("A status is reported on a full commit id");
        if ((await cx.git.commits([sha])).length === 0) {
          throw unprocessable("This repository has no such commit", "ref_not_found");
        }
        if (payload.targetUrl != null && !/^https?:\/\//i.test(payload.targetUrl)) {
          throw badRequest("The link must be an http or https URL");
        }
        const row = await upsertCommitStatus({
          repositoryId: cx.repo.repository.id,
          sha,
          context: payload.context,
          state: payload.state,
          description: payload.description ?? null,
          targetUrl: payload.targetUrl ?? null,
          creatorUserId: cx.userId,
        });
        const [view] = await statusViews([row]);
        return view!;
      }),
    ),
);

// ---------------------------------------------------------------------------
// CI
// ---------------------------------------------------------------------------

/** The keys of the pages runs are of, by the thread number a run records. */
const pageKeysOf = (
  cx: RepoCx,
  rows: ReadonlyArray<{ readonly pullNumber: number | null }>,
): Promise<Map<number, string>> =>
  pageKeysByNumber(
    cx.repo.repository.id,
    rows.flatMap((row) => (row.pullNumber === null ? [] : [row.pullNumber])),
  );

/**
 * A `page=<key>` filter as the thread number runs record: undefined when no
 * page was asked for, null for a key that names no page (nothing matches).
 */
const pageFilter = async (
  cx: RepoCx,
  key: string | undefined,
): Promise<number | null | undefined> =>
  key === undefined ? undefined : pageNumberOf(cx.repo.repository.id, key);

/** The app's CI, which reaches most of server-core: loaded when a run's output is first asked for. */
const appCi = () => import("@infrawrench/server-core/ci/runs");

const ciRunViews = async (cx: RepoCx, rows: readonly CiRunRow[]): Promise<CiRun[]> => {
  const { owner } = cx.repo;
  const logins = [...new Set(rows.flatMap((row) => (row.actorLogin ? [row.actorLogin] : [])))];
  const [retries, actors, titles, pages] = await Promise.all([
    ciRetriesOf(rows.map((row) => row.id)),
    Promise.all(logins.map(async (login) => [login, await userByUsername(login)] as const)),
    cx.git
      .commits([...new Set(rows.map((row) => row.sha).filter((sha) => OID.test(sha)))])
      .catch((error: unknown) => {
        // Without the storage a run simply has no title.
        if (error instanceof RepoReaderError) return [];
        throw error;
      }),
    pageKeysOf(cx, rows),
  ]);
  const actorOf = new Map(actors);
  const titleOf = new Map(titles.map((commit) => [commit.oid, commit.summary]));
  return rows.map((row) => ({
    id: row.id,
    event: row.event,
    headRef: row.headRef,
    sha: row.sha,
    branchPage: row.pullNumber === null ? null : (pages.get(row.pullNumber) ?? null),
    fromFork: row.fromFork,
    actor: row.actorLogin ? toUserRef(actorOf.get(row.actorLogin)) : null,
    status: row.status,
    statusReason: row.statusReason,
    createdAt: iso(row.createdAt),
    startedAt: isoOrNull(row.startedAt),
    finishedAt: isoOrNull(row.finishedAt),
    jobs: (row.jobs as CiRun["jobs"]) ?? null,
    ...(row.pipelineFile !== null ? { pipelineFile: row.pipelineFile } : {}),
    retryOfRunId: row.retryOfRunId,
    retriedAsRunId: retries.get(row.id) ?? null,
    ...(row.cancelRequestedAt !== null && row.status === "running"
      ? { cancelRequested: true }
      : {}),
    commitTitle: titleOf.get(row.sha) ?? null,
    appUrl: `${appOrigin(cx.env)}/org/${row.organizationId}/ci/${row.id}`,
  }));
};

const ciRunOr404 = async (cx: RepoCx, runId: string): Promise<CiRunRow> => {
  const row = await getCiRun(cx.repo.repository.id, runsInOrganization(cx.repo.owner), runId);
  if (!row) throw notFound("No such run");
  return row;
};

/**
 * Whether a run's output is kept from this caller. Terraform prints the
 * attribute values of a plan and an apply that are not marked sensitive, and
 * a CI run is read with `read`, which on a public repository is everyone: a
 * workspace run's output takes `write`. Its jobs and their results stay
 * visible.
 */
const terraformOutputWithheld = (
  row: Pick<CiRunRow, "terraformRunId">,
  access: RepoCx["access"],
): boolean => row.terraformRunId !== null && !accessAtLeast(access, "write");

const pipelinesOf = async (cx: RepoCx): Promise<Array<{ file: string; name: string }>> => {
  const known = await ciKnownPipelines(cx.repo.repository.id);
  if (known.length > 0) return known;
  try {
    const listing = await cx.git.tree({
      ref: undefined,
      path: ".infrawrench/ci",
      lastCommits: false,
    });
    return listing.entries
      .filter((entry) => entry.type === "blob" && /\.ya?ml$/.test(entry.name))
      .map((entry) => ({ file: entry.path, name: entry.name.replace(/\.ya?ml$/, "") }));
  } catch (error) {
    // No such directory, an empty repository, or no storage: no pipelines to name.
    if (error instanceof RepoReaderError) return [];
    throw error;
  }
};

const CI_NEEDS_ORGANISATION =
  "CI runs in an organisation. Choose one for your own repositories in Settings > Profile";

const CI_NEEDS_PLAN = "Infrawrench CI is part of Pro";

/**
 * A page of the app for the organisation the repository runs in, for a
 * caller who is a member of it. Nobody else is told which organisation.
 */
const orgAppUrl = async (cx: RepoCx, page: string): Promise<string | null> => {
  const organizationId = runsInOrganization(cx.repo.owner);
  if (organizationId === null || cx.principal.kind !== "user") return null;
  const member = (await cx.viewer()).organizations.some(({ id }) => id === organizationId);
  return member ? `${appOrigin(cx.env)}/org/${organizationId}/${page}` : null;
};

/** CI in the app: where the organisation's secrets, variables and approvals are. */
const ciAppUrl = (cx: RepoCx): Promise<string | null> => orgAppUrl(cx, "ci");

/**
 * Why CI does not run for the repository, or null when it does. The plan is
 * asked before the switch: on the free plan the switch decides nothing.
 */
const ciBlocked = async (cx: RepoCx): Promise<CiBlockedCode | null> => {
  const organizationId = runsInOrganization(cx.repo.owner);
  if (organizationId === null) return "needs_organisation";
  if (!(await planAccess(organizationId)).paid) return "plan_required";
  return (await ciSwitchedOff(cx.repo.repository.id)) ? "switched_off" : null;
};

const CI_BLOCKED_REASONS: Readonly<Record<CiBlockedCode, string>> = {
  needs_organisation: CI_NEEDS_ORGANISATION,
  plan_required: CI_NEEDS_PLAN,
  switched_off: "CI is switched off for this repository",
};

export const CiHandlers = HttpApiBuilder.group(GitApi, "ci", (handlers) =>
  handlers
    .handle(
      "status",
      repoOp(async (cx) => {
        const code = await ciBlocked(cx);
        return {
          enabled: code === null,
          pipelines: await pipelinesOf(cx),
          reason: code === null ? null : CI_BLOCKED_REASONS[code],
          code,
          upgradeUrl: code === "plan_required" ? await orgAppUrl(cx, "settings/billing") : null,
        };
      }),
    )
    .handle(
      "settings",
      repoOp(async (cx) => ({
        enabled: !(await ciSwitchedOff(cx.repo.repository.id)),
        available: runsInOrganization(cx.repo.owner) !== null,
        appUrl: await ciAppUrl(cx),
      })),
    )
    .handle(
      "updateSettings",
      repoOp(async (cx, { payload }) => {
        const { repository, owner } = cx.repo;
        const organizationId = runsInOrganization(owner);
        if (organizationId === null) {
          throw unprocessable(CI_NEEDS_ORGANISATION, "ci_unavailable");
        }
        // Switching it off never asks: an organisation whose plan ended can still stop.
        if (payload.enabled && !(await planAccess(organizationId)).paid) {
          throw new PaymentRequired({ error: CI_NEEDS_PLAN, code: "plan_required" });
        }
        const saved = await setCiGitRepository(
          {
            id: repository.id,
            namespace: owner.slug,
            name: repository.name,
            defaultBranch: repository.defaultBranch,
            organizationId,
          },
          payload.enabled,
          cx.userId,
        );
        return { enabled: saved.ciEnabled, available: true, appUrl: await ciAppUrl(cx) };
      }),
    )
    .handle(
      "listRuns",
      repoOp(async (cx, { query }) => {
        const { page, ...rest } = query;
        const pull = await pageFilter(cx, page);
        if (pull === null) return { items: [], nextCursor: null };
        const found = await listCiRuns(cx.repo.repository.id, runsInOrganization(cx.repo.owner), {
          ...rest,
          pull,
        });
        return { items: await ciRunViews(cx, found.items), nextCursor: found.nextCursor };
      }),
    )
    .handle(
      "getRun",
      repoOp(async (cx, { params }) => {
        const row = await ciRunOr404(cx, params.runId);
        const [run] = await ciRunViews(cx, [row]);
        const withheld = terraformOutputWithheld(row, cx.access);
        let jobs: Awaited<ReturnType<Awaited<ReturnType<typeof appCi>>["getRun"]>>["jobs"] = null;
        try {
          jobs = (await (await appCi()).getRun(row.organizationId, row.id)).jobs;
        } catch (error) {
          // The run is ours to show even when the runners' store cannot be read.
          console.warn(
            `[git] could not read the output of CI run ${row.id}: ${describeError(error)}`,
          );
        }
        return {
          run: run!,
          jobs:
            jobs?.map((job) => ({
              pipeline: job.pipeline,
              id: job.id,
              name: job.name,
              status: job.status,
              reason: job.reason,
              durationMs: job.durationMs,
              ...(job.needs ? { needs: job.needs } : {}),
              stdout: withheld ? "" : job.stdout,
              stderr: withheld ? "" : job.stderr,
            })) ?? null,
        };
      }),
    )
    .handleRaw("runLog", ({ params }) =>
      Effect.gen(function* () {
        const state = yield* RepoRef;
        const body = yield* inScope(async () => {
          const row = state
            ? await getCiRun(
                state.found.repository.id,
                runsInOrganization(state.found.owner),
                params.runId,
              )
            : null;
          if (!row) throw notFound("No such run");
          if (state && terraformOutputWithheld(row, state.access)) {
            throw forbidden("A Terraform run's output takes write access to the repository");
          }
          const abort = new AbortController();
          const upstream = await (
            await appCi()
          ).openRunLogs(row.organizationId, row.id, abort.signal);
          const reader = upstream.getReader();
          return new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const { done, value } = await reader.read();
                if (done) controller.close();
                else controller.enqueue(value);
              } catch {
                controller.close();
              }
            },
            cancel() {
              abort.abort();
              return reader.cancel().catch(() => {});
            },
          });
        });
        return HttpServerResponse.raw(
          new Response(body, {
            headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
          }),
        );
      }),
    ),
);

// ---------------------------------------------------------------------------
// Terraform
// ---------------------------------------------------------------------------

/** Server-core's side of Terraform runs, which reaches CI: loaded when a run is first acted on. */
const terraformCi = () => import("@infrawrench/server-core/ci/terraform");
/** What the app knows about what a workspace manages: links and cost. */
const terraformManaged = () => import("@infrawrench/server-core/git-terraform/managed");

let stateClients: StateClientFactory = stateClient;

/** Replaces how a workspace's Durable Object is reached, for tests; `null` restores the default. */
export const setStateClientFactory = (factory: StateClientFactory | null): void => {
  stateClients = factory ?? stateClient;
};

const RUN_STATUS: Record<GitTerraformRunStatus, TerraformRunStatus> = {
  queued: "queued",
  running: "planning",
  planned: "planned",
  awaiting_approval: "awaiting_approval",
  applied: "applied",
  failed: "errored",
  cancelled: "cancelled",
  superseded: "discarded",
  skipped: "skipped",
};

const runStatus = (row: TerraformRunRow): TerraformRunStatus => {
  if (row.status === "running") return row.kind === "apply" ? "applying" : "planning";
  if (row.status === "planned" && row.planSummary?.["hasChanges"] === false) return "no_changes";
  return RUN_STATUS[row.status];
};

/** The filter a contract status is, in the rows' own terms. */
const runFilter = (status: TerraformRunStatus | undefined) => {
  switch (status) {
    case undefined:
      return {};
    case "planning":
      return { statuses: ["running"] as const, kind: "plan" as const };
    case "applying":
      return { statuses: ["running"] as const, kind: "apply" as const };
    case "planned":
      return { statuses: ["planned"] as const, hasChanges: true };
    case "no_changes":
      return { statuses: ["planned"] as const, hasChanges: false };
    case "errored":
      return { statuses: ["failed"] as const };
    case "discarded":
      return { statuses: ["superseded"] as const };
    default:
      return { statuses: [status] as const };
  }
};

/** A run's trigger on the wire: a branch page's plan is `branch` (stored `pull-request`). */
const TRIGGERS = { "pull-request": "branch", push: "merge", manual: "manual" } as const;

const planOf = (stored: Record<string, unknown> | null): TerraformRun["plan"] => {
  if (!stored || !Array.isArray(stored["resources"])) return null;
  // Written by `@infrawrench/git-terraform`'s `summarizePlan`, and by nothing else.
  const plan = stored as unknown as PlanSummary;
  return {
    add: plan.add,
    change: plan.change,
    destroy: plan.destroy,
    replace: plan.counts.replace,
    import: plan.counts.import,
    hasChanges: plan.hasChanges,
    resourceChanges: plan.resources.map((change) => ({
      address: change.address,
      type: change.type,
      name: change.name,
      module: change.moduleAddress,
      provider: change.provider ?? "",
      action: change.action,
      changedAttributes: change.attributes.map((attribute) => attribute.name),
    })),
    resourceChangesTruncated: plan.resourcesOmitted > 0,
    outputChanges: plan.outputs.filter((output) => output.action !== "no-op").length,
  };
};

/**
 * Whether a viewer's organisations give `permission` in `organizationId`: the
 * app's rule for its own data (accounts, resources, costs). Reading the
 * repository is not enough: a public repository is read by everyone.
 */
export const holdsInOrganization = (
  organizations: ReadonlyArray<{ readonly id: string; readonly permissions: readonly string[] }>,
  organizationId: string | null,
  permission: string,
): boolean => {
  if (organizationId === null) return false;
  const membership = organizations.find((organization) => organization.id === organizationId);
  return membership !== undefined && hasPermission(membership.permissions, permission);
};

/** Whether the caller holds `permission` in the organisation that owns the repository. */
const holdsInOwner = async (cx: RepoCx, permission: string): Promise<boolean> =>
  cx.principal.kind === "user" &&
  holdsInOrganization((await cx.viewer()).organizations, cx.repo.owner.organizationId, permission);

/** Whether the caller may see what things cost in the organisation that owns the repository. */
const seesCosts = async (cx: RepoCx): Promise<boolean> =>
  cx.principal.kind === "user" &&
  cx.principal.via === "session" &&
  (await holdsInOwner(cx, "costs:read"));

/**
 * Who holds a workspace's lock, as the person when it is one. `lockedBy` is
 * a principal string (`user:<id>`, `ci:<run id>`, ...); only a person is named.
 */
export const lockHolderUserId = (lockedBy: string | null): string | null =>
  lockedBy?.startsWith("user:") ? lockedBy.slice("user:".length) || null : null;

/**
 * Whether the caller may approve an apply: a signed-in person who is an
 * admin of the repository, or has `ci:approve` in the organisation that owns
 * it. A personal access token never approves: it is capped below `admin`,
 * and its scopes say nothing about the organisation's CI.
 */
const mayApprove = async (cx: RepoCx): Promise<boolean> => {
  if (cx.principal.kind !== "user" || cx.principal.via !== "session") return false;
  if (hasAccess(cx.access, "admin")) return true;
  return holdsInOwner(cx, "ci:approve");
};

/** The cost reader's viewer: the person, when they may see costs at all. */
const costViewer = async (cx: RepoCx): Promise<{ userId: string } | null> =>
  cx.userId !== null && (await seesCosts(cx)) ? { userId: cx.userId } : null;

const runViews = async (
  cx: RepoCx,
  rows: readonly TerraformRunRow[],
  workspaces: ReadonlyMap<string, WorkspaceRow>,
): Promise<TerraformRun[]> => {
  const waiting = rows.some((row) => row.status === "awaiting_approval");
  const [person, costs, approver, pages] = await Promise.all([
    peopleById(rows.flatMap((row) => [row.startedByUserId, row.approvedByUserId])),
    seesCosts(cx),
    waiting ? mayApprove(cx) : Promise.resolve(false),
    pageKeysOf(cx, rows),
  ]);
  return rows.map((row) => {
    const cost = row.costDelta;
    return {
      id: row.id,
      workspace: { id: row.workspaceId, name: workspaces.get(row.workspaceId)?.name ?? "" },
      operation: row.kind,
      trigger: TRIGGERS[row.trigger],
      status: runStatus(row),
      statusReason: row.error,
      commitOid: row.commitSha,
      ref: row.branch ?? "",
      branchPage: row.pullNumber === null ? null : (pages.get(row.pullNumber) ?? null),
      actor: person(row.startedByUserId),
      approvedBy: person(row.approvedByUserId),
      createdAt: iso(row.createdAt),
      startedAt: isoOrNull(row.startedAt),
      finishedAt: isoOrNull(row.finishedAt),
      plan: planOf(row.planSummary),
      costDelta:
        costs && cost && cost.monthlyDelta !== null && cost.currency !== null
          ? {
              currency: cost.currency,
              monthlyBefore: null,
              monthlyAfter: null,
              monthlyDelta: cost.monthlyDelta,
              unpriced: cost.unpricedChanges,
              lines: [],
            }
          : null,
      ciRunId: row.ciRunId,
      stateVersionId: null,
      ...(row.status === "awaiting_approval" ? { viewerCanApprove: approver } : {}),
    };
  });
};

const stateVersionViews = async (rows: readonly StateVersionRow[], currentId: string | null) => {
  const person = await peopleById(rows.map((row) => row.createdByUserId));
  return rows.map((row) => ({
    id: row.id,
    serial: row.serial,
    lineage: row.lineage,
    sha256: row.sha256,
    sizeBytes: row.size,
    resourceCount: row.resourceCount,
    terraformVersion: row.terraformVersion,
    createdAt: iso(row.createdAt),
    createdBy: person(row.createdByUserId),
    runId: row.runId,
    current: row.id === currentId,
  }));
};

const workspaceViews = async (
  cx: RepoCx,
  rows: readonly WorkspaceRow[],
): Promise<TerraformWorkspace[]> => {
  const { repository, owner } = cx.repo;
  const ids = rows.map((row) => row.id);
  const organizationId = owner.organizationId;
  const [accounts, lastRuns, states, managed] = await Promise.all([
    workspaceAccounts(ids),
    lastRunsOf(ids),
    stateVersionsById(rows.flatMap((row) => row.currentStateVersionId ?? [])),
    organizationId === null || ids.length === 0
      ? null
      : (async () =>
          (await terraformManaged()).managedResourceCosts(
            organizationId,
            ids,
            await costViewer(cx),
          ))(),
  ]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const runs = await runViews(cx, [...lastRuns.values()], byId);
  const runOf = new Map(runs.map((run) => [run.workspace.id, run]));
  const holders = await peopleById(rows.map((row) => lockHolderUserId(row.lockedBy)));
  // The organisation's connected accounts are the app's to show (`accounts:read`), and what
  // Terraform says of a lock is for those who may take or break it, not every reader of a
  // public repository.
  const seesAccounts = await holdsInOwner(cx, "accounts:read");
  const seesLock = accessAtLeast(cx.access, "write");
  return Promise.all(
    rows.map(async (row) => {
      const state = row.currentStateVersionId ? states.get(row.currentStateVersionId) : undefined;
      const [currentState] = state ? await stateVersionViews([state], state.id) : [];
      return {
        id: row.id,
        name: row.name,
        rootPath: row.rootPath,
        branch: row.branch ?? repository.defaultBranch,
        terraformVersion: row.toolVersion,
        planOnBranch: row.planOnPullRequest,
        applyOnMerge: row.applyOnMerge,
        applyRequiresApproval: !row.autoApply,
        accounts: seesAccounts
          ? (accounts.get(row.id) ?? []).map((account) => ({
              ...account,
              pluginName: account.pluginId,
            }))
          : [],
        stateAddress: `${siteOrigin(cx.env)}${terraformStatePath(
          { owner: owner.slug, repo: repository.name },
          row.name,
        )}`,
        lock:
          row.lockId !== null
            ? {
                id: seesLock ? row.lockId : "",
                operation: row.lockInfo?.Operation ?? null,
                who: seesLock ? (row.lockInfo?.Who ?? null) : null,
                holder: holders(lockHolderUserId(row.lockedBy)),
                runId: null,
                createdAt: iso(row.lockedAt ?? row.updatedAt),
              }
            : null,
        currentState: currentState ?? null,
        resourceCount: state?.resourceCount ?? 0,
        // Through the app's cost visibility: only what this viewer may see is in it.
        monthlyCost: managed?.byWorkspaceId.get(row.id) ?? null,
        matchedResourceCount: managed?.matchedByWorkspaceId.get(row.id) ?? 0,
        // The app's drift for what a workspace manages is not read here yet.
        driftedCount: null,
        lastRun: runOf.get(row.id) ?? null,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      };
    }),
  );
};

const workspaceOr404 = async (cx: RepoCx, name: string): Promise<WorkspaceRow> => {
  const workspace = await getWorkspace(cx.repo.repository.id, name);
  if (!workspace) throw notFound("No such workspace");
  return workspace;
};

const workspaceView = async (cx: RepoCx, row: WorkspaceRow) =>
  (await workspaceViews(cx, [row]))[0]!;

/** The settings a payload names, checked. */
const workspaceSettings = (payload: {
  readonly name?: string | undefined;
  readonly branch?: string | undefined;
  readonly terraformVersion?: string | null | undefined;
  readonly planOnBranch?: boolean | undefined;
  readonly applyOnMerge?: boolean | undefined;
  readonly applyRequiresApproval?: boolean | undefined;
}): WorkspaceSettings => {
  const settings: WorkspaceSettings = {};
  if (payload.name !== undefined) {
    if (!isWorkspaceName(payload.name)) {
      throw badRequest("A workspace name is lowercase letters, digits, dashes and underscores");
    }
    settings.name = payload.name;
  }
  if (payload.branch !== undefined) {
    if (!isValidRefName(payload.branch)) throw badRequest("That is not a valid branch name");
    settings.branch = payload.branch;
  }
  if (payload.terraformVersion !== undefined) {
    if (
      payload.terraformVersion !== null &&
      !/^[0-9A-Za-z.~<>=!, -]{1,64}$/.test(payload.terraformVersion)
    ) {
      throw badRequest("That is not a version or a version constraint");
    }
    settings.toolVersion = payload.terraformVersion;
  }
  if (payload.planOnBranch !== undefined) settings.planOnPullRequest = payload.planOnBranch;
  if (payload.applyOnMerge !== undefined) settings.applyOnMerge = payload.applyOnMerge;
  if (payload.applyRequiresApproval !== undefined) {
    settings.autoApply = !payload.applyRequiresApproval;
  }
  return settings;
};

/**
 * Lending a connected account's credentials to runs is the app's CI access
 * decision, `ci-access:write` there (`setConnectionAccess`): seeing accounts
 * (`accounts:read`, every member) is not enough to hand them to a workspace.
 */
export const LEND_ACCOUNTS_PERMISSION = "ci-access:write";

/**
 * A workspace's accounts must be the owning organisation's, and the caller
 * must be allowed to lend them. Checked whenever a payload names the accounts
 * and they change, so a list of none (removing them all) is checked as well.
 */
const checkAccounts = async (
  cx: RepoCx,
  accountIds: readonly string[],
  current: readonly string[] = [],
): Promise<void> => {
  const same =
    accountIds.length === current.length && accountIds.every((id) => current.includes(id));
  if (same) return;
  const organizationId = cx.repo.owner.organizationId;
  if (organizationId === null) {
    throw unprocessable("Only an organisation's repository can use connected accounts");
  }
  if (!(await holdsInOwner(cx, LEND_ACCOUNTS_PERMISSION))) {
    throw forbidden(
      `Lending accounts to a workspace needs ${LEND_ACCOUNTS_PERMISSION} in the organisation`,
    );
  }
  if (accountIds.length === 0) return;
  const known = await accountsOfOrganization(organizationId, accountIds);
  if (accountIds.some((id) => !known.has(id))) {
    throw unprocessable("One of those accounts is not this organisation's");
  }
};

/**
 * A root directory as the run pipeline accepts it (`git-terraform`'s
 * `validRootPath`): letters, digits, `.`, `_`, `-` and `/`, no empty, `.` or
 * `..` segment. Refused here rather than at the first run.
 */
export const normalRoot = (rootPath: string): string => {
  const path = rootPath.replace(/^\/+|\/+$/g, "");
  if (path === "") return path;
  if (
    !/^[A-Za-z0-9._/-]+$/.test(path) ||
    path.split("/").some((segment) => segment === "" || segment === ".." || segment === ".")
  ) {
    throw badRequest("The directory is a path inside the repository");
  }
  return path;
};

/** A scan row as the views read it. */
const rowView = (row: ScanRow): ScanRowView => ({
  commitOid: row.commitOid,
  summary: summaryOf(row),
  estimates: row.estimates as unknown as Record<string, ConfigurationEstimate> | null,
  pricingStatus: row.pricingStatus,
  pricedAt: row.pricedAt,
  createdAt: row.createdAt,
});

const workspacesById = async (cx: RepoCx) =>
  new Map((await listWorkspaces(cx.repo.repository.id)).map((row) => [row.id, row]));

export const TerraformHandlers = HttpApiBuilder.group(GitApi, "terraform", (handlers) =>
  handlers
    .handle(
      "listWorkspaces",
      repoOp(async (cx) => ({
        workspaces: await workspaceViews(cx, await listWorkspaces(cx.repo.repository.id)),
      })),
    )
    .handle(
      "scan",
      repoOp(async (cx, { query }) => {
        // Resolved once, so the scan reads one commit however long it takes.
        const { commitOid } = await cx.git.resolveRef(query.ref);
        const [row, workspaces] = await Promise.all([
          scanAt({ reader: cx.git, repositoryId: cx.repo.repository.id }, commitOid),
          listWorkspaces(cx.repo.repository.id),
        ]);
        return scanView(rowView(row), commitOid, workspaces);
      }),
    )
    .handle(
      "configurationChange",
      repoOp(async (cx, { query }) => {
        const repositoryId = cx.repo.repository.id;
        const page = await resolveBranchKey(repositoryId, query.page);
        if (!page) throw notFound("No such branch page");
        const { pull, thread } = page;
        const headRepositoryId =
          pull.headRepositoryId !== null && pull.headRepositoryId !== repositoryId
            ? pull.headRepositoryId
            : undefined;
        const baseOid =
          pull.mergeBaseOid ??
          (await cx.git.compare({ base: pull.baseRef, head: pull.headOid, headRepositoryId }))
            .mergeBaseOid;
        const scanner = { reader: cx.git, repositoryId };
        const [head, base, changed, workspaces, runs] = await Promise.all([
          scanAt(scanner, pull.headOid),
          baseOid === null ? Promise.resolve(null) : scanAt(scanner, baseOid),
          changedPaths(cx.git, {
            base: baseOid ?? pull.baseRef,
            head: pull.headOid,
            headRepositoryId,
          }),
          listWorkspaces(repositoryId),
          listTerraformRuns(repositoryId, { pull: thread.number, kind: "plan", limit: 100 }),
        ]);
        const headSummary = summaryOf(head);
        const paths = [
          ...new Set([
            ...headSummary.roots.map((root) => root.path),
            ...(base === null ? [] : summaryOf(base).roots.map((root) => root.path)),
          ]),
        ];
        // When what changed cannot be read, every root is shown: one estimate too
        // many costs a line, one too few hides a change.
        const touched =
          changed === null
            ? new Set(paths)
            : rootsTouchedBy(paths, changed, headSummary.directories);
        const planned = rootsPlannedAtHead(
          workspaces,
          runs.items.map((run) => ({
            workspaceId: run.workspaceId,
            commitSha: run.commitSha,
            pullNumber: run.pullNumber,
            hasPlan: run.planSummary !== null,
          })),
          { number: thread.number, headOid: pull.headOid },
        );
        const headView = rowView(head);
        const baseView = base === null ? null : rowView(base);
        return {
          baseOid,
          headOid: pull.headOid,
          roots: paths
            .filter((path) => touched.has(path) && !planned.has(path))
            .sort()
            .map((path) => rootChangeView(path, baseView, headView, workspaces)),
        };
      }),
    )
    .handle(
      "listAccounts",
      repoOp(async (cx) => {
        const organizationId = cx.repo.owner.organizationId;
        // The picker lists what the caller could see in the app: a person
        // with `accounts:read` there. Everyone else gets nothing to pick.
        if (organizationId === null || cx.principal.kind !== "user") return { accounts: [] };
        const membership = (await cx.viewer()).organizations.find(
          (organization) => organization.id === organizationId,
        );
        if (!membership || !hasPermission(membership.permissions, "accounts:read")) {
          return { accounts: [] };
        }
        return {
          accounts: (await allAccountsOfOrganization(organizationId)).map((account) => ({
            ...account,
            pluginName: account.pluginId,
          })),
        };
      }),
    )
    .handle(
      "createWorkspace",
      repoOp(async (cx, { payload }) => {
        const settings = workspaceSettings(payload);
        const accountIds = payload.accountIds ?? [];
        await checkAccounts(cx, accountIds);
        const workspace = await createWorkspace({
          repositoryId: cx.repo.repository.id,
          organizationId: cx.repo.owner.organizationId,
          name: payload.name,
          rootPath: normalRoot(payload.rootPath),
          settings,
          accountIds,
          createdByUserId: cx.userId,
        });
        if (!workspace) throw conflict("A workspace with that name exists", "name_taken");
        return workspaceView(cx, workspace);
      }),
    )
    .handle(
      "getWorkspace",
      repoOp(async (cx, { params }) =>
        workspaceView(cx, await workspaceOr404(cx, params.workspace)),
      ),
    )
    .handle(
      "updateWorkspace",
      repoOp(async (cx, { params, payload }) => {
        const workspace = await workspaceOr404(cx, params.workspace);
        const settings = workspaceSettings(payload);
        if (payload.accountIds !== undefined) {
          const current = (await workspaceAccounts([workspace.id])).get(workspace.id) ?? [];
          await checkAccounts(
            cx,
            payload.accountIds,
            current.map((account) => account.accountId),
          );
        }
        if (settings.name !== undefined && settings.name !== workspace.name && workspace.lockId) {
          throw unprocessable("A locked workspace cannot be renamed", "terraform_locked");
        }
        const updated = await updateWorkspace(
          workspace.id,
          settings,
          payload.accountIds,
          cx.userId,
        );
        if (!updated) throw conflict("A workspace with that name exists", "name_taken");
        return workspaceView(cx, updated);
      }),
    )
    .handle(
      "deleteWorkspace",
      repoOp(async (cx, { params }) => {
        const workspace = await workspaceOr404(cx, params.workspace);
        // The object is the truth about the lock; the row may trail it.
        const head = await stateClients(cx.env, workspace.id).head();
        if (head.lock) {
          await recordStateHead(workspace.id, head, null);
          throw unprocessable("Something holds this workspace's lock", "terraform_locked");
        }
        if (!(await deleteWorkspace(workspace.id))) {
          throw unprocessable("Something holds this workspace's lock", "terraform_locked");
        }
        return ok;
      }),
    )
    .handle(
      "forceUnlock",
      repoOp(async (cx, { params }) => {
        const workspace = await workspaceOr404(cx, params.workspace);
        const head = await stateClients(cx.env, workspace.id).forceUnlock();
        await recordStateHead(workspace.id, head, null);
        return ok;
      }),
    )
    .handle(
      "listRuns",
      repoOp(async (cx, { query }) => {
        const workspaces = await workspacesById(cx);
        const workspace =
          query.workspace === undefined
            ? undefined
            : [...workspaces.values()].find((row) => row.name === query.workspace);
        if (query.workspace !== undefined && !workspace) return { items: [], nextCursor: null };
        const pull = await pageFilter(cx, query.page);
        if (pull === null) return { items: [], nextCursor: null };
        const found = await listTerraformRuns(cx.repo.repository.id, {
          ...runFilter(query.status),
          workspaceId: workspace?.id,
          pull,
          cursor: query.cursor,
          limit: query.limit,
        });
        return {
          items: await runViews(cx, found.items, workspaces),
          nextCursor: found.nextCursor,
        };
      }),
    )
    .handle(
      "getRun",
      repoOp(async (cx, { params }) => {
        const run = await getTerraformRun(cx.repo.repository.id, params.runId);
        if (!run) throw notFound("No such run");
        return (await runViews(cx, [run], await workspacesById(cx)))[0]!;
      }),
    )
    .handle(
      "approveRun",
      repoOp(async (cx, { params }) => {
        const run = await getTerraformRun(cx.repo.repository.id, params.runId);
        if (!run) throw notFound("No such run");
        if (!(await mayApprove(cx))) {
          throw forbidden(
            "Approving an apply takes admin access to the repository, or ci:approve in its organisation",
          );
        }
        // Approved, it is queued and sent to Infrawrench CI.
        const approved = await (await terraformCi()).approveTerraformRun(run.id, cx.userId);
        if (!approved) throw conflict("This run is not waiting for approval");
        return (await runViews(cx, [approved], await workspacesById(cx)))[0]!;
      }),
    )
    .handle(
      "createRun",
      repoOp(async (cx, { params, payload }) => {
        const workspace = await workspaceOr404(cx, params.workspace);
        const { repository, owner } = cx.repo;
        if (owner.organizationId === null) {
          throw unprocessable(
            "Plans and applies run for an organisation's repositories. A personal namespace has the state backend only.",
            "terraform_unavailable",
          );
        }
        const branch = workspace.branch ?? repository.defaultBranch;
        const ref = payload.ref ?? branch;
        let commitOid: string;
        let branchOid: string | null = null;
        try {
          commitOid = (await cx.git.resolveRef(ref)).commitOid;
          if (payload.operation === "apply") {
            branchOid = (await cx.git.getBranch(branch))?.commit.oid ?? null;
          }
        } catch (error) {
          if (error instanceof RepoReaderError && error.code === "ref_not_found") {
            throw unprocessable("There is no such branch or commit", "ref_not_found");
          }
          throw error;
        }
        if (payload.operation === "apply" && commitOid !== branchOid) {
          throw unprocessable(`An apply runs on the head of ${branch}, the workspace's branch`);
        }
        const approver = payload.operation === "apply" && (await mayApprove(cx));
        const id = await recordRun(workspace, {
          kind: payload.operation,
          trigger: "manual",
          commitSha: commitOid,
          // An apply is of the workspace's branch, whatever name its head was asked for by.
          branch: payload.operation === "apply" || OID.test(ref) ? branch : ref,
          pullNumber: null,
          startedByUserId: cx.userId,
          // Whoever may approve an apply has, by asking for it.
          status: payload.operation === "plan" || approver ? "queued" : "awaiting_approval",
          approvedByUserId: approver ? cx.userId : null,
        });
        const run = id ? await getTerraformRun(repository.id, id) : null;
        if (!run) throw notFound("No such run");
        return (await runViews(cx, [run], await workspacesById(cx)))[0]!;
      }),
    )
    .handle(
      "discardRun",
      repoOp(async (cx, { params }) => {
        const run = await getTerraformRun(cx.repo.repository.id, params.runId);
        if (!run) throw notFound("No such run");
        // A plan nobody applied is discarded; anything still going is stopped, its CI run with it.
        const discarded =
          (await moveTerraformRun(run.id, ["planned"], "superseded", {
            finishedAt: new Date(),
          })) ?? (await (await terraformCi()).cancelTerraformRun(run.id));
        if (!discarded) throw conflict("This run has already finished");
        return (await runViews(cx, [discarded], await workspacesById(cx)))[0]!;
      }),
    )
    .handle(
      "listStateVersions",
      repoOp(async (cx, { params, query }) => {
        const workspace = await workspaceOr404(cx, params.workspace);
        const found = await listStateVersions(workspace.id, query);
        return {
          items: await stateVersionViews(found.items, workspace.currentStateVersionId),
          nextCursor: found.nextCursor,
        };
      }),
    )
    .handleRaw("downloadStateVersion", ({ params }) =>
      Effect.gen(function* () {
        const state = yield* RepoRef;
        const response = yield* inScope(async (inv) => {
          const workspace = state
            ? await getWorkspace(state.found.repository.id, params.workspace)
            : null;
          if (!workspace) throw notFound("No such workspace");
          const version = (await stateVersionsById([params.versionId])).get(params.versionId);
          if (!version || version.workspaceId !== workspace.id) {
            throw notFound("No such state version");
          }
          const stored = await stateClients(inv.env, workspace.id).readVersion(version.id);
          if (!stored) throw notFound("No such state version");
          return new Response(stored.body, {
            headers: {
              "content-type": "application/json",
              "content-disposition": `attachment; filename="${workspace.name}-${version.serial}.tfstate"`,
              "cache-control": "private, no-store",
            },
          });
        });
        return HttpServerResponse.raw(response);
      }),
    )
    .handle(
      "restoreStateVersion",
      repoOp(async (cx, { params }) => {
        const workspace = await workspaceOr404(cx, params.workspace);
        const version = (await stateVersionsById([params.versionId])).get(params.versionId);
        if (!version || version.workspaceId !== workspace.id) {
          throw notFound("No such state version");
        }
        const actor = principalName(cx.principal) ?? "unknown";
        const outcome = await stateClients(cx.env, workspace.id).restore(version.id, actor);
        switch (outcome.kind) {
          case "not-found":
            throw notFound("No such state version");
          case "locked":
            throw unprocessable("Something holds this workspace's lock", "terraform_locked");
          case "busy":
            throw conflict("The state changed while it was being restored. Try again.");
          case "invalid":
            throw unprocessable(outcome.reason);
          case "restored":
            break;
        }
        await recordStateHead(workspace.id, outcome.head, cx.principal, actor);
        const written = outcome.head.written;
        const row = written ? (await stateVersionsById([written.id])).get(written.id) : undefined;
        if (!row) throw notFound("No such state version");
        return (await stateVersionViews([row], row.id))[0]!;
      }),
    )
    .handle(
      "listResources",
      repoOp(async (cx, { params, query }) => {
        const workspace = await workspaceOr404(cx, params.workspace);
        // Which of the organisation's resources an address is (their ids, names and the
        // organisation itself) is the app's to show (`resources:read`); what the state calls
        // an instance is for those who may write here. A public repository is read by anyone.
        const seesResources = await holdsInOwner(cx, "resources:read");
        const seesLabels = accessAtLeast(cx.access, "write");
        const matchedFilter = query.matched === undefined ? undefined : query.matched === "true";
        // Without the match, nothing is matched: the filter must not answer it either.
        if (!seesResources && matchedFilter === true) return { items: [], nextCursor: null };
        const found = await listManagedResources(workspace.id, {
          q: query.q,
          matched: seesResources ? matchedFilter : undefined,
          cursor: query.cursor,
          limit: query.limit,
        });
        const organizationId = cx.repo.owner.organizationId;
        const viewer = organizationId === null ? null : await costViewer(cx);
        const costs =
          organizationId !== null && viewer !== null
            ? (
                await (
                  await terraformManaged()
                ).managedResourceCosts(organizationId, [workspace.id], viewer)
              ).byResourceId
            : null;
        return {
          items: found.items.map(({ resource, matched }) => {
            // `module.a.module.b.aws_s3_bucket.logs`, `data.aws_ami.base`.
            const parts = resource.address.split(".");
            const typeAt = parts.lastIndexOf(resource.terraformType);
            const module =
              typeAt > 0 ? parts.slice(0, typeAt).filter((part) => part !== "data") : [];
            return {
              address: resource.address,
              mode: parts[typeAt - 1] === "data" ? ("data" as const) : ("managed" as const),
              type: resource.terraformType,
              name: (seesLabels ? resource.label : null) ?? parts.slice(typeAt + 1).join("."),
              module: module.length > 0 ? module.join(".") : null,
              provider: resource.provider ?? "",
              providerId: null,
              infrawrench:
                matched && seesResources
                  ? {
                      resourceId: matched.id,
                      name: matched.displayName,
                      pluginId: matched.pluginId,
                      resourceTypeId: matched.resourceTypeId,
                      appUrl: `${appOrigin(cx.env)}/org/${resource.organizationId}/resources/${encodeURIComponent(matched.id)}`,
                    }
                  : null,
              monthlyCost: (matched && seesResources && costs?.get(matched.id)) || null,
              drift: null,
            };
          }),
          nextCursor: found.nextCursor,
        };
      }),
    ),
);
