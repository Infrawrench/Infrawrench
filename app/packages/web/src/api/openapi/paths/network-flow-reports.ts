import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";
import { CostDateRange } from "./cost-reports";

const IdParam = strict({ orgId: Uuid, id: Uuid });

const TRAFFIC_CLASSES = [
  "intra_zone",
  "cross_zone",
  "cross_region",
  "internet_egress",
  "internet_ingress",
  "nat_gateway",
  "private_interconnect",
  "provider_service",
  "unknown",
] as const;

const TrafficClass = z
  .enum(TRAFFIC_CLASSES)
  .describe(
    "The billing boundary a flow crossed. Intra-region VPC peering is billed, and classified, " +
      "as `cross_zone`; transit gateway, VPN and interconnect traffic is `private_interconnect`.",
  )
  .openapi("NetworkFlowTrafficClass");

const Direction = z.enum(["egress", "ingress"]);

const Granularity = z
  .enum(["daily", "weekly", "monthly"])
  .describe(
    "Bucket size. No hourly (flows are stored one row per UTC day) and no quarterly (the store " +
      "keeps 90 days). Weeks start on Monday.",
  )
  .openapi("NetworkFlowReportGranularity");

const GroupBy = z
  .enum([
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
  ])
  .describe(
    "Pair-shaped groupings (`pair`, `zone_pair`, `region_pair`) key on source then destination, " +
      "joined by U+001F. `service` is the peer's provider service (the destination of egress, " +
      "the source of ingress); `network` is the local side's VPC. Under `pair`, `source` and " +
      "`destination` the per-day remainder below the stored pair cap is its own group, keyed " +
      "`infrawrench:truncated`.",
  )
  .openapi("NetworkFlowReportGroupBy");

const Metric = z
  .enum(["cost", "bytes", "both"])
  .describe(
    "What the report shows. `bytes` ranks groups and pairs by bytes; `cost` and `both` rank by " +
      "estimated cost. Every result carries both figures either way.",
  )
  .openapi("NetworkFlowReportMetric");

const list = <T extends z.ZodTypeAny>(item: T) => z.array(item).max(200).optional();

const Filters = strict({
  accountIds: list(Uuid),
  networks: list(z.string()).describe("VPC / network ids, matched at either end."),
  regions: list(z.string()).describe("Provider regions, matched at either end."),
  zones: list(z.string()).describe("Availability zone ids, matched at either end."),
  sourceRefs: list(z.string()).describe("Source endpoint refs, as `report-options` lists them."),
  destinationRefs: list(z.string()).describe(
    "Destination endpoint refs, as `report-options` lists them.",
  ),
  services: list(z.string()).describe("The peer's provider service (`s3`, `dynamodb`)."),
  resourceTypes: list(z.string()).describe("The peer's resource type id."),
  trafficClasses: list(TrafficClass),
  directions: list(Direction),
})
  .describe(
    "Lists AND-compose; values within a list OR. An absent or empty list does not filter. " +
      "Without `accountIds`, Kubernetes cluster traffic is left out (it re-cuts bytes a cloud " +
      "flow log already counts); naming a cluster's account includes it.",
  )
  .openapi("NetworkFlowReportFilters");

const Config = strict({
  version: z.literal(1),
  dateRange: CostDateRange,
  granularity: Granularity,
  groupBy: GroupBy,
  filters: Filters,
  metric: Metric,
  topN: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Groups and top talkers listed. Absent means 25."),
}).openapi("NetworkFlowReportConfig");

const Input = strict({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  config: Config,
  folderId: Uuid.nullable()
    .optional()
    .describe(
      "A report folder (`/cost-report-folders`, shared with cost reports); null is the top level.",
    ),
}).openapi("NetworkFlowReportInput");

