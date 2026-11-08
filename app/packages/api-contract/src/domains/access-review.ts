/**
 * Cross-cloud access review: `/api/org/:orgId/access-review`, the endpoint
 * definitions.
 *
 * These are the principals inside the customer's clouds (IAM users and roles,
 * service accounts, app registrations, role bindings, long-lived API keys),
 * not Infrawrench's own team roles (`/team`) and not the credentials
 * Infrawrench holds (`/credential-hygiene`). Reading is `resources:read`;
 * accepting a finding is `resources:write`, the same trust level as changing
 * the resource it is about.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { maxLength } from "../schemas";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgParams, Uuid } from "../http/schemas/common";
import { documentedAs, optionalRequestBody, requiredQuery } from "../http/schemas/documented";
import { PluginId } from "../http/schemas/plugin-registry";

const AccessReviewSeverity = Schema.Literals(["critical", "high", "medium", "low"]).annotate({
  description:
    "How bad the finding is. `critical` and `high` findings ride the posture alert window; " +
    "`medium` and `low` are review work surfaced on the access review screen and in the " +
    "weekly digest only.",
});

const PrincipalRole = Schema.Literals([
  "user",
  "group",
  "role",
  "service-account",
  "key",
  "binding",
]).annotate({
  description:
    "What kind of identity the principal is, from the resource type's `principalRole` " +
    "declaration. Grouping and labels only; it is not a permission model.",
});

const PrincipalActivity = Schema.Literals(["active", "stale", "unknown"]).annotate({
  description:
    "What could be established about the principal's last use. `unknown` means the resource " +
    "type declares no last-used field, or the provider stored nothing parseable; it is a " +
    "first-class answer and is never reported as `stale`.",
});

const AccessReviewRuleId = Schema.Literals([
  "access-review:stale-principal",
  "access-review:admin-principal",
  "access-review:key-past-rotation",
  "access-review:no-recorded-owner",
  "access-review:no-mfa",
]).annotate({
  description:
    "Which rule was raised. Half of a dismissal's key, alongside the resource id. The " +
    "`access-review:` prefix is reserved so these can share the posture dismissal store " +
    "without colliding with plugin-declared posture rule ids.",
});

const AccessPrincipalOwner = Schema.Struct({
  userId: Schema.NullOr(Uuid).annotate({
    description: "Infrawrench user id when the owner is a member.",
  }),
  displayName: Schema.String.annotate({
    description: "Member name, or the free-text owner label.",
  }),
  isLabel: Schema.Boolean.annotate({
    description: "True when the owner is a label rather than a routable member.",
  }),
  ticketUrl: Schema.NullOr(Schema.String),
  purpose: Schema.NullOr(Schema.String),
}).annotate({ identifier: "AccessPrincipalOwner" });

const AccessPrincipal = Schema.Struct({
  resourceId: Schema.String.annotate({ description: "Infrawrench resource id." }),
  pluginId: PluginId,
  pluginName: Schema.String.annotate({ examples: ["AWS"] }),
  resourceTypeId: Schema.String,
  resourceTypeName: Schema.String.annotate({ examples: ["IAM User"] }),
  accountId: Uuid,
  accountName: Schema.String,
  displayName: Schema.String,
  externalId: Schema.NullOr(Schema.String).annotate({
    description: "Provider-native id, when known.",
  }),
  role: PrincipalRole,
  lastUsedAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When the principal was last used, or null when the review has no evidence.",
  }),
  daysSinceLastUsed: Schema.NullOr(Schema.Int),
  activity: PrincipalActivity,
  createdAt: Schema.NullOr(IsoDateTime),
  ageDays: Schema.NullOr(Schema.Int),
  admin: Schema.NullOr(Schema.Boolean).annotate({
    description:
      "True when the type's declared admin indicator matched; null when the type declares none.",
  }),
  mfa: Schema.NullOr(Schema.Boolean).annotate({
    description:
      "Multi-factor state, only on types that declare an MFA field. Null everywhere else; " +
      '"not synced" is not "MFA is off".',
  }),
  parent: Schema.NullOr(Schema.String).annotate({
    description: "The principal this one hangs off; a key's owner, a binding's subject.",
  }),
  owner: Schema.NullOr(AccessPrincipalOwner).annotate({
    description:
      "Who owns the resource, from the resource-ownership record. Null when nobody is named.",
  }),
  revokeActionId: Schema.NullOr(Schema.String).annotate({
    description:
      "The plugin action that revokes this principal, when the type declares one. Dispatch it " +
      "through POST /resources/invoke-action; null means the provider offers no revocation " +
      "Infrawrench can invoke.",
  }),
}).annotate({ identifier: "AccessPrincipal" });

// Kept as a field set so `DismissedAccessFinding` is one flat object rather
// than an `allOf` branch, which `additionalProperties: false` would make
// uninhabited.
const accessFindingFields = {
  resourceId: Schema.String.annotate({ description: "Infrawrench resource id the finding is on." }),
  ruleId: AccessReviewRuleId,
  title: Schema.String.annotate({ examples: ["Unused for 90+ days"] }),
  severity: AccessReviewSeverity,
  reason: Schema.String.annotate({ description: "Why this principal is flagged, in a sentence." }),
  principal: AccessPrincipal,
};

const AccessFinding = Schema.Struct(accessFindingFields).annotate({
  identifier: "AccessFinding",
});

export const AccessReviewDismissal = Schema.Struct({
  resourceId: Schema.String,
  ruleId: Schema.String,
  dismissedAt: IsoDateTime.annotate({ description: "When the finding was accepted." }),
  dismissedBy: Schema.NullOr(Schema.String).annotate({
    description: "Display name or email of whoever accepted it; null when unknown.",
  }),
  reason: Schema.NullOr(Schema.String).annotate({
    description: "The operator's note, when they left one.",
  }),
}).annotate({ identifier: "AccessReviewDismissal" });

const DismissedAccessFinding = Schema.Struct({
  ...accessFindingFields,
  dismissal: AccessReviewDismissal,
}).annotate({ identifier: "DismissedAccessFinding" });

const AccessReviewSeverityCounts = Schema.Struct({
  critical: Schema.Int,
  high: Schema.Int,
  medium: Schema.Int,
  low: Schema.Int,
}).annotate({ identifier: "AccessReviewSeverityCounts" });

const AccessReviewRuleCounts = Schema.Struct({
  "access-review:stale-principal": Schema.Int,
  "access-review:admin-principal": Schema.Int,
  "access-review:key-past-rotation": Schema.Int,
  "access-review:no-recorded-owner": Schema.Int,
  "access-review:no-mfa": Schema.Int,
}).annotate({ identifier: "AccessReviewRuleCounts" });

const AccessReviewRoleCounts = Schema.Struct({
  user: Schema.Int,
  group: Schema.Int,
  role: Schema.Int,
  "service-account": Schema.Int,
  key: Schema.Int,
  binding: Schema.Int,
}).annotate({ identifier: "AccessReviewRoleCounts" });

const JitGrantIssue = Schema.Struct({
  requestId: Schema.String,
  kind: Schema.Literals(["revoke_failed", "overdue", "still_present"]),
  accountId: Schema.String,
  accountName: Schema.NullOr(Schema.String),
  pluginId: Schema.String,
  scopeName: Schema.String,
  roleName: Schema.String,
  principalName: Schema.String,
  userName: Schema.NullOr(Schema.String),
  grantExpiresAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
  revokeAttempts: Schema.Int,
}).annotate({ identifier: "JitGrantIssue" });

export const AccessReviewResponse = Schema.Struct({
  principals: Schema.Array(AccessPrincipal).annotate({
    description:
      "Every synced principal, by account then type then name. Never filtered by dismissals; " +
      "accepting a finding must not remove a principal from the inventory.",
  }),
  findings: Schema.Array(AccessFinding).annotate({
    description: "Live findings, worst severity first. Dismissed findings are not included.",
  }),
  totalCount: Schema.Int.annotate({ description: "Live finding count; dismissals excluded." }),
  counts: AccessReviewSeverityCounts,
  byRule: AccessReviewRuleCounts,
  byRole: AccessReviewRoleCounts,
  dismissed: Schema.Array(DismissedAccessFinding).annotate({
    description:
      "Findings a dismissal is currently suppressing, most recently dismissed first. Only " +
      "dismissals whose rule still matches appear.",
  }),
  dismissedCount: Schema.Int,
  unknownActivityCount: Schema.Int.annotate({
    description:
      "How many principals the review could establish no last-use evidence for. Surfaces " +
      'render this so "we found nothing" and "we could not look" do not read the same.',
  }),
  staleDays: Schema.Int.annotate({
    description: "The staleness window this review was computed against.",
  }),
  generatedAt: IsoDateTime,
  jitGrantIssues: Schema.optionalKey(
    Schema.Array(JitGrantIssue).annotate({
      description:
        "Just-in-time grants whose revocation failed, that the provider still reports after a " +
        "revoke, or that are still marked held past their window.",
    }),
  ),
}).annotate({ identifier: "AccessReviewResponse" });

/** Documented; the handler checks each field itself, with its own sentences. */
const AccessReviewDismissalCreate = Schema.Struct({
  resourceId: Schema.String.annotate({ description: "Infrawrench resource id the finding is on." }),
  ruleId: AccessReviewRuleId,
  reason: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(maxLength(500))).annotate({
      description: "Why this finding is acceptable. Trimmed; an empty note is stored as none.",
    }),
  ),
}).annotate({ identifier: "AccessReviewDismissalCreate" });

