import {
  badRequest,
  conflict,
  defineMockHandlers,
  mockError,
  notFound,
  ok,
  paginate,
  unprocessable,
} from "../define";
import { accessTo, findRepository, gitOf, requireUser, type RepositoryRecord } from "../db";
import { resolveRef } from "../git";
import { hoursAgo, newId } from "../settings-data";
import {
  ACCOUNTS,
  findWorkspace,
  restoreVersion,
  rootsOf,
  stateDocument,
  terraformOf,
  toRun,
  toWorkspace,
  type WorkspaceRecord,
} from "../terraform-data";

const origin = (): string => window.location.origin;

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function accountsFor(ids: ReadonlyArray<string>) {
  return ids.map((id) => {
    const account = ACCOUNTS.find((item) => item.accountId === id);
    if (!account) throw unprocessable("That account is not one you can use");
    return account;
  });
}

function checkName(repo: RepositoryRecord, name: string, except?: WorkspaceRecord): void {
  if (!NAME.test(name)) throw badRequest("Use lowercase letters, digits, dashes and underscores");
  const clash = terraformOf(repo).workspaces.some(
    (item) => item !== except && item.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) throw conflict("A workspace with that name exists", "name_taken");
}

function findRun(repo: RepositoryRecord, runId: string) {
  const run = terraformOf(repo).runs.find((item) => item.id === runId);
  if (!run) throw notFound("Run not found");
  return run;
}

