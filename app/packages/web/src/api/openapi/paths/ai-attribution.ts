import { z } from "../zod";
import { strict, OrgIdParam, ErrorResponses } from "../common";
import type { BuildContext } from "../context";

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function registerAiAttributionPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const tags = ["AI attribution"];

  const SourceKind = z.enum(["plugin", "litellm"]);

  const AiRequestSourceKindOption = strict({
    kind: SourceKind,
    pluginId: z.string().nullable(),
    pluginName: z.string().nullable(),
    sourceKindId: z.string(),
    label: z.string(),
    description: z.string(),
    locationLabel: z.string(),
    maxHistoryDays: z.number().int(),
    queriesBillable: z
      .boolean()
      .describe("Reading this source is billed to the account's own provider (Logs Insights)."),
    acceptsPrefix: z.boolean(),
    helpUrl: z.string().nullable(),
    accounts: z.array(strict({ id: z.string(), name: z.string() })),
  }).openapi("AiRequestSourceKindOption");

  const AiRequestLogLocation = strict({
    id: z.string(),
    label: z.string(),
    detail: z.string().optional(),
    location: z.record(z.string(), z.string()),
    recommended: z.boolean().optional(),
  }).openapi("AiRequestLogLocation");

  const AiRequestSource = strict({
    id: z.string(),
    name: z.string(),
    kind: SourceKind,
    pluginId: z.string().nullable(),
    accountId: z.string().nullable(),
    accountName: z.string().nullable(),
    sourceKindId: z.string(),
    location: z.record(z.string(), z.string()),
    enabled: z.boolean(),
    lookbackDays: z.number().int(),
    baseUrl: z.string().nullable(),
    hasApiKey: z.boolean(),
    collectedThrough: z.string().nullable(),
    lastRunAt: z.string().nullable(),
    nextRunAt: z.string().nullable(),
    lastError: z.string().nullable(),
    lastErrorHelpUrl: z.string().nullable(),
    failureCount: z.number().int(),
    observedMetadataKeys: z.record(z.string(), z.number()),
    lastQueryBytesScanned: z.number().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }).openapi("AiRequestSource");

  const AiRequestSourceInput = strict({
    name: z.string().min(1).max(120),
    kind: SourceKind,
    accountId: z.string().nullable().optional().describe("Required for `plugin` sources."),
    sourceKindId: z.string(),
    location: z
      .record(z.string(), z.string())
      .describe("What the location picker returned, plus `prefix` where the kind accepts one."),
    enabled: z.boolean(),
    lookbackDays: z.number().int().min(1).max(90),
    baseUrl: z.string().nullable().optional().describe("LiteLLM only: the proxy's https URL."),
    apiKey: z
      .string()
      .optional()
      .describe("LiteLLM only. Write-only; omit on update to keep the stored key."),
  }).openapi("AiRequestSourceInput");

  const AiAttributionDimension = strict({
    id: z.string(),
    key: z.string(),
    label: z.string(),
    metadataKeys: z.array(z.string()),
    createdAt: z.string(),
    updatedAt: z.string(),
  }).openapi("AiAttributionDimension");

  const AiAttributionDimensionInput = strict({
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,31}$/)
      .describe("Becomes the tag key `caller:<key>` in cost reports."),
    label: z.string().min(1).max(60),
    metadataKeys: z
      .array(z.string().min(1).max(256))
      .min(1)
      .max(8)
      .describe("Request-metadata keys feeding the dimension, first present wins."),
  }).openapi("AiAttributionDimensionInput");

  const AiSourceMatchStats = strict({
    sourceId: z.string(),
    name: z.string(),
    days: z.number().int(),
    requests: z.number(),
    matchedRequests: z.number(),
    ambiguousRequests: z.number(),
    unmatchedRequests: z.number(),
    skippedRecords: z.number(),
    currency: z.string().nullable(),
    attributedAmount: z.number(),
    billedAmount: z.number(),
    coveragePercent: z.number().nullable(),
    degradedDays: z.number().int(),
    truncatedDays: z.number().int(),
  }).openapi("AiSourceMatchStats");

  const AiProviderCoverage = strict({
    provider: z.string(),
    currency: z.string(),
    billedAmount: z.number(),
    attributedAmount: z.number(),
    unattributedAmount: z.number(),
  }).openapi("AiProviderCoverage");

  const AiAttributionStats = strict({
    from: z.string(),
    to: z.string(),
    sources: z.array(AiSourceMatchStats),
    providers: z.array(AiProviderCoverage),
    attributedDays: z.number().int(),
  }).openapi("AiAttributionStats");

  const AiSpendBreakdown = strict({
    from: z.string(),
    to: z.string(),
    dimension: z.string(),
    tagKey: z.string(),
    rows: z.array(strict({ value: z.string(), currency: z.string(), amount: z.number() })),
  }).openapi("AiSpendBreakdown");

  const Ok = strict({ ok: z.literal(true) });
  const IdParam = OrgIdParam.extend({ id: z.string() });
  const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({
    description,
    content: { "application/json": { schema } },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/ai-attribution/source-kinds",
    tags,
    summary: "List the request-log source kinds the org can add",
    request: { params: OrgIdParam },
    responses: {
      200: json(strict({ sourceKinds: z.array(AiRequestSourceKindOption) }), "Source kinds"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/ai-attribution/locations",
    tags,
    summary: "Discover locations (buckets, log groups, gateways) for a source kind",
    request: {
      params: OrgIdParam,
      query: strict({ accountId: z.string(), sourceKindId: z.string() }),
    },
    responses: {
      200: json(strict({ locations: z.array(AiRequestLogLocation) }), "Picker options"),
      400: ErrorResponses[400],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/ai-attribution/sources",
    tags,
    summary: "List request-log sources",
    request: { params: OrgIdParam },
    responses: { 200: json(strict({ sources: z.array(AiRequestSource) }), "Sources") },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/ai-attribution/sources/{id}",
    tags,
    summary: "Read one request-log source",
    request: { params: IdParam },
    responses: { 200: json(AiRequestSource, "Source"), 404: ErrorResponses[404] },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/ai-attribution/sources",
    tags,
    summary: "Add a request-log source",
    description:
      "Governed by `org:settings:write`: a source authorizes a daily read of the org's request " +
      "logs, and the Bedrock CloudWatch kind runs a Logs Insights query billed to the org's own " +
      "AWS account per GB scanned. Audit-logged.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: AiRequestSourceInput } }, required: true },
    },
    responses: {
      201: json(AiRequestSource, "Created"),
      400: ErrorResponses[400],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/ai-attribution/sources/{id}",
    tags,
    summary: "Update a request-log source",
    description: "Pointing a source at a different location restarts its collection history.",
    request: {
      params: IdParam,
      body: { content: { "application/json": { schema: AiRequestSourceInput } }, required: true },
    },
    responses: {
      200: json(AiRequestSource, "Updated"),
      400: ErrorResponses[400],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/ai-attribution/sources/{id}",
    tags,
    summary: "Delete a request-log source",
    request: { params: IdParam },
    responses: { 200: json(Ok, "Deleted"), 403: ErrorResponses[403], 404: ErrorResponses[404] },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/ai-attribution/sources/{id}/recollect",
    tags,
    summary: "Re-read a source's history from a day",
    description:
      "Aggregates keep only mapped metadata keys, so a newly mapped dimension reaches history " +
      "only by re-reading it. Clamped to the source kind's history limit.",
    request: {
      params: IdParam,
      body: {
        content: { "application/json": { schema: strict({ from: DAY }) } },
        required: true,
      },
    },
    responses: {
      200: json(AiRequestSource, "Rescheduled"),
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/ai-attribution/dimensions",
    tags,
    summary: "List caller dimensions",
    request: { params: OrgIdParam },
    responses: {
      200: json(strict({ dimensions: z.array(AiAttributionDimension) }), "Dimensions"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/ai-attribution/dimensions",
    tags,
    summary: "Map request-metadata keys to a caller dimension",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: AiAttributionDimensionInput } },
        required: true,
      },
    },
    responses: {
      201: json(AiAttributionDimension, "Created"),
      400: ErrorResponses[400],
      403: ErrorResponses[403],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/ai-attribution/dimensions/{id}",
    tags,
    summary: "Update a caller dimension",
    request: {
      params: IdParam,
      body: {
        content: { "application/json": { schema: AiAttributionDimensionInput } },
        required: true,
      },
    },
    responses: {
      200: json(AiAttributionDimension, "Updated"),
      400: ErrorResponses[400],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/ai-attribution/dimensions/{id}",
    tags,
    summary: "Delete a caller dimension",
    request: { params: IdParam },
    responses: { 200: json(Ok, "Deleted"), 403: ErrorResponses[403], 404: ErrorResponses[404] },
  });

  const RangeQuery = strict({
    from: DAY.optional().describe("Inclusive start day. Defaults to 29 days ago."),
    to: DAY.optional().describe("Inclusive end day. Defaults to today."),
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/ai-attribution/stats",
    tags,
    summary: "Match-rate statistics per source and coverage per provider",
    request: { params: OrgIdParam, query: RangeQuery },
    responses: { 200: json(AiAttributionStats, "Statistics"), 400: ErrorResponses[400] },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/ai-attribution/spend",
    tags,
    summary: "Attributed AI spend by one caller dimension",
    description:
      "Includes the `(unattributed)` remainder and `(not set)` for matched requests that lacked " +
      "every mapped key. For time series, group a cost report by the tag key `caller:<dimension>`.",
    request: {
      params: OrgIdParam,
      query: RangeQuery.extend({ dimension: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/) }),
    },
    responses: { 200: json(AiSpendBreakdown, "Breakdown"), 400: ErrorResponses[400] },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/ai-attribution/reattribute",
    tags,
    summary: "Re-split a range of days now",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: strict({ from: DAY, to: DAY }) } },
        required: true,
      },
    },
    responses: {
      200: json(strict({ ok: z.literal(true), days: z.number().int() }), "Re-split"),
      400: ErrorResponses[400],
      403: ErrorResponses[403],
    },
  });
}
