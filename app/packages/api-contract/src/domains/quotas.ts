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
import { IsoDateTime, OrgParams, ResourceId, Uuid } from "../http/schemas/common";
import { optionalRequestBody } from "../http/schemas/documented";
import { PluginId, ResourceTypeId } from "../http/schemas/plugin-registry";

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

const RunwayStatus = Schema.Literals(["full", "critical", "watch", "ok"]).annotate({
  description:
    "Where the usage sits: `full` (used >= limit now), `critical` (alerting: reaches the limit " +
    "within the organization's runway days on a clean trend, or a monthly allowance is past the " +
    "allowance threshold or projected past its limit before the cycle resets), `watch` (inside " +
    "the runway days but the trend is too noisy to alert on), or `ok`.",
});

const RunwayForecast = Schema.Struct({
  perDay: Schema.NullOr(Schema.Finite).annotate({
    description:
      "Change in usage per day, in the row's unit. A Theil-Sen slope (the median of every " +
      "pairwise slope) over the recorded readings, or for a monthly allowance with too few " +
      "readings this cycle, the average since the cycle started. Null without a rate.",
  }),
  daysLeft: Schema.NullOr(Schema.Finite).annotate({
    description:
      "Days until usage reaches the limit at that rate. Null when flat or falling, when already " +
      "full, when the crossing is more than 365 days out, or (for an allowance) when the cycle " +
      "resets first.",
  }),
  fullAt: Schema.NullOr(IsoDateTime).annotate({
    description: "The crossing, when `daysLeft` is set.",
  }),
  method: Schema.NullOr(Schema.Literals(["trend", "cycle-average"])),
  confidence: Schema.Literals(["ok", "noisy", "short"]).annotate({
    description:
      "`short`: fewer than 3 readings or less than a day of history, so no projection. " +
      "`noisy`: the scatter around the trend is as large as the change it explains. `ok` otherwise.",
  }),
  points: Schema.Int.annotate({ description: "Readings the fit used." }),
}).annotate({ identifier: "RunwayForecast" });

const RunwayCycle = Schema.Struct({
  start: IsoDateTime,
  end: IsoDateTime.annotate({ description: "When the allowance resets." }),
  projectedUsed: Schema.NullOr(Schema.Finite).annotate({
    description: "Usage projected at the end of the cycle at the current rate.",
  }),
  projectedUtilization: Schema.NullOr(Schema.Finite),
}).annotate({ identifier: "RunwayCycle" });

const runwayRowFields = {
  key: Schema.String.annotate({
    description:
      "The usage's key within the resource: a field or output key, or `metric:<series>`.",
    examples: ["storageBytes"],
  }),
  resourceId: ResourceId,
  resourceName: Schema.String,
  resourceTypeId: ResourceTypeId,
  accountId: Uuid,
  accountName: Schema.String,
  pluginId: PluginId,
  label: Schema.String.annotate({ examples: ["Storage"] }),
  unit: Schema.NullOr(Schema.String).annotate({
    description: "What both numbers count. `bytes` is a byte count; anything else is a word.",
  }),
  used: Schema.Finite,
  limit: Schema.Finite,
  utilization: Schema.Finite.annotate({ description: "used / limit, not clamped at 1." }),
  limitSource: Schema.Literals(["provider", "plan", "constant"]).annotate({
    description:
      "Whose number the limit is: `provider` (read from the resource itself, so it follows " +
      "resizes), `plan` (the provider's published allowance for the plan in `plan`), or " +
      "`constant` (a fixed documented ceiling).",
  }),
  plan: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["runway", "allowance"]).annotate({
    description: "`allowance` resets every month; `runway` accumulates until it hits the limit.",
  }),
  source: Schema.Literals(["field", "output", "metric"]),
  observedAt: IsoDateTime.annotate({ description: "When the current reading was taken." }),
  forecast: RunwayForecast,
  cycle: Schema.NullOr(RunwayCycle),
  status: RunwayStatus,
};

const RunwayRow = Schema.Struct(runwayRowFields).annotate({ identifier: "RunwayRow" });

const RunwayPoint = Schema.Struct({
  observedAt: IsoDateTime,
  used: Schema.Finite,
  limit: Schema.Finite,
}).annotate({ identifier: "RunwayPoint" });

