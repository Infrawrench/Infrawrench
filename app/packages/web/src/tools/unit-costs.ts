/**
 * Business-metric and unit-cost tools — "what does a customer cost us?" for
 * MCP clients and the chat agent.
 *
 * These sit alongside `tools/costs.ts` and share its stance: org-wide spend
 * data, so every handler enforces the same permissions as the HTTP API, and
 * every description explains *how to read the numbers* rather than only naming
 * the fields. That matters more here than anywhere else in the cost surface,
 * because the two ways to misread a unit cost are both silent — treating a gap
 * as a zero, and treating an average of daily ratios as a period ratio — and a
 * model summarising this data will happily do either unless told not to.
 */
import { z } from "zod";

import { businessMetricInputSchema, unitCostQueryRequestSchema } from "@infrawrench/ui/cost/config";
import { BUSINESS_METRIC_LIMITS } from "@infrawrench/client-core";
import {
  BusinessMetricIngestError,
  ingestMetricValues,
} from "@infrawrench/server-core/cost/metric-ingest";

import {
  BusinessMetricInputError,
  BusinessMetricKeyConflictError,
  createBusinessMetric,
  getBusinessMetric,
  listBusinessMetricValues,
  listBusinessMetrics,
  softDeleteBusinessMetric,
  updateBusinessMetric,
} from "../services/business-metrics";
import {
  BusinessMetricNotFoundError,
  CostQueryError,
  runUnitCostQuery,
} from "../services/unit-cost-query";
import { logAudit } from "../services/audit";
import { denyUnlessPermitted } from "./permissions";
import { ok, err, type ToolDefinition } from "./types";

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/** Map the shared service errors onto tool results. */
function toolError(e: unknown) {
  if (e instanceof BusinessMetricNotFoundError) return err(e.message);
  if (e instanceof BusinessMetricKeyConflictError) return err(e.message);
  if (e instanceof BusinessMetricInputError) return err(e.message);
  if (e instanceof BusinessMetricIngestError) return err(e.message);
  if (e instanceof CostQueryError) return err(e.message);
  throw e;
}

