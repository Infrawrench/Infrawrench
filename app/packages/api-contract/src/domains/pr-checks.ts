/**
 * Pull request checks: `/api/org/:orgId/pr-checks`, the endpoint definitions.
 *
 * Cost and blast radius posted as a GitHub check run on infrastructure pull
 * requests, through the org's GitHub App installation. The request schemas
 * here are also the routes' validation, so the documented shape and the
 * accepted shape cannot drift. The VS Code and Raycast extensions call the
 * preview.
 *
 * Reads and the preview take `iac:read`, the permission the IaC page and its
 * Terraform state need, because the check reads that state; writes take
 * `org:settings:write`, because a repository's threshold can fail pull
 * requests where branch protection requires the check.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { PR_CHECK_LIMITS, PR_CHECK_THRESHOLD_CONCLUSIONS } from "@infrawrench/client-core";
import { maxLength, minLength, pattern } from "../schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadGateway, BadRequest, Conflict, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { documentedAs } from "../http/schemas/documented";
import { numericQuery } from "../http/schemas/query";
import { IsoDateTime, OrgId, OrgParams } from "../http/schemas/common";

const L = PR_CHECK_LIMITS;

/** Zod's `.strict()`: an unknown key is a 400, at every level of the body. */
const strictBody = { errors: "all", onExcessProperty: "error" } as const;

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

const PermissionLevel = Schema.Literals(["none", "read", "write", "admin"]);

const ThresholdConclusion = Schema.Literals(PR_CHECK_THRESHOLD_CONCLUSIONS).annotate({
  identifier: "PrCheckThresholdConclusion",
  description:
    "What the check concludes when the priced monthly increase exceeds `costThreshold`: `neutral` flags it without blocking, `failure` fails it (and blocks merging where branch protection requires the check).",
});

const repositoryInputFields = {
  installationId: PositiveInt.annotate({
    description: "A GitHub App installation connected to the organization (`/github/status`).",
  }),
  repo: Schema.String.check(
    minLength(3),
    maxLength(201),
    pattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  ).annotate({
    description: "`owner/name`, as listed by `/github/repos`.",
    examples: ["acme/infra"],
  }),
  enabled: Schema.Boolean.annotate({
    description: "Post checks on this repository's pull requests. Off keeps the settings.",
  }),
  commentEnabled: Schema.Boolean.annotate({
    description:
      "Also keep one summary comment on each infrastructure pull request, edited in place on every push rather than re-posted. Needs the installation's `pull_requests: write`.",
  }),
  costThreshold: Schema.NullOr(
    Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: L.maxCostThreshold })),
  ).annotate({
    description:
      "Monthly cost increase, in the estimate's currency (USD for every provider that prices today), above which the check concludes `thresholdConclusion`. Null never trips. An increase that could not be priced never trips it either.",
    examples: [500],
  }),
  thresholdConclusion: ThresholdConclusion,
  directories: Schema.mutable(
    Schema.Array(Schema.String.check(maxLength(L.maxDirectoryLength))).check(
      maxLength(L.maxDirectories),
    ),
  ).annotate({
    description:
      "Path prefixes the check looks in, without leading or trailing slashes. Empty covers the whole repository.",
    examples: [["infra/prod"]],
  }),
};

export const PrCheckRepositoryInput = Schema.Struct(repositoryInputFields).annotate({
  identifier: "PrCheckRepositoryInput",
});

export const PrCheckRepository = Schema.Struct({
  ...repositoryInputFields,
  id: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "PrCheckRepository" });

const PrCheckInstallationAccess = Schema.Struct({
  installationId: Schema.Int,
  accountLogin: Schema.NullOr(Schema.String),
  checks: PermissionLevel,
  pullRequests: PermissionLevel,
  contents: PermissionLevel,
  suspended: Schema.Boolean,
  manageUrl: Schema.NullOr(Schema.String),
  checked: Schema.Boolean.annotate({
    description: "False when GitHub could not be asked; the levels are then all `none`.",
  }),
}).annotate({
  identifier: "PrCheckInstallationAccess",
  description:
    "What an installation has **accepted** of the permissions checks need: `checks: write`, `pull_requests` (read, or write for the comment) and `contents: read`. An installation made before checks existed shows `checks: none` until an owner of the GitHub account approves the app's updated permissions.",
});

export const PrCheckStatus = Schema.Struct({
  appConfigured: Schema.Boolean,
  installations: Schema.Array(PrCheckInstallationAccess),
  repositories: Schema.Array(PrCheckRepository),
}).annotate({ identifier: "PrCheckStatus" });

