/**
 * Posture checks: `/api/org/:orgId/posture`, the endpoint definitions.
 *
 * Reading is `resources:read`; the alert settings are `org:settings:write`,
 * because the toggle decides what the org's channels and phones hear about;
 * accepting a finding is `resources:write`, the same trust level as changing
 * the resource it is about. The VS Code and Raycast extensions read
 * `GET /posture`, so its body is part of their contract too.
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

const PostureSeverity = Schema.Literals(["critical", "high", "medium", "low"]).annotate({
  description:
    "How bad the finding is. `critical` and `high` findings feed the posture alerts; " +
    "`medium` and `low` are hygiene work surfaced on the posture screen only.",
});

const PostureCategory = Schema.Literals([
  "public-exposure",
  "encryption",
  "credential-age",
  "data-protection",
  "other",
]).annotate({ description: "Grouping bucket for what kind of exposure the finding describes." });

// Kept as a field set so `DismissedPostureFinding` is one flat object rather
// than an `allOf` branch, which `additionalProperties: false` would make
// uninhabited.
const postureFindingFields = {
  resourceId: Schema.String.annotate({ description: "Infrawrench resource id." }),
  pluginId: PluginId,
  pluginName: Schema.String.annotate({ examples: ["AWS"] }),
  resourceTypeId: Schema.String,
  resourceTypeName: Schema.String.annotate({ examples: ["S3 Bucket"] }),
  accountId: Uuid,
  accountName: Schema.String,
  displayName: Schema.String,
  externalId: Schema.NullOr(Schema.String).annotate({
    description: "Provider-native id, when known.",
  }),
  ruleId: Schema.String.annotate({
    description: "The matched rule's stable id, unique within the plugin.",
    examples: ["hetzner-server-no-firewall"],
  }),
  title: Schema.String.annotate({
    description: "Short rule title.",
    examples: ["No firewall attached"],
  }),
  severity: PostureSeverity,
  category: PostureCategory,
  reason: Schema.String.annotate({
    description: "Plugin-authored explanation of why this is a finding.",
  }),
};

const PostureFinding = Schema.Struct(postureFindingFields).annotate({
  identifier: "PostureFinding",
});

const PostureSeverityCounts = Schema.Struct({
  critical: Schema.Int,
  high: Schema.Int,
  medium: Schema.Int,
  low: Schema.Int,
}).annotate({ identifier: "PostureSeverityCounts" });

export const PostureDismissal = Schema.Struct({
  resourceId: Schema.String,
  ruleId: Schema.String,
  dismissedAt: IsoDateTime.annotate({ description: "When the finding was accepted." }),
  dismissedBy: Schema.NullOr(Schema.String).annotate({
    description: "Display name or email of whoever accepted it; null when unknown.",
  }),
  reason: Schema.NullOr(Schema.String).annotate({
    description: "The operator's note, when they left one.",
  }),
}).annotate({ identifier: "PostureDismissal" });

const DismissedPostureFinding = Schema.Struct({
  ...postureFindingFields,
  dismissal: PostureDismissal,
}).annotate({ identifier: "DismissedPostureFinding" });

export const PostureListResponse = Schema.Struct({
  findings: Schema.Array(PostureFinding).annotate({
    description: "Live findings, worst severity first. Dismissed findings are not included.",
  }),
  totalCount: Schema.Int.annotate({ description: "Live finding count; dismissals excluded." }),
  counts: PostureSeverityCounts,
  dismissed: Schema.Array(DismissedPostureFinding).annotate({
    description:
      "Findings a dismissal is currently suppressing, most recently dismissed first. " +
      "Only dismissals whose rule still matches appear, so a finding that has since " +
      "been fixed simply drops out.",
  }),
  dismissedCount: Schema.Int,
  leakedCredentials: Schema.optionalKey(
    Schema.Struct({
      open: Schema.Int.annotate({ description: "Open leaked credentials." }),
      matched: Schema.Int.annotate({
        description: "Open leaks matched to something Infrawrench holds.",
      }),
      scanners: Schema.Int.annotate({ description: "Secret scanning accounts connected." }),
    }).annotate({
      description:
        "The Leaked credentials category: secrets a scanner found committed to code. The rows are " +
        "at `GET /leaked-secrets`.",
    }),
  ),
  generatedAt: IsoDateTime,
}).annotate({ identifier: "PostureListResponse" });

/** Documented; the handler checks each field itself, with its own sentences. */
const PostureDismissalCreate = Schema.Struct({
  resourceId: Schema.String.annotate({ description: "Infrawrench resource id the finding is on." }),
  ruleId: Schema.String.annotate({ description: "The matched rule's id." }),
  reason: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(maxLength(500))).annotate({
      description: "Why this finding is acceptable. Trimmed; an empty note is stored as none.",
    }),
  ),
}).annotate({ identifier: "PostureDismissalCreate" });

