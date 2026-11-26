/**
 * `/api/repos/:owner/:repo`: what runs on a repository's commits. Commit
 * statuses (anything may report one), Infrawrench CI runs, and Terraform
 * workspaces.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import {
  AllowedWhenArchived,
  RequiredAccess,
  RequiresUser,
  SuccessDescription,
} from "../http/annotations";
import { Authentication, RepositoryAccess } from "../http/auth";
import { BadRequest, Conflict, NotFound, UnprocessableEntity } from "../http/errors";
import { BranchKey, CommitSha, Ok, Page, PageQuery, RefQuery, RepoParams } from "../schemas/common";
import {
  CiEvent,
  CiRepositorySettings,
  CiRepositorySettingsUpdate,
  CiRepositoryStatus,
  CiRun,
  CiRunDetail,
  CiRunStatus,
} from "../schemas/ci";
import { CombinedStatus, CommitStatus, CommitStatusCreate } from "../schemas/git";
import {
  TerraformManagedResource,
  TerraformRoot,
  TerraformAccount,
  TerraformRun,
  TerraformRunCreate,
  TerraformRunStatus,
  TerraformStateVersion,
  TerraformWorkspace,
  TerraformWorkspaceCreate,
  TerraformWorkspaceSettings,
} from "../schemas/terraform";

export class StatusesGroup extends HttpApiGroup.make("statuses")
  .add(
    HttpApiEndpoint.get("forRef", "/statuses", {
      params: RepoParams,
      query: { ref: RefQuery },
      success: CombinedStatus,
      error: UnprocessableEntity,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "The statuses of a ref's commit")
      .annotate(SuccessDescription, "The combined status and each context's newest"),
    HttpApiEndpoint.post("create", "/statuses/:sha", {
      params: { ...RepoParams, sha: CommitSha },
      payload: CommitStatusCreate,
      success: CommitStatus,
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "write")
      .annotate(OpenApi.Summary, "Report a status on a commit")
      .annotate(
        OpenApi.Description,
        "One per `context`: reporting again replaces it. What CI does with a write-scoped job token; any `repo:write` token may. The sha must be a full commit id the repository has.",
      )
      .annotate(SuccessDescription, "The status"),
  )
  .prefix("/api/repos/:owner/:repo")
  .middleware(RepositoryAccess)
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Commit statuses") {}

/** The run's live log: the runner's events as `event:` / `data:` frames, as the app's CI tab reads them. */
const RunLogStream = Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" }));

const RunParams = { ...RepoParams, runId: Schema.String } as const;