const EstimateSide = Schema.Struct({
  monthlyAmount: Schema.Finite,
  currency: Schema.String,
  partial: Schema.Boolean,
}).annotate({ identifier: "PrCheckEstimateSide" });

const BlastSeverity = Schema.Literals(["none", "low", "medium", "high", "unknown"]);

const PrCheckChange = Schema.Struct({
  address: Schema.String,
  terraformType: Schema.String,
  action: Schema.Literals(["create", "update", "delete"]),
  path: Schema.String,
  line: Schema.NullOr(Schema.Int),
  resourceId: Schema.NullOr(Schema.String).annotate({
    description: "The synced resource the block manages, matched through uploaded Terraform state.",
  }),
  displayName: Schema.NullOr(Schema.String),
  pluginId: Schema.NullOr(Schema.String),
  resourceTypeId: Schema.NullOr(Schema.String),
  changedAttributes: Schema.Array(Schema.String),
  count: Schema.NullOr(Schema.Int).annotate({
    description: "The block's literal `count`; null for `for_each` or a computed count.",
  }),
  before: Schema.NullOr(EstimateSide),
  after: Schema.NullOr(EstimateSide),
  monthlyDelta: Schema.NullOr(Schema.Finite).annotate({
    description: "Null when either side could not be priced; never zero for unknown.",
  }),
  currency: Schema.NullOr(Schema.String),
  unpricedReason: Schema.NullOr(Schema.String),
  blastRadius: Schema.NullOr(
    Schema.Struct({
      directDependants: Schema.Int,
      transitiveDependants: Schema.Int,
      references: Schema.Int,
      severity: BlastSeverity,
      headline: Schema.String,
      topDependants: Schema.Array(Schema.String),
      unchecked: Schema.Int,
    }),
  ),
  warnings: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["rightsizing", "tag-policy", "posture", "parse"]),
      severity: Schema.Literals(["notice", "warning"]),
      message: Schema.String,
    }),
  ),
}).annotate({ identifier: "PrCheckChange" });

const PrCheckReport = Schema.Struct({
  generatedAt: IsoDateTime,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      kind: Schema.Literals(["terraform", "infrafile", "kubernetes"]),
      status: Schema.Literals(["added", "modified", "removed", "renamed"]),
      analysed: Schema.Boolean,
      note: Schema.NullOr(Schema.String),
    }),
  ),
  changes: Schema.Array(PrCheckChange),
  totals: Schema.Struct({
    monthlyDelta: Schema.NullOr(Schema.Finite),
    currency: Schema.NullOr(Schema.String),
    partial: Schema.Boolean,
    pricedChanges: Schema.Int,
    unpricedChanges: Schema.Int,
    otherCurrencyChanges: Schema.Int,
  }),
  blast: Schema.Struct({
    touchedResources: Schema.Int,
    dependants: Schema.Int,
    highestSeverity: Schema.NullOr(BlastSeverity),
  }),
  notes: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
}).annotate({ identifier: "PrCheckReport" });

const Conclusion = Schema.Literals(["success", "neutral", "failure"]).annotate({
  identifier: "PrCheckConclusion",
});

export const PrCheckRun = Schema.Struct({
  id: Schema.String,
  repositoryId: Schema.String,
  repo: Schema.String,
  pullNumber: Schema.Int,
  pullTitle: Schema.NullOr(Schema.String),
  pullUrl: Schema.NullOr(Schema.String),
  headSha: Schema.String,
  status: Schema.Literals(["running", "completed", "failed"]),
  conclusion: Schema.NullOr(Conclusion),
  checkRunUrl: Schema.NullOr(Schema.String),
  commentUrl: Schema.NullOr(Schema.String),
  report: Schema.NullOr(PrCheckReport),
  error: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "PrCheckRun" });

const PreviewFile = Schema.Struct({
  path: Schema.String.check(minLength(1), maxLength(1024)),
  before: Schema.NullOr(Schema.String.check(maxLength(L.maxFileBytes))),
  after: Schema.NullOr(Schema.String.check(maxLength(L.maxFileBytes))),
});

export const PrCheckPreviewInput = Schema.Union([
  Schema.Struct({
    repositoryId: Schema.String.check(minLength(1), maxLength(64)),
    pullNumber: PositiveInt,
  }),
  Schema.Struct({
    files: Schema.mutable(Schema.Array(PreviewFile)).check(minLength(1), maxLength(L.maxFiles)),
    repo: Schema.optionalKey(
      Schema.String.check(maxLength(201)).annotate({
        description:
          "`owner/name`, to apply that repository's settings and its Terraform state mapping.",
      }),
    ),
  }),
]).annotate({
  identifier: "PrCheckPreviewInput",
  description:
    "Either a configured repository and pull request number (read through the GitHub App), or file contents from a local diff (`before` null for an added file, `after` null for a removed one).",
});

