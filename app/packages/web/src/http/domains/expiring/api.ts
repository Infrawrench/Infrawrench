/**
 * Expiry radar: `/api/org/:orgId/expiring`, the endpoint definitions.
 *
 * The feed is `resources:read`; the settings are `org:settings:write`, the
 * drift alert settings' permission, because the lead time decides what the
 * org's channels and phones hear about.
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

const ExpirySeverity = Schema.Literals([
  "expired",
  "critical",
  "warning",
  "upcoming",
  "ok",
]).annotate({
  description:
    "How close the deadline is: `expired` (in the past), `critical` (due within 7 days), " +
    "`warning` (within 30 days), `upcoming` (within the organization's lead time), or `ok` " +
    "(tracked, but further out than the lead time).",
});

const ExpiryKind = Schema.Literals([
  "tls-cert",
  "domain",
  "api-token",
  "access-key",
  "k8s-cert",
  "ssh-key",
  "secret-version",
  "lease",
  "extended-support",
  "other",
]).annotate({ description: "Grouping bucket for the kind of deadline." });

const ExpiryItem = Schema.Struct({
  resourceId: Schema.String.annotate({ description: "Infrawrench resource id." }),
  pluginId: PluginId,
  pluginName: Schema.String.annotate({ examples: ["Cloudflare"] }),
  resourceTypeId: Schema.String,
  resourceTypeName: Schema.String.annotate({ examples: ["ACM Certificate"] }),
  accountId: Uuid,
  accountName: Schema.String,
  displayName: Schema.String,
  externalId: Schema.NullOr(Schema.String).annotate({
    description: "Provider-native id, when known.",
  }),
  fieldKey: Schema.String.annotate({ description: "The declared field the deadline came from." }),
  kind: ExpiryKind,
  label: Schema.String.annotate({
    description: "Plugin-authored caption for the deadline.",
    examples: ["Certificate expires"],
  }),
  basis: Schema.Literals(["expiry", "age"]).annotate({
    description:
      "`expiry`: the field held the deadline itself; `age`: the deadline was derived " +
      "from a creation/rotation date plus an age budget.",
  }),
  dueAt: IsoDateTime.annotate({ description: "The deadline." }),
  daysRemaining: Schema.Int.annotate({
    description: "Whole days until dueAt (floor); negative once expired.",
  }),
  severity: ExpirySeverity,
}).annotate({ identifier: "ExpiryItem" });

const ExpirySeverityCounts = Schema.Struct({
  expired: Schema.Int,
  critical: Schema.Int,
  warning: Schema.Int,
  upcoming: Schema.Int,
  ok: Schema.Int,
}).annotate({ identifier: "ExpirySeverityCounts" });

export const ExpiryListResponse = Schema.Struct({
  items: Schema.Array(ExpiryItem).annotate({
    description: "All tracked deadlines, soonest first (`ok` items included).",
  }),
  totalCount: Schema.Int,
  counts: ExpirySeverityCounts,
  leadDays: Schema.Int.annotate({
    description: "The lead time the `upcoming` bucket was computed against.",
  }),
  generatedAt: IsoDateTime,
}).annotate({ identifier: "ExpiryListResponse" });

const LeadDays = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 }));

export const ExpiryAlertSettings = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    description: "Whether the poller sends expiry alerts for this organization at all.",
  }),
  leadDays: LeadDays.annotate({
    description:
      "Days of lead time before a deadline counts as `upcoming` and alertable. Default 60.",
  }),
  lastNotifiedAt: Schema.NullOr(IsoDateTime).annotate({
    description:
      "When the organization's expiry alert scan last completed, or null before the first. " +
      "Owned by the poller's cooldown claim; not writable through this API.",
  }),
}).annotate({ identifier: "ExpiryAlertSettings" });

/** Documented; the handler checks each field itself and server-core owns the bounds. */
const ExpiryAlertSettingsUpdate = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  leadDays: Schema.optionalKey(LeadDays),
}).annotate({ identifier: "ExpiryAlertSettingsUpdate" });

export class ExpiringGroup extends HttpApiGroup.make("expiring")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: ExpiryListResponse,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List approaching deadlines on synced resources")
      .annotate(
        OpenApi.Description,
        "One cross-provider countdown of everything with a clock on it: TLS certificate " +
          "expiries, domain registrations, API token expirations, access keys past their " +
          "rotation budget, Kubernetes/SSH credential ages. Plugins declare which synced fields " +
          "carry deadlines; the feed is computed over already-stored state, so no provider API " +
          "calls are made and results reflect the last sync. Items are sorted soonest first and " +
          "bucketed by severity against the organization's lead time.",
      )
      .annotate(SuccessDescription, "Tracked deadlines, soonest first"),
    HttpApiEndpoint.get("getSettings", "/settings", {
      params: OrgParams,
      success: ExpiryAlertSettings,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Get the organization's expiry alert settings")
      .annotate(
        OpenApi.Description,
        "The lead time feeds both the feed's `upcoming` bucket and the poller's daily alert " +
          "scan. An organization that never saved reads the shipped defaults (enabled, 60 days).",
      )
      .annotate(SuccessDescription, "Expiry alert settings"),
    HttpApiEndpoint.put("updateSettings", "/settings", {
      params: OrgParams,
      payload: ExpiryAlertSettingsUpdate,
      success: ExpiryAlertSettings,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Update the expiry alert settings")
      .annotate(
        OpenApi.Description,
        "Every field is optional so a single toggle can be saved on its own. `leadDays` must " +
          "be a whole number from 1 to 365. Saving never resets the alert cooldown.",
      )
      .annotate(SuccessDescription, "The updated settings")
      .annotate(OpenApi.Transform, optionalRequestBody),
  )
  .prefix("/api/org/:orgId/expiring")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Expiry radar") {}

export class ExpiringApi extends withApiDefaults(HttpApi.make("expiring").add(ExpiringGroup)) {}