export default defineMockHandlers({
  terraform: {
    listWorkspaces: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      return {
        workspaces: terraformOf(repo)
          .workspaces.map((item) => toWorkspace(repo, item, origin()))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
    listRoots: ({ params, query }) => {
      const repo = findRepository(params.owner, params.repo);
      return { roots: rootsOf(repo, query?.ref) };
    },
    listAccounts: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      // A personal namespace has no organisation whose accounts it could link.
      return { accounts: repo.owner.kind === "org" ? ACCOUNTS : [] };
    },
    createWorkspace: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      requireUser();
      checkName(repo, payload.name);
      const now = new Date().toISOString();
      const item: WorkspaceRecord = {
        id: newId("ws"),
        name: payload.name,
        rootPath: payload.rootPath,
        branch: payload.branch ?? null,
        terraformVersion: payload.terraformVersion ?? null,
        planOnPullRequest: payload.planOnPullRequest ?? true,
        applyOnMerge: payload.applyOnMerge ?? true,
        applyRequiresApproval: payload.applyRequiresApproval ?? false,
        accounts: accountsFor(payload.accountIds ?? []),
        lock: null,
        versions: [],
        resources: [],
        drifted: null,
        createdAt: now,
        updatedAt: now,
      };
      terraformOf(repo).workspaces.push(item);
      repo.hasTerraform = true;
      return toWorkspace(repo, item, origin());
    },
    getWorkspace: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      return toWorkspace(repo, findWorkspace(repo, params.workspace), origin());
    },
    updateWorkspace: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      const item = findWorkspace(repo, params.workspace);
      if (payload.name !== undefined && payload.name !== item.name) {
        checkName(repo, payload.name, item);
        for (const run of terraformOf(repo).runs) {
          if (run.workspace.id === item.id) run.workspace = { id: item.id, name: payload.name };
        }
        item.name = payload.name;
      }
      if (payload.branch !== undefined) item.branch = payload.branch;
      if (payload.terraformVersion !== undefined) item.terraformVersion = payload.terraformVersion;
      if (payload.planOnPullRequest !== undefined)
        item.planOnPullRequest = payload.planOnPullRequest;
      if (payload.applyOnMerge !== undefined) item.applyOnMerge = payload.applyOnMerge;
      if (payload.applyRequiresApproval !== undefined) {
        item.applyRequiresApproval = payload.applyRequiresApproval;
      }
      if (payload.accountIds !== undefined) item.accounts = accountsFor(payload.accountIds);
      item.updatedAt = new Date().toISOString();
      return toWorkspace(repo, item, origin());
    },
    deleteWorkspace: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      const item = findWorkspace(repo, params.workspace);
      if (item.lock !== null) {
        throw unprocessable("The state is locked. Unlock it first.", "terraform_locked");
      }
      const store = terraformOf(repo);
      store.workspaces.splice(store.workspaces.indexOf(item), 1);
      store.runs = store.runs.filter((run) => run.workspace.id !== item.id);
      repo.hasTerraform = store.workspaces.length > 0;
      return ok;
    },
    forceUnlock: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      findWorkspace(repo, params.workspace).lock = null;
      return ok;
    },
    listRuns: ({ params, query }) => {
      const repo = findRepository(params.owner, params.repo);
      const runs = terraformOf(repo)
        .runs.filter(
          (run) =>
            (query?.workspace === undefined || run.workspace.name === query.workspace) &&
            (query?.pull === undefined || run.pullNumber === query.pull) &&
            (query?.status === undefined || run.status === query.status),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const page = paginate(runs, query);
      return { ...page, items: page.items.map((run) => toRun(repo, run)) };
    },
    getRun: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      return toRun(repo, findRun(repo, params.runId));
    },
    createRun: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      const actor = requireUser();
      const item = findWorkspace(repo, params.workspace);
      if (repo.owner.kind !== "org") {
        throw unprocessable(
          "Runs are for an organisation's repositories. A personal namespace has the state backend only.",
          "terraform_unavailable",
        );
      }
      const branch = item.branch ?? repo.defaultBranch;
      const ref = payload.ref ?? branch;
      if (payload.operation === "apply" && ref !== branch) {
        throw unprocessable(`An apply runs on ${branch} only`);
      }
      const run = {
        id: newId("tfrun"),
        workspace: { id: item.id, name: item.name },
        operation: payload.operation,
        trigger: "manual" as const,
        // The mock has no CI to send it to: a plan stays queued, an apply waits.
        status:
          payload.operation === "apply" ? ("awaiting_approval" as const) : ("queued" as const),
        statusReason: null,
        commitOid: resolveRef(gitOf(repo), ref).commitOid,
        ref,
        pullNumber: null,
        actor,
        approvedBy: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        plan: null,
        costDelta: null,
        ciRunId: null,
        stateVersionId: null,
      };
      terraformOf(repo).runs.push(run);
      return toRun(repo, run);
    },
    approveRun: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      const run = findRun(repo, params.runId);
      if (run.status !== "awaiting_approval")
        throw conflict("That run is not waiting for approval");
      const item = terraformOf(repo).workspaces.find((entry) => entry.id === run.workspace.id);
      run.status = "applied";
      run.approvedBy = requireUser();
      run.finishedAt = new Date().toISOString();
      if (item) {
        const top = Math.max(0, ...item.versions.map((version) => version.serial));
        for (const version of item.versions) version.current = false;
        const version = {
          ...(item.versions[0] ?? {
            lineage: "00000000-0000-4000-8000-000000000000",
            sha256: "0".repeat(32),
            sizeBytes: 2048,
            resourceCount: item.resources.length,
            terraformVersion: "1.10.3",
          }),
          id: newId("sv"),
          serial: top + 1,
          createdAt: hoursAgo(0),
          createdBy: null,
          runId: run.id,
          current: true,
        };
        item.versions.unshift(version);
        run.stateVersionId = version.id;
      }
      return toRun(repo, run);
    },
    discardRun: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      const run = findRun(repo, params.runId);
      if (!["awaiting_approval", "planned", "queued"].includes(run.status)) {
        throw conflict("That run has already finished");
      }
      run.status = run.status === "queued" ? "cancelled" : "discarded";
      run.statusReason = `Discarded by ${requireUser().username ?? "someone"}`;
      run.finishedAt = new Date().toISOString();
      return toRun(repo, run);
    },
    listStateVersions: ({ params, query }) => {
      const repo = findRepository(params.owner, params.repo);
      return paginate(findWorkspace(repo, params.workspace).versions, query);
    },
    downloadStateVersion: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      // The document holds secrets: `admin`, as the API asks.
      if (accessTo(repo) !== "admin") throw mockError(403, "Forbidden");
      return stateDocument(repo, params.workspace, params.versionId);
    },
    restoreStateVersion: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      const item = findWorkspace(repo, params.workspace);
      if (item.lock !== null) {
        throw unprocessable("Something holds this workspace's lock", "terraform_locked");
      }
      return restoreVersion(repo, params.workspace, params.versionId, requireUser());
    },
    listResources: ({ params, query }) => {
      const repo = findRepository(params.owner, params.repo);
      const words = (query?.q ?? "").toLowerCase().trim();
      const items = findWorkspace(repo, params.workspace).resources.filter(
        (item) =>
          (words === "" || `${item.address} ${item.type}`.toLowerCase().includes(words)) &&
          (query?.matched === undefined ||
            (item.infrawrench !== null) === (query.matched === "true")),
      );
      return paginate(items, query);
    },
  },
});
