/**
 * GitHub issue filing: `/api/org/:orgId/github-issues`, the endpoint
 * definitions.
 *
 * The third tracker beside Jira and Linear, running on the org's existing
 * GitHub App installation rather than a stored credential. What it adds over
 * the other two is dedupe by finding fingerprint, issue resolution when a
 * finding goes away, and IaC pull requests. Reads take `github-issues:read`;
 * filing and pull requests `github-issues:write`; the settings document
 * `org:settings:write`, because its pull-request switch decides whether every
 * holder of `write` may propose infrastructure changes.
 *
 * The request schemas are also the endpoints' validation (strict, as the zod
 * ones were), so the documented shape and the accepted shape cannot drift.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { GITHUB_ISSUE_LIMITS, GITHUB_ISSUE_SOURCE_KINDS } from "@infrawrench/client-core";
import { maxLength, minLength, pattern } from "@infrawrench/ui/schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadGateway, BadRequest } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, OrgParams } from "../../schemas/common";
import { documentedAs, requiredQuery } from "../../schemas/documented";
import { IssueStatusRefreshResult, isUrl, issueStatusFields } from "../../schemas/issue-status";

const L = GITHUB_ISSUE_LIMITS;

/** The zod schemas were `.strict()` at every level: an unknown key is refused. */
const strictBody = { errors: "all", onExcessProperty: "error" } as const;

const GithubIssueSourceKind = Schema.Literals(GITHUB_ISSUE_SOURCE_KINDS).annotate({
  identifier: "GithubIssueSourceKind",
  description: "Which detector produced the finding the issue was filed from.",
});

const GithubRepoRef = Schema.Struct({
  installationId: Schema.Int.check(Schema.isGreaterThan(0)).annotate({
    description: "A GitHub App installation connected to the organization (`/github/status`).",
  }),
  fullName: Schema.String.check(
    minLength(3),
    maxLength(201),
    pattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  ).annotate({
    description: "`owner/name`, as listed by `/github/repos`.",
    examples: ["acme/infra"],
  }),
}).annotate({ identifier: "GithubRepoRef" });

const Label = Schema.String.check(minLength(1), maxLength(L.maxLabelLength));
const Login = Schema.String.check(minLength(1), maxLength(39));
const Labels = Schema.mutable(Schema.Array(Label)).check(maxLength(L.maxLabels));
const Logins = Schema.mutable(Schema.Array(Login)).check(maxLength(L.maxAssignees));

const GithubIssueRouteMatch = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("cost_centre"),
    costCentreId: Schema.String.check(minLength(1), maxLength(64)).annotate({
      description: "A cost centre id.",
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("tag"),
    tagKey: Schema.String.check(minLength(1), maxLength(128)),
    tagValue: Schema.NullOr(Schema.String.check(maxLength(256))).annotate({
      description: "Null matches any value of the key.",
    }),
  }),
]).annotate({
  identifier: "GithubIssueRouteMatch",
  description:
    "What sends a finding to this route's repository: the cost centre the organization's allocation rules place its resource in, or a tag on the resource. Allocation rules that match on `service` cannot be judged from a resource and never match here.",
});

const routeFields = {
  match: GithubIssueRouteMatch,
  repo: GithubRepoRef,
  labels: Labels.annotate({ description: "Added to the organization-wide labels." }),
  assignees: Logins.annotate({
    description: "Replace the organization-wide assignees when non-empty.",
  }),
};

const GithubIssueRouteInput = Schema.Struct({
  id: Schema.optionalKey(Schema.String.check(maxLength(64))),
  ...routeFields,
}).annotate({ identifier: "GithubIssueRouteInput" });

const GithubIssueRoute = Schema.Struct({ id: Schema.String, ...routeFields }).annotate({
  identifier: "GithubIssueRoute",
});

const iacSourceFields = {
  iacAccountId: Schema.NullOr(Schema.String.check(maxLength(64))).annotate({
    description:
      "The IaC state scope this maps: the account an uploaded state document covers, or null for the organization-wide state.",
  }),
  repo: GithubRepoRef,
  baseBranch: Schema.NullOr(Schema.String.check(maxLength(255))).annotate({
    description: "Branch pull requests target. Null means the repository's default branch.",
  }),
  directory: Schema.String.check(maxLength(L.maxDirectoryLength)).annotate({
    description: "Directory holding the root module's `.tf` files. Empty for the repository root.",
    examples: ["infra/prod"],
  }),
};

