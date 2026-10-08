import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const SliKind = z.enum(["probe_availability", "probe_latency", "metric_threshold"]).openapi({
  description:
    "Where the SLI comes from: a synthetic probe's success ratio, the share of a probe's " +
    "checks at or under a latency threshold, or the share of minutes a resource's metric " +
    "series satisfies a comparison.",
});

const Comparator = z.enum(["<", "<=", ">", ">="]).openapi({
  description: "`metric_threshold` only: a minute is good when `value <comparator> threshold`.",
});

const SloStatus = z.enum(["exhausted", "fast_burn", "slow_burn", "ok", "unknown"]).openapi({
  description:
    "Worst true thing first: `exhausted` (no budget left), `fast_burn` (a page-severity " +
    "burn-rate pair is firing), `slow_burn` (the ticket pair), `ok`, or `unknown` (no data in " +
    "the window, never evaluated, or disabled).",
});

const BurnAlert = z.enum(["none", "slow", "fast"]).openapi({
  description: "The alert level the evaluator last settled on.",
});

const TargetPercent = z.number().openapi({
  description: "Objective as a percentage, at least 50 and at most 99.999.",
  example: 99.9,
});

const WindowDays = z.union([z.literal(7), z.literal(28), z.literal(30)]).openapi({
  description: "Rolling window in days.",
  example: 30,
});

const BurnRates = z.record(z.string(), z.number().nullable()).openapi({
  description:
    "Burn rate per window (`5m`, `30m`, `1h`, `6h`, `3d`); 1 is exactly on budget, null " +
    "where the window held no events.",
});

