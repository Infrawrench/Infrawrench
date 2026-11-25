/**
 * What runs on a repository's commits: commit statuses, Infrawrench CI's runs
 * (read here, driven from the app) and Terraform workspaces.
 */
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  type CiRun,
  type TerraformRun,
  type TerraformRunStatus,
  type TerraformWorkspace,
  GitApi,
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
  type PlanSummary,
  type TreeReader,
  discoverTerraformRoots,
  isWorkspaceName,
} from "@infrawrench/git-terraform";
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
  ciKnownPipelines,
  ciRetriesOf,
  ciSwitchedOff,
  clearWorkspaceLock,
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
import { combinedState, statusesForCommit, upsertCommitStatus } from "../../db/policy";
import { userByUsername } from "../../db/users";
import { appOrigin, siteOrigin } from "../../env";
import { RepoReaderError } from "../../repo/reader";
import { RepoRef, type RepoCx, inScope, repoOp } from "../context";
import { statusViews } from "../views/pulls";
import { iso, isoOrNull, peopleById, toUserRef } from "../views/repositories";

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

/** The app's CI, which reaches most of server-core: loaded when a run's output is first asked for. */
const appCi = () => import("@infrawrench/server-core/ci/runs");

const ciRunViews = async (cx: RepoCx, rows: readonly CiRunRow[]): Promise<CiRun[]> => {
  const { owner } = cx.repo;
  const logins = [...new Set(rows.flatMap((row) => (row.actorLogin ? [row.actorLogin] : [])))];
  const [retries, actors, titles] = await Promise.all([
    ciRetriesOf(rows.map((row) => row.id)),
    Promise.all(logins.map(async (login) => [login, await userByUsername(login)] as const)),
    cx.git
      .commits([...new Set(rows.map((row) => row.sha).filter((sha) => OID.test(sha)))])
      .catch((error: unknown) => {
        // Without the storage a run simply has no title.
        if (error instanceof RepoReaderError) return [];
        throw error;
      }),
  ]);
  const actorOf = new Map(actors);
  const titleOf = new Map(titles.map((commit) => [commit.oid, commit.summary]));
  return rows.map((row) => ({
    id: row.id,
    event: row.event,
    headRef: row.headRef,
    sha: row.sha,
    pullNumber: row.pullNumber,
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
    appUrl: owner.organizationId
      ? `${appOrigin(cx.env)}/org/${owner.organizationId}/ci/${row.id}`
      : null,
  }));
};

const ciRunOr404 = async (cx: RepoCx, runId: string): Promise<CiRunRow> => {
  const row = await getCiRun(cx.repo.repository.id, runId);
  if (!row) throw notFound("No such run");
  return row;
};

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

