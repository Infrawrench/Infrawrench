import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const AccessReviewSeverity = z.enum(["critical", "high", "medium", "low"]).openapi({
  description:
    "How bad the finding is. `critical` and `high` findings ride the posture alert window; " +
    "`medium` and `low` are review work surfaced on the access review screen and in the " +
    "weekly digest only.",
});

const PrincipalRole = z
  .enum(["user", "group", "role", "service-account", "key", "binding"])
  .openapi({
    description:
      "What kind of identity the principal is, from the resource type's `principalRole` " +
      "declaration. Grouping and labels only — it is not a permission model.",
  });

const PrincipalActivity = z.enum(["active", "stale", "unknown"]).openapi({
  description:
    "What could be established about the principal's last use. `unknown` means the resource " +
    "type declares no last-used field, or the provider stored nothing parseable — it is a " +
    "first-class answer and is never reported as `stale`.",
});

const AccessReviewRuleId = z
  .enum([
    "access-review:stale-principal",
    "access-review:admin-principal",
    "access-review:key-past-rotation",
    "access-review:no-recorded-owner",
    "access-review:no-mfa",
  ])
  .openapi({
    description:
      "Which rule was raised. Half of a dismissal's key, alongside the resource id. The " +
      "`access-review:` prefix is reserved so these can share the posture dismissal store " +
      "without colliding with plugin-declared posture rule ids.",
  });

