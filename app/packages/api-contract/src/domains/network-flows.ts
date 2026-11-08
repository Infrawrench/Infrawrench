/**
 * Network flow attribution: `/api/org/:orgId/network-flows`, the endpoint
 * definitions. Which two things are talking, across which billing boundary,
 * and what that costs; plus per-cluster Kubernetes network costs and the
 * saved network flow reports.
 *
 * All of it is spend information, so reading is `costs:read`. Turning
 * collection on is `org:settings:write` (it runs queries the provider bills
 * to the organization's own cloud account, every day); the per-cluster billed
 * source and saved reports are cost-object edits, `costs:write`.
 *
 * The range parameters and the bodies are documented here and read raw by
 * the handlers, which answer a malformed one with their own sentence (the
 * report bodies are judged by client-core's normalizers).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { CostDateRange, maxLength, minLength, pattern } from "../schemas";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Forbidden, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { documentedAs } from "../http/schemas/documented";
import { numericQuery } from "../http/schemas/query";
import { IsoDateTime, Ok, OrgParams, Uuid } from "../http/schemas/common";

/* ------------------------------------------------------------- the feed -- */

const SCOPES = [
  "intra_zone",
  "cross_zone",
  "cross_region",
  "internet_egress",
  "internet_ingress",
  "provider_service",
  "nat_gateway",
  "private_interconnect",
  "unknown",
] as const;

const NetworkFlowScope = Schema.Literals(SCOPES).annotate({
  description:
    "Which billing boundary the traffic crossed. `unknown` means the provider's record did " +
    "not determine one; it is priced at zero and labelled rather than folded into a " +
    "neighbouring boundary.",
});

const NetworkFlowDirection = Schema.Literals(["egress", "ingress"]);

const NetworkFlowEndpoint = Schema.Struct({
  ref: Schema.String.annotate({
    description:
      "Stable endpoint identity; a provider resource id where one could be resolved, " +
      "otherwise a class token (`internet`, `aws:s3`, `infrawrench:unattributed`). Never a " +
      "raw IP address: addresses churn, so the same workload would be a different row " +
      "every day.",
  }),
  label: Schema.String,
  zone: Schema.String,
  region: Schema.String,
  service: Schema.String,
  resourceTypeId: Schema.String.annotate({
    description: "Set when `ref` is a resource this organization syncs, so the row can link out.",
  }),
}).annotate({ identifier: "NetworkFlowEndpoint" });

const NetworkFlowScopeSummary = Schema.Struct({
  scope: NetworkFlowScope,
  direction: NetworkFlowDirection,
  bytes: Schema.Finite,
  estimatedCost: Schema.Finite,
  currency: Schema.String,
  crossedZone: Schema.Boolean,
  crossedRegion: Schema.Boolean,
  leftCloud: Schema.Boolean,
  unattributedBytes: Schema.Finite.annotate({
    description:
      "Bytes inside `bytes` whose endpoints could not be tied to a workload. A subset, not " +
      "an addition: nothing here has been apportioned across the attributed rows.",
  }),
  truncatedBytes: Schema.Finite.annotate({
    description:
      "Bytes inside `bytes` that fell below the stored top-N pair cap, computed by " +
      "subtraction against the provider's exact totals rather than estimated.",
  }),
}).annotate({ identifier: "NetworkFlowScopeSummary" });

const NetworkFlowPair = Schema.Struct({
  source: NetworkFlowEndpoint,
  destination: NetworkFlowEndpoint,
  scope: NetworkFlowScope,
  direction: NetworkFlowDirection,
  attribution: Schema.Literals(["resolved", "unattributed"]),
  bytes: Schema.Finite,
  packets: Schema.Finite,
  estimatedCost: Schema.Finite,
  currency: Schema.String,
  accountId: Schema.String,
  pluginId: Schema.String,
  days: Schema.Int.annotate({ description: "Days in the range this pair appeared on." }),
}).annotate({ identifier: "NetworkFlowPair" });