export const PrCheckPreview = Schema.Struct({
  report: PrCheckReport,
  conclusion: Conclusion,
  title: Schema.String,
  markdown: Schema.String.annotate({ description: "The check run summary, as GitHub renders it." }),
}).annotate({ identifier: "PrCheckPreview" });

export const PrCheckDeleted = Schema.Struct({ ok: Schema.Literal(true) });

/** Repository ids were never checked: an id out of these bounds finds nothing (404). */
const IdParams = {
  orgId: OrgId,
  id: documentedAs(Schema.String.check(minLength(1), maxLength(64))),
} as const;

export class PrChecksGroup extends HttpApiGroup.make("prChecks")
  .add(
    HttpApiEndpoint.get("status", "/", {
      params: OrgParams,
      success: PrCheckStatus,
    })
      .annotate(RequiredPermission, "iac:read")
      .annotate(OpenApi.Summary, "Get pull request check settings and installation access")
      .annotate(SuccessDescription, "Settings"),
    HttpApiEndpoint.get("listRepositories", "/repositories", {
      params: OrgParams,
      success: Schema.Array(PrCheckRepository),
    })
      .annotate(RequiredPermission, "iac:read")
      .annotate(OpenApi.Summary, "List repositories with pull request checks")
      .annotate(SuccessDescription, "Repositories"),
    HttpApiEndpoint.post("createRepository", "/repositories", {
      params: OrgParams,
      payload: PrCheckRepositoryInput,
      success: PrCheckRepository.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, Conflict],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Turn on pull request checks for a repository")
      .annotate(HttpApi.PayloadParseOptions, strictBody)
      .annotate(InvalidRequestMessage, "Invalid repository settings")
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.get("getRepository", "/repositories/:id", {
      params: IdParams,
      success: PrCheckRepository,
      error: NotFound,
    })
      .annotate(RequiredPermission, "iac:read")
      .annotate(OpenApi.Summary, "Get one repository's pull request check settings")
      .annotate(SuccessDescription, "Repository"),
    HttpApiEndpoint.put("updateRepository", "/repositories/:id", {
      params: IdParams,
      payload: PrCheckRepositoryInput,
      success: PrCheckRepository,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Replace one repository's pull request check settings")
      .annotate(HttpApi.PayloadParseOptions, strictBody)
      .annotate(InvalidRequestMessage, "Invalid repository settings")
      .annotate(SuccessDescription, "Saved"),
    HttpApiEndpoint.delete("deleteRepository", "/repositories/:id", {
      params: IdParams,
      success: PrCheckDeleted,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Stop pull request checks for a repository")
      .annotate(OpenApi.Description, "Removes the settings and the repository's check history.")
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.get("runs", "/runs", {
      params: OrgParams,
      query: {
        repositoryId: Schema.optionalKey(Schema.String.check(maxLength(64))),
        limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
      },
      success: Schema.Array(PrCheckRun),
      error: BadRequest,
    })
      .annotate(RequiredPermission, "iac:read")
      .annotate(OpenApi.Summary, "List recent pull request checks")
      .annotate(InvalidRequestMessage, "Invalid query")
      .annotate(
        OpenApi.Transform,
        numericQuery({ limit: { type: "integer", minimum: 1, maximum: 200 } }),
      )
      .annotate(SuccessDescription, "Runs, newest first"),
    HttpApiEndpoint.post("preview", "/preview", {
      params: OrgParams,
      payload: PrCheckPreviewInput,
      success: PrCheckPreview,
      error: [BadRequest, NotFound, BadGateway],
    })
      .annotate(RequiredPermission, "iac:read")
      .annotate(OpenApi.Summary, "Preview a pull request check without posting it")
      .annotate(
        OpenApi.Description,
        "Runs the same analysis the check posts, for a pull request in a configured repository or for file contents from a local diff. Reads only: nothing is posted to GitHub and nothing is stored.",
      )
      .annotate(HttpApi.PayloadParseOptions, strictBody)
      .annotate(InvalidRequestMessage, "Invalid preview request")
      .annotate(SuccessDescription, "Preview"),
  )
  .prefix("/api/org/:orgId/pr-checks")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Pull request checks") {}

export class PrChecksApi extends withApiDefaults(HttpApi.make("prChecks").add(PrChecksGroup)) {}
