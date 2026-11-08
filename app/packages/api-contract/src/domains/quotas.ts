/**
 * Quota radar: `/api/org/:orgId/quotas`, the endpoint definitions.
 *
 * The feed is `resources:read`, a read over already-collected readings; the
 * settings are `org:settings:write`, the expiry settings' permission, because
 * the threshold decides what the org's channels and phones hear about.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgParams, Uuid } from "../http/schemas/common";
import { optionalRequestBody } from "../http/schemas/documented";
import { PluginId } from "../http/schemas/plugin-registry";

const QuotaSeverity = Schema.Literals(["exhausted", "critical", "trending", "ok"]).annotate({
  description:
    "Where the quota sits: `exhausted` (used >= limit; the provider is already refusing " +
    "requests), `critical` (at or over the organization's threshold), `trending` (under the " +
    "threshold, but the fitted trend reaches the limit within 30 days), or `ok`. Ordered: an " +
    "exhausted quota is also over threshold and also trending, and reports as `exhausted`.",
});

const QuotaTrend = Schema.Struct({
  perDay: Schema.NullOr(Schema.Finite).annotate({
    description:
      "Least-squares change in utilisation fraction per day over the last 14 days of " +
      "snapshots. Null when fewer than 3 readings exist, or when every reading shares " +
      "an instant. Null means 'not enough history', never 'no risk'.",
  }),
  daysToExhaustion: Schema.NullOr(Schema.Finite).annotate({
    description:
      "Days until used reaches limit at the fitted rate. Null when the trend is flat or " +
      "falling, when the quota is already at its limit, or when exhaustion lands beyond " +
      "the 30-day horizon.",
  }),
  points: Schema.Int.annotate({ description: "Snapshots the fit used." }),
}).annotate({ identifier: "QuotaTrend" });

const QuotaRow = Schema.Struct({
  key: Schema.String.annotate({
    description: "Plugin-chosen stable id for this quota within the account.",
    examples: ["ec2/L-1216C47A/eu-west-1"],
  }),
  accountId: Uuid,
  accountName: Schema.String,
  pluginId: PluginId,
  service: Schema.String.annotate({
    description: "Provider service in the provider's own vocabulary.",
    examples: ["ec2"],
  }),
  name: Schema.String.annotate({ examples: ["Running On-Demand Standard instances"] }),
  region: Schema.NullOr(Schema.String).annotate({
    description: "Provider region, or null for an account-wide quota. Never the string 'global'.",
  }),
  limit: Schema.Finite.annotate({
    description: "The ceiling the provider will enforce, in `unit`.",
  }),
  used: Schema.Finite.annotate({
    description: "How much of `limit` is consumed, in the same unit.",
  }),
  utilization: Schema.Finite.annotate({
    description: "used / limit. Not clamped at 1; an over-quota reading is a real state.",
  }),
  unit: Schema.NullOr(Schema.String).annotate({
    description: "What is being counted, in the provider's own word.",
    examples: ["vCPUs"],
  }),
  adjustable: Schema.NullOr(Schema.Boolean).annotate({
    description:
      "Whether the provider lets the customer request an increase. Null means the plugin " +
      "does not know, which is not the same as `false`.",
  }),
  docsUrl: Schema.NullOr(Schema.String).annotate({
    description: "Provider page explaining or raising this quota.",
  }),
  observedAt: IsoDateTime.annotate({ description: "When this reading was collected." }),
  severity: QuotaSeverity,
  trend: QuotaTrend,
}).annotate({ identifier: "QuotaRow" });

const QuotaAccountStatus = Schema.Struct({
  accountId: Uuid,
  accountName: Schema.String,
  pluginId: PluginId,
  quotaCount: Schema.Int.annotate({ description: "Quota rows currently stored for this account." }),
  lastPolledAt: Schema.NullOr(IsoDateTime).annotate({
    description: "Last successful collection; null if never.",
  }),
  lastError: Schema.NullOr(Schema.String).annotate({
    description: "Last collection failure, or null when the last pass succeeded.",
  }),
  lastErrorHelpLabel: Schema.NullOr(Schema.String),
  lastErrorHelpUrl: Schema.NullOr(Schema.String).annotate({
    description: "Set when the failure was a fixable permission gap rather than an outage.",
  }),
  partial: Schema.Boolean.annotate({
    description:
      "The plugin reports a representative subset of the provider's quotas, not all of " +
      "them. True for AWS and DigitalOcean.",
  }),
}).annotate({ identifier: "QuotaAccountStatus" });

export const QuotaListResponse = Schema.Struct({
  rows: Schema.Array(QuotaRow).annotate({
    description: "Every quota with a reading, worst first.",
  }),
  accounts: Schema.Array(QuotaAccountStatus).annotate({
    description:
      "Per-account collection status for every account on a quota-capable plugin. Present " +
      "even when the account has rows: an empty `rows` alone cannot distinguish 'nothing " +
      "is near a limit' from 'every collection is failing'.",
  }),
  threshold: Schema.Finite.annotate({
    description:
      "The organization's alert threshold as a fraction, so the page's marker and " +
      "the alert agree.",
  }),
  unsupportedPluginIds: Schema.Array(PluginId).annotate({
    description:
      "Plugins the organization holds accounts with that cannot report quotas at all. " +
      "Named rather than counted, because the absence is the finding.",
  }),
}).annotate({ identifier: "QuotaListResponse" });

const Threshold = Schema.Finite.check(Schema.isBetween({ minimum: 0.5, maximum: 0.99 }));

export const QuotaAlertSettings = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    description: "Whether the poller sends quota alerts for this organization at all.",
  }),
  threshold: Threshold.annotate({
    description:
      "Utilisation fraction at or above which a quota alerts. Default 0.8. Bounded below " +
      "at 0.5 (a lower threshold makes every quota critical) and above at 0.99 (at 1.0 " +
      "the provider is already refusing requests, so the alert reports an outage rather " +
      "than warning about one). Values outside the range are rejected, not clamped.",
  }),
  lastNotifiedAt: Schema.NullOr(IsoDateTime).annotate({
    description:
      "When the organization's quota alert scan last completed, or null before the " +
      "first. Owned by the poller's cooldown claim; not writable through this API.",
  }),
}).annotate({ identifier: "QuotaAlertSettings" });

/** Documented; the handler checks each field itself and server-core owns the bounds. */
const QuotaAlertSettingsUpdate = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  threshold: Schema.optionalKey(Threshold),
}).annotate({ identifier: "QuotaAlertSettingsUpdate" });

