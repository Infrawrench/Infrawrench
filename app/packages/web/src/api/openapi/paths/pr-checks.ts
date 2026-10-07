import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, IsoDateTime } from "../common";
import type { BuildContext } from "../context";
import { PR_CHECK_LIMITS, PR_CHECK_THRESHOLD_CONCLUSIONS } from "@infrawrench/client-core";

/**
 * Pull request checks: cost and blast radius posted as a GitHub check run on
 * infrastructure pull requests, through the org's GitHub App installation.
 * The schemas here are also the route's runtime validation
 * (`routes/pr-checks.ts` imports them), so the documented shape and the
 * accepted shape cannot drift.
 */

const L = PR_CHECK_LIMITS;

const PermissionLevel = z.enum(["none", "read", "write", "admin"]);

const ThresholdConclusion = z
  .enum(PR_CHECK_THRESHOLD_CONCLUSIONS)
  .openapi("PrCheckThresholdConclusion", {
    description:
      "What the check concludes when the priced monthly increase exceeds `costThreshold`: `neutral` flags it without blocking, `failure` fails it (and blocks merging where branch protection requires the check).",
  });

export const PrCheckRepositoryInput = strict({
  installationId: z.number().int().positive().openapi({
    description: "A GitHub App installation connected to the organization (`/github/status`).",
  }),
  repo: z
    .string()
    .min(3)
    .max(201)
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .openapi({ description: "`owner/name`, as listed by `/github/repos`.", example: "acme/infra" }),
  enabled: z.boolean().openapi({
    description: "Post checks on this repository's pull requests. Off keeps the settings.",
  }),
  commentEnabled: z.boolean().openapi({
    description:
      "Also keep one summary comment on each infrastructure pull request, edited in place on every push rather than re-posted. Needs the installation's `pull_requests: write`.",
  }),
  costThreshold: z.number().min(0).max(L.maxCostThreshold).nullable().openapi({
    description:
      "Monthly cost increase, in the estimate's currency (USD for every provider that prices today), above which the check concludes `thresholdConclusion`. Null never trips. An increase that could not be priced never trips it either.",
    example: 500,
  }),
  thresholdConclusion: ThresholdConclusion,
  directories: z
    .array(z.string().max(L.maxDirectoryLength))
    .max(L.maxDirectories)
    .openapi({
      description:
        "Path prefixes the check looks in, without leading or trailing slashes. Empty covers the whole repository.",
      example: ["infra/prod"],
    }),
}).openapi("PrCheckRepositoryInput");