export const PostureAlertSettings = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    description: "Whether the poller sends posture alerts for this organization at all.",
  }),
  lastNotifiedAt: Schema.NullOr(IsoDateTime).annotate({
    description:
      "When the organization's posture alert scan last completed, or null before the " +
      "first. Owned by the poller's cooldown claim; not writable through this API.",
  }),
}).annotate({ identifier: "PostureAlertSettings" });

const PostureAlertSettingsUpdate = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "PostureAlertSettingsUpdate" });

export class PostureGroup extends HttpApiGroup.make("posture")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: PostureListResponse,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List security posture findings on synced resources")
      .annotate(
        OpenApi.Description,
        "Plugin-declared security checks evaluated over already-synced resource state: public " +
          "buckets, 0.0.0.0/0 ingress rules, unencrypted disks, publicly reachable database " +
          "endpoints, stale credentials, missing deletion/backup protection. No provider API " +
          "calls are made and results reflect the last sync. Findings are sorted worst severity " +
          "first, with per-severity counts. Findings the organization has dismissed are reported " +
          "separately under `dismissed` and are excluded from `findings`, `counts` and the " +
          "posture alerts.",
      )
      .annotate(SuccessDescription, "Posture findings, worst first"),
    HttpApiEndpoint.post("dismiss", "/dismissals", {
      params: OrgParams,
      payload: PostureDismissalCreate,
      success: PostureDismissal,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Dismiss a posture finding")
      .annotate(
        OpenApi.Description,
        "Accept a finding; the bucket really is meant to be public, the key really is rotated " +
          "out of band. The finding leaves `findings` and stops feeding the daily posture alerts, " +
          "but the rule keeps being evaluated and the finding is reported back under `dismissed` " +
          "for as long as it still matches. Idempotent: dismissing an already-dismissed finding " +
          "rewrites the note and the author.",
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
        ruleId: Schema.optionalKey(
          documentedAs(Schema.String.annotate({ description: "The matched rule's id." })),
        ),
      },
      success: HttpApiSchema.NoContent,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Restore a dismissed posture finding")
      .annotate(
        OpenApi.Description,
        "Undo a dismissal, putting the finding back on the list and back into the alert feed. " +
          "The finding is identified by query parameters rather than path segments because " +
          "resource ids are provider-native and routinely contain slashes.",
      )
      .annotate(SuccessDescription, "The dismissal was removed")
      .annotate(OpenApi.Transform, requiredQuery(["resourceId", "ruleId"])),
    HttpApiEndpoint.get("getSettings", "/settings", {
      params: OrgParams,
      success: PostureAlertSettings,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Get the organization's posture alert settings")
      .annotate(
        OpenApi.Description,
        "Whether the poller's daily posture alert scan is enabled. An organization that never " +
          "saved reads the shipped defaults (enabled).",
      )
      .annotate(SuccessDescription, "Posture alert settings"),
    HttpApiEndpoint.put("updateSettings", "/settings", {
      params: OrgParams,
      payload: PostureAlertSettingsUpdate,
      success: PostureAlertSettings,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Update the posture alert settings")
      .annotate(OpenApi.Description, "Saving never resets the alert cooldown.")
      .annotate(SuccessDescription, "The updated settings")
      .annotate(OpenApi.Transform, optionalRequestBody),
  )
  .prefix("/api/org/:orgId/posture")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Posture checks") {}

export class PostureApi extends withApiDefaults(HttpApi.make("posture").add(PostureGroup)) {}
