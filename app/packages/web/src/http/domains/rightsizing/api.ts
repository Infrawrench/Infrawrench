/**
 * Right-sizing: `/api/org/:orgId/rightsizing`, the endpoint definitions.
 *
 * `resources:read`, like orphans: the list is derived from the org's resource
 * set, and the prices are catalog rates, not the org's billing data.
 * Applying a recommendation is not a route here: the UI submits the size
 * field through `POST /resources/update`, which carries change-freeze
 * enforcement and audit logging.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, OrgParams, Uuid } from "../../schemas/common";
import { documentedAs } from "../../schemas/documented";
import { PluginId } from "../../schemas/plugin-registry";
import { FindingRemediation } from "../../schemas/remediation";

const OversizedSizeSummary = Schema.Struct({
  id: Schema.String.annotate({ examples: ["cx32"] }),
  label: Schema.String,
  vcpus: Schema.Int,
  memoryMb: Schema.Int,
  priceMonthly: Schema.NullOr(Schema.Finite).annotate({
    description: "Monthly catalog price in `currency`; null when unpriced.",
  }),
}).annotate({ identifier: "OversizedSizeSummary" });

const OversizedResource = Schema.Struct({
  id: Schema.String.annotate({ description: "Infrawrench resource id." }),
  pluginId: PluginId,
  resourceTypeId: Schema.String,
  resourceTypeName: Schema.String.annotate({ examples: ["Server"] }),
  displayName: Schema.String,
  externalId: Schema.NullOr(Schema.String).annotate({
    description: "Provider-native id, when known.",
  }),
  sizeFieldKey: Schema.String.annotate({
    description:
      "Field to submit through the resource-update endpoint to apply the recommended size.",
    examples: ["serverType"],
  }),
  region: Schema.NullOr(Schema.String).annotate({
    description: "Provider region/zone/location the resource lives in.",
  }),
  currentSize: OversizedSizeSummary,
  recommendedSize: OversizedSizeSummary,
  cpuP95: Schema.Finite.annotate({
    description: "p95 CPU utilisation over the window, percent of the current size.",
  }),
  memoryP95: Schema.NullOr(Schema.Finite).annotate({
    description: "p95 memory utilisation, percent of the current size; null when unmeasured.",
  }),
  memoryMeasured: Schema.Boolean.annotate({
    description: "False when the provider stores no memory series for this resource.",
  }),
  projectedCpuP95: Schema.Finite.annotate({
    description: "Projected p95 CPU on the recommended size, for the confirm dialog.",
  }),
  currency: Schema.String.annotate({
    description: "ISO 4217 code the size prices are quoted in.",
    examples: ["USD"],
  }),
  monthlySaving: Schema.NullOr(Schema.Finite).annotate({
    description: "Current minus recommended monthly price; null when either side is unpriced.",
  }),
  currentMonthlyKgCo2e: Schema.NullOr(Schema.Finite).annotate({
    description:
      "Estimated monthly kg CO2e of the current size where it runs; null when the region " +
      "has no published grid figure. See the Carbon tag for the method.",
  }),
  monthlyKgCo2eSaving: Schema.NullOr(Schema.Finite).annotate({
    description: "Estimated monthly kg CO2e the resize would save; null as above.",
  }),
  resizeNote: Schema.NullOr(Schema.String).annotate({
    description: "Plugin-authored caveat (e.g. the provider requires the machine stopped).",
  }),
  lastSyncedAt: Schema.NullOr(IsoDateTime),
  remediation: Schema.optionalKey(FindingRemediation).annotateKey({
    description: "Ready-to-run commands that perform the same resize from a terminal.",
  }),
}).annotate({ identifier: "OversizedResource" });

const OversizedAccountGroup = Schema.Struct({
  accountId: Uuid,
  accountName: Schema.String,
  pluginId: PluginId,
  pluginName: Schema.String.annotate({ examples: ["Hetzner"] }),
  resources: Schema.Array(OversizedResource),
}).annotate({ identifier: "OversizedAccountGroup" });

export const RightsizingListResponse = Schema.Struct({
  accounts: Schema.Array(OversizedAccountGroup).annotate({
    description: "Groups sorted by account name.",
  }),
  totalCount: Schema.Int,
  windowDays: Schema.Int.annotate({
    description: "Days of stored metrics the percentiles cover.",
  }),
  generatedAt: IsoDateTime,
}).annotate({ identifier: "RightsizingListResponse" });

export class RightsizingGroup extends HttpApiGroup.make("rightsizing")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      // Read as sent: anything but `true` uses the cache, as it always has.
      query: {
        refresh: Schema.optionalKey(
          documentedAs(
            Schema.Literals(["true", "false"]).annotate({
              description: "Bypass the short server-side cache and recompute now.",
            }),
          ),
        ),
      },
      success: RightsizingListResponse,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List oversized resources with resize recommendations")
      .annotate(
        OpenApi.Description,
        "Computes p95 CPU/memory utilisation over the last 14 days of stored metrics for every " +
          "resource whose plugin declares right-sizing support, and matches under-utilised ones " +
          "against the plugin's real size catalog (the create form's size options, live-priced). " +
          "Each recommendation names the cheapest smaller size that still clears a headroom margin " +
          "and quotes the monthly saving. Apply one by submitting `sizeFieldKey` with the " +
          "recommended size id through the resource-update endpoint; which enforces change " +
          "freezes and writes the audit trail. Results are cached for a few minutes; pass " +
          "`refresh=true` to recompute.",
      )
      .annotate(SuccessDescription, "Oversized resources grouped by account"),
  )
  .prefix("/api/org/:orgId/rightsizing")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Orphans") {}

export class RightsizingApi extends withApiDefaults(
  HttpApi.make("rightsizing").add(RightsizingGroup),
) {}
