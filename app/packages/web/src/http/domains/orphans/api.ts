/**
 * Orphans: `/api/org/:orgId/orphans`, the endpoint definitions.
 *
 * Listing needs `resources:read`; the trailing-spend annotation is cost data,
 * so a caller without `costs:read` gets the flagged rows with `cost: null`
 * rather than a 403 (decided in the handler).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, OrgParams, Uuid } from "../../schemas/common";
import { PluginId } from "../../schemas/plugin-registry";
import { FindingRemediation } from "../../schemas/remediation";

const OrphanCostAnnotation = Schema.Struct({
  amount: Schema.Finite.annotate({ description: "Spend over the trailing cost window." }),
  currency: Schema.String.annotate({ examples: ["USD"] }),
}).annotate({ identifier: "OrphanCostAnnotation" });

const ResourceOwnerAnnotation = Schema.Struct({
  userId: Schema.NullOr(Uuid).annotate({ description: "Set when a routable org member owns it." }),
  displayName: Schema.String.annotate({
    description: "The member's name, or the free-text owner.",
  }),
  isLabel: Schema.Boolean.annotate({
    description: "True when the owner is free text; nothing can be routed to it.",
  }),
  ticketUrl: Schema.NullOr(Schema.String),
  purpose: Schema.NullOr(Schema.String),
}).annotate({ identifier: "ResourceOwnerAnnotation" });

const IdleMetricEvidence = Schema.Struct({
  metric: Schema.String.annotate({
    description: "Provider metric name.",
    examples: ["BytesOutToDestination"],
  }),
  label: Schema.String.annotate({ examples: ["Bytes sent to the internet"] }),
  statistic: Schema.Literals(["sum", "max", "average", "min", "count"]),
  value: Schema.NullOr(Schema.Finite).annotate({
    description:
      "The aggregate over the whole lookback window; null when the provider had no data.",
  }),
  unit: Schema.Literals(["count", "bytes", "percent", "days"]),
  threshold: Schema.optionalKey(
    Schema.NullOr(Schema.Finite).annotate({
      description: "The bound this reading was judged against, when it was a deciding reading.",
    }),
  ),
  comparison: Schema.optionalKey(
    Schema.Literals(["atMost", "atLeast"]).annotate({
      description: "`atMost`: the value at or under the threshold is the idle side.",
    }),
  ),
}).annotate({ identifier: "IdleMetricEvidence" });

const IdleSavingsEstimate = Schema.Struct({
  monthlyAmount: Schema.Finite.annotate({
    description: "Monthly figure at the provider's published rate.",
  }),
  currency: Schema.String.annotate({ examples: ["USD"] }),
  basis: Schema.Literals(["list-price"]),
  note: Schema.optionalKey(
    Schema.String.annotate({ description: "Caveat shown beside the figure." }),
  ),
}).annotate({ identifier: "IdleSavingsEstimate" });

const OrphanIdleDetail = Schema.Struct({
  ruleId: Schema.String.annotate({ examples: ["nat-gateway"] }),
  ruleKey: Schema.String.annotate({
    description: "`pluginId:ruleId`, the key the settings use.",
    examples: ["aws:nat-gateway"],
  }),
  ruleLabel: Schema.String.annotate({ examples: ["Idle NAT gateway"] }),
  action: Schema.Literals(["remove", "reconfigure", "stop"]).annotate({
    description:
      "What acting on it means. Only `remove` findings are offered as a removal pull request.",
  }),
  lookbackDays: Schema.Int,
  evidence: Schema.Array(IdleMetricEvidence),
  detectedAt: IsoDateTime.annotate({ description: "First collection that flagged it." }),
  evaluatedAt: IsoDateTime.annotate({ description: "Latest collection that confirmed it." }),
  hasResource: Schema.Boolean.annotate({
    description:
      "False when the subject is not a synced resource (a custom metric): `id` is then a " +
      "finding id, not a resource id.",
  }),
}).annotate({ identifier: "OrphanIdleDetail" });

const OrphanedResource = Schema.Struct({
  id: Schema.String.annotate({
    description:
      "Infrawrench resource id; for an idle finding whose `idle.hasResource` is false, a " +
      "finding id prefixed `idle:`.",
  }),
  pluginId: PluginId,
  resourceTypeId: Schema.String,
  resourceTypeName: Schema.String.annotate({ examples: ["EBS Volume"] }),
  displayName: Schema.String,
  externalId: Schema.NullOr(Schema.String).annotate({
    description: "Provider-native id, when known.",
  }),
  reason: Schema.String.annotate({
    description: "Plugin-authored explanation of why this resource looks wasted.",
    examples: ["Volume is not attached to any Droplet"],
  }),
  cost: Schema.NullOr(OrphanCostAnnotation).annotate({
    description:
      "Best-effort trailing spend matched from collected per-resource cost rows; " +
      "null when the provider reports no per-resource cost. The flag itself never " +
      "depends on billing data.",
  }),
  owner: Schema.NullOr(ResourceOwnerAnnotation).annotate({
    description:
      "Who owns this resource, or null when nobody has claimed it. Present only " +
      "when the owner can be named: a resource carrying a purpose but no owner " +
      "reads as null, because the question this answers is who to tell.",
  }),
  lastSyncedAt: Schema.NullOr(IsoDateTime),
  remediation: Schema.optionalKey(FindingRemediation).annotateKey({
    description:
      "Ready-to-run commands to clean this resource up (snapshot first where it applies).",
  }),
  idle: Schema.optionalKey(OrphanIdleDetail).annotateKey({
    description:
      "Present when a metric-based idle rule flagged the row rather than the type's " +
      "orphan rule: the rule, the metric evidence and the lookback window.",
  }),
  estimate: Schema.optionalKey(
    Schema.NullOr(IdleSavingsEstimate).annotate({
      description:
        "Monthly figure at the provider's published list price, for idle rows a plugin could " +
        "price. An estimate: show it only when `cost` (billed spend) is null.",
    }),
  ),
}).annotate({ identifier: "OrphanedResource" });

const OrphanAccountGroup = Schema.Struct({
  accountId: Uuid,
  accountName: Schema.String,
  pluginId: PluginId,
  pluginName: Schema.String.annotate({ examples: ["DigitalOcean"] }),
  resources: Schema.Array(OrphanedResource),
}).annotate({ identifier: "OrphanAccountGroup" });

export const OrphanListResponse = Schema.Struct({
  accounts: Schema.Array(OrphanAccountGroup).annotate({
    description: "Groups sorted by account name.",
  }),
  totalCount: Schema.Int,
  unownedCount: Schema.Int.annotate({
    description: "Flagged resources with no recorded owner; the 'nobody to ask' count.",
  }),
  costWindowDays: Schema.Int.annotate({
    description: "Days of trailing spend the annotations cover.",
  }),
  generatedAt: IsoDateTime,
}).annotate({ identifier: "OrphanListResponse" });

export class OrphansGroup extends HttpApiGroup.make("orphans")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: OrphanListResponse,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List likely-orphaned and idle resources")
      .annotate(
        OpenApi.Description,
        "Scans the organization's already-synced resources against each plugin's declarative " +
          "orphan heuristics (unattached volumes, unassigned floating/elastic IPs, reserved-but-" +
          "unused static IPs) and returns the matches grouped by account, each with the plugin's " +
          "reason. Rows flagged by a metric-based idle rule (a NAT gateway with no traffic, a load " +
          "balancer with no requests) carry `idle` with the evidence; those verdicts come from a " +
          "daily collection, tuned under `/idle-findings`. Purely a read over stored state: no " +
          "provider API calls are made. Where the org's collected cost data has per-resource rows, " +
          "matches are annotated with trailing spend; idle rows a plugin could price also carry a " +
          "list-price `estimate`.",
      )
      .annotate(SuccessDescription, "Flagged resources grouped by account"),
  )
  .prefix("/api/org/:orgId/orphans")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Orphans") {}

export class OrphansApi extends withApiDefaults(HttpApi.make("orphans").add(OrphansGroup)) {}