export const CiHandlers = HttpApiBuilder.group(GitApi, "ci", (handlers) =>
  handlers
    .handle(
      "status",
      repoOp(async (cx) => {
        const { repository, owner } = cx.repo;
        const reason =
          owner.organizationId === null
            ? "CI runs for an organisation's repositories"
            : (await ciSwitchedOff(repository.id))
              ? "CI is switched off for this repository"
              : !(await planAccess(owner.organizationId)).paid
                ? "CI needs a paid plan"
                : null;
        return { enabled: reason === null, pipelines: await pipelinesOf(cx), reason };
      }),
    )
    .handle(
      "listRuns",
      repoOp(async (cx, { query }) => {
        const found = await listCiRuns(cx.repo.repository.id, query);
        return { items: await ciRunViews(cx, found.items), nextCursor: found.nextCursor };
      }),
    )
    .handle(
      "getRun",
      repoOp(async (cx, { params }) => {
        const row = await ciRunOr404(cx, params.runId);
        const [run] = await ciRunViews(cx, [row]);
        let jobs: Awaited<ReturnType<Awaited<ReturnType<typeof appCi>>["getRun"]>>["jobs"] = null;
        try {
          jobs = (await (await appCi()).getRun(row.organizationId, row.id)).jobs;
        } catch (error) {
          // The run is ours to show even when the runners' store cannot be read.
          console.warn(`[git] could not read the output of CI run ${row.id}:`, error);
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
              stdout: job.stdout,
              stderr: job.stderr,
            })) ?? null,
        };
      }),
    )
    .handleRaw("runLog", ({ params }) =>
      Effect.gen(function* () {
        const state = yield* RepoRef;
        const body = yield* inScope(async () => {
          const row = state ? await getCiRun(state.found.repository.id, params.runId) : null;
          if (!row) throw notFound("No such run");
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

const RUN_STATUS: Record<GitTerraformRunStatus, TerraformRunStatus> = {
  queued: "queued",
  running: "planning",
  planned: "planned",
  awaiting_approval: "awaiting_approval",
  applied: "applied",
  failed: "errored",
  cancelled: "cancelled",
  superseded: "discarded",
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

const TRIGGERS = { "pull-request": "pull_request", push: "merge", manual: "manual" } as const;

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

/** Whether the caller may see what things cost in the organisation that owns the repository. */
const seesCosts = async (cx: RepoCx): Promise<boolean> => {
  const organizationId = cx.repo.owner.organizationId;
  if (organizationId === null || cx.principal.kind !== "user" || cx.principal.via !== "session") {
    return false;
  }
  const membership = (await cx.viewer()).organizations.find(
    (organization) => organization.id === organizationId,
  );
  return membership !== undefined && hasPermission(membership.permissions, "costs:read");
};

const runViews = async (
  cx: RepoCx,
  rows: readonly TerraformRunRow[],
  workspaces: ReadonlyMap<string, WorkspaceRow>,
): Promise<TerraformRun[]> => {
  const [person, costs] = await Promise.all([
    peopleById(rows.flatMap((row) => [row.startedByUserId, row.approvedByUserId])),
    seesCosts(cx),
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
      pullNumber: row.pullNumber,
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
  const [accounts, lastRuns, states] = await Promise.all([
    workspaceAccounts(ids),
    lastRunsOf(ids),
    stateVersionsById(rows.flatMap((row) => row.currentStateVersionId ?? [])),
  ]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const runs = await runViews(cx, [...lastRuns.values()], byId);
  const runOf = new Map(runs.map((run) => [run.workspace.id, run]));
  const holders = await peopleById(rows.map((row) => row.lockedBy));
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
        planOnPullRequest: row.planOnPullRequest,
        applyOnMerge: row.applyOnMerge,
        applyRequiresApproval: !row.autoApply,
        accounts: (accounts.get(row.id) ?? []).map((account) => ({
          ...account,
          pluginName: account.pluginId,
        })),
        stateAddress: `${siteOrigin(cx.env)}${terraformStatePath(
          { owner: owner.slug, repo: repository.name },
          row.name,
        )}`,
        lock:
          row.lockId !== null
            ? {
                id: row.lockId,
                operation: row.lockInfo?.Operation ?? null,
                who: row.lockInfo?.Who ?? null,
                holder: holders(row.lockedBy),
                runId: null,
                createdAt: iso(row.lockedAt ?? row.updatedAt),
              }
            : null,
        currentState: currentState ?? null,
        resourceCount: state?.resourceCount ?? 0,
        // The app's cost and drift for what a workspace manages are not read here yet.
        monthlyCost: null,
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
  readonly planOnPullRequest?: boolean | undefined;
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
  if (payload.planOnPullRequest !== undefined)
    settings.planOnPullRequest = payload.planOnPullRequest;
  if (payload.applyOnMerge !== undefined) settings.applyOnMerge = payload.applyOnMerge;
  if (payload.applyRequiresApproval !== undefined) {
    settings.autoApply = !payload.applyRequiresApproval;
  }
  return settings;
};

/** A workspace's accounts must be the owning organisation's, and the caller's to use in the app. */
const checkAccounts = async (cx: RepoCx, accountIds: readonly string[]): Promise<void> => {
  if (accountIds.length === 0) return;
  const organizationId = cx.repo.owner.organizationId;
  if (organizationId === null) {
    throw unprocessable("Only an organisation's repository can use connected accounts");
  }
  const membership = (await cx.viewer()).organizations.find(
    (organization) => organization.id === organizationId,
  );
  if (!membership || !hasPermission(membership.permissions, "accounts:read")) {
    throw forbidden("Connecting accounts needs accounts:read in the organisation");
  }
  const known = await accountsOfOrganization(organizationId, accountIds);
  if (accountIds.some((id) => !known.has(id))) {
    throw unprocessable("One of those accounts is not this organisation's");
  }
};

const normalRoot = (rootPath: string): string => {
  const path = rootPath.replace(/^\/+|\/+$/g, "");
  if (path.split("/").some((segment) => segment === ".." || segment === ".")) {
    throw badRequest("The directory is a path inside the repository");
  }
  return path;
};

/** The repository's tree at a ref, as Terraform root discovery reads it. */
const treeReader = (cx: RepoCx, ref: string): TreeReader => ({
  list: async (path) => {
    try {
      const listing = await cx.git.tree({ ref, path, lastCommits: false });
      return listing.entries.map((entry) => ({
        name: entry.name,
        kind: entry.type === "tree" ? ("directory" as const) : ("file" as const),
      }));
    } catch (error) {
      if (error instanceof RepoReaderError && error.code !== "unavailable") return [];
      throw error;
    }
  },
  read: async (path) => {
    try {
      const blob = await cx.git.blob({ ref, path });
      return blob.text === null ? null : new TextEncoder().encode(blob.text);
    } catch (error) {
      if (error instanceof RepoReaderError && error.code !== "unavailable") return null;
      throw error;
    }
  },
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
      "listRoots",
      repoOp(async (cx, { query }) => {
        // Resolved once, so the walk reads one commit however long it takes.
        const { commitOid } = await cx.git.resolveRef(query.ref);
        const [{ roots }, workspaces] = await Promise.all([
          discoverTerraformRoots(treeReader(cx, commitOid)),
          listWorkspaces(cx.repo.repository.id),
        ]);
        return {
          roots: roots.map((root) => ({
            path: root.path,
            workspaces: workspaces
              .filter((workspace) => workspace.rootPath === root.path)
              .map((workspace) => workspace.name),
            backend: root.backend,
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
        if (payload.accountIds !== undefined) await checkAccounts(cx, payload.accountIds);
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
        if (!(await deleteWorkspace(workspace.id))) {
          throw unprocessable("Something holds this workspace's lock", "terraform_locked");
        }
        return ok;
      }),
    )
    .handle(
      "forceUnlock",
      repoOp(async (cx, { params }) => {
        await clearWorkspaceLock((await workspaceOr404(cx, params.workspace)).id);
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
        const found = await listTerraformRuns(cx.repo.repository.id, {
          ...runFilter(query.status),
          workspaceId: workspace?.id,
          pull: query.pull,
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
        // Approved, it is queued again: whatever dispatches runs applies it.
        const approved = await moveTerraformRun(run.id, ["awaiting_approval"], "queued", {
          approvedByUserId: cx.userId,
          approvedAt: new Date(),
        });
        if (!approved) throw conflict("This run is not waiting for approval");
        return (await runViews(cx, [approved], await workspacesById(cx)))[0]!;
      }),
    )
    .handle(
      "discardRun",
      repoOp(async (cx, { params }) => {
        const run = await getTerraformRun(cx.repo.repository.id, params.runId);
        if (!run) throw notFound("No such run");
        const finishedAt = new Date();
        const discarded =
          (await moveTerraformRun(run.id, ["queued"], "cancelled", { finishedAt })) ??
          (await moveTerraformRun(run.id, ["planned", "awaiting_approval"], "superseded", {
            finishedAt,
          }));
        if (!discarded) throw conflict("This run has already started or finished");
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
    .handle(
      "listResources",
      repoOp(async (cx, { params, query }) => {
        const workspace = await workspaceOr404(cx, params.workspace);
        const found = await listManagedResources(workspace.id, {
          q: query.q,
          matched: query.matched === undefined ? undefined : query.matched === "true",
          cursor: query.cursor,
          limit: query.limit,
        });
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
              name: resource.label ?? parts.slice(typeAt + 1).join(".") ?? "",
              module: module.length > 0 ? module.join(".") : null,
              provider: resource.provider ?? "",
              providerId: null,
              infrawrench: matched
                ? {
                    resourceId: matched.id,
                    name: matched.displayName,
                    pluginId: matched.pluginId,
                    resourceTypeId: matched.resourceTypeId,
                    appUrl: `${appOrigin(cx.env)}/org/${resource.organizationId}/resources/${encodeURIComponent(matched.id)}`,
                  }
                : null,
              monthlyCost: null,
              drift: null,
            };
          }),
          nextCursor: found.nextCursor,
        };
      }),
    ),
);
