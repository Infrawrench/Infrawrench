/**
 * Reviewing work a branch at a time. A branch's page is its branch page
 * shown another way, so most of this is under
 * `/api/repos/:owner/:repo/branches/:branch`: the versions a branch has been
 * through and the diffs between them, what review agents found, what
 * reviewers sent back to the agent, and the agent itself. Traces are written
 * to a branch (it may not have a branch page, or exist, yet). The inbox
 * and the viewer's T3 Code environments have no
 * repository in the path.
 *
 * Who writes what:
 * - A reviewer is a person with a session or a personal token.
 * - An authoring agent uses a personal token with `repo:write` (or, in CI,
 *   the job's token for `traces.record`): it records traces, reads its
 *   instructions and marks them delivered and answered.
 * - A review agent that runs outside the forge reports with
 *   `findings.report` and `findings.updateRun`.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  AllowedWhenArchived,
  RequiredAccess,
  RequiresUser,
  SuccessDescription,
} from "../http/annotations";
import { Authentication, RepositoryAccess } from "../http/auth";
import { BadRequest, Conflict, UnprocessableEntity } from "../http/errors";
import { BranchParams, Ok, Page, PageQuery, RepoParams } from "../schemas/common";
import { DiffQuery } from "../schemas/git";
import {
  AgentLink,
  AgentLinkSet,
  AgentToken,
  BranchPageState,
  BranchVersion,
  BranchVersionList,
  FindingReport,
  FindingStatus,
  FindingsTally,
  Instruction,
  InstructionCreate,
  InstructionStatus,
  MergeOverride,
  ReviewFinding,
  ReviewInbox,
  ReviewRun,
  ReviewRunRequest,
  ReviewRunUpdate,
  ReviewSettings,
  ReviewSettingsUpdate,
  StartWork,
  T3Environment,
  T3EnvironmentCreate,
  T3EnvironmentUpdate,
  T3Models,
  T3Thread,
  TraceEntry,
  TraceRecord,
  VersionDiff,
  VersionNumber,
  VersionReviewMark,
} from "../schemas/review";
import { BranchPage } from "../schemas/threads";

/** A version in a path: its number, or `latest`. */
const VersionSelector = Schema.String.check(
  Schema.isPattern(/^(latest|[1-9][0-9]{0,8})$/),
).annotate({ description: "A version's number, or `latest`." });
const VersionParams = { ...BranchParams, version: VersionSelector } as const;
const FindingParams = { ...BranchParams, findingId: Schema.String } as const;
const RunParams = { ...BranchParams, runId: Schema.String } as const;
const InstructionParams = { ...BranchParams, instructionId: Schema.String } as const;
const EnvironmentParams = { environmentId: Schema.String } as const;