const NetworkFlowSource = Schema.Struct({
  id: Schema.String,
  target: Schema.String.annotate({
    description: "What the flow log is attached to; a VPC id, a network.",
  }),
  region: Schema.NullOr(Schema.String),
  destinationType: Schema.String,
  usable: Schema.Boolean,
  unusableReason: Schema.NullOr(Schema.String).annotate({
    description: "Why the source cannot be read, in terms that name the fix.",
  }),
  helpUrl: Schema.NullOr(Schema.String),
}).annotate({ identifier: "NetworkFlowSource" });

const NetworkFlowAccountStatus = Schema.Struct({
  accountId: Schema.String,
  pluginId: Schema.String,
  displayName: Schema.String,
  supportsFlows: Schema.Boolean.annotate({
    description:
      "False when the account's provider has no flow source we can read. Such accounts are " +
      "listed and excluded from the totals rather than contributing zero bytes; zero would " +
      "be a claim about their network, this is a statement about our coverage.",
  }),
  recut: Schema.Boolean.annotate({
    description:
      "True when the account's flows re-cut traffic another account may already report (a " +
      "Kubernetes cluster's pods). Left out of this feed's totals unless asked for by " +
      "`accountId`; see `GET /network-flows/kubernetes/{accountId}`.",
  }),
  collectedThrough: Schema.NullOr(Schema.String),
  lastPolledAt: Schema.NullOr(Schema.String),
  failureCount: Schema.Int,
  lastError: Schema.NullOr(Schema.String),
  lastErrorHelpUrl: Schema.NullOr(Schema.String),
  sources: Schema.Array(NetworkFlowSource),
  lastQueryBytesScanned: Schema.NullOr(Schema.Finite).annotate({
    description: "Log data the provider billed this account for the last collection's queries.",
  }),
}).annotate({ identifier: "NetworkFlowAccountStatus" });

const NetworkFlowRateCard = Schema.Struct({
  pluginId: Schema.String,
  currency: Schema.String,
  asOf: Schema.String.annotate({
    description: "Date the rates were last checked against the provider's pricing page.",
  }),
  perGb: Schema.Record(Schema.String, Schema.Finite),
  queriesBillable: Schema.Boolean.annotate({
    description:
      "True when collecting flows runs queries the provider bills to your cloud account.",
  }),
  sampled: Schema.Boolean.annotate({
    description: "True when the flow source samples rather than recording all flows.",
  }),
}).annotate({ identifier: "NetworkFlowRateCard" });

const Range = Schema.Struct({ from: Schema.String, to: Schema.String });

export const NetworkFlowFeed = Schema.Struct({
  enabled: Schema.Boolean,
  initialLookbackDays: Schema.Int,
  estimated: Schema.Literal(true).annotate({
    description:
      "Always true. Flow bytes come from logs that sample or drop under load and are priced " +
      "at published list rates with no free tier, no volume tier and no negotiated discount " +
      "modelled: the ranking is sound, the absolute figure will not reconcile to the invoice.",
  }),
  range: Range,
  scopes: Schema.Array(NetworkFlowScopeSummary),
  topFlows: Schema.Array(NetworkFlowPair),
  accounts: Schema.Array(NetworkFlowAccountStatus),
  rateCards: Schema.Array(NetworkFlowRateCard),
  totals: Schema.Struct({
    bytes: Schema.Finite,
    estimatedCost: Schema.Finite,
    currency: Schema.String,
    unattributedBytes: Schema.Finite,
    truncatedBytes: Schema.Finite,
  }),
}).annotate({ identifier: "NetworkFlowFeed" });

/* ----------------------------------------------------------- Kubernetes -- */

const KubernetesNetworkMethod = Schema.Literals([
  "flow_log",
  "in_cluster_flows",
  "counter_estimate",
  "",
]).annotate({
  description:
    "How the bytes and boundary were established, strongest first: `flow_log` (the cloud's " +
    "VPC flow log for the node, split across its pods by their counters), " +
    "`in_cluster_flows` (Cilium Hubble named the peers; the boundary follows from where they " +
    "run), `counter_estimate` (the kubelet's per-pod byte counter alone, no destination, " +
    "boundary unknown). Empty for residual rows.",
});