const Report = strict({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  config: Config,
  folderId: Uuid.nullable(),
  createdByUserId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).openapi("NetworkFlowReport");

const totalsShape = {
  bytes: z.number().describe("Observed bytes (decimal: a GB is 10^9 bytes)."),
  estimatedCost: z
    .number()
    .describe(
      "Bytes priced at the provider's published list rate for the boundary crossed. Always an " +
        "estimate: free allowances, volume tiers and negotiated rates are not modelled.",
    ),
  sampledBytes: z
    .number()
    .describe(
      "Of `bytes`, those from a flow source that samples. The plugin already scaled them up; " +
        "they are counted and labelled, never dropped.",
    ),
  sampledCost: z.number().describe("Of `estimatedCost`, the part priced from sampled bytes."),
  unattributedBytes: z
    .number()
    .describe("Of `bytes`, those that could not be tied to a workload at one end."),
  truncatedBytes: z
    .number()
    .describe("Of `bytes`, the per-day remainder below the stored pair cap."),
};

const Totals = strict(totalsShape).openapi("NetworkFlowReportTotals");

const Point = strict({ bucket: z.string(), ...totalsShape }).openapi("NetworkFlowReportPoint");

const Series = strict({
  id: z.string(),
  groupKey: z
    .string()
    .describe("The group's key; `__other__` is everything outside the charted groups."),
  label: z.string(),
  currency: z.string(),
  points: z.array(Point),
  total: Totals,
}).openapi("NetworkFlowReportSeries");

const GroupTotal = strict({
  groupKey: z.string(),
  label: z.string(),
  currency: z.string(),
  pairCount: z.number().int(),
  ...totalsShape,
}).openapi("NetworkFlowReportGroupTotal");

const Endpoint = strict({
  ref: z.string(),
  label: z.string(),
  zone: z.string(),
  region: z.string(),
  service: z.string(),
  resourceTypeId: z.string(),
  network: z.string().describe("The endpoint's VPC / network id, when the provider reports it."),
}).openapi("NetworkFlowReportEndpoint");

const Talker = strict({
  source: Endpoint,
  destination: Endpoint,
  scope: TrafficClass,
  direction: Direction,
  attribution: z.enum(["resolved", "unattributed"]),
  bytes: z.number(),
  packets: z.number(),
  estimatedCost: z.number(),
  currency: z.string(),
  accountId: z.string(),
  accountName: z.string(),
  pluginId: z.string(),
  days: z.number().int().describe("Days in the window the pair appeared on."),
  sampled: z.boolean().describe("True when the pair's bytes came from a sampled flow source."),
}).openapi("NetworkFlowReportTalker");

const Notice = z
  .enum([
    "collection_disabled",
    "no_flow_accounts",
    "beyond_retention",
    "sampled_sources",
    "recut_excluded",
    "unattributed_traffic",
    "truncated_traffic",
    "multiple_currencies",
  ])
  .openapi("NetworkFlowReportNotice");

const resultShape = {
  from: z.string(),
  to: z.string(),
  granularity: Granularity,
  groupBy: GroupBy,
  metric: Metric,
  estimated: z.literal(true),
  buckets: z.array(z.string()),
  series: z
    .array(Series)
    .describe(
      "The chart: the largest groups, then one `__other__` series per currency, so the stack " +
        "adds up to `overall`. Empty when `groupBy` is `none`.",
    ),
  overall: z.array(Series).describe("All groups combined, one series per currency."),
  groups: z.array(GroupTotal).describe("Per-group totals, largest first, up to `topN`."),
  groupCount: z.number().int().describe("How many groups there were before the `topN` cut."),
  topTalkers: z.array(Talker),
  sampledPluginIds: z.array(z.string()),
  notices: z.array(Notice),
};

const Result = strict(resultShape).openapi("NetworkFlowReportResult");
const RunResult = strict({ ...resultShape, reportId: Uuid, name: z.string() }).openapi(
  "NetworkFlowReportRunResult",
);

const Options = strict({
  accounts: z.array(
    strict({
      id: Uuid,
      name: z.string(),
      pluginId: z.string(),
      recut: z
        .boolean()
        .describe("True for a Kubernetes cluster, whose traffic is only read when named."),
    }),
  ),
  networks: z.array(z.string()),
  regions: z.array(z.string()),
  zones: z.array(z.string()),
  services: z.array(z.string()),
  resourceTypes: z.array(z.string()),
  endpoints: z.array(
    strict({
      ref: z.string(),
      label: z.string(),
      resourceTypeId: z.string(),
      side: z.enum(["source", "destination", "both"]),
    }),
  ),
  trafficClasses: z.array(TrafficClass),
}).openapi("NetworkFlowReportOptions");

export function registerNetworkFlowReportPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const tags = ["Network flows"];

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/network-flows/report-options",
    tags,
    summary: "Picker values for the network flow report editor",
    description:
      "Accounts whose provider can report flows, and every VPC, region, zone, peer service, " +
      "peer resource type and endpoint seen in the store's 90-day retention. Scoped to what the " +
      "caller may see.",
    request: { params: OrgIdParam },
    responses: {
      200: { description: "Options", content: { "application/json": { schema: Options } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/network-flows/report-query",
    tags,
    summary: "Run an unsaved network flow report config",
    description:
      "Bytes and estimated cost over time, per group, with the top talking pairs. A read despite " +
      "the method.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: Config } }, required: true },
    },
    responses: {
      200: { description: "The report", content: { "application/json": { schema: Result } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/network-flows/reports",
    tags,
    summary: "List saved network flow reports",
    request: { params: OrgIdParam },
    responses: {
      200: { description: "Reports", content: { "application/json": { schema: z.array(Report) } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/network-flows/reports",
    tags,
    summary: "Create a network flow report",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: Input } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: Report } } },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/network-flows/reports/{id}",
    tags,
    summary: "Get a network flow report",
    request: { params: IdParam },
    responses: {
      200: { description: "The report", content: { "application/json": { schema: Report } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/network-flows/reports/{id}",
    tags,
    summary: "Replace a network flow report",
    request: {
      params: IdParam,
      body: { content: { "application/json": { schema: Input } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: Report } } },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/network-flows/reports/{id}",
    tags,
    summary: "Delete a network flow report",
    request: { params: IdParam },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/network-flows/reports/{id}/run",
    tags,
    summary: "Run a saved network flow report",
    description: "A relative date range resolves against today on every run.",
    request: { params: IdParam },
    responses: {
      200: { description: "The report", content: { "application/json": { schema: RunResult } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });
}