const GithubIacSourceInput = Schema.Struct({
  id: Schema.optionalKey(Schema.String.check(maxLength(64))),
  ...iacSourceFields,
}).annotate({ identifier: "GithubIacSourceInput" });

const GithubIacSource = Schema.Struct({ id: Schema.String, ...iacSourceFields }).annotate({
  identifier: "GithubIacSource",
});

const ResolveAction = Schema.Literals(["close", "comment", "none"]).annotate({
  identifier: "GithubResolveAction",
  description:
    "What happens to an open issue when its finding goes away: close it with a comment, only comment, or leave it alone.",
});

export const GithubIssueSettingsInput = Schema.Struct({
  enabled: Schema.Boolean.annotate({ description: "Master switch for filing, manual and routed." }),
  defaultRepo: Schema.NullOr(GithubRepoRef),
  labels: Labels,
  assignees: Logins,
  routes: Schema.mutable(Schema.Array(GithubIssueRouteInput))
    .check(maxLength(L.maxRoutes))
    .annotate({
      description: "Ordered; the first match wins and no match falls back to `defaultRepo`.",
    }),
  resolveAction: ResolveAction,
  pullRequestsEnabled: Schema.Boolean.annotate({
    description:
      "Allow holders of `github-issues:write` to open pull requests editing Terraform for IaC-managed findings. Never auto-merged.",
  }),
  iacSources: Schema.mutable(Schema.Array(GithubIacSourceInput)).check(maxLength(L.maxIacSources)),
  acknowledgeOnDone: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When an issue filed for a cost anomaly is closed as completed, record the anomaly as explained. Omit to keep the stored value.",
    }),
  ),
}).annotate({ identifier: "GithubIssueSettingsInput" });

export const GithubIssueSettings = Schema.Struct({
  enabled: Schema.Boolean,
  defaultRepo: Schema.NullOr(GithubRepoRef),
  labels: Schema.Array(Schema.String),
  assignees: Schema.Array(Schema.String),
  routes: Schema.Array(GithubIssueRoute),
  resolveAction: ResolveAction,
  pullRequestsEnabled: Schema.Boolean,
  iacSources: Schema.Array(GithubIacSource),
  acknowledgeOnDone: Schema.Boolean,
  updatedAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "GithubIssueSettings" });

const PermissionLevel = Schema.Literals(["none", "read", "write", "admin"]);

const GithubInstallationAccess = Schema.Struct({
  installationId: Schema.Int,
  accountLogin: Schema.NullOr(Schema.String),
  issues: PermissionLevel,
  pullRequests: PermissionLevel,
  contents: PermissionLevel,
  suspended: Schema.Boolean,
  manageUrl: Schema.NullOr(Schema.String),
  checked: Schema.Boolean.annotate({
    description: "False when GitHub could not be asked; the levels are then all `none`.",
  }),
}).annotate({
  identifier: "GithubInstallationAccess",
  description:
    "What an installation has **accepted**. An installation made before issue filing existed shows `issues: none` until an owner of the GitHub account approves the app's updated permissions.",
});

export const GithubIssuesStatus = Schema.Struct({
  appConfigured: Schema.Boolean,
  installations: Schema.Array(GithubInstallationAccess),
  settings: GithubIssueSettings,
  webhookConfigured: Schema.Boolean.annotate({
    description:
      "Whether the server verifies GitHub App webhooks (`GITHUB_APP_WEBHOOK_SECRET` is set), which makes issue status live rather than polled.",
  }),
  webhookUrl: Schema.NullOr(Schema.String).annotate({
    description: "The URL the GitHub App's webhook points at; null when the server has no APP_URL.",
  }),
}).annotate({ identifier: "GithubIssuesStatus" });

/**
 * The repository a picker reads, as the query strings they arrive as: an
 * unreadable or foreign one is the handler's `Unknown repository`, never a
 * schema 400.
 */
