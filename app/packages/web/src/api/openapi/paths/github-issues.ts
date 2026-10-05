import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, IsoDateTime } from "../common";
import type { BuildContext } from "../context";
import { GITHUB_ISSUE_LIMITS, GITHUB_ISSUE_SOURCE_KINDS } from "@infrawrench/client-core";

/**
 * GitHub issue filing for findings, through the org's GitHub App
 * installation. The schemas here are also the route's runtime validation
 * (`routes/github-issues.ts` imports them), so the documented shape and the
 * accepted shape cannot drift.
 */

const L = GITHUB_ISSUE_LIMITS;

export const GithubIssueSourceKind = z
  .enum(GITHUB_ISSUE_SOURCE_KINDS)
  .openapi("GithubIssueSourceKind", {
    description: "Which detector produced the finding the issue was filed from.",
  });

export const GithubRepoRef = strict({
  installationId: z.number().int().positive().openapi({
    description: "A GitHub App installation connected to the organization (`/github/status`).",
  }),
  fullName: z
    .string()
    .min(3)
    .max(201)
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .openapi({ description: "`owner/name`, as listed by `/github/repos`.", example: "acme/infra" }),
}).openapi("GithubRepoRef");

const Label = z.string().min(1).max(L.maxLabelLength);
const Login = z.string().min(1).max(39);

const GithubIssueRouteMatch = z
  .discriminatedUnion("kind", [
    strict({
      kind: z.literal("cost_centre"),
      costCentreId: z.string().min(1).max(64).openapi({ description: "A cost centre id." }),
    }),
    strict({
      kind: z.literal("tag"),
      tagKey: z.string().min(1).max(128),
      tagValue: z.string().max(256).nullable().openapi({
        description: "Null matches any value of the key.",
      }),
    }),
  ])
  .openapi("GithubIssueRouteMatch", {
    description:
      "What sends a finding to this route's repository: the cost centre the organization's allocation rules place its resource in, or a tag on the resource. Allocation rules that match on `service` cannot be judged from a resource and never match here.",
  });

const GithubIssueRouteInput = strict({
  id: z.string().max(64).optional(),
  match: GithubIssueRouteMatch,
  repo: GithubRepoRef,
  labels: z.array(Label).max(L.maxLabels).openapi({
    description: "Added to the organization-wide labels.",
  }),
  assignees: z.array(Login).max(L.maxAssignees).openapi({
    description: "Replace the organization-wide assignees when non-empty.",
  }),
}).openapi("GithubIssueRouteInput");

const GithubIssueRoute = GithubIssueRouteInput.extend({ id: z.string() }).openapi(
  "GithubIssueRoute",
);

const GithubIacSourceInput = strict({
  id: z.string().max(64).optional(),
  iacAccountId: z.string().max(64).nullable().openapi({
    description:
      "The IaC state scope this maps: the account an uploaded state document covers, or null for the organization-wide state.",
  }),
  repo: GithubRepoRef,
  baseBranch: z.string().max(255).nullable().openapi({
    description: "Branch pull requests target. Null means the repository's default branch.",
  }),
  directory: z.string().max(L.maxDirectoryLength).openapi({
    description: "Directory holding the root module's `.tf` files. Empty for the repository root.",
    example: "infra/prod",
  }),
}).openapi("GithubIacSourceInput");

const GithubIacSource = GithubIacSourceInput.extend({ id: z.string() }).openapi("GithubIacSource");

const ResolveAction = z.enum(["close", "comment", "none"]).openapi("GithubResolveAction", {
  description:
    "What happens to an open issue when its finding goes away: close it with a comment, only comment, or leave it alone.",
});

export const GithubIssueSettingsInput = strict({
  enabled: z.boolean().openapi({ description: "Master switch for filing, manual and routed." }),
  defaultRepo: GithubRepoRef.nullable(),
  labels: z.array(Label).max(L.maxLabels),
  assignees: z.array(Login).max(L.maxAssignees),
  routes: z.array(GithubIssueRouteInput).max(L.maxRoutes).openapi({
    description: "Ordered; the first match wins and no match falls back to `defaultRepo`.",
  }),
  resolveAction: ResolveAction,
  pullRequestsEnabled: z.boolean().openapi({
    description:
      "Allow holders of `github-issues:write` to open pull requests editing Terraform for IaC-managed findings. Never auto-merged.",
  }),
  iacSources: z.array(GithubIacSourceInput).max(L.maxIacSources),
}).openapi("GithubIssueSettingsInput");

const GithubIssueSettings = strict({
  enabled: z.boolean(),
  defaultRepo: GithubRepoRef.nullable(),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  routes: z.array(GithubIssueRoute),
  resolveAction: ResolveAction,
  pullRequestsEnabled: z.boolean(),
  iacSources: z.array(GithubIacSource),
  updatedAt: IsoDateTime.nullable(),
}).openapi("GithubIssueSettings");