export function unitCostTools(): ToolDefinition[] {
  return [
    {
      name: "list_business_metrics",
      title: "List business metrics",
      description:
        "The organization's declared business metrics — the denominators unit costs divide by " +
        "(customers, API requests, GB processed, revenue). Each row carries its `key` (how " +
        'workflows and the API address it), its `unit` (the noun in "USD per customer"), its ' +
        "`kind` (`count` for a quantity, `currency` for revenue — only `currency` metrics " +
        "support margin), the `costScope` filter naming which spend it divides, and `coverage`: " +
        "the days it actually has values for. " +
        "A metric whose `coverage` is null or sparse is not broken, but every unit-cost chart " +
        "drawn from it will be mostly gaps — say so rather than reporting a confident number.",
      inputSchema: {},
      risk: "read",
      permission: "costs:read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        return ok(await listBusinessMetrics(auth.organizationId));
      },
    },
    {
      name: "get_business_metric_values",
      title: "Get business metric values",
      description:
        "The reported daily values for one business metric, newest day first. `metric` accepts " +
        'the metric\'s key or its id. Use this to answer "is this metric actually being fed" — ' +
        "a missing day is not a zero, it is a day nobody reported, and it is why the matching " +
        "unit-cost bucket comes back as a gap.",
      inputSchema: {
        metric: z.string().describe("Metric key or id."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(BUSINESS_METRIC_LIMITS.maxValuesPageSize)
          .optional()
          .describe("Days to return, newest first. Default 90."),
      },
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        const metric = await getBusinessMetric(auth.organizationId, String(input["metric"] ?? ""));
        if (!metric) return err(`No business metric "${String(input["metric"])}".`);
        const limit = typeof input["limit"] === "number" ? input["limit"] : 90;
        return ok({
          metric: { id: metric.id, key: metric.key, unit: metric.unit, kind: metric.kind },
          values: await listBusinessMetricValues(metric.id, limit),
        });
      },
    },
    {
      name: "query_unit_costs",
      title: "Query unit costs or margin",
      description:
        "Divide spend by a business metric: cost per unit, or margin for a revenue metric. " +
        "`metric` accepts the metric's key or its id; dates are inclusive YYYY-MM-DD.\n\n" +
        "Three properties of the answer decide how it must be read:\n" +
        "1. Each bucket's ratio is the bucket's **summed** spend over its **summed** metric " +
        "value. Do not average the per-bucket ratios to get a period figure — " +
        "`series[].overallValue` is the correct period ratio and is computed the same way.\n" +
        "2. `value: null` is a **gap**, not a zero. It means no metric value was reported for " +
        "that period (or the value was zero or negative), so the unit cost is unknown. Report " +
        "it as unknown; never substitute 0, and never describe the period as free or cheap.\n" +
        "3. There is one series **per currency**. More than one means spend exists in a " +
        "currency with no stated exchange rate; those series are not comparable and must not be " +
        "added together.\n\n" +
        "`gapBuckets` and `partialBuckets` summarise how much of the answer is unreliable — a " +
        "partial bucket has spend for the whole period but volume for only part of it, so its " +
        "ratio reads high. Margin is a 400 for a metric whose kind is not `currency`.",
      inputSchema: {
        metric: z.string().describe("Metric key or id."),
        ...unitCostQueryRequestSchema.shape,
      },
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        const parsed = unitCostQueryRequestSchema.safeParse(input);
        if (!parsed.success) return err(`Invalid unit-cost query: ${parsed.error.message}`);
        try {
          return ok(
            await runUnitCostQuery(auth.organizationId, String(input["metric"] ?? ""), parsed.data),
          );
        } catch (e) {
          return toolError(e);
        }
      },
    },
    {
      name: "create_business_metric",
      title: "Create a business metric",
      description:
        'Declare a denominator. `kind: "count"` is a quantity (customers, requests, GB) and ' +
        'supports unit cost; `kind: "currency"` is revenue and must also state a `currency`, ' +
        "and is the only kind margin can be computed against. `costScope` narrows which spend " +
        "the metric divides — leave it empty for all spend, and remember a unit-cost query can " +
        "narrow it further but never widen it. Creating the metric does not populate it: values " +
        "arrive through `write_business_metric_values`, the API, or a workflow.",
      inputSchema: businessMetricInputSchema.shape,
      risk: "write",
      permission: "costs:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:write");
        if (denied) return denied;
        const parsed = businessMetricInputSchema.safeParse(input);
        if (!parsed.success) return err(`Invalid business metric: ${parsed.error.message}`);
        try {
          const created = await createBusinessMetric(auth.organizationId, parsed.data, auth.userId);
          void logAudit({
            organizationId: auth.organizationId,
            userId: auth.userId,
            action: "business_metric.create",
            entityType: "business_metric",
            entityId: created.id,
            metadata: { key: created.key, kind: created.kind, source: auth.source },
          });
          return ok(created);
        } catch (e) {
          return toolError(e);
        }
      },
    },
    {
      name: "update_business_metric",
      title: "Update a business metric",
      description:
        "Replace a metric's whole definition. Changing `key` never orphans reported values " +
        "(they are keyed on the metric's id) but does break any workflow still writing to the " +
        "old key. Changing `costScope` changes what every unit-cost chart using this metric " +
        "means, so say what the new scope is when reporting the change.",
      inputSchema: {
        metricId: z.string().describe("Metric id or key."),
        ...businessMetricInputSchema.shape,
      },
      risk: "write",
      permission: "costs:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:write");
        if (denied) return denied;
        const parsed = businessMetricInputSchema.safeParse(input);
        if (!parsed.success) return err(`Invalid business metric: ${parsed.error.message}`);
        const existing = await getBusinessMetric(
          auth.organizationId,
          String(input["metricId"] ?? ""),
        );
        if (!existing) return err(`No business metric "${String(input["metricId"])}".`);
        try {
          const updated = await updateBusinessMetric(auth.organizationId, existing.id, parsed.data);
          if (!updated) return err("Business metric not found");
          void logAudit({
            organizationId: auth.organizationId,
            userId: auth.userId,
            action: "business_metric.update",
            entityType: "business_metric",
            entityId: updated.id,
            metadata: { key: updated.key, source: auth.source },
          });
          return ok(updated);
        } catch (e) {
          return toolError(e);
        }
      },
    },
    {
      name: "write_business_metric_values",
      title: "Report business metric values",
      description:
        "Write daily values for a metric. **Re-reporting a day restates it rather than adding " +
        "to it**, so this is safe to call twice — and it is the only correct way to fix a bad " +
        "number: send the day again with the right value. Dates are UTC YYYY-MM-DD. Nothing " +
        "lands unless the whole batch validates.",
      inputSchema: {
        metric: z.string().describe("Metric key or id."),
        values: z
          .array(z.object({ date: isoDay, value: z.number() }))
          .max(BUSINESS_METRIC_LIMITS.maxValuesPerCall),
      },
      risk: "write",
      permission: "costs:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:write");
        if (denied) return denied;
        const metric = await getBusinessMetric(auth.organizationId, String(input["metric"] ?? ""));
        if (!metric) return err(`No business metric "${String(input["metric"])}".`);
        try {
          const result = await ingestMetricValues({
            organizationId: auth.organizationId,
            metricId: metric.id,
            values: (input["values"] ?? []) as Array<{ date: string; value: number }>,
            source: {
              errorPrefix: "write_business_metric_values",
              source: "api",
              userId: auth.userId,
              maxValues: BUSINESS_METRIC_LIMITS.maxValuesPerCall,
            },
          });
          void logAudit({
            organizationId: auth.organizationId,
            userId: auth.userId,
            action: "business_metric.values.write",
            entityType: "business_metric",
            entityId: metric.id,
            metadata: { key: metric.key, days: result.written, source: auth.source },
          });
          return ok(result);
        } catch (e) {
          return toolError(e);
        }
      },
    },
    {
      name: "delete_business_metric",
      title: "Delete a business metric",
      description:
        "Soft-delete a metric and stop its values being reachable. Any dashboard card dividing " +
        "by it will show an error rather than quietly reverting to plain spend — which is " +
        "deliberate, because a chart that silently changed what it measures is worse than one " +
        "that says it is broken.",
      inputSchema: { metricId: z.string().describe("Metric id or key.") },
      risk: "destructive",
      permission: "costs:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:write");
        if (denied) return denied;
        const metric = await getBusinessMetric(
          auth.organizationId,
          String(input["metricId"] ?? ""),
        );
        if (!metric) return err(`No business metric "${String(input["metricId"])}".`);
        await softDeleteBusinessMetric(auth.organizationId, metric.id);
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "business_metric.delete",
          entityType: "business_metric",
          entityId: metric.id,
          metadata: { key: metric.key, source: auth.source },
        });
        return ok({ ok: true });
      },
    },
  ];
}
