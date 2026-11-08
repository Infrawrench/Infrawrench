/**
 * Credential hygiene: `/api/org/:orgId/credential-hygiene`, the endpoint
 * definitions. One read-only report over data the server already holds.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgParams } from "../http/schemas/common";
import { documentedAs } from "../http/schemas/documented";

const HygieneFinding = Schema.Struct({
  id: Schema.String.annotate({
    description: "Stable across runs, so a client can remember what has been reviewed.",
  }),
  kind: Schema.Literals([
    "api_key_never_used",
    "api_key_idle",
    "api_key_expired_not_revoked",
    "api_key_wildcard_scope",
    "api_key_unused_scopes",
    "ssh_key_never_used",
    "ssh_key_idle",
    "member_unused_permissions",
  ]),
  severity: Schema.Literals(["high", "medium", "low"]),
  title: Schema.String,
  detail: Schema.String.annotate({ description: "The evidence behind the finding." }),
  recommendation: Schema.String,
  entityType: Schema.Literals(["api-key", "ssh-key", "member"]),
  entityId: Schema.String,
  entityName: Schema.String,
  facts: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]),
  ).annotate({ description: "Structured detail for table columns and reports." }),
}).annotate({ identifier: "HygieneFinding" });

export const HygieneReport = Schema.Struct({
  generatedAt: IsoDateTime,
  windowDays: Schema.Int,
  auditHistoryDays: Schema.NullOr(Schema.Int).annotate({
    description: "How much audit history the organization actually has; null when it has none.",
  }),
  permissionFindingsWithheld: Schema.Boolean.annotate({
    description:
      "True when there was not enough audit history for the unused-permission finding to mean " +
      "anything, so it was withheld rather than guessed at.",
  }),
  findings: Schema.Array(HygieneFinding),
  counts: Schema.Struct({
    high: Schema.Int,
    medium: Schema.Int,
    low: Schema.Int,
    total: Schema.Int,
  }),
}).annotate({ identifier: "HygieneReport" });

export class CredentialHygieneGroup extends HttpApiGroup.make("credentialHygiene")
  .add(
    HttpApiEndpoint.get("report", "/", {
      params: OrgParams,
      query: {
        // Read raw and checked by the handler, which names the bounds in its 400.
        windowDays: Schema.optionalKey(
          documentedAs(
            Schema.Int.check(Schema.isBetween({ minimum: 7, maximum: 365 })).annotate({
              description: "Activity window. Defaults to 90.",
            }),
          ),
        ),
      },
      success: HygieneReport,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "audit:read")
      .annotate(OpenApi.Summary, "Credential hygiene report")
      .annotate(
        OpenApi.Description,
        "API keys nobody uses, SSH keys nothing references, and members holding write permissions " +
          "they have never exercised; derived entirely from data the server already holds. No " +
          "provider call and nothing to enable.\n\n" +
          "**The audit log only witnesses writes.** Reading a resource list or a cost graph leaves " +
          "no audit row by design, so this report draws no conclusion about read permissions: an " +
          "absence of evidence about them proves nothing. `permissionFindingsWithheld` is set when " +
          "the organization does not yet have enough audit history for the unused-permission " +
          "finding to be meaningful. Both are load-bearing; a governance report that overclaims is " +
          "worse than none.\n\n" +
          "Gated on `audit:read` rather than a permission of its own: every fact here is already " +
          "reachable by anyone who can read the audit log, so this is a lens rather than a new " +
          "disclosure.",
      )
      .annotate(SuccessDescription, "The report"),
  )
  .prefix("/api/org/:orgId/credential-hygiene")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Credential hygiene") {}

export class CredentialHygieneApi extends withApiDefaults(
  HttpApi.make("credentialHygiene").add(CredentialHygieneGroup),
) {}