const PermissionLevel = z.enum(["none", "read", "write", "admin"]);

const GithubInstallationAccess = strict({
  installationId: z.number().int(),
  accountLogin: z.string().nullable(),
  issues: PermissionLevel,
  pullRequests: PermissionLevel,
  contents: PermissionLevel,
  suspended: z.boolean(),
  manageUrl: z.string().nullable(),
  checked: z.boolean().openapi({
    description: "False when GitHub could not be asked; the levels are then all `none`.",
  }),
}).openapi("GithubInstallationAccess", {
  description:
    "What an installation has **accepted**. An installation made before issue filing existed shows `issues: none` until an owner of the GitHub account approves the app's updated permissions.",
});

const GithubIssuesStatus = strict({
  appConfigured: z.boolean(),
  installations: z.array(GithubInstallationAccess),
  settings: GithubIssueSettings,
}).openapi("GithubIssuesStatus");

export const RepoQuery = strict({
  installationId: z.coerce.number().int().positive(),
  repo: z.string().min(3).max(201),
});

const GithubLabel = strict({
  name: z.string(),
  color: z.string(),
  description: z.string().nullable(),
}).openapi("GithubLabel");

const GithubAssignee = strict({
  login: z.string(),
  avatarUrl: z.string().nullable(),
}).openapi("GithubAssignee");

const GithubIssueLink = strict({
  id: z.string(),
  sourceKind: GithubIssueSourceKind,
  sourceId: z.string(),
  fingerprint: z.string().openapi({
    description: "Hash of the finding; also written into the issue body as a hidden marker.",
  }),
  repo: z.string(),
  installationId: z.number().int(),
  issueNumber: z.number().int(),
  issueUrl: z.string(),
  state: z.enum(["open", "closed"]),
  autoFiled: z.boolean(),
  pullRequestNumber: z.number().int().nullable(),
  pullRequestUrl: z.string().nullable(),
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
  resolvedAt: IsoDateTime.nullable(),
}).openapi("GithubIssueLink");

const RouteResolution = strict({
  repo: GithubRepoRef.nullable(),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  routeId: z.string().nullable(),
}).openapi("GithubIssueRouteResolution");

export const FileGithubIssueInput = strict({
  sourceKind: GithubIssueSourceKind,
  sourceId: z.string().min(1).max(512),
  title: z.string().min(1).max(240),
  details: z
    .array(
      strict({
        label: z.string().max(100),
        value: z.union([z.string().max(500), z.number(), z.null()]).optional(),
      }),
    )
    .max(30)
    .optional(),
  note: z.string().max(5_000).optional(),
  resourceId: z.string().max(512).optional(),
  monthlyCost: strict({ amount: z.number().finite(), currency: z.string().length(3) }).optional(),
  remediation: z.array(z.string().max(2_000)).max(20).optional().openapi({
    description: "Shell commands that fix the finding, rendered as a code block to review.",
  }),
  repo: GithubRepoRef.optional().openapi({ description: "Override the routed repository." }),
  labels: z.array(Label).max(L.maxLabels).optional(),
  assignees: z.array(Login).max(L.maxAssignees).optional(),
  appUrl: z.string().url().max(2_000).optional(),
}).openapi("FileGithubIssueInput");

const FileGithubIssueResult = strict({
  action: z.enum(["created", "commented"]).openapi({
    description: "`commented` when an open issue for the finding already existed.",
  }),
  link: GithubIssueLink,
}).openapi("FileGithubIssueResult");

export const LinksQuery = strict({
  sourceKind: GithubIssueSourceKind.optional(),
  state: z.enum(["open", "closed"]).optional(),
  sourceId: z.array(z.string().max(512)).max(500).optional(),
});

export const GithubPullRequestInput = strict({
  sourceKind: GithubIssueSourceKind,
  sourceId: z.string().min(1).max(512),
  resourceId: z.string().min(1).max(512),
  change: z.discriminatedUnion("kind", [
    strict({ kind: z.literal("resize"), recommendedSizeId: z.string().min(1).max(200) }),
    strict({ kind: z.literal("remove") }),
  ]),
}).openapi("GithubPullRequestInput");

const GithubPullRequestPreview = z
  .union([
    strict({
      eligible: z.literal(true),
      repo: GithubRepoRef,
      baseBranch: z.string(),
      path: z.string(),
      terraformAddress: z.string(),
      title: z.string(),
      body: z.string(),
      diff: z.string().openapi({ description: "Unified diff of the one file the PR changes." }),
    }),
    strict({ eligible: z.literal(false), reason: z.string() }),
  ])
  .openapi("GithubPullRequestPreview");