const RepoQuery = {
  installationId: Schema.optionalKey(documentedAs(Schema.Int.check(Schema.isGreaterThan(0)))),
  repo: Schema.optionalKey(documentedAs(Schema.String.check(minLength(3), maxLength(201)))),
};

const GithubLabel = Schema.Struct({
  name: Schema.String,
  color: Schema.String,
  description: Schema.NullOr(Schema.String),
}).annotate({ identifier: "GithubLabel" });
export const GithubLabels = Schema.Array(GithubLabel);

const GithubAssignee = Schema.Struct({
  login: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
}).annotate({ identifier: "GithubAssignee" });
export const GithubAssignees = Schema.Array(GithubAssignee);

export const GithubBranches = Schema.Array(Schema.String);

const IssueState = Schema.Literals(["open", "closed"]);

const GithubIssueLink = Schema.Struct({
  id: Schema.String,
  sourceKind: GithubIssueSourceKind,
  sourceId: Schema.String,
  fingerprint: Schema.String.annotate({
    description: "Hash of the finding; also written into the issue body as a hidden marker.",
  }),
  repo: Schema.String,
  installationId: Schema.Int,
  issueNumber: Schema.Int,
  issueUrl: Schema.String,
  state: IssueState,
  autoFiled: Schema.Boolean,
  pullRequestNumber: Schema.NullOr(Schema.Int),
  pullRequestUrl: Schema.NullOr(Schema.String),
  ...issueStatusFields,
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "GithubIssueLink" });
export const GithubIssueLinks = Schema.Array(GithubIssueLink);

export const RouteResolution = Schema.Struct({
  repo: Schema.NullOr(GithubRepoRef),
  labels: Schema.Array(Schema.String),
  assignees: Schema.Array(Schema.String),
  routeId: Schema.NullOr(Schema.String),
}).annotate({ identifier: "GithubIssueRouteResolution" });

export const FileGithubIssueInput = Schema.Struct({
  sourceKind: GithubIssueSourceKind,
  sourceId: Schema.String.check(minLength(1), maxLength(512)),
  title: Schema.String.check(minLength(1), maxLength(240)),
  details: Schema.optionalKey(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          label: Schema.String.check(maxLength(100)),
          value: Schema.optionalKey(
            Schema.Union([Schema.String.check(maxLength(500)), Schema.Finite, Schema.Null]),
          ),
        }),
      ),
    ).check(maxLength(30)),
  ),
  note: Schema.optionalKey(Schema.String.check(maxLength(5_000))),
  resourceId: Schema.optionalKey(Schema.String.check(maxLength(512))),
  monthlyCost: Schema.optionalKey(
    Schema.Struct({
      amount: Schema.Finite,
      currency: Schema.String.check(minLength(3), maxLength(3)),
    }),
  ),
  remediation: Schema.optionalKey(
    Schema.mutable(Schema.Array(Schema.String.check(maxLength(2_000))))
      .check(maxLength(20))
      .annotate({
        description: "Shell commands that fix the finding, rendered as a code block to review.",
      }),
  ),
  repo: Schema.optionalKey(
    GithubRepoRef.annotate({ description: "Override the routed repository." }),
  ),
  labels: Schema.optionalKey(Labels),
  assignees: Schema.optionalKey(Logins),
  appUrl: Schema.optionalKey(Schema.String.check(isUrl, maxLength(2_000))),
}).annotate({ identifier: "FileGithubIssueInput" });

export const FileGithubIssueResult = Schema.Struct({
  action: Schema.Literals(["created", "commented"]).annotate({
    description: "`commented` when an open issue for the finding already existed.",
  }),
  link: GithubIssueLink,
}).annotate({ identifier: "FileGithubIssueResult" });

export const GithubPullRequestInput = Schema.Struct({
  sourceKind: GithubIssueSourceKind,
  sourceId: Schema.String.check(minLength(1), maxLength(512)),
  resourceId: Schema.String.check(minLength(1), maxLength(512)),
  change: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("resize"),
      recommendedSizeId: Schema.String.check(minLength(1), maxLength(200)),
    }),
    Schema.Struct({ kind: Schema.Literal("remove") }),
  ]),
}).annotate({ identifier: "GithubPullRequestInput" });