const KubernetesNetworkRow = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  namespace: Schema.String,
  kind: Schema.Literals(["workload", "namespace", "node", "truncated"]),
  bytes: Schema.Finite,
  estimatedCost: Schema.Finite.annotate({
    description: "Bytes × the published rate for each boundary crossed.",
  }),
  allocatedCost: Schema.NullOr(Schema.Finite).annotate({
    description:
      "This row's share of the cluster's billed data transfer. Null when no billed source is " +
      "configured. The rows never add up to more than was billed.",
  }),
  byScope: Schema.Record(Schema.String, Schema.Finite).annotate({
    description: "Bytes by boundary.",
  }),
  method: KubernetesNetworkMethod,
}).annotate({ identifier: "KubernetesNetworkRow" });

export const KubernetesNetworkReport = Schema.Struct({
  accountId: Schema.String,
  displayName: Schema.String,
  range: Range,
  estimated: Schema.Literal(true),
  currency: Schema.String,
  totals: Schema.Struct({
    bytes: Schema.Finite,
    estimatedCost: Schema.Finite,
    allocatedCost: Schema.NullOr(Schema.Finite),
    unallocatedCost: Schema.NullOr(Schema.Finite).annotate({
      description: "Billed money no observed traffic accounted for. Never spread across rows.",
    }),
  }),
  billed: Schema.Struct({
    query: Schema.NullOr(Schema.String),
    error: Schema.NullOr(Schema.String),
    billedCost: Schema.NullOr(Schema.Finite),
    basis: Schema.Literals(["cost", "bytes", "none"]).annotate({
      description:
        "`cost`: apportioned by list-priced traffic. `bytes`: nothing in the range could be " +
        "priced, so apportioned by bytes alone (weakest). `none`: nothing apportioned.",
    }),
    scaledDays: Schema.Int,
    daysWithoutBilled: Schema.Int,
  }),
  scopes: Schema.Array(
    Schema.Struct({
      scope: NetworkFlowScope,
      bytes: Schema.Finite,
      estimatedCost: Schema.Finite,
      allocatedCost: Schema.NullOr(Schema.Finite),
    }),
  ),
  methods: Schema.Array(Schema.Struct({ method: KubernetesNetworkMethod, bytes: Schema.Finite })),
  namespaces: Schema.Array(KubernetesNetworkRow),
  workloads: Schema.Array(KubernetesNetworkRow),
  topTalkers: Schema.Array(NetworkFlowPair),
  collection: Schema.NullOr(NetworkFlowAccountStatus),
}).annotate({ identifier: "KubernetesNetworkReport" });

const BilledQuery = Schema.NullOr(Schema.String.check(maxLength(4000)));

export const KubernetesNetworkSettings = Schema.Struct({
  accountId: Schema.String,
  billedQuery: BilledQuery.annotate({
    description:
      "Cost query language text selecting this cluster's billed data-transfer rows, for " +
      "example `account = 'prod-aws' AND service = 'AWS Data Transfer'`. Null: none.",
  }),
  updatedAt: Schema.NullOr(Schema.String),
}).annotate({ identifier: "KubernetesNetworkSettings" });

/** The cluster's params, documented as plain strings, as they always were. */
const AccountIdParams = { orgId: Schema.String, accountId: Schema.String } as const;

export const NetworkFlowSettings = Schema.Struct({
  enabled: Schema.Boolean,
  initialLookbackDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 })),
}).annotate({ identifier: "NetworkFlowSettings" });

/* -------------------------------------------------------- saved reports -- */

const ReportIdParams = { orgId: Uuid, id: Uuid } as const;

const TrafficClass = Schema.Literals([
  "intra_zone",
  "cross_zone",
  "cross_region",
  "internet_egress",
  "internet_ingress",
  "nat_gateway",
  "private_interconnect",
  "provider_service",
  "unknown",
]).annotate({
  identifier: "NetworkFlowTrafficClass",
  description:
    "The billing boundary a flow crossed. Intra-region VPC peering is billed, and classified, " +
    "as `cross_zone`; transit gateway, VPN and interconnect traffic is `private_interconnect`.",
});

const Granularity = Schema.Literals(["daily", "weekly", "monthly"]).annotate({
  identifier: "NetworkFlowReportGranularity",
  description:
    "Bucket size. No hourly (flows are stored one row per UTC day) and no quarterly (the store " +
    "keeps 90 days). Weeks start on Monday.",
});