export function registerAccessReviewPaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const AccessPrincipalOwner = strict({
    userId: Uuid.nullable().describe("Infrawrench user id when the owner is a member."),
    displayName: z.string().describe("Member name, or the free-text owner label."),
    isLabel: z.boolean().describe("True when the owner is a label rather than a routable member."),
    ticketUrl: z.string().nullable(),
    purpose: z.string().nullable(),
  }).openapi("AccessPrincipalOwner");

  const AccessPrincipal = strict({
    resourceId: z.string().describe("Infrawrench resource id."),
    pluginId: enums.PluginId,
    pluginName: z.string().openapi({ example: "AWS" }),
    resourceTypeId: z.string(),
    resourceTypeName: z.string().openapi({ example: "IAM User" }),
    accountId: Uuid,
    accountName: z.string(),
    displayName: z.string(),
    externalId: z.string().nullable().describe("Provider-native id, when known."),
    role: PrincipalRole,
    lastUsedAt: IsoDateTime.nullable().describe(
      "When the principal was last used, or null when the review has no evidence.",
    ),
    daysSinceLastUsed: z.number().int().nullable(),
    activity: PrincipalActivity,
    createdAt: IsoDateTime.nullable(),
    ageDays: z.number().int().nullable(),
    admin: z
      .boolean()
      .nullable()
      .describe(
        "True when the type's declared admin indicator matched; null when the type declares none.",
      ),
    mfa: z
      .boolean()
      .nullable()
      .describe(
        "Multi-factor state, only on types that declare an MFA field. Null everywhere else — " +
          '"not synced" is not "MFA is off".',
      ),
    parent: z
      .string()
      .nullable()
      .describe("The principal this one hangs off — a key's owner, a binding's subject."),
    owner: AccessPrincipalOwner.nullable().describe(
      "Who owns the resource, from the resource-ownership record. Null when nobody is named.",
    ),
    revokeActionId: z
      .string()
      .nullable()
      .describe(
        "The plugin action that revokes this principal, when the type declares one. Dispatch it " +
          "through POST /resources/invoke-action; null means the provider offers no revocation " +
          "Infrawrench can invoke.",
      ),
  }).openapi("AccessPrincipal");

  // Kept as a raw shape so `DismissedAccessFinding` can be emitted as one flat
  // object rather than an `allOf` branch — the posture schemas' reasoning: a
  // branch declaring only `dismissal` while inheriting the rest through a
  // sibling `$ref` is uninhabited under `additionalProperties: false`.
  const accessFindingShape = {
    resourceId: z.string().describe("Infrawrench resource id the finding is on."),
    ruleId: AccessReviewRuleId,
    title: z.string().openapi({ example: "Unused for 90+ days" }),
    severity: AccessReviewSeverity,
    reason: z.string().describe("Why this principal is flagged, in a sentence."),
    principal: AccessPrincipal,
  } as const;

  const AccessFinding = strict(accessFindingShape).openapi("AccessFinding");

  const AccessReviewDismissal = strict({
    resourceId: z.string(),
    ruleId: z.string(),
    dismissedAt: IsoDateTime.describe("When the finding was accepted."),
    dismissedBy: z
      .string()
      .nullable()
      .describe("Display name or email of whoever accepted it; null when unknown."),
    reason: z.string().nullable().describe("The operator's note, when they left one."),
  }).openapi("AccessReviewDismissal");

  const DismissedAccessFinding = strict({
    ...accessFindingShape,
    dismissal: AccessReviewDismissal,
  }).openapi("DismissedAccessFinding");

  const AccessReviewSeverityCounts = strict({
    critical: z.number().int(),
    high: z.number().int(),
    medium: z.number().int(),
    low: z.number().int(),
  }).openapi("AccessReviewSeverityCounts");

  const AccessReviewRuleCounts = strict({
    "access-review:stale-principal": z.number().int(),
    "access-review:admin-principal": z.number().int(),
    "access-review:key-past-rotation": z.number().int(),
    "access-review:no-recorded-owner": z.number().int(),
    "access-review:no-mfa": z.number().int(),
  }).openapi("AccessReviewRuleCounts");

  const AccessReviewRoleCounts = strict({
    user: z.number().int(),
    group: z.number().int(),
    role: z.number().int(),
    "service-account": z.number().int(),
    key: z.number().int(),
    binding: z.number().int(),
  }).openapi("AccessReviewRoleCounts");

  const AccessReviewResponse = strict({
    principals: z
      .array(AccessPrincipal)
      .describe(
        "Every synced principal, by account then type then name. Never filtered by dismissals — " +
          "accepting a finding must not remove a principal from the inventory.",
      ),
    findings: z
      .array(AccessFinding)
      .describe("Live findings, worst severity first. Dismissed findings are not included."),
    totalCount: z.number().int().describe("Live finding count; dismissals excluded."),
    counts: AccessReviewSeverityCounts,
    byRule: AccessReviewRuleCounts,
    byRole: AccessReviewRoleCounts,
    dismissed: z
      .array(DismissedAccessFinding)
      .describe(
        "Findings a dismissal is currently suppressing, most recently dismissed first. Only " +
          "dismissals whose rule still matches appear.",
      ),
    dismissedCount: z.number().int(),
    unknownActivityCount: z
      .number()
      .int()
      .describe(
        "How many principals the review could establish no last-use evidence for. Surfaces " +
          'render this so "we found nothing" and "we could not look" do not read the same.',
      ),
    staleDays: z.number().int().describe("The staleness window this review was computed against."),
    generatedAt: IsoDateTime,
  }).openapi("AccessReviewResponse");

  const AccessReviewDismissalCreate = strict({
    resourceId: z.string().describe("Infrawrench resource id the finding is on."),
    ruleId: AccessReviewRuleId,
    reason: z
      .string()
      .max(500)
      .nullable()
      .optional()
      .describe("Why this finding is acceptable. Trimmed; an empty note is stored as none."),
  }).openapi("AccessReviewDismissalCreate");

  const StaleDaysQuery = z.coerce
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .describe("Staleness window in days. Defaults to 90.");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/access-review",
    tags: ["Access review"],
    summary: "Review the principals inside your connected clouds",
    description:
      "Every IAM user and role, service account, app registration, group, role binding and " +
      "long-lived API key your connected accounts have synced, with the findings that have " +
      "evidence against them: unused beyond the staleness window, holding administrative or " +
      "wildcard permissions, past the rotation budget their plugin declares, carrying no " +
      "recorded owner, or signing in without a second factor.\n\n" +
      "This is about principals in **your** clouds — it is neither your Infrawrench team's " +
      "roles (`/team`) nor the credentials Infrawrench stores for you " +
      "(`/credential-hygiene`).\n\n" +
      "No provider API calls are made: everything is computed from already-synced fields, so " +
      "a principal whose provider does not report last use is reported with " +
      '`activity: "unknown"` and is never called stale. Findings the organization has ' +
      "dismissed are reported separately under `dismissed` and are excluded from `findings`, " +
      "`counts`, `byRule` and the security alerts.",
    request: { params: OrgIdParam, query: strict({ staleDays: StaleDaysQuery }) },
    responses: {
      200: {
        description: "The access review",
        content: { "application/json": { schema: AccessReviewResponse } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/access-review/export",
    tags: ["Access review"],
    summary: "Export the access review as compliance evidence",
    description:
      "The same review as a downloadable file, one row per finding. `format=csv` (the default) " +
      "returns RFC 4180 CSV with every cell quoted and spreadsheet formulas neutralised; " +
      "`format=json` returns the full response body pretty-printed.\n\n" +
      "Dismissed findings are included and labelled in both formats, with the note and the " +
      "person who accepted them: an evidence pack answers what you found *and* what you " +
      "decided. Exports are recorded in the audit log.",
    request: {
      params: OrgIdParam,
      query: strict({
        format: z.enum(["csv", "json"]).optional().describe('Defaults to "csv".'),
        staleDays: StaleDaysQuery,
      }),
    },
    responses: {
      200: {
        description: "The review as an attachment",
        content: {
          "text/csv": { schema: z.string() },
          "application/json": { schema: AccessReviewResponse },
        },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/access-review/dismissals",
    tags: ["Access review"],
    summary: "Dismiss an access review finding",
    description:
      "Accept a finding — that break-glass role really is meant to be admin, that shared key " +
      "really is rotated out of band. The finding leaves `findings` and stops feeding the " +
      "security alerts, but the rule keeps being evaluated and the finding is reported back " +
      "under `dismissed` for as long as it still matches. The principal itself stays in " +
      "`principals` either way. Idempotent: dismissing an already-dismissed finding rewrites " +
      "the note and the author.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: AccessReviewDismissalCreate } } },
    },
    responses: {
      200: {
        description: "The recorded dismissal",
        content: { "application/json": { schema: AccessReviewDismissal } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/access-review/dismissals",
    tags: ["Access review"],
    summary: "Restore a dismissed access review finding",
    description:
      "Undo a dismissal, putting the finding back on the list and back into the security " +
      "alerts. The finding is identified by query parameters rather than path segments because " +
      "resource ids are provider-native and routinely contain slashes.",
    request: {
      params: OrgIdParam,
      query: strict({
        resourceId: z.string().describe("Infrawrench resource id the finding is on."),
        ruleId: AccessReviewRuleId,
      }),
    },
    responses: {
      204: { description: "The dismissal was removed" },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });
}