export class QuotasGroup extends HttpApiGroup.make("quotas")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: QuotaListResponse,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List provider quota utilisation across the organization")
      .annotate(
        OpenApi.Description,
        "How close each account is to the limits its provider enforces, with the trend fitted " +
          "over the last 14 days of collected readings. Both halves of every row (the used " +
          "figure and the limit) come from the provider; nothing is filled in from published " +
          "defaults, so an account with an approved increase reads as having the headroom it " +
          "has. This is a read over already-collected snapshots: no provider API calls are made " +
          "here, and the readings are as fresh as the last collection pass (roughly six hours). " +
          "A plugin that declares no quota capability contributes nothing rather than zero, see " +
          "`unsupportedPluginIds`.",
      )
      .annotate(
        SuccessDescription,
        "Quota readings, worst first, with per-account collection status",
      ),
    HttpApiEndpoint.get("getSettings", "/settings", {
      params: OrgParams,
      success: QuotaAlertSettings,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Get the organization's quota alert settings")
      .annotate(
        OpenApi.Description,
        "The threshold feeds both the feed's severity buckets and the poller's daily alert " +
          "scan. An organization that never saved reads the shipped defaults (enabled, 0.8).",
      )
      .annotate(SuccessDescription, "Quota alert settings"),
    HttpApiEndpoint.put("updateSettings", "/settings", {
      params: OrgParams,
      payload: QuotaAlertSettingsUpdate,
      success: QuotaAlertSettings,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Update the quota alert settings")
      .annotate(
        OpenApi.Description,
        "Every field is optional so a single toggle can be saved on its own. `threshold` is a " +
          "fraction from 0.5 to 0.99 and is rejected rather than clamped when out of range. " +
          "Saving never resets the alert cooldown.",
      )
      .annotate(SuccessDescription, "The updated settings")
      .annotate(OpenApi.Transform, optionalRequestBody),
  )
  .prefix("/api/org/:orgId/quotas")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Quota radar") {}

export class QuotasApi extends withApiDefaults(HttpApi.make("quotas").add(QuotasGroup)) {}