const GroupBy = Schema.Literals([
  "none",
  "pair",
  "source",
  "destination",
  "traffic_class",
  "service",
  "zone_pair",
  "region_pair",
  "account",
  "network",
]).annotate({
  identifier: "NetworkFlowReportGroupBy",
  description:
    "Pair-shaped groupings (`pair`, `zone_pair`, `region_pair`) key on source then destination, " +
    "joined by U+001F. `service` is the peer's provider service (the destination of egress, " +
    "the source of ingress); `network` is the local side's VPC. Under `pair`, `source` and " +
    "`destination` the per-day remainder below the stored pair cap is its own group, keyed " +
    "`infrawrench:truncated`.",
});

const Metric = Schema.Literals(["cost", "bytes", "both"]).annotate({
  identifier: "NetworkFlowReportMetric",
  description:
    "What the report shows. `bytes` ranks groups and pairs by bytes; `cost` and `both` rank by " +
    "estimated cost. Every result carries both figures either way.",
});

const list = <S extends Schema.Top>(item: S, description?: string) =>
  Schema.optionalKey(
    Schema.Array(item)
      .check(maxLength(200))
      .annotate(description === undefined ? {} : { description }),
  );

const Filters = Schema.Struct({
  accountIds: list(Uuid),
  networks: list(Schema.String, "VPC / network ids, matched at either end."),
  regions: list(Schema.String, "Provider regions, matched at either end."),
  zones: list(Schema.String, "Availability zone ids, matched at either end."),
  sourceRefs: list(Schema.String, "Source endpoint refs, as `report-options` lists them."),
  destinationRefs: list(
    Schema.String,
    "Destination endpoint refs, as `report-options` lists them.",
  ),
  services: list(Schema.String, "The peer's provider service (`s3`, `dynamodb`)."),
  resourceTypes: list(Schema.String, "The peer's resource type id."),
  trafficClasses: list(TrafficClass),
  directions: list(NetworkFlowDirection),
}).annotate({
  identifier: "NetworkFlowReportFilters",
  description:
    "Lists AND-compose; values within a list OR. An absent or empty list does not filter. " +
    "Without `accountIds`, Kubernetes cluster traffic is left out (it re-cuts bytes a cloud " +
    "flow log already counts); naming a cluster's account includes it.",
});

const Config = Schema.Struct({
  version: Schema.Literal(1),
  dateRange: CostDateRange,
  granularity: Granularity,
  groupBy: GroupBy,
  filters: Filters,
  metric: Metric,
  topN: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })).annotate({
      description: "Groups and top talkers listed. Absent means 25.",
    }),
  ),
}).annotate({ identifier: "NetworkFlowReportConfig" });

const Input = Schema.Struct({
  name: Schema.String.check(minLength(1), maxLength(120)),
  description: Schema.optionalKey(Schema.NullOr(Schema.String.check(maxLength(2000)))),
  config: Config,
  folderId: Schema.optionalKey(
    Schema.NullOr(Uuid).annotate({
      description:
        "A report folder (`/cost-report-folders`, shared with cost reports); null is the top level.",
    }),
  ),
}).annotate({ identifier: "NetworkFlowReportInput" });

export const Report = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  config: Config,
  folderId: Schema.NullOr(Uuid),
  createdByUserId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "NetworkFlowReport" });

const totalsFields = {
  bytes: Schema.Finite.annotate({ description: "Observed bytes (decimal: a GB is 10^9 bytes)." }),
  estimatedCost: Schema.Finite.annotate({
    description:
      "Bytes priced at the provider's published list rate for the boundary crossed. Always an " +
      "estimate: free allowances, volume tiers and negotiated rates are not modelled.",
  }),
  sampledBytes: Schema.Finite.annotate({
    description:
      "Of `bytes`, those from a flow source that samples. The plugin already scaled them up; " +
      "they are counted and labelled, never dropped.",
  }),
  sampledCost: Schema.Finite.annotate({
    description: "Of `estimatedCost`, the part priced from sampled bytes.",
  }),
  unattributedBytes: Schema.Finite.annotate({
    description: "Of `bytes`, those that could not be tied to a workload at one end.",
  }),
  truncatedBytes: Schema.Finite.annotate({
    description: "Of `bytes`, the per-day remainder below the stored pair cap.",
  }),
};