export const GithubPullRequestPreview = Schema.Union([
  Schema.Struct({
    eligible: Schema.Literal(true),
    repo: GithubRepoRef,
    baseBranch: Schema.String,
    path: Schema.String,
    terraformAddress: Schema.String,
    title: Schema.String,
    body: Schema.String,
    diff: Schema.String.annotate({ description: "Unified diff of the one file the PR changes." }),
  }),
  Schema.Struct({ eligible: Schema.Literal(false), reason: Schema.String }),
]).annotate({ identifier: "GithubPullRequestPreview" });

export const GithubPullRequestResult = Schema.Struct({
  pullRequest: Schema.Struct({ number: Schema.Int, url: Schema.String }),
  link: Schema.NullOr(GithubIssueLink),
}).annotate({ identifier: "GithubPullRequestResult" });

/**
 * The structured 409 both clients turn into a "grant the permission" prompt:
 * the installation has not approved the app's newer `issues` / `contents` /
 * `pull_requests` permissions.
 */
export class GithubPermissionRequired extends Schema.Error<GithubPermissionRequired>(
  "infrawrench/http/github-issues/PermissionRequired",
)(
  {
    error: Schema.String,
    code: Schema.Literal("github_permission_required"),
    permissions: Schema.Array(Schema.String),
    installationId: Schema.Int,
    accountLogin: Schema.NullOr(Schema.String),
    manageUrl: Schema.NullOr(Schema.String),
  },
  {
    httpApiStatus: 409,
    identifier: "GithubPermissionRequired",
    description:
      "The installation has not accepted the permission this needs. An owner of the GitHub account approves it from `manageUrl`.",
  },
) {}

/** What a call to GitHub can answer besides success. */
const GithubErrors = [BadRequest, GithubPermissionRequired, BadGateway] as const;

