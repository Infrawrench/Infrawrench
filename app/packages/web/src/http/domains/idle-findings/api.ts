/**
 * Idle-rule tuning: `/api/org/:orgId/idle-findings`, the endpoint definitions.
 *
 * The findings themselves are rows of `GET /orphans` (an `OrphanedResource`
 * with `idle` set); these are the part a person tunes. The overview reads
 * under `resources:read`, like the findings it explains. The settings and a
 * forced re-scan are `org:settings:write`: they decide what the whole org's
 * savings list says, and a re-scan spends metric reads on the customer's own
 * cloud bill.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, OrgParams, Uuid } from "../../schemas/common";
import { optionalRequestBody } from "../../schemas/documented";
import { PluginId } from "../../schemas/plugin-registry";

const IdleRuleOverride = Schema.Struct({
  enabled: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "False switches the rule off for the organization." }),
  ),
  thresholds: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Finite).annotate({
      description: "Threshold overrides by key; each must sit within the rule's declared range.",
    }),
  ),
}).annotate({ identifier: "IdleRuleOverride" });

const LookbackDays = Schema.Int.check(Schema.isBetween({ minimum: 7, maximum: 42 }));

export const IdleFindingSettings = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    description: "Master switch: off stops collection and hides every idle row.",
  }),
  lookbackDays: Schema.Int.annotate({
    description: "Days of metrics each rule judges over, 7 to 42. Ships as 14.",
  }).check(Schema.isBetween({ minimum: 7, maximum: 42 })),
  rules: Schema.Record(Schema.String, IdleRuleOverride).annotate({
    description:
      "Overrides keyed by `pluginId:ruleId`. A rule absent here runs enabled with its declared " +
      "defaults.",
  }),
}).annotate({ identifier: "IdleFindingSettings" });

/** Documented; the handler checks each field itself and the settings module owns the bounds. */
const IdleFindingSettingsUpdate = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  lookbackDays: Schema.optionalKey(LookbackDays),
  rules: Schema.optionalKey(
    Schema.Record(Schema.String, IdleRuleOverride).annotate({
      description: "Replaces the whole overrides map when sent.",
    }),
  ),
}).annotate({ identifier: "IdleFindingSettingsUpdate" });

const IdleRuleThresholdView = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  description: Schema.NullOr(Schema.String),
  unit: Schema.Literals(["count", "bytes", "percent", "days"]),
  default: Schema.Finite,
  min: Schema.Finite,
  max: Schema.Finite,
  value: Schema.Finite.annotate({
    description: "The effective value after the organization's override.",
  }),
}).annotate({ identifier: "IdleRuleThresholdView" });

const IdleRuleView = Schema.Struct({
  ruleKey: Schema.String.annotate({ examples: ["aws:nat-gateway"] }),
  pluginId: PluginId,
  pluginName: Schema.String,
  ruleId: Schema.String,
  label: Schema.String.annotate({ examples: ["Idle NAT gateway"] }),
  description: Schema.String,
  action: Schema.Literals(["remove", "reconfigure", "stop"]),
  resourceTypeNames: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
  thresholds: Schema.Array(IdleRuleThresholdView),
}).annotate({ identifier: "IdleRuleView" });

const IdleAccountStatus = Schema.Struct({
  accountId: Uuid,
  accountName: Schema.String,
  pluginId: PluginId,
  pluginName: Schema.String,
  lastPolledAt: Schema.NullOr(IsoDateTime),
  nextPollAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String).annotate({
    description: "Last collection failure; null after a success.",
  }),
  helpLabel: Schema.NullOr(Schema.String),
  helpUrl: Schema.NullOr(Schema.String).annotate({
    description: "https link to the fix for a permission gap.",
  }),
  findingCount: Schema.Int,
}).annotate({ identifier: "IdleAccountStatus" });

export const IdleFindingsOverview = Schema.Struct({
  settings: IdleFindingSettings,
  rules: Schema.Array(IdleRuleView),
  accounts: Schema.Array(IdleAccountStatus),
}).annotate({ identifier: "IdleFindingsOverview" });

/** The re-scan's answer, inline in the document as it always was (not the `Ok` component). */
export const IdleRescanScheduled = Schema.Struct({ ok: Schema.Literal(true) });

export class IdleFindingsGroup extends HttpApiGroup.make("idleFindings")
  .add(
    HttpApiEndpoint.get("overview", "/", {
      params: OrgParams,
      success: IdleFindingsOverview,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Idle rules, their settings and collection status")
      .annotate(
        OpenApi.Description,
        "Every metric-based idle rule the loaded plugins declare (idle NAT gateways, load " +
          "balancers, caches, provisioned tables, clusters, unused custom metrics), with the " +
          "organization's effective thresholds, plus each account's last collection and error. " +
          "The findings themselves are rows of `GET /orphans` with `idle` set.",
      )
      .annotate(SuccessDescription, "Settings, rule catalog and per-account status"),
    HttpApiEndpoint.get("getSettings", "/settings", {
      params: OrgParams,
      success: IdleFindingSettings,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Get the organization's idle-rule settings")
      .annotate(
        OpenApi.Description,
        "An organization that never saved reads the shipped defaults (enabled, 14 days).",
      )
      .annotate(SuccessDescription, "Idle-rule settings"),
    HttpApiEndpoint.put("updateSettings", "/settings", {
      params: OrgParams,
      payload: IdleFindingSettingsUpdate,
      success: IdleFindingSettings,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Update the idle-rule settings")
      .annotate(
        OpenApi.Description,
        "Every field is optional. `lookbackDays` must be a whole number from 7 to 42; an unknown " +
          "rule or threshold key, or a threshold outside its declared range, is rejected rather " +
          "than clamped. Any change makes every account due for a fresh collection.",
      )
      .annotate(SuccessDescription, "The updated settings")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.post("rescan", "/rescan", {
      params: OrgParams,
      success: IdleRescanScheduled,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Re-scan idle rules now")
      .annotate(
        OpenApi.Description,
        "Makes every account due for an idle collection on the next poller tick. The reads are " +
          "billed to the organization's own cloud accounts (CloudWatch GetMetricData and the like).",
      )
      .annotate(SuccessDescription, "Scheduled"),
  )
  .prefix("/api/org/:orgId/idle-findings")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Orphans") {}

export class IdleFindingsApi extends withApiDefaults(
  HttpApi.make("idleFindings").add(IdleFindingsGroup),
) {}
