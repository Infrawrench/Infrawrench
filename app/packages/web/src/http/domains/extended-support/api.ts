/**
 * Extended support: `/api/org/:orgId/extended-support`, the endpoint
 * definitions. Filed under the Orphans tag, beside the other waste findings.
 *
 * The list is `resources:read`; the settings follow the expiry settings,
 * permission included: `org:settings:write`, because the switch and the lead
 * time decide what the org's channels hear about.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, OrgParams, Uuid } from "../../schemas/common";
import { documentedAs, optionalRequestBody } from "../../schemas/documented";
import { PluginId } from "../../schemas/plugin-registry";

const ExtendedSupportStatus = Schema.Literals([
  "end-of-life",
  "surcharged",
  "unsupported",
  "upcoming",
]).annotate({
  description:
    "`surcharged`: past standard support and paying for extended support. `unsupported`: " +
    "past standard support with no surcharge (no paid extension, or not enrolled), so a " +
    "forced upgrade is pending. `end-of-life`: past the end of extended support too. " +
    "`upcoming`: standard support ends within the organization's lead time.",
});

const ExtendedSupportUnit = Schema.Literals([
  "cluster-hour",
  "vcpu-hour",
  "vcore-hour",
  "node-hour",
  "instance-hour",
  "acu-hour",
]);

const CostBasis = Schema.Literals(["billed", "billed-share", "list-price", "unpriced"]).annotate({
  description:
    "Where `monthlySurcharge` came from: `billed` (the provider's billing, attributable to " +
    "this resource alone), `billed-share` (a billed line shared by several matching " +
    "resources, split by list-price weight), `list-price` (computed from published rates), " +
    "or `unpriced` (no figure).",
});

const ExtendedSupportTotal = Schema.Struct({
  currency: Schema.String.annotate({ examples: ["USD"] }),
  monthly: Schema.Finite,
}).annotate({ identifier: "ExtendedSupportTotal" });

const ExtendedSupportFinding = Schema.Struct({
  resourceId: Schema.String.annotate({ description: "Infrawrench resource id." }),
  pluginId: PluginId,
  pluginName: Schema.String.annotate({ examples: ["AWS"] }),
  resourceTypeId: Schema.String,
  resourceTypeName: Schema.String.annotate({ examples: ["EKS Cluster"] }),
  accountId: Uuid,
  accountName: Schema.String,
  displayName: Schema.String,
  externalId: Schema.NullOr(Schema.String),
  region: Schema.NullOr(Schema.String),
  releaseId: Schema.String.annotate({
    description: "The matched support-calendar entry, unique within the resource type.",
    examples: ["k8s-1.30"],
  }),
  product: Schema.String.annotate({ examples: ["Amazon EKS"] }),
  engine: Schema.NullOr(Schema.String),
  currentVersion: Schema.String.annotate({ examples: ["1.30"] }),
  targetVersion: Schema.String.annotate({ examples: ["1.35"] }),
  status: ExtendedSupportStatus,
  standardSupportEnds: Schema.String.annotate({
    description: "Last day of standard support, YYYY-MM-DD.",
  }),
  surchargeStartsOn: Schema.String.annotate({
    description: "First day the surcharge applies, YYYY-MM-DD.",
  }),
  daysUntilSurcharge: Schema.Int.annotate({ description: "Zero or negative once it has started." }),
  extendedSupportEnds: Schema.NullOr(Schema.String).annotate({
    description: "Last day of extended support, after which the provider upgrades it.",
  }),
  daysUntilForcedUpgrade: Schema.NullOr(Schema.Int),
  charged: Schema.Boolean.annotate({
    description: "False when there is no paid extension or the resource is not enrolled.",
  }),
  quantity: Schema.NullOr(Schema.Finite).annotate({
    description: "Billable units (vCPUs, nodes); null when unknown.",
  }),
  unit: Schema.NullOr(ExtendedSupportUnit),
  currency: Schema.NullOr(Schema.String),
  tierLabel: Schema.NullOr(Schema.String).annotate({
    description: "The rate tier in force (or first, if upcoming).",
  }),
  monthlySurcharge: Schema.NullOr(Schema.Finite).annotate({
    description:
      "Monthly surcharge an upgrade removes (projected for `upcoming`). Null means no figure.",
  }),
  listMonthlySurcharge: Schema.NullOr(Schema.Finite).annotate({
    description: "The list-price figure.",
  }),
  costBasis: CostBasis,
  billedLineItems: Schema.Array(Schema.String).annotate({
    description: "Provider line items behind a billed figure.",
  }),
  nextTier: Schema.NullOr(
    Schema.Struct({
      from: Schema.String,
      label: Schema.String,
      monthlySurcharge: Schema.NullOr(Schema.Finite),
    }),
  ).annotate({ description: "The next, higher rate tier, when the rate is scheduled to rise." }),
  priceNote: Schema.NullOr(Schema.String),
  pricingUrl: Schema.NullOr(Schema.String),
  upgradeUrl: Schema.String,
  note: Schema.NullOr(Schema.String),
}).annotate({ identifier: "ExtendedSupportFinding" });

const UnattributedExtendedSupportCharge = Schema.Struct({
  resourceTypeId: Schema.optionalKey(Schema.String),
  releaseId: Schema.optionalKey(Schema.String),
  region: Schema.optionalKey(Schema.String),
  engine: Schema.optionalKey(Schema.String),
  lineItem: Schema.String.annotate({ description: "Provider line item, e.g. an AWS usage type." }),
  amount: Schema.Finite.annotate({ description: "Billed over the window." }),
  currency: Schema.String,
  accountId: Uuid,
  accountName: Schema.String,
  monthlyAmount: Schema.Finite,
}).annotate({ identifier: "UnattributedExtendedSupportCharge" });

export const ExtendedSupportListResponse = Schema.Struct({
  findings: Schema.Array(ExtendedSupportFinding).annotate({
    description: "Most urgent first, then largest surcharge.",
  }),
  totalCount: Schema.Int,
  counts: Schema.Struct({
    "end-of-life": Schema.Int,
    surcharged: Schema.Int,
    unsupported: Schema.Int,
    upcoming: Schema.Int,
  }),
  currentMonthly: Schema.Array(ExtendedSupportTotal).annotate({
    description: "What surcharged and end-of-life findings cost now.",
  }),
  upcomingMonthly: Schema.Array(ExtendedSupportTotal).annotate({
    description: "What upcoming findings will add once they start.",
  }),
  leadDays: Schema.Int,
  billing: Schema.optionalKey(
    Schema.Struct({
      windowDays: Schema.Int,
      accounts: Schema.Array(
        Schema.Struct({
          accountId: Uuid,
          accountName: Schema.String,
          status: Schema.Literals(["read", "failed"]),
          error: Schema.optionalKey(Schema.String),
        }),
      ),
      unattributed: Schema.Array(UnattributedExtendedSupportCharge),
    }).annotate({
      description: "Present when billed charges were read for at least one account.",
    }),
  ),
  generatedAt: IsoDateTime,
}).annotate({ identifier: "ExtendedSupportListResponse" });

export const ExtendedSupportSettings = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    description: "Whether the weekly extended-support alert is sent.",
  }),
  leadDays: Schema.Int.annotate({
    description: "Days ahead an upcoming surcharge is listed for. Default 90.",
  }),
  lastNotifiedAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When the last weekly alert scan completed. Owned by the poller; read-only.",
  }),
}).annotate({ identifier: "ExtendedSupportSettings" });

/** Documented; the handler checks each field itself and server-core owns the bounds. */
const ExtendedSupportSettingsUpdate = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  leadDays: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 }))),
}).annotate({ identifier: "ExtendedSupportSettingsUpdate" });

