import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const ProbeStatus = z.enum(["up", "down", "unknown"]).openapi({
  description:
    "The probe's state machine: `unknown` until the first result, `down` after " +
    "`failureThreshold` consecutive failures, `up` on any success.",
});

const ProbeMethod = z.string().openapi({
  description: "HTTP method the probe uses — GET, HEAD or OPTIONS. Unknown values become GET.",
  example: "GET",
});

const IntervalSeconds = z.number().int().openapi({
  description: "Seconds between checks. Clamped server-side to 60–86400.",
  example: 60,
});

const TimeoutMs = z.number().int().openapi({
  description: "Per-check timeout in milliseconds. Clamped server-side to 1000–60000.",
  example: 10000,
});

const FailureThreshold = z.number().int().openapi({
  description: "Consecutive failures before the probe flips to `down` and notifies. Clamped 1–20.",
  example: 3,
});

export function registerProbePaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const SyntheticProbe = strict({
    id: Uuid,
    name: z.string(),
    url: z.string().describe("Absolute http(s) URL the check hits from the edge proxy."),
    method: ProbeMethod,
    intervalSeconds: IntervalSeconds,
    timeoutMs: TimeoutMs,
    failureThreshold: FailureThreshold,
    enabled: z.boolean(),
    accountId: Uuid.nullable().describe(
      "Account of the linked resource, when the URL came from one.",
    ),
    resourceId: z.string().nullable().describe("Linked resource id; advisory, not a foreign key."),
    pluginId: enums.PluginId.nullable(),
    resourceTypeId: z.string().nullable(),
    outputKey: z
      .string()
      .nullable()
      .describe("The resource output/field key the URL was suggested from."),
    status: ProbeStatus,
    consecutiveFailures: z.number().int(),
    lastProbeAt: IsoDateTime.nullable(),
    lastStatusCode: z.number().int().nullable(),
    lastLatencyMs: z.number().int().nullable(),
    lastError: z.string().nullable().describe("Failure detail; null after a success."),
    lastStateChangeAt: IsoDateTime.nullable().describe("When status last flipped up/down."),
    uptime24h: z
      .number()
      .nullable()
      .describe(
        "Fraction (0–1) of the trailing 24h the endpoint was up, from the recorded series; " +
          "null before the first result lands in the metric store.",
      ),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }).openapi("SyntheticProbe");

  const ProbeList = strict({
    probes: z.array(SyntheticProbe),
  }).openapi("SyntheticProbeList");

  const ProbeCreate = strict({
    name: z.string(),
    url: z.string(),
    method: ProbeMethod.optional(),
    intervalSeconds: IntervalSeconds.optional(),
    timeoutMs: TimeoutMs.optional(),
    failureThreshold: FailureThreshold.optional(),
    enabled: z.boolean().optional(),
    resourceId: z
      .string()
      .optional()
      .describe("Link the probe to the resource whose output suggested the URL."),
    outputKey: z.string().optional(),
  }).openapi("SyntheticProbeCreate");

  const ProbeUpdate = strict({
    name: z.string().optional(),
    url: z.string().optional(),
    method: ProbeMethod.optional(),
    intervalSeconds: IntervalSeconds.optional(),
    timeoutMs: TimeoutMs.optional(),
    failureThreshold: FailureThreshold.optional(),
    enabled: z.boolean().optional(),
  }).openapi("SyntheticProbeUpdate");

  const ProbeSuggestion = strict({
    url: z.string().describe("Normalized to an absolute URL — bare hosts get https://."),
    resourceId: z.string(),
    displayName: z.string(),
    pluginId: enums.PluginId,
    resourceTypeId: z.string(),
    accountId: Uuid,
    outputKey: z.string().describe("The output/field key the URL was mined from."),
  }).openapi("ProbeSuggestion");

  const ProbeSuggestions = strict({
    suggestions: z.array(ProbeSuggestion),
  }).openapi("ProbeSuggestions");

  const ProbeMetricSeries = strict({
    label: z.string().describe('"Latency" (ms) or "Up" (1/0).'),
    unit: z.string().optional(),
    points: z.array(
      strict({
        timestamp: z.number().openapi({ description: "Unix epoch milliseconds." }),
        value: z.number(),
      }),
    ),
  }).openapi("ProbeMetricSeries");

  const ProbeMetrics = strict({
    series: z.array(ProbeMetricSeries),
  }).openapi("ProbeMetrics");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/probes",
    tags: ["Synthetic probes"],
    summary: "List synthetic probes",
    description:
      "Every probe in the organization with its live status, consecutive-failure count, last " +
      "latency and trailing-24h uptime. Probes run on an interval from an edge proxy outside " +
      "the cluster, so results reflect what an internet client would see.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The organization's probes",
        content: { "application/json": { schema: ProbeList } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/probes/suggestions",
    tags: ["Synthetic probes"],
    summary: "Suggest endpoints from synced resources",
    description:
      "Endpoint candidates mined from the organization's synced resource outputs and fields " +
      "(keys like url, endpoint, host, domain, publicIp). A cheap read over stored state — no " +
      "provider API calls. Deduplicated by URL.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Suggested endpoints",
        content: { "application/json": { schema: ProbeSuggestions } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/probes",
    tags: ["Synthetic probes"],
    summary: "Create a probe",
    description:
      "Point an uptime/latency check at an endpoint. Numeric inputs are clamped into their " +
      "allowed ranges rather than rejected; the first check runs within one poller tick. " +
      "Audit-logged.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: ProbeCreate } } },
    },
    responses: {
      201: {
        description: "The created probe",
        content: { "application/json": { schema: SyntheticProbe } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/probes/{probeId}",
    tags: ["Synthetic probes"],
    summary: "Update or disable a probe",
    description:
      "Edit settings and/or toggle `enabled`. Changing the URL or method resets the probe's " +
      "state to `unknown` — the history belongs to the old endpoint. Audit-logged.",
    request: {
      params: OrgIdParam.extend({ probeId: Uuid }),
      body: { content: { "application/json": { schema: ProbeUpdate } } },
    },
    responses: {
      200: {
        description: "The updated probe",
        content: { "application/json": { schema: SyntheticProbe } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/probes/{probeId}",
    tags: ["Synthetic probes"],
    summary: "Delete a probe",
    description: "Remove the probe. Recorded series age out of the metric store. Audit-logged.",
    request: { params: OrgIdParam.extend({ probeId: Uuid }) },
    responses: {
      204: { description: "Deleted" },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/probes/{probeId}/metrics",
    tags: ["Synthetic probes"],
    summary: "Read a probe's recorded series",
    description:
      'The "Latency" (ms) and "Up" (1/0) series over a time range, from the shared metric ' +
      "store. Resolution auto-selects raw/1-minute/1-hour rollups by span. Defaults to the " +
      "trailing 24 hours.",
    request: {
      params: OrgIdParam.extend({ probeId: Uuid }),
      query: strict({
        startMs: z.string().optional().describe("Range start, Unix epoch ms."),
        endMs: z.string().optional().describe("Range end, Unix epoch ms."),
      }),
    },
    responses: {
      200: {
        description: "The recorded series",
        content: { "application/json": { schema: ProbeMetrics } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });
}
