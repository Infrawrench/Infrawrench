import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const Comparator = z.enum([">", ">=", "<", "<="]).openapi({ example: ">" });

/**
 * The rule fields shared by the input and response schemas. Spread into flat
 * `strict` objects rather than composed with `.extend()`: extending a
 * registered schema emits `allOf` over the registered `$ref`, and an `allOf`
 * whose branches are all `additionalProperties: false` can never validate —
 * each branch rejects the other's fields.
 */
const ruleInputShape = {
  name: z.string().min(1).max(120),
  pluginId: z.string().min(1).max(100).nullable().openapi({
    description: "Selector: plugin the resource must belong to. Null matches any plugin.",
  }),
  resourceTypeId: z.string().min(1).max(100).nullable().openapi({
    description: "Selector: resource type within the plugin. Null matches any type.",
  }),
  tagKey: z.string().min(1).max(200).nullable().openapi({
    description:
      "Selector: tag key the resource must carry (matched case-insensitively). Null applies no tag filter. Resources are always selected by this query, never by id, so rules cover resources created later.",
  }),
  tagValue: z.string().min(1).max(200).nullable().openapi({
    description: "Selector: exact value tagKey must have. Null matches any value.",
  }),
  metricKey: z.string().min(1).max(200).openapi({
    description:
      "The metric series label as the resource's charts report it (see /metric-alerts/metric-keys).",
    example: "CPU %",
  }),
  comparator: Comparator,
  threshold: z.number(),
  forMinutes: z.number().int().min(5).max(1440).openapi({
    description: "Trailing window (minutes) the condition must hold for before firing.",
  }),
  cooldownMinutes: z.number().int().min(0).max(10080).openapi({
    description: "Least minutes between notified firings for one (rule, resource).",
  }),
  enabled: z.boolean(),
};

const MetricAlertRuleInput = strict(ruleInputShape).openapi("MetricAlertRuleInput");

const ruleShape = {
  ...ruleInputShape,
  id: Uuid,
  lastEvalAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
};

const MetricAlertRule = strict(ruleShape).openapi("MetricAlertRule");

const MetricAlertRuleWithStatus = strict({
  ...ruleShape,
  firingCount: z.number().int().openapi({
    description: "Resources currently in breach of this rule.",
  }),
  matchingResourceCount: z.number().int().openapi({
    description: "Resources the selector matches right now.",
  }),
}).openapi("MetricAlertRuleWithStatus");

const MetricAlertEvent = strict({
  id: Uuid,
  ruleId: Uuid,
  ruleName: z.string(),
  resourceId: z.string(),
  resourceName: z.string(),
  status: z.enum(["firing", "resolved"]),
  observedValue: z.number().openapi({
    description: "Worst sample observed in the breaching window, in the metric's unit.",
  }),
  firedAt: IsoDateTime,
  resolvedAt: IsoDateTime.nullable(),
}).openapi("MetricAlertEvent");

const MetricSeriesKey = strict({
  label: z.string(),
  unit: z.string(),
  resourceCount: z.number().int().openapi({
    description: "Distinct resources that reported this series in the last 7 days.",
  }),
}).openapi("MetricSeriesKey");

const MetricAlertSelectorOptions = strict({
  plugins: z.array(
    strict({
      pluginId: z.string(),
      resourceTypeIds: z.array(z.string()),
    }),
  ),
  tagKeys: z.array(z.string()),
}).openapi("MetricAlertSelectorOptions");

const MetricAlertSelectorPreview = strict({
  matchingResourceCount: z.number().int(),
  sampleResourceNames: z.array(z.string()).openapi({
    description: "Up to 10 matching display names, for a live form preview.",
  }),
}).openapi("MetricAlertSelectorPreview");

export function registerMetricAlertPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const params = (extra: Record<string, z.ZodType>) => OrgIdParam.extend(extra);
  const idParam = () => params({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/metric-alerts",
    tags: ["Metric alerts"],
    summary: "List metric alert rules with live firing status",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Rules",
        content: { "application/json": { schema: z.array(MetricAlertRuleWithStatus) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/metric-alerts",
    tags: ["Metric alerts"],
    summary: "Create a metric alert rule",
    description:
      "Rules select resources by query (plugin + resource type + tag), never by id list, so a rule automatically covers resources created after it was written. The poller evaluates enabled rules about once a minute and alerts when the condition held for the whole trailing window.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: MetricAlertRuleInput } }, required: true },
    },
    responses: {
      200: { description: "Created", content: { "application/json": { schema: MetricAlertRule } } },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/metric-alerts/metric-keys",
    tags: ["Metric alerts"],
    summary: "List metric series that actually exist",
    description:
      "The series labels resources reported in the last 7 days, optionally narrowed to one plugin and resource type — what the rule builder's metric picker is fed from.",
    request: {
      params: OrgIdParam,
      query: strict({
        pluginId: z.string().optional(),
        resourceTypeId: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Series keys",
        content: { "application/json": { schema: z.array(MetricSeriesKey) } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/metric-alerts/selector-options",
    tags: ["Metric alerts"],
    summary: "List what the organization's resources offer to select on",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Selector options",
        content: { "application/json": { schema: MetricAlertSelectorOptions } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/metric-alerts/selector-preview",
    tags: ["Metric alerts"],
    summary: "Preview which resources a selector matches right now",
    request: {
      params: OrgIdParam,
      query: strict({
        pluginId: z.string().optional(),
        resourceTypeId: z.string().optional(),
        tagKey: z.string().optional(),
        tagValue: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "Preview",
        content: { "application/json": { schema: MetricAlertSelectorPreview } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/metric-alerts/events",
    tags: ["Metric alerts"],
    summary: "Recent metric alert firings",
    request: {
      params: OrgIdParam,
      query: strict({
        ruleId: Uuid.optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
    },
    responses: {
      200: {
        description: "Events, newest first",
        content: { "application/json": { schema: z.array(MetricAlertEvent) } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/metric-alerts/{id}",
    tags: ["Metric alerts"],
    summary: "Get a metric alert rule",
    request: { params: idParam() },
    responses: {
      200: { description: "Rule", content: { "application/json": { schema: MetricAlertRule } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/metric-alerts/{id}",
    tags: ["Metric alerts"],
    summary: "Update a metric alert rule",
    request: {
      params: idParam(),
      body: { content: { "application/json": { schema: MetricAlertRuleInput } }, required: true },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: MetricAlertRule } } },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/metric-alerts/{id}",
    tags: ["Metric alerts"],
    summary: "Delete a metric alert rule",
    description: "Soft delete. The rule's firing history stays readable via /metric-alerts/events.",
    request: { params: idParam() },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });
}