export class VersionsGroup extends HttpApiGroup.make("versions")
  .add(
    HttpApiEndpoint.get("list", "/:branch/versions", {
      params: BranchParams,
      success: BranchVersionList,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A branch's versions")
      .annotate(
        OpenApi.Description,
        "One per push to the branch page's head branch, forced pushes included, oldest first.",
      )
      .annotate(SuccessDescription, "Versions"),
    HttpApiEndpoint.get("get", "/:branch/versions/:version", {
      params: VersionParams,
      success: BranchVersion,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "One version")
      .annotate(SuccessDescription, "The version"),
    HttpApiEndpoint.get("diff", "/:branch/versions/:version/diff", {
      params: VersionParams,
      query: {
        ...PageQuery,
        ...DiffQuery,
        from: Schema.optionalKey(
          Schema.String.check(
            Schema.isPattern(/^(base|previous|reviewed|[1-9][0-9]{0,8})$/),
          ).annotate({
            description:
              "`base` (default): the whole change at this version, base to tip. `previous`: what this version changed since the one before it. A number: since that version. `reviewed`: since the version the viewer last marked as reviewed, or the whole change when there is none. Everything but `base` compares each version against its own base, so a rebase alone shows nothing.",
          }),
        ),
      },
      success: VersionDiff,
      error: UnprocessableEntity,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A diff of a version, with hunks")
      .annotate(SuccessDescription, "The diff, paged by file"),
    HttpApiEndpoint.put("markReviewed", "/:branch/versions/:version/reviewed", {
      params: VersionParams,
      success: VersionReviewMark,
    })
      .annotate(RequiredAccess, "read")
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Mark a branch as reviewed up to a version")
      .annotate(
        OpenApi.Description,
        'Where "since you last looked" starts for the viewer. It never moves backwards.',
      )
      .annotate(SuccessDescription, "The mark"),
    HttpApiEndpoint.get("branchState", "/:branch/branch-state", {
      params: BranchParams,
      success: BranchPageState,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "Where a branch stands")
      .annotate(
        OpenApi.Description,
        "The branch page's header in one call: its state, the agent behind it, instructions out, and the findings tally.",
      )
      .annotate(SuccessDescription, "The branch page's state"),
  )
  .prefix("/api/repos/:owner/:repo/branches")
  .middleware(RepositoryAccess)
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Branch versions") {}

export class TracesGroup extends HttpApiGroup.make("traces")
  .add(
    HttpApiEndpoint.post("record", "/", {
      params: RepoParams,
      payload: TraceRecord,
      success: Schema.Struct({ entries: Schema.Array(TraceEntry) }),
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "Record what an agent did")
      .annotate(
        OpenApi.Description,
        "Entries wait on the branch and belong to the version its next push makes. Secrets in bodies and evidence are masked before anything is stored. Takes a person with `write` access (a session, or a personal token with `repo:write`) or a CI job's token for this repository; anyone else gets a 403.",
      )
      .annotate(SuccessDescription, "The entries as stored"),
    HttpApiEndpoint.get("list", "/", {
      params: RepoParams,
      query: {
        ...PageQuery,
        branch: Schema.String.annotate({
          description: "A branch's name. It need not have a page, or exist, yet.",
        }),
        version: Schema.optionalKey(
          Schema.String.check(Schema.isPattern(/^(pending|[1-9][0-9]{0,8})$/)).annotate({
            description:
              "A version's number, or `pending` for what has been recorded since the last push. Every version when omitted.",
          }),
        ),
      },
      success: Page(TraceEntry),
      error: BadRequest,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "An agent's trace")
      .annotate(OpenApi.Description, "Oldest first.")
      .annotate(SuccessDescription, "Trace entries"),
  )
  .prefix("/api/repos/:owner/:repo/traces")
  .middleware(RepositoryAccess)
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Traces") {}

export class FindingsGroup extends HttpApiGroup.make("findings")
  .add(
    HttpApiEndpoint.get("list", "/:branch/findings", {
      params: BranchParams,
      query: {
        version: Schema.optionalKey(
          VersionNumber.annotate({ description: "Only findings seen on this version." }),
        ),
        status: Schema.optionalKey(FindingStatus),
      },
      success: Schema.Struct({ findings: Schema.Array(ReviewFinding), tally: FindingsTally }),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "What review agents found")
      .annotate(SuccessDescription, "Findings, in file then line order, and their tally"),
    HttpApiEndpoint.post("report", "/:branch/findings", {
      params: BranchParams,
      payload: FindingReport,
      success: Schema.Struct({ findings: Schema.Array(ReviewFinding) }),
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "write")
      .annotate(OpenApi.Summary, "Report a reviewer's findings on a version")
      .annotate(
        OpenApi.Description,
        "For a review agent that runs outside the forge. A finding with the fingerprint of one already known updates it, and one that was dismissed stays dismissed.",
      )
      .annotate(SuccessDescription, "The findings as stored"),
    HttpApiEndpoint.put("dismiss", "/:branch/findings/:findingId/dismiss", {
      params: FindingParams,
      payload: Schema.Struct({
        reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
      }),
      success: ReviewFinding,
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "triage")
      .annotate(OpenApi.Summary, "Dismiss a finding")
      .annotate(SuccessDescription, "The finding, dismissed"),
    HttpApiEndpoint.put("reopen", "/:branch/findings/:findingId/reopen", {
      params: FindingParams,
      success: ReviewFinding,
      error: UnprocessableEntity,
    })
      .annotate(RequiredAccess, "triage")
      .annotate(OpenApi.Summary, "Reopen a dismissed finding")
      .annotate(SuccessDescription, "The finding, open"),
    HttpApiEndpoint.post("override", "/:branch/findings/override", {
      params: BranchParams,
      payload: Schema.Struct({
        reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
        findingIds: Schema.optionalKey(
          Schema.Array(Schema.String).annotate({
            description: "The findings to merge past. Every open must-fix finding when omitted.",
          }),
        ),
      }),
      success: MergeOverride,
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "admin")
      .annotate(OpenApi.Summary, "Let a branch page merge past its open must-fix findings")
      .annotate(
        OpenApi.Description,
        "Recorded with who and why. It covers the findings named and no finding raised afterwards.",
      )
      .annotate(SuccessDescription, "The override"),
    HttpApiEndpoint.get("listRuns", "/:branch/review-runs", {
      params: BranchParams,
      success: Schema.Struct({ runs: Schema.Array(ReviewRun) }),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "Review runs")
      .annotate(SuccessDescription, "Runs, newest first"),
    HttpApiEndpoint.get("getRun", "/:branch/review-runs/:runId", {
      params: RunParams,
      success: ReviewRun,
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A review run")
      .annotate(SuccessDescription, "The run"),
    HttpApiEndpoint.post("requestRun", "/:branch/review-runs", {
      params: BranchParams,
      payload: ReviewRunRequest,
      success: ReviewRun,
      error: [BadRequest, Conflict, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "write")
      .annotate(OpenApi.Summary, "Run the review agents again")
      .annotate(
        OpenApi.Description,
        "409 when a run of the same version is already queued or running.",
      )
      .annotate(SuccessDescription, "The run, queued"),
    HttpApiEndpoint.patch("updateRun", "/:branch/review-runs/:runId", {
      params: RunParams,
      payload: ReviewRunUpdate,
      success: ReviewRun,
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "write")
      .annotate(OpenApi.Summary, "Report a review run's progress and usage")
      .annotate(SuccessDescription, "The run"),
  )
  .prefix("/api/repos/:owner/:repo/branches")
  .middleware(RepositoryAccess)
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Review findings") {}

export class InstructionsGroup extends HttpApiGroup.make("instructions")
  .add(
    HttpApiEndpoint.post("send", "/:branch/instructions", {
      params: BranchParams,
      payload: InstructionCreate,
      success: Instruction,
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "write")
      .annotate(OpenApi.Summary, "Send a comment, a finding or a note to the authoring agent")
      .annotate(SuccessDescription, "The instruction, queued"),
    HttpApiEndpoint.get("list", "/:branch/instructions", {
      params: BranchParams,
      query: { status: Schema.optionalKey(InstructionStatus) },
      success: Schema.Struct({ instructions: Schema.Array(Instruction) }),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "A branch's instructions")
      .annotate(SuccessDescription, "Instructions, oldest first"),
    HttpApiEndpoint.put("markDelivered", "/:branch/instructions/:instructionId/delivered", {
      params: InstructionParams,
      payload: Schema.Struct({
        via: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
      }),
      success: Instruction,
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "write")
      .annotate(OpenApi.Summary, "Say an instruction reached the agent")
      .annotate(SuccessDescription, "The instruction"),
    HttpApiEndpoint.put("markAnswered", "/:branch/instructions/:instructionId/answered", {
      params: InstructionParams,
      payload: Schema.Struct({
        version: Schema.optionalKey(
          Schema.Int.annotate({
            description:
              "The version that answers it. Omitted: the next version pushed to the branch.",
          }),
        ),
      }),
      success: Instruction,
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "write")
      .annotate(OpenApi.Summary, "Say which version answers an instruction")
      .annotate(SuccessDescription, "The instruction"),
    HttpApiEndpoint.put("dismiss", "/:branch/instructions/:instructionId/dismiss", {
      params: InstructionParams,
      success: Instruction,
      error: UnprocessableEntity,
    })
      .annotate(RequiredAccess, "write")
      .annotate(OpenApi.Summary, "Withdraw an instruction")
      .annotate(SuccessDescription, "The instruction, dismissed"),
  )
  .prefix("/api/repos/:owner/:repo/branches")
  .middleware(RepositoryAccess)
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Instructions") {}

export class AgentsGroup extends HttpApiGroup.make("agents")
  .add(
    HttpApiEndpoint.get("get", "/branches/:branch/agent", {
      params: BranchParams,
      success: Schema.Struct({ agent: Schema.NullOr(AgentLink) }),
    })
      .annotate(RequiredAccess, "read")
      .annotate(OpenApi.Summary, "The agent that writes a branch")
      .annotate(SuccessDescription, "The agent, or null"),
    HttpApiEndpoint.put("set", "/branches/:branch/agent", {
      params: BranchParams,
      payload: AgentLinkSet,
      success: Schema.Struct({ agent: AgentLink }),
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "write")
      .annotate(OpenApi.Summary, "Name the agent that writes a branch")
      .annotate(SuccessDescription, "The agent"),
    HttpApiEndpoint.delete("remove", "/branches/:branch/agent", {
      params: BranchParams,
      success: Ok,
    })
      .annotate(RequiredAccess, "write")
      .annotate(OpenApi.Summary, "Disconnect a branch's agent")
      .annotate(SuccessDescription, "Disconnected"),
    HttpApiEndpoint.post("token", "/branches/:branch/agent/token", {
      params: BranchParams,
      success: AgentToken,
      error: UnprocessableEntity,
    })
      .annotate(RequiredAccess, "write")
      .annotate(OpenApi.Summary, "A token for a branch's agent")
      .annotate(
        OpenApi.Description,
        "A token good for six hours that records this branch's trace, reads and answers its instructions and reports findings on it, through the API and the MCP server, and does nothing else: it does not clone or push. Asked for with a personal access token, an API key or a session that has write access; asking again is how it is renewed. 422 for a branch page that is closed or a fork's.",
      )
      .annotate(SuccessDescription, "The token"),
    HttpApiEndpoint.post("startWork", "/work", {
      params: RepoParams,
      payload: StartWork,
      success: Schema.Struct({
        page: BranchPage,
        branch: Schema.String,
        agent: Schema.NullOr(AgentLink),
      }),
      error: [BadRequest, Conflict, UnprocessableEntity],
    })
      .annotate(RequiredAccess, "write")
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Start work from an ask")
      .annotate(
        OpenApi.Description,
        "Creates the branch at the base's commit and opens a draft branch page whose body is the ask. 409 `ref_exists` when the branch name is taken; 422 `ref_not_found` for a base that is not a branch.",
      )
      .annotate(SuccessDescription, "The branch and its branch page"),
  )
  .prefix("/api/repos/:owner/:repo")
  .middleware(RepositoryAccess)
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Authoring agents") {}

export class ReviewSettingsGroup extends HttpApiGroup.make("reviewSettings")
  .add(
    HttpApiEndpoint.get("get", "/", { params: RepoParams, success: ReviewSettings })
      .annotate(RequiredAccess, "admin")
      .annotate(AllowedWhenArchived, true)
      .annotate(OpenApi.Summary, "A repository's review settings")
      .annotate(SuccessDescription, "The settings"),
    HttpApiEndpoint.patch("update", "/", {
      params: RepoParams,
      payload: ReviewSettingsUpdate,
      success: ReviewSettings,
      error: BadRequest,
    })
      .annotate(RequiredAccess, "admin")
      .annotate(OpenApi.Summary, "Change a repository's review settings")
      .annotate(SuccessDescription, "The settings"),
  )
  .prefix("/api/repos/:owner/:repo/review-settings")
  .middleware(RepositoryAccess)
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Review settings") {}

export class ReviewGroup extends HttpApiGroup.make("review")
  .add(
    HttpApiEndpoint.get("inbox", "/inbox", { query: PageQuery, success: ReviewInbox })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Branches waiting on the viewer")
      .annotate(
        OpenApi.Description,
        "Open branch pages the viewer wrote, is assigned, has reviewed or connected an agent to, with a version they have not reviewed. The longest wait first.",
      )
      .annotate(SuccessDescription, "The inbox"),
  )
  .prefix("/api/review")
  .middleware(Authentication)
  .annotate(OpenApi.Title, "Review") {}

/**
 * The viewer's T3 Code environments. The forge is an OAuth client of each
 * environment's MCP server: `beginOAuth` answers where to send the browser,
 * and the environment sends it back to `AUTH_PATHS.t3Callback` (`urls.ts`),
 * which is a redirect, not an endpoint. Session only, like the rest of a
 * person's credentials.
 */
export class T3Group extends HttpApiGroup.make("t3")
  .add(
    HttpApiEndpoint.get("list", "/environments", {
      success: Schema.Struct({ environments: Schema.Array(T3Environment) }),
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "The viewer's T3 Code environments")
      .annotate(SuccessDescription, "Environments"),
    HttpApiEndpoint.post("create", "/environments", {
      payload: T3EnvironmentCreate,
      success: T3Environment,
      error: [BadRequest, Conflict, UnprocessableEntity],
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Add a T3 Code environment")
      .annotate(
        OpenApi.Description,
        "It is `pending` until the person signs in to it (`beginOAuth`). 409 when they already have one at that address.",
      )
      .annotate(SuccessDescription, "The environment"),
    HttpApiEndpoint.patch("update", "/environments/:environmentId", {
      params: EnvironmentParams,
      payload: T3EnvironmentUpdate,
      success: T3Environment,
      error: BadRequest,
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Rename a T3 Code environment")
      .annotate(SuccessDescription, "The environment"),
    HttpApiEndpoint.delete("remove", "/environments/:environmentId", {
      params: EnvironmentParams,
      success: Ok,
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Remove a T3 Code environment and its tokens")
      .annotate(SuccessDescription, "Removed"),
    HttpApiEndpoint.post("beginOAuth", "/environments/:environmentId/oauth/begin", {
      params: EnvironmentParams,
      payload: Schema.Struct({
        returnTo: Schema.optionalKey(
          Schema.String.check(Schema.isMaxLength(2048)).annotate({
            description: "A path on this site to come back to. Anything else is ignored.",
          }),
        ),
      }),
      success: Schema.Struct({
        authorizeUrl: Schema.String.annotate({
          description: "Where to send the browser to sign in to the environment.",
        }),
      }),
      error: [BadRequest, UnprocessableEntity],
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "Start signing in to a T3 Code environment")
      .annotate(SuccessDescription, "The address to open"),
    HttpApiEndpoint.get("listThreads", "/environments/:environmentId/threads", {
      params: EnvironmentParams,
      query: { q: Schema.optionalKey(Schema.String) },
      success: Schema.Struct({ threads: Schema.Array(T3Thread) }),
      error: UnprocessableEntity,
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "An environment's threads, for picking one")
      .annotate(SuccessDescription, "Threads, the most recent first"),
    HttpApiEndpoint.get("listModels", "/environments/:environmentId/models", {
      params: EnvironmentParams,
      query: {
        owner: Schema.optionalKey(Schema.String),
        repo: Schema.optionalKey(
          Schema.String.annotate({
            description:
              "With `owner`: the repository whose project's default model is answered as `default`.",
          }),
        ),
      },
      success: T3Models,
      error: UnprocessableEntity,
    })
      .annotate(RequiresUser, true)
      .annotate(OpenApi.Summary, "An environment's providers and models, for picking one")
      .annotate(SuccessDescription, "Providers that can run a thread, each with its models"),
  )
  .prefix("/api/t3")
  .middleware(Authentication)
  .annotate(OpenApi.Title, "T3 Code") {}