export class GithubIssuesGroup extends HttpApiGroup.make("githubIssues")
  .add(
    HttpApiEndpoint.get("status", "/", {
      params: OrgParams,
      success: GithubIssuesStatus,
    })
      .annotate(RequiredPermission, "github-issues:read")
      .annotate(OpenApi.Summary, "Get GitHub issue settings and installation access")
      .annotate(SuccessDescription, "Settings"),
    HttpApiEndpoint.put("updateSettings", "/settings", {
      params: OrgParams,
      payload: GithubIssueSettingsInput,
      success: GithubIssueSettings,
      error: GithubErrors,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Replace the GitHub issue settings")
      .annotate(
        OpenApi.Description,
        "Whole-document replace: route order is part of the meaning. Route and source ids are kept when supplied.",
      )
      .annotate(SuccessDescription, "Saved")
      .annotate(InvalidRequestMessage, "Invalid GitHub issue settings")
      .annotate(HttpApi.PayloadParseOptions, strictBody),
    HttpApiEndpoint.get("labels", "/labels", {
      params: OrgParams,
      query: RepoQuery,
      success: GithubLabels,
      error: GithubErrors,
    })
      .annotate(RequiredPermission, "github-issues:read")
      .annotate(OpenApi.Summary, "List a repository's labels")
      .annotate(OpenApi.Description, "Backs the label picker.")
      .annotate(SuccessDescription, "Labels")
      .annotate(OpenApi.Transform, requiredQuery(["installationId", "repo"])),
    HttpApiEndpoint.get("assignees", "/assignees", {
      params: OrgParams,
      query: RepoQuery,
      success: GithubAssignees,
      error: GithubErrors,
    })
      .annotate(RequiredPermission, "github-issues:read")
      .annotate(OpenApi.Summary, "List a repository's assignable users")
      .annotate(OpenApi.Description, "Backs the assignee picker.")
      .annotate(SuccessDescription, "Assignable users")
      .annotate(OpenApi.Transform, requiredQuery(["installationId", "repo"])),
    HttpApiEndpoint.get("branches", "/branches", {
      params: OrgParams,
      query: RepoQuery,
      success: GithubBranches,
      error: GithubErrors,
    })
      .annotate(RequiredPermission, "github-issues:read")
      .annotate(OpenApi.Summary, "List a repository's branches")
      .annotate(OpenApi.Description, "Backs the base-branch picker for Terraform sources.")
      .annotate(SuccessDescription, "Branch names")
      .annotate(OpenApi.Transform, requiredQuery(["installationId", "repo"])),
    HttpApiEndpoint.get("route", "/route", {
      params: OrgParams,
      query: {
        resourceId: Schema.optionalKey(documentedAs(Schema.String.check(maxLength(512)))),
      },
      success: RouteResolution,
    })
      .annotate(RequiredPermission, "github-issues:read")
      .annotate(OpenApi.Summary, "Resolve where a finding would be filed")
      .annotate(SuccessDescription, "The routed repository"),
    HttpApiEndpoint.post("fileIssue", "/issues", {
      params: OrgParams,
      payload: FileGithubIssueInput,
      success: FileGithubIssueResult,
      error: GithubErrors,
    })
      .annotate(RequiredPermission, "github-issues:write")
      .annotate(OpenApi.Summary, "File a finding as a GitHub issue")
      .annotate(
        OpenApi.Description,
        "Opens an issue in the routed repository, or comments on the open issue already filed for the same finding (matched by fingerprint, including a hidden marker in issue bodies).",
      )
      .annotate(SuccessDescription, "Filed")
      .annotate(InvalidRequestMessage, "Invalid issue")
      .annotate(HttpApi.PayloadParseOptions, strictBody),
    HttpApiEndpoint.get("links", "/links", {
      params: OrgParams,
      query: {
        sourceKind: Schema.optionalKey(GithubIssueSourceKind),
        state: Schema.optionalKey(IssueState),
        sourceId: Schema.optionalKey(
          Schema.Array(Schema.String.check(maxLength(512))).check(maxLength(500)),
        ),
      },
      success: GithubIssueLinks,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "github-issues:read")
      .annotate(OpenApi.Summary, "Look up filed GitHub issues for a set of findings")
      .annotate(SuccessDescription, "Links, newest first")
      .annotate(InvalidRequestMessage, "Invalid link filter"),
    HttpApiEndpoint.post("refreshLinks", "/links/refresh", {
      params: OrgParams,
      success: IssueStatusRefreshResult,
      error: GithubErrors,
    })
      .annotate(RequiredPermission, "github-issues:read")
      .annotate(OpenApi.Summary, "Refresh the status of filed GitHub issues now")
      .annotate(
        OpenApi.Description,
        "Reads up to 200 of the org's filed issues from GitHub (least recently checked first) instead of waiting for the App's webhook or the poll. An issue GitHub no longer has is recorded as deleted.",
      )
      .annotate(SuccessDescription, "How many were checked and changed"),
    HttpApiEndpoint.post("previewPullRequest", "/pull-requests/preview", {
      params: OrgParams,
      payload: GithubPullRequestInput,
      success: GithubPullRequestPreview,
      error: GithubErrors,
    })
      .annotate(RequiredPermission, "github-issues:write")
      .annotate(OpenApi.Summary, "Preview an IaC pull request for a finding")
      .annotate(
        OpenApi.Description,
        "Reads only. Says what the pull request would change (one file, as a diff), or why the change is not mechanical.",
      )
      .annotate(SuccessDescription, "Preview")
      .annotate(InvalidRequestMessage, "Invalid pull request")
      .annotate(HttpApi.PayloadParseOptions, strictBody),
    HttpApiEndpoint.post("openPullRequest", "/pull-requests", {
      params: OrgParams,
      payload: GithubPullRequestInput,
      success: GithubPullRequestResult,
      error: GithubErrors,
    })
      .annotate(RequiredPermission, "github-issues:write")
      .annotate(OpenApi.Summary, "Open an IaC pull request for a finding")
      .annotate(
        OpenApi.Description,
        "Creates a branch, commits the one-file change and opens a pull request against the mapped base branch. Never merged automatically.",
      )
      .annotate(SuccessDescription, "Opened")
      .annotate(InvalidRequestMessage, "Invalid pull request")
      .annotate(HttpApi.PayloadParseOptions, strictBody),
  )
  .prefix("/api/org/:orgId/github-issues")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "GitHub issues") {}

export class GithubIssuesApi extends withApiDefaults(
  HttpApi.make("github-issues").add(GithubIssuesGroup),
) {}