export class CiGroup extends HttpApiGroup.make("ci")
  .add(
    HttpApiEndpoint.get("status", "/ci", { params: RepoParams, success: CiRepositoryStatus })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "Whether CI runs for a repository, and its pipelines")
      .annotate(SuccessDescription, "CI status"),
    HttpApiEndpoint.get("settings", "/ci/settings", {
      params: RepoParams,
      success: CiRepositorySettings,
    })
      .annotate(RequiredAccess, "admin")
      .annotate(AllowedWhenArchived, true)
      .annotate(OpenApi.Summary, "A repository's CI switch")
      .annotate(SuccessDescription, "The switch"),
    HttpApiEndpoint.put("updateSettings", "/ci/settings", {
      params: RepoParams,
      payload: CiRepositorySettingsUpdate,
      success: CiRepositorySettings,
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "admin")
      .annotate(OpenApi.Summary, "Switch CI on or off for a repository")
      .annotate(
        OpenApi.Description,
        "Runs already started finish. Secrets, variables and approvals are the organisation's, in the app. 422 `ci_unavailable` for a repository in a personal namespace.",
      )
      .annotate(SuccessDescription, "The switch"),
    HttpApiEndpoint.get("listRuns", "/ci/runs", {
      params: RepoParams,
      query: {
        ...PageQuery,
        sha: Schema.optionalKey(
          Schema.String.annotate({ description: "Runs of this commit (a full id)." }),
        ),
        ref: Schema.optionalKey(Schema.String.annotate({ description: "Runs on this branch." })),
        page: Schema.optionalKey(
          BranchKey.annotate({ description: "Runs of this branch's page (its key)." }),
        ),
        status: Schema.optionalKey(CiRunStatus),
        event: Schema.optionalKey(CiEvent),
      },
      success: Page(CiRun),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "CI runs of a repository, a commit or a branch page")
      .annotate(
        OpenApi.Description,
        "Newest first. `skipped` runs are left out unless `status=skipped` asks for them.",
      )
      .annotate(SuccessDescription, "Runs"),
    HttpApiEndpoint.get("getRun", "/ci/runs/:runId", {
      params: RunParams,
      success: CiRunDetail,
      error: NotFound,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A CI run with each job's output")
      .annotate(
        OpenApi.Description,
        "The output of a Terraform workspace's run is empty for a caller without `write`: Terraform prints attribute values that are not marked sensitive.",
      )
      .annotate(SuccessDescription, "The run"),
    HttpApiEndpoint.get("runLog", "/ci/runs/:runId/log", {
      params: RunParams,
      success: RunLogStream,
      error: NotFound,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "Follow a running CI run's log")
      .annotate(
        OpenApi.Description,
        "403 for a Terraform workspace's run without `write` on the repository.",
      )
      .annotate(SuccessDescription, "Server-sent events until the run ends"),
  )
  .prefix("/api/repos/:owner/:repo")
  .middleware(RepositoryAccess)
  .middleware(Authentication)
  .annotate(OpenApi.Title, "CI") {}

const WorkspaceParams = {
  ...RepoParams,
  workspace: Schema.String.annotate({ description: "The workspace's name." }),
} as const;
const TerraformRunParams = { ...RepoParams, runId: Schema.String } as const;
const StateVersionParams = { ...WorkspaceParams, versionId: Schema.String } as const;

/** A state document, exactly as Terraform wrote it. */
const StateDocument = Schema.String.pipe(HttpApiSchema.asText({ contentType: "application/json" }));

export class TerraformGroup extends HttpApiGroup.make("terraform")
  .add(
    HttpApiEndpoint.get("listWorkspaces", "/terraform/workspaces", {
      params: RepoParams,
      success: Schema.Struct({ workspaces: Schema.Array(TerraformWorkspace) }),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A repository's Terraform workspaces")
      .annotate(SuccessDescription, "Workspaces, by name"),
    HttpApiEndpoint.get("listRoots", "/terraform/roots", {
      params: RepoParams,
      query: { ref: RefQuery },
      success: Schema.Struct({ roots: Schema.Array(TerraformRoot) }),
    })
      .annotate(RequiredAccess, "admin")
      .annotate(AllowedWhenArchived, true)
      .annotate(OpenApi.Summary, "Directories that look like Terraform roots")
      .annotate(OpenApi.Description, "For the picker a new workspace's directory comes from.")
      .annotate(SuccessDescription, "Roots"),
    HttpApiEndpoint.get("listAccounts", "/terraform/accounts", {
      params: RepoParams,
      success: Schema.Struct({ accounts: Schema.Array(TerraformAccount) }),
    })
      .annotate(RequiredAccess, "admin")
      .annotate(AllowedWhenArchived, true)
      .annotate(OpenApi.Summary, "Connected accounts a workspace can link")
      .annotate(
        OpenApi.Description,
        "The Infrawrench accounts of the organisation that owns the repository, by name, for the picker of a workspace's accounts. Empty for a repository in a personal namespace, for a caller without `accounts:read` in the organisation, and for anything but a signed-in person.",
      )
      .annotate(SuccessDescription, "Accounts"),
    HttpApiEndpoint.post("createWorkspace", "/terraform/workspaces", {
      params: RepoParams,
      payload: TerraformWorkspaceCreate,
      success: TerraformWorkspace,
      error: [BadRequest, Conflict, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "admin")
      .annotate(OpenApi.Summary, "Add a Terraform workspace")
      .annotate(SuccessDescription, "The workspace"),
    HttpApiEndpoint.get("getWorkspace", "/terraform/workspaces/:workspace", {
      params: WorkspaceParams,
      success: TerraformWorkspace,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A Terraform workspace")
      .annotate(SuccessDescription, "The workspace"),
    HttpApiEndpoint.patch("updateWorkspace", "/terraform/workspaces/:workspace", {
      params: WorkspaceParams,
      payload: TerraformWorkspaceSettings,
      success: TerraformWorkspace,
      error: [BadRequest, Conflict, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "admin")
      .annotate(OpenApi.Summary, "Change a Terraform workspace's settings")
      .annotate(SuccessDescription, "The workspace"),
    HttpApiEndpoint.delete("deleteWorkspace", "/terraform/workspaces/:workspace", {
      params: WorkspaceParams,
      success: Ok,
      error: UnprocessableEntity,
    })
      .annotate(RequiredAccess, "admin")
      .annotate(OpenApi.Summary, "Remove a Terraform workspace")
      .annotate(
        OpenApi.Description,
        "Its state versions are kept for thirty days. 422 `terraform_locked` while a run holds the lock.",
      )
      .annotate(SuccessDescription, "Removed"),
    HttpApiEndpoint.delete("forceUnlock", "/terraform/workspaces/:workspace/lock", {
      params: WorkspaceParams,
      success: Ok,
    })
      .annotate(RequiredAccess, "admin")
      .annotate(OpenApi.Summary, "Force-unlock a workspace's state")
      .annotate(SuccessDescription, "Unlocked"),
    HttpApiEndpoint.get("listRuns", "/terraform/runs", {
      params: RepoParams,
      query: {
        ...PageQuery,
        workspace: Schema.optionalKey(Schema.String),
        page: Schema.optionalKey(BranchKey),
        status: Schema.optionalKey(TerraformRunStatus),
      },
      success: Page(TerraformRun),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "Terraform runs of a repository, a workspace or a branch page")
      .annotate(
        OpenApi.Description,
        "Newest first. With `page`, the newest plan per workspace comes first: what the branch page's Infrastructure box shows.",
      )
      .annotate(SuccessDescription, "Runs, each with its plan summary and cost change"),
    HttpApiEndpoint.get("getRun", "/terraform/runs/:runId", {
      params: TerraformRunParams,
      success: TerraformRun,
      error: NotFound,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A Terraform run")
      .annotate(SuccessDescription, "The run"),
    HttpApiEndpoint.post("approveRun", "/terraform/runs/:runId/approve", {
      params: TerraformRunParams,
      success: TerraformRun,
      error: [NotFound, Conflict, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Approve an apply that is waiting")
      .annotate(
        OpenApi.Description,
        "For a signed-in person with `admin` on the repository, or with `ci:approve` in the organisation that owns it (403 otherwise; a personal access token never approves). The run is queued and sent to Infrawrench CI. 409 when it is not waiting any more.",
      )
      .annotate(SuccessDescription, "The run"),
    HttpApiEndpoint.post("createRun", "/terraform/workspaces/:workspace/runs", {
      params: WorkspaceParams,
      payload: TerraformRunCreate,
      success: TerraformRun,
      error: [BadRequest, NotFound, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "write")
      .annotate(OpenApi.Summary, "Start a plan or an apply by hand")
      .annotate(
        OpenApi.Description,
        "A plan of a branch or a commit starts at once. An apply runs on the workspace's branch only, and waits for approval unless the caller may approve it. 422 `terraform_unavailable` for a repository in a personal namespace, which has the state backend only.",
      )
      .annotate(SuccessDescription, "The run"),
    HttpApiEndpoint.post("discardRun", "/terraform/runs/:runId/discard", {
      params: TerraformRunParams,
      success: TerraformRun,
      error: [NotFound, Conflict, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "write")
      .annotate(OpenApi.Summary, "Discard a plan, or cancel a queued run")
      .annotate(SuccessDescription, "The run"),
    HttpApiEndpoint.get("listStateVersions", "/terraform/workspaces/:workspace/state-versions", {
      params: WorkspaceParams,
      query: PageQuery,
      success: Page(TerraformStateVersion),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A workspace's state versions")
      .annotate(
        OpenApi.Description,
        "Newest first. The state documents themselves hold secrets and are only served to an `admin` of the repository: by the HTTP backend, and by the download below.",
      )
      .annotate(SuccessDescription, "State versions"),
    HttpApiEndpoint.get(
      "downloadStateVersion",
      "/terraform/workspaces/:workspace/state-versions/:versionId/download",
      { params: StateVersionParams, success: StateDocument, error: NotFound },
    )
      .annotate(RequiredAccess, "admin")
      // An archived repository's state is still read by its administrators.
      .annotate(AllowedWhenArchived, true)
      .annotate(OpenApi.Summary, "Download a state version")
      .annotate(
        OpenApi.Description,
        "The document as stored, as an attachment. It holds every secret the workspace manages, so it takes `admin`, as the HTTP backend does: every member of an organisation has `write`. Anyone else gets 403.",
      )
      .annotate(SuccessDescription, "The state document"),
    HttpApiEndpoint.post(
      "restoreStateVersion",
      "/terraform/workspaces/:workspace/state-versions/:versionId/restore",
      {
        params: StateVersionParams,
        success: TerraformStateVersion,
        error: [NotFound, Conflict, UnprocessableEntity],
      },
    )
      .annotate(RequiredAccess, "admin")
      .annotate(OpenApi.Summary, "Make an old state version current again")
      .annotate(
        OpenApi.Description,
        "Writes the old document as a new version with the next serial; no version is changed or removed. 422 `terraform_locked` while something holds the lock, 409 when the state changed meanwhile.",
      )
      .annotate(SuccessDescription, "The new current version"),
    HttpApiEndpoint.get("listResources", "/terraform/workspaces/:workspace/resources", {
      params: WorkspaceParams,
      query: {
        ...PageQuery,
        q: Schema.optionalKey(
          Schema.String.annotate({ description: "Part of an address or type." }),
        ),
        matched: Schema.optionalKey(
          Schema.Literals(["true", "false"]).annotate({
            description: "Only resources matched (or not matched) to an Infrawrench resource.",
          }),
        ),
      },
      success: Page(TerraformManagedResource),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "The resources a workspace manages")
      .annotate(
        OpenApi.Description,
        "From its current state, each with the Infrawrench resource it was matched to and what that costs a month. Costs are only sent to callers who may see them in the app.",
      )
      .annotate(SuccessDescription, "Resources, by address"),
  )
  .prefix("/api/repos/:owner/:repo")
  .middleware(RepositoryAccess)
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Terraform") {}