export class ExtendedSupportGroup extends HttpApiGroup.make("extendedSupport")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      query: {
        refresh: Schema.optionalKey(
          documentedAs(
            Schema.Literals(["true", "false"]).annotate({
              description: "Bypass the short server-side cache and recompute now.",
            }),
          ),
        ),
      },
      success: ExtendedSupportListResponse,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List resources billed at extended-support or end-of-life rates")
      .annotate(
        OpenApi.Description,
        "Matches every synced resource's version against its provider's support calendar " +
          "(declared by the plugin): resources paying an extended-support surcharge, past the end " +
          "of support, or whose standard support ends within the lead time. Each finding carries " +
          "the monthly surcharge an upgrade removes: the provider's billed amount where it can be " +
          "attributed (AWS Cost Explorer extended-support usage types), otherwise list price. " +
          "Results are cached for a few minutes; pass `refresh=true` to recompute.",
      )
      .annotate(SuccessDescription, "Extended-support findings"),
    HttpApiEndpoint.get("getSettings", "/settings", {
      params: OrgParams,
      success: ExtendedSupportSettings,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Get the organization's extended-support settings")
      .annotate(
        OpenApi.Description,
        "An organization that never saved reads the shipped defaults (enabled, 90 days).",
      )
      .annotate(SuccessDescription, "Extended-support settings"),
    HttpApiEndpoint.put("updateSettings", "/settings", {
      params: OrgParams,
      payload: ExtendedSupportSettingsUpdate,
      success: ExtendedSupportSettings,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Update the extended-support settings")
      .annotate(
        OpenApi.Description,
        "Every field is optional. `leadDays` must be a whole number from 1 to 365. Saving never " +
          "resets the alert cooldown.",
      )
      .annotate(SuccessDescription, "The updated settings")
      .annotate(OpenApi.Transform, optionalRequestBody),
  )
  .prefix("/api/org/:orgId/extended-support")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Orphans") {}

export class ExtendedSupportApi extends withApiDefaults(
  HttpApi.make("extendedSupport").add(ExtendedSupportGroup),
) {}