const GithubPullRequestResult = strict({
  pullRequest: strict({ number: z.number().int(), url: z.string() }),
  link: GithubIssueLink.nullable(),
}).openapi("GithubPullRequestResult");

const PermissionRequired = strict({
  error: z.string(),
  code: z.literal("github_permission_required"),
  permissions: z.array(z.string()),
  installationId: z.number().int(),
  accountLogin: z.string().nullable(),
  manageUrl: z.string().nullable(),
}).openapi("GithubPermissionRequired", {
  description:
    "The installation has not accepted the permission this needs. An owner of the GitHub account approves it from `manageUrl`.",
});

const permissionResponse = {
  description: "The GitHub App installation needs a permission an owner has not approved yet",
  content: { "application/json": { schema: PermissionRequired } },
};
const githubFailure = {
  description: "GitHub refused the request or was unreachable",
  content: { "application/json": { schema: strict({ error: z.string() }) } },
};

export function registerGithubIssuesPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const tags = ["GitHub issues"];

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/github-issues",
    tags,
    summary: "Get GitHub issue settings and installation access",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Settings",
        content: { "application/json": { schema: GithubIssuesStatus } },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/github-issues/settings",
    tags,
    summary: "Replace the GitHub issue settings",
    description:
      "Whole-document replace: route order is part of the meaning. Route and source ids are kept when supplied.",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: GithubIssueSettingsInput } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Saved",
        content: { "application/json": { schema: GithubIssueSettings } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/github-issues/labels",
    tags,
    summary: "List a repository's labels",
    description: "Backs the label picker.",
    request: { params: OrgIdParam, query: RepoQuery },
    responses: {
      200: {
        description: "Labels",
        content: { "application/json": { schema: z.array(GithubLabel) } },
      },
      400: ErrorResponses[400],
      409: permissionResponse,
      502: githubFailure,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/github-issues/assignees",
    tags,
    summary: "List a repository's assignable users",
    description: "Backs the assignee picker.",
    request: { params: OrgIdParam, query: RepoQuery },
    responses: {
      200: {
        description: "Assignable users",
        content: { "application/json": { schema: z.array(GithubAssignee) } },
      },
      400: ErrorResponses[400],
      409: permissionResponse,
      502: githubFailure,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/github-issues/branches",
    tags,
    summary: "List a repository's branches",
    description: "Backs the base-branch picker for Terraform sources.",
    request: { params: OrgIdParam, query: RepoQuery },
    responses: {
      200: {
        description: "Branch names",
        content: { "application/json": { schema: z.array(z.string()) } },
      },
      400: ErrorResponses[400],
      409: permissionResponse,
      502: githubFailure,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/github-issues/route",
    tags,
    summary: "Resolve where a finding would be filed",
    request: {
      params: OrgIdParam,
      query: strict({ resourceId: z.string().max(512).optional() }),
    },
    responses: {
      200: {
        description: "The routed repository",
        content: { "application/json": { schema: RouteResolution } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/github-issues/issues",
    tags,
    summary: "File a finding as a GitHub issue",
    description:
      "Opens an issue in the routed repository, or comments on the open issue already filed for the same finding (matched by fingerprint, including a hidden marker in issue bodies).",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: FileGithubIssueInput } }, required: true },
    },
    responses: {
      200: {
        description: "Filed",
        content: { "application/json": { schema: FileGithubIssueResult } },
      },
      400: ErrorResponses[400],
      409: permissionResponse,
      502: githubFailure,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/github-issues/links",
    tags,
    summary: "Look up filed GitHub issues for a set of findings",
    request: { params: OrgIdParam, query: LinksQuery },
    responses: {
      200: {
        description: "Links, newest first",
        content: { "application/json": { schema: z.array(GithubIssueLink) } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/github-issues/pull-requests/preview",
    tags,
    summary: "Preview an IaC pull request for a finding",
    description:
      "Reads only. Says what the pull request would change (one file, as a diff), or why the change is not mechanical.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: GithubPullRequestInput } }, required: true },
    },
    responses: {
      200: {
        description: "Preview",
        content: { "application/json": { schema: GithubPullRequestPreview } },
      },
      400: ErrorResponses[400],
      409: permissionResponse,
      502: githubFailure,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/github-issues/pull-requests",
    tags,
    summary: "Open an IaC pull request for a finding",
    description:
      "Creates a branch, commits the one-file change and opens a pull request against the mapped base branch. Never merged automatically.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: GithubPullRequestInput } }, required: true },
    },
    responses: {
      200: {
        description: "Opened",
        content: { "application/json": { schema: GithubPullRequestResult } },
      },
      400: ErrorResponses[400],
      409: permissionResponse,
      502: githubFailure,
    },
  });
}
