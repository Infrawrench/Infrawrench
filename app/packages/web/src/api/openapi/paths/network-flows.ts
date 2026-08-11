import { z } from "../zod";
import { strict, OrgIdParam, ErrorResponses } from "../common";
import type { BuildContext } from "../context";

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

export function registerNetworkFlowPaths(ctx: BuildContext) {
  const { registry } = ctx;

  const NetworkFlowScope = z
    .enum(SCOPES)
    .describe(
      "Which billing boundary the traffic crossed. `unknown` means the provider's record did " +
        "not determine one — it is priced at zero and labelled rather than folded into a " +
        "neighbouring boundary.",
    );

  const NetworkFlowDirection = z.enum(["egress", "ingress"]);

  const NetworkFlowEndpoint = strict({
    ref: z
      .string()
      .describe(
        "Stable endpoint identity — a provider resource id where one could be resolved, " +
          "otherwise a class token (`internet`, `aws:s3`, `infrawrench:unattributed`). Never a " +
          "raw IP address: addresses churn, so the same workload would be a different row " +
          "every day.",
      ),
    label: z.string(),
    zone: z.string(),
    region: z.string(),
    service: z.string(),
    resourceTypeId: z
      .string()
      .describe("Set when `ref` is a resource this organization syncs, so the row can link out."),
  }).openapi("NetworkFlowEndpoint");

  const NetworkFlowScopeSummary = strict({
    scope: NetworkFlowScope,
    direction: NetworkFlowDirection,
    bytes: z.number(),
    estimatedCost: z.number(),
    currency: z.string(),
    crossedZone: z.boolean(),
    crossedRegion: z.boolean(),
    leftCloud: z.boolean(),
    unattributedBytes: z
      .number()
      .describe(
        "Bytes inside `bytes` whose endpoints could not be tied to a workload. A subset, not " +
          "an addition — nothing here has been apportioned across the attributed rows.",
      ),
    truncatedBytes: z
      .number()
      .describe(
        "Bytes inside `bytes` that fell below the stored top-N pair cap, computed by " +
          "subtraction against the provider's exact totals rather than estimated.",
      ),
  }).openapi("NetworkFlowScopeSummary");

  const NetworkFlowPair = strict({
    source: NetworkFlowEndpoint,
    destination: NetworkFlowEndpoint,
    scope: NetworkFlowScope,
    direction: NetworkFlowDirection,
    attribution: z.enum(["resolved", "unattributed"]),
    bytes: z.number(),
    packets: z.number(),
    estimatedCost: z.number(),
    currency: z.string(),
    accountId: z.string(),
    pluginId: z.string(),
    days: z.number().int().describe("Days in the range this pair appeared on."),
  }).openapi("NetworkFlowPair");

  const NetworkFlowSource = strict({
    id: z.string(),
    target: z.string().describe("What the flow log is attached to — a VPC id, a network."),
    region: z.string().nullable(),
    destinationType: z.string(),
    usable: z.boolean(),
    unusableReason: z
      .string()
      .nullable()
      .describe("Why the source cannot be read, in terms that name the fix."),
    helpUrl: z.string().nullable(),
  }).openapi("NetworkFlowSource");

  const NetworkFlowAccountStatus = strict({
    accountId: z.string(),
    pluginId: z.string(),
    displayName: z.string(),
    supportsFlows: z
      .boolean()
      .describe(
        "False when the account's provider has no flow source we can read. Such accounts are " +
          "listed and excluded from the totals rather than contributing zero bytes — zero would " +
          "be a claim about their network, this is a statement about our coverage.",
      ),
    collectedThrough: z.string().nullable(),
    lastPolledAt: z.string().nullable(),
    failureCount: z.number().int(),
    lastError: z.string().nullable(),
    lastErrorHelpUrl: z.string().nullable(),
    sources: z.array(NetworkFlowSource),
    lastQueryBytesScanned: z
      .number()
      .nullable()
      .describe("Log data the provider billed this account for the last collection's queries."),
  }).openapi("NetworkFlowAccountStatus");

  const NetworkFlowRateCard = strict({
    pluginId: z.string(),
    currency: z.string(),
    asOf: z
      .string()
      .describe("Date the rates were last checked against the provider's pricing page."),
    perGb: z.record(z.string(), z.number()),
    queriesBillable: z
      .boolean()
      .describe(
        "True when collecting flows runs queries the provider bills to your cloud account.",
      ),
    sampled: z
      .boolean()
      .describe("True when the flow source samples rather than recording all flows."),
  }).openapi("NetworkFlowRateCard");

  const NetworkFlowFeed = strict({
    enabled: z.boolean(),
    initialLookbackDays: z.number().int(),
    estimated: z
      .literal(true)
      .describe(
        "Always true. Flow bytes come from logs that sample or drop under load and are priced " +
          "at published list rates with no free tier, no volume tier and no negotiated discount " +
          "modelled — the ranking is sound, the absolute figure will not reconcile to the invoice.",
      ),
    range: strict({ from: z.string(), to: z.string() }),
    scopes: z.array(NetworkFlowScopeSummary),
    topFlows: z.array(NetworkFlowPair),
    accounts: z.array(NetworkFlowAccountStatus),
    rateCards: z.array(NetworkFlowRateCard),
    totals: strict({
      bytes: z.number(),
      estimatedCost: z.number(),
      currency: z.string(),
      unattributedBytes: z.number(),
      truncatedBytes: z.number(),
    }),
  }).openapi("NetworkFlowFeed");

  const NetworkFlowSettings = strict({
    enabled: z.boolean(),
    initialLookbackDays: z.number().int().min(1).max(30),
  }).openapi("NetworkFlowSettings");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/network-flows",
    tags: ["Network flows"],
    summary: "Priced source→destination network flow attribution",
    description:
      "Which two things are talking, across which billing boundary, and what that costs. " +
      "Answers the question the cost dimensions structurally cannot: every cost dimension is " +
      "about one side of a transfer, and a network charge is about a pair.\n\n" +
      "All figures are **estimates** and the `estimated` field says so unconditionally. " +
      "Bytes come from the provider's flow logs (which sample, or drop records under capacity " +
      "pressure) and are priced at published list rates with no free tier, no volume tier and " +
      "no negotiated discount applied. Use the ranking; do not reconcile the total against an " +
      "invoice line.\n\n" +
      "Accounts whose provider has no readable flow source appear in `accounts` with " +
      "`supportsFlows: false` and contribute nothing to the totals — never zero bytes.",
    request: {
      params: OrgIdParam,
      query: strict({
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Inclusive start day. Defaults to 13 days ago."),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Inclusive end day. Defaults to today."),
        scope: z.enum(SCOPES).optional().describe("Narrow to one billing boundary."),
        accountId: z.string().optional().describe("Narrow to one connected account."),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Pairs to return in `topFlows`, largest cost first. Defaults to 50."),
      }),
    },
    responses: {
      200: {
        description: "Flow attribution for the range",
        content: { "application/json": { schema: NetworkFlowFeed } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/network-flows/settings",
    tags: ["Network flows"],
    summary: "Read the network flow collection switch",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Settings",
        content: { "application/json": { schema: NetworkFlowSettings } },
      },
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/network-flows/settings",
    tags: ["Network flows"],
    summary: "Turn network flow collection on or off",
    description:
      "Collection is **off by default**. Enabling it authorizes Infrawrench to run daily " +
      "queries against the provider's log store — and on AWS those queries are billed to your " +
      "own cloud account per GB of log data scanned, every day, until you turn them off. That " +
      "is why the write is governed by `org:settings:write` rather than `costs:write`, and why " +
      "it is audit-logged.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: NetworkFlowSettings } }, required: true },
    },
    responses: {
      200: {
        description: "Updated settings",
        content: { "application/json": { schema: NetworkFlowSettings } },
      },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
    },
  });
}