const Totals = Schema.Struct(totalsFields).annotate({ identifier: "NetworkFlowReportTotals" });

const Point = Schema.Struct({ bucket: Schema.String, ...totalsFields }).annotate({
  identifier: "NetworkFlowReportPoint",
});

const Series = Schema.Struct({
  id: Schema.String,
  groupKey: Schema.String.annotate({
    description: "The group's key; `__other__` is everything outside the charted groups.",
  }),
  label: Schema.String,
  currency: Schema.String,
  points: Schema.Array(Point),
  total: Totals,
}).annotate({ identifier: "NetworkFlowReportSeries" });

const GroupTotal = Schema.Struct({
  groupKey: Schema.String,
  label: Schema.String,
  currency: Schema.String,
  pairCount: Schema.Int,
  ...totalsFields,
}).annotate({ identifier: "NetworkFlowReportGroupTotal" });

const ReportEndpoint = Schema.Struct({
  ref: Schema.String,
  label: Schema.String,
  zone: Schema.String,
  region: Schema.String,
  service: Schema.String,
  resourceTypeId: Schema.String,
  network: Schema.String.annotate({
    description: "The endpoint's VPC / network id, when the provider reports it.",
  }),
}).annotate({ identifier: "NetworkFlowReportEndpoint" });

const Talker = Schema.Struct({
  source: ReportEndpoint,
  destination: ReportEndpoint,
  scope: TrafficClass,
  direction: NetworkFlowDirection,
  attribution: Schema.Literals(["resolved", "unattributed"]),
  bytes: Schema.Finite,
  packets: Schema.Finite,
  estimatedCost: Schema.Finite,
  currency: Schema.String,
  accountId: Schema.String,
  accountName: Schema.String,
  pluginId: Schema.String,
  days: Schema.Int.annotate({ description: "Days in the window the pair appeared on." }),
  sampled: Schema.Boolean.annotate({
    description: "True when the pair's bytes came from a sampled flow source.",
  }),
}).annotate({ identifier: "NetworkFlowReportTalker" });

const Notice = Schema.Literals([
  "collection_disabled",
  "no_flow_accounts",
  "beyond_retention",
  "sampled_sources",
  "recut_excluded",
  "unattributed_traffic",
  "truncated_traffic",
  "multiple_currencies",
]).annotate({ identifier: "NetworkFlowReportNotice" });

const resultFields = {
  from: Schema.String,
  to: Schema.String,
  granularity: Granularity,
  groupBy: GroupBy,
  metric: Metric,
  estimated: Schema.Literal(true),
  buckets: Schema.Array(Schema.String),
  series: Schema.Array(Series).annotate({
    description:
      "The chart: the largest groups, then one `__other__` series per currency, so the stack " +
      "adds up to `overall`. Empty when `groupBy` is `none`.",
  }),
  overall: Schema.Array(Series).annotate({
    description: "All groups combined, one series per currency.",
  }),
  groups: Schema.Array(GroupTotal).annotate({
    description: "Per-group totals, largest first, up to `topN`.",
  }),
  groupCount: Schema.Int.annotate({
    description: "How many groups there were before the `topN` cut.",
  }),
  topTalkers: Schema.Array(Talker),
  sampledPluginIds: Schema.Array(Schema.String),
  notices: Schema.Array(Notice),
};

export const Result = Schema.Struct(resultFields).annotate({
  identifier: "NetworkFlowReportResult",
});

export const RunResult = Schema.Struct({
  ...resultFields,
  reportId: Uuid,
  name: Schema.String,
}).annotate({ identifier: "NetworkFlowReportRunResult" });

export const Options = Schema.Struct({
  accounts: Schema.Array(
    Schema.Struct({
      id: Uuid,
      name: Schema.String,
      pluginId: Schema.String,
      recut: Schema.Boolean.annotate({
        description: "True for a Kubernetes cluster, whose traffic is only read when named.",
      }),
    }),
  ),
  networks: Schema.Array(Schema.String),
  regions: Schema.Array(Schema.String),
  zones: Schema.Array(Schema.String),
  services: Schema.Array(Schema.String),
  resourceTypes: Schema.Array(Schema.String),
  endpoints: Schema.Array(
    Schema.Struct({
      ref: Schema.String,
      label: Schema.String,
      resourceTypeId: Schema.String,
      side: Schema.Literals(["source", "destination", "both"]),
    }),
  ),
  trafficClasses: Schema.Array(TrafficClass),
}).annotate({ identifier: "NetworkFlowReportOptions" });