const PrCheckRepository = PrCheckRepositoryInput.extend({
  id: z.string(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("PrCheckRepository");

const PrCheckInstallationAccess = strict({
  installationId: z.number().int(),
  accountLogin: z.string().nullable(),
  checks: PermissionLevel,
  pullRequests: PermissionLevel,
  contents: PermissionLevel,
  suspended: z.boolean(),
  manageUrl: z.string().nullable(),
  checked: z.boolean().openapi({
    description: "False when GitHub could not be asked; the levels are then all `none`.",
  }),
}).openapi("PrCheckInstallationAccess", {
  description:
    "What an installation has **accepted** of the permissions checks need: `checks: write`, `pull_requests` (read, or write for the comment) and `contents: read`. An installation made before checks existed shows `checks: none` until an owner of the GitHub account approves the app's updated permissions.",
});

const PrCheckStatus = strict({
  appConfigured: z.boolean(),
  installations: z.array(PrCheckInstallationAccess),
  repositories: z.array(PrCheckRepository),
}).openapi("PrCheckStatus");

const EstimateSide = strict({
  monthlyAmount: z.number(),
  currency: z.string(),
  partial: z.boolean(),
}).openapi("PrCheckEstimateSide");

const BlastSeverity = z.enum(["none", "low", "medium", "high", "unknown"]);

const PrCheckChange = strict({
  address: z.string(),
  terraformType: z.string(),
  action: z.enum(["create", "update", "delete"]),
  path: z.string(),
  line: z.number().int().nullable(),
  resourceId: z.string().nullable().openapi({
    description: "The synced resource the block manages, matched through uploaded Terraform state.",
  }),
  displayName: z.string().nullable(),
  pluginId: z.string().nullable(),
  resourceTypeId: z.string().nullable(),
  changedAttributes: z.array(z.string()),
  count: z.number().int().nullable().openapi({
    description: "The block's literal `count`; null for `for_each` or a computed count.",
  }),
  before: EstimateSide.nullable(),
  after: EstimateSide.nullable(),
  monthlyDelta: z.number().nullable().openapi({
    description: "Null when either side could not be priced; never zero for unknown.",
  }),
  currency: z.string().nullable(),
  unpricedReason: z.string().nullable(),
  blastRadius: strict({
    directDependants: z.number().int(),
    transitiveDependants: z.number().int(),
    references: z.number().int(),
    severity: BlastSeverity,
    headline: z.string(),
    topDependants: z.array(z.string()),
    unchecked: z.number().int(),
  }).nullable(),
  warnings: z.array(
    strict({
      kind: z.enum(["rightsizing", "tag-policy", "posture", "parse"]),
      severity: z.enum(["notice", "warning"]),
      message: z.string(),
    }),
  ),
}).openapi("PrCheckChange");

const PrCheckReport = strict({
  generatedAt: IsoDateTime,
  files: z.array(
    strict({
      path: z.string(),
      kind: z.enum(["terraform", "infrafile", "kubernetes"]),
      status: z.enum(["added", "modified", "removed", "renamed"]),
      analysed: z.boolean(),
      note: z.string().nullable(),
    }),
  ),
  changes: z.array(PrCheckChange),
  totals: strict({
    monthlyDelta: z.number().nullable(),
    currency: z.string().nullable(),
    partial: z.boolean(),
    pricedChanges: z.number().int(),
    unpricedChanges: z.number().int(),
    otherCurrencyChanges: z.number().int(),
  }),
  blast: strict({
    touchedResources: z.number().int(),
    dependants: z.number().int(),
    highestSeverity: BlastSeverity.nullable(),
  }),
  notes: z.array(z.string()),
  truncated: z.boolean(),
}).openapi("PrCheckReport");

const Conclusion = z.enum(["success", "neutral", "failure"]).openapi("PrCheckConclusion");

const PrCheckRun = strict({
  id: z.string(),
  repositoryId: z.string(),
  repo: z.string(),
  pullNumber: z.number().int(),
  pullTitle: z.string().nullable(),
  pullUrl: z.string().nullable(),
  headSha: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  conclusion: Conclusion.nullable(),
  checkRunUrl: z.string().nullable(),
  commentUrl: z.string().nullable(),
  report: PrCheckReport.nullable(),
  error: z.string().nullable(),
  createdAt: IsoDateTime,
  completedAt: IsoDateTime.nullable(),
}).openapi("PrCheckRun");

export const PrCheckRunsQuery = strict({
  repositoryId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const PreviewFile = strict({
  path: z.string().min(1).max(1024),
  before: z.string().max(L.maxFileBytes).nullable(),
  after: z.string().max(L.maxFileBytes).nullable(),
});

export const PrCheckPreviewInput = z
  .union([
    strict({
      repositoryId: z.string().min(1).max(64),
      pullNumber: z.number().int().positive(),
    }),
    strict({
      files: z.array(PreviewFile).min(1).max(L.maxFiles),
      repo: z.string().max(201).optional().openapi({
        description:
          "`owner/name`, to apply that repository's settings and its Terraform state mapping.",
      }),
    }),
  ])
  .openapi("PrCheckPreviewInput", {
    description:
      "Either a configured repository and pull request number (read through the GitHub App), or file contents from a local diff (`before` null for an added file, `after` null for a removed one).",
  });

const PrCheckPreview = strict({
  report: PrCheckReport,
  conclusion: Conclusion,
  title: z.string(),
  markdown: z.string().openapi({ description: "The check run summary, as GitHub renders it." }),
}).openapi("PrCheckPreview");

const IdParam = OrgIdParam.extend({ id: z.string().min(1).max(64) });

const githubFailure = {
  description: "GitHub refused the request or was unreachable",
  content: { "application/json": { schema: strict({ error: z.string() }) } },
};

export function registerPrChecksPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const tags = ["Pull request checks"];

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/pr-checks",
    tags,
    summary: "Get pull request check settings and installation access",
    request: { params: OrgIdParam },
    responses: {
      200: { description: "Settings", content: { "application/json": { schema: PrCheckStatus } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/pr-checks/repositories",
    tags,
    summary: "List repositories with pull request checks",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Repositories",
        content: { "application/json": { schema: z.array(PrCheckRepository) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/pr-checks/repositories",
    tags,
    summary: "Turn on pull request checks for a repository",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: PrCheckRepositoryInput } }, required: true },
    },
    responses: {
      201: {
        description: "Created",
        content: { "application/json": { schema: PrCheckRepository } },
      },
      400: ErrorResponses[400],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/pr-checks/repositories/{id}",
    tags,
    summary: "Get one repository's pull request check settings",
    request: { params: IdParam },
    responses: {
      200: {
        description: "Repository",
        content: { "application/json": { schema: PrCheckRepository } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/pr-checks/repositories/{id}",
    tags,
    summary: "Replace one repository's pull request check settings",
    request: {
      params: IdParam,
      body: { content: { "application/json": { schema: PrCheckRepositoryInput } }, required: true },
    },
    responses: {
      200: { description: "Saved", content: { "application/json": { schema: PrCheckRepository } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/pr-checks/repositories/{id}",
    tags,
    summary: "Stop pull request checks for a repository",
    description: "Removes the settings and the repository's check history.",
    request: { params: IdParam },
    responses: {
      200: {
        description: "Deleted",
        content: { "application/json": { schema: strict({ ok: z.literal(true) }) } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/pr-checks/runs",
    tags,
    summary: "List recent pull request checks",
    request: { params: OrgIdParam, query: PrCheckRunsQuery },
    responses: {
      200: {
        description: "Runs, newest first",
        content: { "application/json": { schema: z.array(PrCheckRun) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/pr-checks/preview",
    tags,
    summary: "Preview a pull request check without posting it",
    description:
      "Runs the same analysis the check posts, for a pull request in a configured repository or for file contents from a local diff. Reads only: nothing is posted to GitHub and nothing is stored.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: PrCheckPreviewInput } }, required: true },
    },
    responses: {
      200: { description: "Preview", content: { "application/json": { schema: PrCheckPreview } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      502: githubFailure,
    },
  });
}