export function registerSloPaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const sourceFields = {
    sliKind: SliKind,
    probeId: Uuid.nullable().describe("`probe_*`: the synthetic probe the SLI is read from."),
    latencyThresholdMs: z
      .number()
      .int()
      .nullable()
      .describe("`probe_latency`: a check is good at or under this many ms (1-60000)."),
    resourceId: z
      .string()
      .nullable()
      .describe("`metric_threshold`: the synced resource reporting the series."),
    metricKey: z
      .string()
      .nullable()
      .describe('`metric_threshold`: the series label as the resource reports it, e.g. "CPU %".'),
    comparator: Comparator.nullable(),
    threshold: z.number().nullable().describe("`metric_threshold`: the comparison's right side."),
  };

  const settingFields = {
    name: z.string().describe("Unique in the organization; at most 120 characters."),
    description: z.string().nullable().describe("At most 500 characters."),
    targetPercent: TargetPercent,
    windowDays: WindowDays,
    alertsEnabled: z
      .boolean()
      .describe("Route burn-rate and exhaustion alerts through the org's alert routing rules."),
    suggestFreeze: z
      .boolean()
      .describe("When the budget runs out, the alert and the page suggest a change freeze."),
    enabled: z.boolean(),
  };

  const Slo = strict({
    id: Uuid,
    ...settingFields,
    ...sourceFields,
    probeName: z.string().nullable().describe("The probe's name; null when it was deleted."),
    resourceName: z.string().nullable().describe("The resource's name; null when it is gone."),
    accountId: Uuid.nullable(),
    pluginId: enums.PluginId.nullable(),
    resourceTypeId: z.string().nullable(),
    status: SloStatus,
    sli: z.number().nullable().describe("Fraction of good events over the window (0-1)."),
    goodEvents: z.number(),
    totalEvents: z.number().describe("Minutes with data in the window."),
    budgetRemaining: z
      .number()
      .nullable()
      .describe("Fraction of the window's error budget left; negative when overspent."),
    budgetTotalMinutes: z
      .number()
      .describe("The window's whole budget in minutes (43.2 for 99.9% over 30 days)."),
    budgetRemainingMinutes: z.number().nullable(),
    burnRates: BurnRates,
    burnAlert: BurnAlert,
    exhaustedAt: IsoDateTime.nullable(),
    lastEvalAt: IsoDateTime.nullable(),
    lastError: z.string().nullable(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }).openapi("Slo");

  const SloList = strict({ slos: z.array(Slo) }).openapi("SloList");

  const SloCreate = strict({
    name: settingFields.name,
    description: settingFields.description.optional(),
    sliKind: SliKind,
    probeId: sourceFields.probeId.optional(),
    latencyThresholdMs: sourceFields.latencyThresholdMs.optional(),
    resourceId: sourceFields.resourceId.optional(),
    metricKey: sourceFields.metricKey.optional(),
    comparator: sourceFields.comparator.optional(),
    threshold: sourceFields.threshold.optional(),
    targetPercent: TargetPercent.optional(),
    windowDays: WindowDays.optional(),
    alertsEnabled: z.boolean().optional(),
    suggestFreeze: z.boolean().optional(),
    enabled: z.boolean().optional(),
  }).openapi("SloCreate");

  const SloUpdate = strict({
    name: settingFields.name.optional(),
    description: settingFields.description.optional(),
    sliKind: SliKind.optional(),
    probeId: sourceFields.probeId.optional(),
    latencyThresholdMs: sourceFields.latencyThresholdMs.optional(),
    resourceId: sourceFields.resourceId.optional(),
    metricKey: sourceFields.metricKey.optional(),
    comparator: sourceFields.comparator.optional(),
    threshold: sourceFields.threshold.optional(),
    targetPercent: TargetPercent.optional(),
    windowDays: WindowDays.optional(),
    alertsEnabled: z.boolean().optional(),
    suggestFreeze: z.boolean().optional(),
    enabled: z.boolean().optional(),
  }).openapi("SloUpdate");

  const SloBucket = strict({
    startMs: z.number().describe("Hour start, Unix epoch ms."),
    good: z.number(),
    total: z.number().describe("Minutes with data in the hour."),
  }).openapi("SloBucket");

  const SloActiveFreeze = strict({
    id: Uuid,
    name: z.string(),
    endsAt: IsoDateTime.nullable(),
  }).openapi("SloActiveFreeze");

  const SloDetail = strict({
    slo: Slo,
    buckets: z.array(SloBucket).describe("Hourly events over the window, oldest first."),
    activeFreeze: SloActiveFreeze.nullable().describe("The change freeze in effect, if any."),
  }).openapi("SloDetail");

  const SloSources = strict({
    probes: z.array(
      strict({
        id: Uuid,
        name: z.string(),
        url: z.string(),
        status: z.enum(["up", "down", "unknown"]),
      }),
    ),
    metricResources: z.array(
      strict({
        resourceId: z.string(),
        displayName: z.string(),
        accountId: Uuid,
        pluginId: enums.PluginId,
        resourceTypeId: z.string(),
        series: z.array(strict({ label: z.string(), unit: z.string() })),
      }),
    ),
  }).openapi("SloSources");

  const SloFreezeRequest = strict({
    durationHours: z
      .union([z.literal(24), z.literal(72), z.literal(168)])
      .nullable()
      .optional()
      .describe("How long the freeze lasts; null or omitted means until somebody ends it."),
    reason: z.string().optional(),
  }).openapi("SloFreezeRequest");

  const SloIdParam = OrgIdParam.extend({ sloId: Uuid });
  const tags = ["SLOs"];

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/slos",
    tags,
    summary: "List SLOs",
    description:
      "Every service-level objective with its last snapshot: SLI, error budget remaining (as a " +
      "fraction and in minutes) and burn rates over the alerting windows.",
    request: { params: OrgIdParam },
    responses: {
      200: { description: "The SLOs", content: { "application/json": { schema: SloList } } },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/slos/sources",
    tags,
    summary: "List what an SLO can be measured from",
    description:
      "Every synthetic probe, and every synced resource that reported a metric series in the " +
      "last week with the series it reported. Feeds the editor's pickers.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Probes and metric-reporting resources",
        content: { "application/json": { schema: SloSources } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/slos/{sloId}",
    tags,
    summary: "Read an SLO with its history",
    description:
      "The SLO plus hourly good/total buckets over its window (the SLI and budget-burndown " +
      "charts are drawn from these) and the change freeze in effect, if any.",
    request: { params: SloIdParam },
    responses: {
      200: { description: "The SLO", content: { "application/json": { schema: SloDetail } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/slos",
    tags,
    summary: "Create an SLO",
    description:
      "Out-of-range inputs are rejected, not clamped. The source must exist in the " +
      "organization. The first evaluation runs within one poller tick. Audit-logged.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: SloCreate } } },
    },
    responses: {
      201: { description: "The created SLO", content: { "application/json": { schema: Slo } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/slos/{sloId}",
    tags,
    summary: "Update an SLO",
    description:
      "Omitted fields keep their value. Changing the source, target or window resets the " +
      "snapshot and the alert state. Audit-logged.",
    request: {
      params: SloIdParam,
      body: { content: { "application/json": { schema: SloUpdate } } },
    },
    responses: {
      200: { description: "The updated SLO", content: { "application/json": { schema: Slo } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/slos/{sloId}",
    tags,
    summary: "Delete an SLO",
    description: "The measured series are untouched. Audit-logged.",
    request: { params: SloIdParam },
    responses: { 204: { description: "Deleted" }, 404: ErrorResponses[404] },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/slos/{sloId}/freeze",
    tags,
    summary: "Start a change freeze for an SLO",
    description:
      "Acts on the freeze suggestion an exhausted budget makes: creates an ordinary change " +
      "freeze named after the SLO, listed and ended like any other. Needs `freezes:write`.",
    request: {
      params: SloIdParam,
      body: { content: { "application/json": { schema: SloFreezeRequest } } },
    },
    responses: {
      201: {
        description: "The freeze",
        content: { "application/json": { schema: SloActiveFreeze } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });
}