const ResourceRunwayRow = Schema.Struct({
  ...runwayRowFields,
  history: Schema.Array(RunwayPoint).annotate({
    description:
      "The readings the projection used: the trend window for a runway row, the current " +
      "cycle for an allowance.",
  }),
}).annotate({ identifier: "ResourceRunwayRow" });

const runwayEnvelopeFields = {
  runwayDays: Schema.Int.annotate({
    description: "The organization's runway alert threshold, in days.",
  }),
  allowanceThreshold: Schema.Finite.annotate({
    description: "The organization's monthly allowance alert threshold, as a fraction.",
  }),
  windowDays: Schema.Int.annotate({ description: "How far back the trend looks, in days." }),
};

export const RunwayListResponse = Schema.Struct({
  rows: Schema.Array(RunwayRow).annotate({
    description: "Every declared usage with a reading, soonest to run out first.",
  }),
  ...runwayEnvelopeFields,
}).annotate({ identifier: "RunwayListResponse" });

export const ResourceRunwayResponse = Schema.Struct({
  rows: Schema.Array(ResourceRunwayRow),
  ...runwayEnvelopeFields,
}).annotate({ identifier: "ResourceRunwayResponse" });

const Threshold = Schema.Finite.check(Schema.isBetween({ minimum: 0.5, maximum: 0.99 }));
const RunwayDays = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 90 }));

export const QuotaAlertSettings = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    description:
      "Whether the poller sends quota and capacity runway alerts for this organization at all.",
  }),
  threshold: Threshold.annotate({
    description:
      "Utilisation fraction at or above which a quota alerts. Default 0.8. Bounded below " +
      "at 0.5 (a lower threshold makes every quota critical) and above at 0.99 (at 1.0 " +
      "the provider is already refusing requests, so the alert reports an outage rather " +
      "than warning about one). Values outside the range are rejected, not clamped.",
  }),
  runwayDays: RunwayDays.annotate({
    description:
      "Capacity runway: alert when a resource will reach its limit within this many days on a " +
      "clean trend. Default 14, from 1 to 90.",
  }),
  allowanceThreshold: Threshold.annotate({
    description:
      "Capacity runway: alert when a monthly allowance is at this fraction of its limit, or is " +
      "projected past the whole of it before the cycle resets. Default 0.8, from 0.5 to 0.99.",
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
  runwayDays: Schema.optionalKey(RunwayDays),
  allowanceThreshold: Schema.optionalKey(Threshold),
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
    HttpApiEndpoint.get("runway", "/runway", {
      params: OrgParams,
      success: RunwayListResponse,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List capacity runway across the organization's resources")
      .annotate(
        OpenApi.Description,
        "Every usage a plugin declares on a resource type (a disk's used bytes against its size, " +
          "a database against its plan's storage cap, connections against `max_connections`, a " +
          "monthly allowance of compute hours or sends) with when it reaches its limit at the " +
          "current rate, soonest first. Monthly allowances report the usage projected at the end " +
          "of the billing cycle instead of a far-off crossing. A read over stored readings: the " +
          "sync records each declared usage hourly, so no provider API calls are made here.",
      )
      .annotate(SuccessDescription, "Runway rows, soonest to run out first"),
    HttpApiEndpoint.get("resourceRunway", "/runway/resource", {
      params: OrgParams,
      query: { resourceId: ResourceId },
      success: ResourceRunwayResponse,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Get one resource's capacity runway with its readings")
      .annotate(
        OpenApi.Description,
        "The runway rows for one resource, each with the readings the projection used, for the " +
          "resource page's runway chart. An empty `rows` means the resource's type declares no " +
          "usage, or no reading with a resolvable limit has been recorded yet.",
      )
      .annotate(SuccessDescription, "The resource's runway rows with history"),
    HttpApiEndpoint.get("getSettings", "/settings", {
      params: OrgParams,
      success: QuotaAlertSettings,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Get the organization's quota alert settings")
      .annotate(
        OpenApi.Description,
        "The threshold feeds both the feed's severity buckets and the poller's daily alert " +
          "scan; the runway thresholds feed the capacity runway the same way. An organization " +
          "that never saved reads the shipped defaults (enabled, 0.8, 14 days, 0.8).",
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