/* ------------------------------------------------------------ endpoints -- */

const Day = Schema.String.check(pattern(/^\d{4}-\d{2}-\d{2}$/));

/** Read as sent: the handler checks the range and the limit itself. */
const rangeQuery = {
  from: Schema.optionalKey(
    documentedAs(Day.annotate({ description: "Inclusive start day. Defaults to 13 days ago." })),
  ),
  to: Schema.optionalKey(
    documentedAs(Day.annotate({ description: "Inclusive end day. Defaults to today." })),
  ),
};

const limitDoc = (description: string) =>
  Schema.optionalKey(documentedAs(Schema.String.annotate({ description })));

const limitAsInteger = numericQuery({ limit: { type: "integer", minimum: 1, maximum: 200 } });

export class NetworkFlowsGroup extends HttpApiGroup.make("networkFlows")
  .add(
    HttpApiEndpoint.get("feed", "/", {
      params: OrgParams,
      query: {
        ...rangeQuery,
        scope: Schema.optionalKey(
          documentedAs(
            Schema.Literals(SCOPES).annotate({ description: "Narrow to one billing boundary." }),
          ),
        ),
        accountId: Schema.optionalKey(
          Schema.String.annotate({ description: "Narrow to one connected account." }),
        ),
        limit: limitDoc("Pairs to return in `topFlows`, largest cost first. Defaults to 50."),
      },
      success: NetworkFlowFeed,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Priced source→destination network flow attribution")
      .annotate(
        OpenApi.Description,
        "Which two things are talking, across which billing boundary, and what that costs. " +
          "Answers the question the cost dimensions structurally cannot: every cost dimension is " +
          "about one side of a transfer, and a network charge is about a pair.\n\n" +
          "All figures are **estimates** and the `estimated` field says so unconditionally. " +
          "Bytes come from the provider's flow logs (which sample, or drop records under capacity " +
          "pressure) and are priced at published list rates with no free tier, no volume tier and " +
          "no negotiated discount applied. Use the ranking; do not reconcile the total against an " +
          "invoice line.\n\n" +
          "Accounts whose provider has no readable flow source appear in `accounts` with " +
          "`supportsFlows: false` and contribute nothing to the totals; never zero bytes.",
      )
      .annotate(OpenApi.Transform, limitAsInteger)
      .annotate(SuccessDescription, "Flow attribution for the range"),
    HttpApiEndpoint.get("kubernetes", "/kubernetes/:accountId", {
      params: AccountIdParams,
      query: {
        ...rangeQuery,
        limit: limitDoc("Pairs to return in `topTalkers`. Defaults to 25."),
      },
      success: KubernetesNetworkReport,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Kubernetes network costs for one cluster")
      .annotate(
        OpenApi.Description,
        "Pod-level network attribution for a Kubernetes account: bytes by namespace, workload and " +
          "boundary (same zone, cross-zone, cross-region, internet), the largest workload → peer " +
          "pairs, and which sources the figures came from.\n\n" +
          "`estimatedCost` is bytes at the published rate of the cloud the nodes run on, with any " +
          "per-cluster overrides from the account's rates field. When a billed source is configured " +
          "(`PUT .../settings`), `allocatedCost` apportions that real billed spend across the rows " +
          "day by day, never handing out more than was billed; the rest is `unallocatedCost`.",
      )
      .annotate(OpenApi.Transform, limitAsInteger)
      .annotate(SuccessDescription, "The cluster's network costs"),
    HttpApiEndpoint.get("kubernetesSettings", "/kubernetes/:accountId/settings", {
      params: AccountIdParams,
      success: KubernetesNetworkSettings,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Read a cluster's network cost settings")
      .annotate(SuccessDescription, "Settings"),
    // `costs:write`: it changes how collected money is apportioned on screen,
    // never what is collected or spent. Audit-logged: it moves money between
    // teams' views.
    HttpApiEndpoint.put("setKubernetesSettings", "/kubernetes/:accountId/settings", {
      params: AccountIdParams,
      payload: Schema.Struct({ billedQuery: BilledQuery }),
      success: KubernetesNetworkSettings,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Set the billed data-transfer source for a cluster")
      .annotate(
        OpenApi.Description,
        "Say which billed cost rows are this cluster's data transfer, in the cost query language. " +
          "An empty or null query clears it. A query that narrows nothing is refused: it would " +
          "apportion the whole bill across one cluster.",
      )
      .annotate(SuccessDescription, "Updated settings"),
    HttpApiEndpoint.get("settings", "/settings", {
      params: OrgParams,
      success: NetworkFlowSettings,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Read the network flow collection switch")
      .annotate(SuccessDescription, "Settings"),
    // Not `costs:write`: enabling collection spends the organization's money
    // in its own cloud account every day until somebody turns it off, a
    // governance decision like a billing rule. Audit-logged for the same reason.
    HttpApiEndpoint.put("setSettings", "/settings", {
      params: OrgParams,
      payload: NetworkFlowSettings,
      success: NetworkFlowSettings,
      error: [BadRequest, Forbidden],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Turn network flow collection on or off")
      .annotate(
        OpenApi.Description,
        "Collection is **off by default**. Enabling it authorizes Infrawrench to run daily " +
          "queries against the provider's log store; and on AWS those queries are billed to your " +
          "own cloud account per GB of log data scanned, every day, until you turn them off. That " +
          "is why the write is governed by `org:settings:write` rather than `costs:write`, and why " +
          "it is audit-logged.",
      )
      .annotate(SuccessDescription, "Updated settings"),
    HttpApiEndpoint.get("reportOptions", "/report-options", {
      params: OrgParams,
      success: Options,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Picker values for the network flow report editor")
      .annotate(
        OpenApi.Description,
        "Accounts whose provider can report flows, and every VPC, region, zone, peer service, " +
          "peer resource type and endpoint seen in the store's 90-day retention. Scoped to what the " +
          "caller may see.",
      )
      .annotate(SuccessDescription, "Options"),
    // A read despite the method, like `/costs/query`.
    HttpApiEndpoint.post("reportQuery", "/report-query", {
      params: OrgParams,
      payload: Config,
      success: Result,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Run an unsaved network flow report config")
      .annotate(
        OpenApi.Description,
        "Bytes and estimated cost over time, per group, with the top talking pairs. A read despite " +
          "the method.",
      )
      .annotate(SuccessDescription, "The report"),
    HttpApiEndpoint.get("listReports", "/reports", {
      params: OrgParams,
      success: Schema.Array(Report),
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List saved network flow reports")
      .annotate(SuccessDescription, "Reports"),
    HttpApiEndpoint.post("createReport", "/reports", {
      params: OrgParams,
      payload: Input,
      success: Report,
      error: [BadRequest, Forbidden],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Create a network flow report")
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.get("getReport", "/reports/:id", {
      params: ReportIdParams,
      success: Report,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Get a network flow report")
      .annotate(SuccessDescription, "The report"),
    HttpApiEndpoint.put("updateReport", "/reports/:id", {
      params: ReportIdParams,
      payload: Input,
      success: Report,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Replace a network flow report")
      .annotate(SuccessDescription, "Updated"),
    HttpApiEndpoint.delete("deleteReport", "/reports/:id", {
      params: ReportIdParams,
      success: Ok,
      error: [Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "costs:write")
      .annotate(OpenApi.Summary, "Delete a network flow report")
      .annotate(SuccessDescription, "Deleted"),
    // A read despite the method.
    HttpApiEndpoint.post("runReport", "/reports/:id/run", {
      params: ReportIdParams,
      success: RunResult,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Run a saved network flow report")
      .annotate(OpenApi.Description, "A relative date range resolves against today on every run.")
      .annotate(SuccessDescription, "The report"),
  )
  .prefix("/api/org/:orgId/network-flows")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Network flows") {}

export class NetworkFlowsApi extends withApiDefaults(
  HttpApi.make("networkFlows").add(NetworkFlowsGroup),
) {}