/** Read raw: an absent window takes the default, a present bad one is the handler's 400. */
const StaleDaysQuery = Schema.optionalKey(
  documentedAs(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 })).annotate({
      description: "Staleness window in days. Defaults to 90.",
    }),
  ),
);

export class AccessReviewGroup extends HttpApiGroup.make("accessReview")
  .add(
    HttpApiEndpoint.get("review", "/", {
      params: OrgParams,
      query: { staleDays: StaleDaysQuery },
      success: AccessReviewResponse,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Review the principals inside your connected clouds")
      .annotate(
        OpenApi.Description,
        "Every IAM user and role, service account, app registration, group, role binding and " +
          "long-lived API key your connected accounts have synced, with the findings that have " +
          "evidence against them: unused beyond the staleness window, holding administrative or " +
          "wildcard permissions, past the rotation budget their plugin declares, carrying no " +
          "recorded owner, or signing in without a second factor.\n\n" +
          "This is about principals in **your** clouds; it is neither your Infrawrench team's " +
          "roles (`/team`) nor the credentials Infrawrench stores for you " +
          "(`/credential-hygiene`).\n\n" +
          "No provider API calls are made: everything is computed from already-synced fields, so " +
          "a principal whose provider does not report last use is reported with " +
          '`activity: "unknown"` and is never called stale. Findings the organization has ' +
          "dismissed are reported separately under `dismissed` and are excluded from `findings`, " +
          "`counts`, `byRule` and the security alerts.",
      )
      .annotate(SuccessDescription, "The access review"),
    HttpApiEndpoint.get("export", "/export", {
      params: OrgParams,
      query: {
        format: Schema.optionalKey(
          documentedAs(
            Schema.Literals(["csv", "json"]).annotate({ description: 'Defaults to "csv".' }),
          ),
        ),
        staleDays: StaleDaysQuery,
      },
      success: [
        Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/csv" })),
        AccessReviewResponse,
      ],
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Export the access review as compliance evidence")
      .annotate(
        OpenApi.Description,
        "The same review as a downloadable file, one row per finding. `format=csv` (the default) " +
          "returns RFC 4180 CSV with every cell quoted and spreadsheet formulas neutralised; " +
          "`format=json` returns the full response body pretty-printed.\n\n" +
          "Dismissed findings are included and labelled in both formats, with the note and the " +
          "person who accepted them: an evidence pack answers what you found *and* what you " +
          "decided. Exports are recorded in the audit log.",
      )
      .annotate(SuccessDescription, "The review as an attachment"),
    HttpApiEndpoint.post("dismiss", "/dismissals", {
      params: OrgParams,
      payload: AccessReviewDismissalCreate,
      success: AccessReviewDismissal,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Dismiss an access review finding")
      .annotate(
        OpenApi.Description,
        "Accept a finding; that break-glass role really is meant to be admin, that shared key " +
          "really is rotated out of band. The finding leaves `findings` and stops feeding the " +
          "security alerts, but the rule keeps being evaluated and the finding is reported back " +
          "under `dismissed` for as long as it still matches. The principal itself stays in " +
          "`principals` either way. Idempotent: dismissing an already-dismissed finding rewrites " +
          "the note and the author.",
      )
      .annotate(SuccessDescription, "The recorded dismissal")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("restore", "/dismissals", {
      params: OrgParams,
      query: {
        resourceId: Schema.optionalKey(
          documentedAs(
            Schema.String.annotate({ description: "Infrawrench resource id the finding is on." }),
          ),
        ),
        ruleId: Schema.optionalKey(documentedAs(AccessReviewRuleId)),
      },
      success: HttpApiSchema.NoContent,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Restore a dismissed access review finding")
      .annotate(
        OpenApi.Description,
        "Undo a dismissal, putting the finding back on the list and back into the security " +
          "alerts. The finding is identified by query parameters rather than path segments because " +
          "resource ids are provider-native and routinely contain slashes.",
      )
      .annotate(SuccessDescription, "The dismissal was removed")
      .annotate(OpenApi.Transform, requiredQuery(["resourceId", "ruleId"])),
  )
  .prefix("/api/org/:orgId/access-review")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Access review") {}

export class AccessReviewApi extends withApiDefaults(
  HttpApi.make("accessReview").add(AccessReviewGroup),
) {}
