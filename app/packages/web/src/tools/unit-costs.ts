/**
 * Business-metric and unit-cost tools: "what does a customer cost us?" for
 * MCP clients and the chat agent.
 *
 * These sit alongside `tools/costs.ts` and share its stance: org-wide spend
 * data, so every handler enforces the same permissions as the HTTP API, and
 * every description explains *how to read the numbers* rather than only naming
 * the fields. That matters more here than anywhere else in the cost surface,
 * because the two ways to misread a unit cost are both silent (treating a gap
 * as a zero, and treating an average of daily ratios as a period ratio) and a
 * model summarising this data will happily do either unless told not to.
 */
import { z } from "zod";

import {
  businessMetricImporterInputSchema,
  businessMetricInputSchema,
  unitCostQueryRequestSchema,
} from "@infrawrench/ui/cost/config";
import {
  BUSINESS_METRIC_IMPORT_AGGREGATIONS,
  BUSINESS_METRIC_IMPORT_SCHEDULES,
  BUSINESS_METRIC_LIMITS,
} from "@infrawrench/client-core";
import {
  BusinessMetricIngestError,
  ingestMetricValues,
} from "@infrawrench/server-core/cost/metric-ingest";
import {
  BusinessMetricImporterError,
  deleteBusinessMetricImporter,
  getBusinessMetricImporter,
  listBusinessMetricImportRuns,
  listBusinessMetricSourceAccounts,
  listBusinessMetricSourceOptions,
  previewBusinessMetricImport,
  runBusinessMetricImporterNow,
  upsertBusinessMetricImporter,
} from "@infrawrench/server-core/cost/metric-importers";

import {
  BusinessMetricInputError,
  BusinessMetricKeyConflictError,
  createBusinessMetric,
  getBusinessMetric,
  listBusinessMetricLabels,
  listBusinessMetricValues,
  listBusinessMetrics,
  softDeleteBusinessMetric,
  updateBusinessMetric,
} from "../services/business-metrics";
import {
  BusinessMetricNotFoundError,
  CostQueryError,
  listUsageUnits,
  runUnitCostQuery,
  runUsageUnitCostQuery,
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
  if (e instanceof BusinessMetricImporterError) return err(e.message);
  throw e;
}

/** Importer writes run queries with an account's credentials: both permissions, like the API. */
async function denyUnlessImporterWrite(auth: Parameters<typeof denyUnlessPermitted>[0]) {
  return (
    (await denyUnlessPermitted(auth, "costs:write")) ??
    (await denyUnlessPermitted(auth, "resources:execute"))
  );
}

const sourceParams = z
  .record(z.string(), z.string())
  .describe(
    "The source's form values, keyed by the field keys `list_business_metric_sources` returns. " +
      "Fill `select` fields from `list_business_metric_source_options`, never by guessing ids.",
  );

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
        "ratio reads high. Margin is a 400 for a metric whose kind is not `currency`.\n\n" +
        "Calculations (`mode`): `unit_cost` (default), `margin` (fraction, with " +
        "`absoluteMargin` = revenue − spend on every point), `raw_metric` (the metric itself " +
        "beside spend; zero is a real value there), and `usage_unit_cost` (spend ÷ the usage " +
        "providers report in `usageUnit`; omit `metric` — find units with `list_usage_units`). " +
        "`scale` (1, 100, 1000, 1e6, 1e9) expresses a ratio per that many units, so cost per " +
        "1,000 requests is `scale: 1000`; values come back already scaled.\n\n" +
        "Labels: `groupByLabel` returns one series per label value (e.g. per customer) with " +
        "`series[].label`; `labelFilters` keeps only some values. In a ratio mode the label must " +
        "be mapped to a cost dimension on the metric (see `list_business_metric_labels`), " +
        "otherwise the query is refused — an unmapped label has no per-value spend to divide.",
      inputSchema: {
        metric: z
          .string()
          .optional()
          .describe("Metric key or id. Omit only for `mode: usage_unit_cost`."),
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
          if (parsed.data.mode === "usage_unit_cost") {
            return ok(await runUsageUnitCostQuery(auth.organizationId, parsed.data));
          }
          const metric = typeof input["metric"] === "string" ? input["metric"] : "";
          if (!metric) return err("`metric` is required for this calculation.");
          return ok(await runUnitCostQuery(auth.organizationId, metric, parsed.data));
        } catch (e) {
          return toolError(e);
        }
      },
    },
    {
      name: "list_business_metric_labels",
      title: "List business metric labels",
      description:
        "The label keys a metric's values carry (customer, plan, region), each with its " +
        "distinct values and its `mapping`: the cost dimension (tag, virtual tag, account, " +
        "service…, or cost centre) whose values the label names. Only a mapped label can split " +
        "or filter a unit cost or margin; any label can split the raw metric.",
      inputSchema: { metric: z.string().describe("Metric key or id.") },
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        const metric = await getBusinessMetric(auth.organizationId, String(input["metric"] ?? ""));
        if (!metric) return err(`No business metric "${String(input["metric"])}".`);
        return ok({ metric: metric.key, labels: await listBusinessMetricLabels(metric) });
      },
    },
    {
      name: "list_usage_units",
      title: "List usage units",
      description:
        "The provider usage units the organization's cost rows report (GB-Mo, Hrs, Requests…) " +
        "over the last 90 days, most spend first, with some of the services reporting each. " +
        "Pass one as `usageUnit` to `query_unit_costs` with `mode: usage_unit_cost`.",
      inputSchema: {},
      risk: "read",
      permission: "costs:read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        return ok(await listUsageUnits(auth.organizationId));
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
        "lands unless the whole batch validates. Optional `labels` (e.g. " +
        '`{"customer": "acme"}`) break a day down; the same day with the same labels restates, ' +
        "and a day's total is the sum of its rows, so send a breakdown or a total, never both.",
      inputSchema: {
        metric: z.string().describe("Metric key or id."),
        values: z
          .array(
            z.object({
              date: isoDay,
              value: z.number(),
              label: z
                .string()
                .max(BUSINESS_METRIC_LIMITS.maxLabelValueLength)
                .optional()
                .describe("A single breakdown label, stored as the `label` key of `labels`."),
              labels: z.record(z.string(), z.string()).optional(),
            }),
          )
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
            values: (input["values"] ?? []) as Array<{
              date: string;
              value: number;
              label?: string;
              labels?: Record<string, string>;
            }>,
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
    {
      name: "list_business_metric_sources",
      title: "List business metric importer sources",
      description:
        "Connected accounts that can feed a business metric on a schedule (CloudWatch, BigQuery, " +
        "Snowflake, ClickHouse, Postgres, MySQL, Metronome, …), each with its importer form: the " +
        "field keys, which are pickers, which are SQL, whether read-only is enforced by the " +
        "engine or only validated, and whether a dry run is available. Start here before " +
        "`set_business_metric_importer`.",
      inputSchema: {},
      risk: "read",
      permission: "costs:read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        return ok(await listBusinessMetricSourceAccounts(auth.organizationId));
      },
    },
    {
      name: "list_business_metric_source_options",
      title: "List an importer picker's choices",
      description:
        "The choices for one `select` field of a source's form (a CloudWatch namespace, a " +
        "BigQuery dataset, a Snowflake warehouse), given the values picked so far. Calls the " +
        "provider with the account's credentials.",
      inputSchema: {
        accountId: z.string(),
        fieldKey: z.string(),
        params: sourceParams.optional(),
      },
      risk: "read",
      permission: "resources:execute",
      handler: async (input, auth) => {
        const denied = await denyUnlessImporterWrite(auth);
        if (denied) return denied;
        try {
          return ok(
            await listBusinessMetricSourceOptions(
              auth.organizationId,
              String(input["accountId"] ?? ""),
              String(input["fieldKey"] ?? ""),
              (input["params"] ?? {}) as Record<string, string>,
            ),
          );
        } catch (e) {
          return toolError(e);
        }
      },
    },
    {
      name: "preview_business_metric_import",
      title: "Preview a business metric import",
      description:
        "Run a source over a window (default: the 14 days ending yesterday) and return the daily " +
        "values it would write, writing nothing. SQL must be one SELECT or WITH statement that " +
        "returns `day` and `value` columns (and optionally `label`), using `{{from}}`, `{{to}}`, " +
        "`{{to_exclusive}}` and `{{timezone}}` placeholders. `dryRun: true` validates the query " +
        "with the provider without reading data, where the source supports it.",
      inputSchema: {
        accountId: z.string(),
        params: sourceParams,
        from: isoDay.optional(),
        to: isoDay.optional(),
        timezone: z.string().optional(),
        aggregation: z.enum(BUSINESS_METRIC_IMPORT_AGGREGATIONS).optional(),
        dryRun: z.boolean().optional(),
      },
      risk: "read",
      permission: "resources:execute",
      handler: async (input, auth) => {
        const denied = await denyUnlessImporterWrite(auth);
        if (denied) return denied;
        try {
          return ok(
            await previewBusinessMetricImport(auth.organizationId, {
              accountId: String(input["accountId"] ?? ""),
              params: (input["params"] ?? {}) as Record<string, string>,
              from: input["from"] as string | undefined,
              to: input["to"] as string | undefined,
              timezone: input["timezone"] as string | undefined,
              aggregation: input["aggregation"] as
                (typeof BUSINESS_METRIC_IMPORT_AGGREGATIONS)[number] | undefined,
              dryRun: input["dryRun"] as boolean | undefined,
            }),
          );
        } catch (e) {
          return toolError(e);
        }
      },
    },
    {
      name: "get_business_metric_importer",
      title: "Get a business metric's importer",
      description:
        "The scheduled importer feeding a metric (source account, params, schedule, backfill " +
        "window, timezone, aggregation, last status) plus its recent runs with their errors. " +
        "`importer` is null when the metric's values are only pushed. A failing importer means " +
        "the recent days are gaps, not zeros.",
      inputSchema: { metric: z.string().describe("Metric key or id.") },
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        const metric = await getBusinessMetric(auth.organizationId, String(input["metric"] ?? ""));
        if (!metric) return err(`No business metric "${String(input["metric"])}".`);
        return ok({
          importer: await getBusinessMetricImporter(auth.organizationId, metric.id),
          runs: await listBusinessMetricImportRuns(auth.organizationId, metric.id, 10),
        });
      },
    },
    {
      name: "set_business_metric_importer",
      title: "Configure a business metric's importer",
      description:
        "Create or replace the importer feeding a metric: a full replace, so send every field you " +
        "want kept. Each scheduled run restates the trailing `backfillDays` closed days (ending " +
        "yesterday in `timezone`), replacing every label those days carried. Use " +
        "`preview_business_metric_import` first to check the query returns what you expect.",
      inputSchema: {
        metric: z.string().describe("Metric key or id."),
        accountId: z.string(),
        params: sourceParams,
        schedule: z.enum(BUSINESS_METRIC_IMPORT_SCHEDULES).optional(),
        backfillDays: z.number().int().min(1).max(730).optional(),
        timezone: z.string().optional(),
        aggregation: z.enum(BUSINESS_METRIC_IMPORT_AGGREGATIONS).optional(),
        enabled: z.boolean().optional(),
      },
      risk: "write",
      permission: "resources:execute",
      handler: async (input, auth) => {
        const denied = await denyUnlessImporterWrite(auth);
        if (denied) return denied;
        const metric = await getBusinessMetric(auth.organizationId, String(input["metric"] ?? ""));
        if (!metric) return err(`No business metric "${String(input["metric"])}".`);
        const { metric: _metric, ...rest } = input;
        const parsed = businessMetricImporterInputSchema.safeParse(rest);
        if (!parsed.success) return err(parsed.error.issues.map((i) => i.message).join("; "));
        try {
          const importer = await upsertBusinessMetricImporter(
            auth.organizationId,
            metric.id,
            parsed.data,
            auth.userId,
          );
          void logAudit({
            organizationId: auth.organizationId,
            userId: auth.userId,
            action: "business_metric.importer.save",
            entityType: "business_metric",
            entityId: metric.id,
            metadata: {
              key: metric.key,
              accountId: importer.accountId,
              pluginId: importer.pluginId,
              source: auth.source,
            },
          });
          return ok(importer);
        } catch (e) {
          return toolError(e);
        }
      },
    },
    {
      name: "run_business_metric_importer",
      title: "Run a business metric's importer now",
      description:
        "Run the importer now and return the finished run (status, days written, error). With no " +
        "`from`/`to` it reads the importer's own window; give them to backfill up to 730 days.",
      inputSchema: {
        metric: z.string().describe("Metric key or id."),
        from: isoDay.optional(),
        to: isoDay.optional(),
      },
      risk: "write",
      permission: "resources:execute",
      handler: async (input, auth) => {
        const denied = await denyUnlessImporterWrite(auth);
        if (denied) return denied;
        const metric = await getBusinessMetric(auth.organizationId, String(input["metric"] ?? ""));
        if (!metric) return err(`No business metric "${String(input["metric"])}".`);
        try {
          const run = await runBusinessMetricImporterNow(
            auth.organizationId,
            metric.id,
            auth.userId,
            {
              from: input["from"] as string | undefined,
              to: input["to"] as string | undefined,
            },
          );
          void logAudit({
            organizationId: auth.organizationId,
            userId: auth.userId,
            action: "business_metric.importer.run",
            entityType: "business_metric",
            entityId: metric.id,
            metadata: {
              key: metric.key,
              status: run.status,
              days: run.daysWritten,
              source: auth.source,
            },
          });
          return ok(run);
        } catch (e) {
          return toolError(e);
        }
      },
    },
    {
      name: "delete_business_metric_importer",
      title: "Delete a business metric's importer",
      description:
        "Stop importing a metric and drop its run history. Values already imported stay; new days " +
        "will be gaps unless something else reports them.",
      inputSchema: { metric: z.string().describe("Metric key or id.") },
      risk: "destructive",
      permission: "costs:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:write");
        if (denied) return denied;
        const metric = await getBusinessMetric(auth.organizationId, String(input["metric"] ?? ""));
        if (!metric) return err(`No business metric "${String(input["metric"])}".`);
        const deleted = await deleteBusinessMetricImporter(auth.organizationId, metric.id);
        if (!deleted) return err(`"${metric.key}" has no importer.`);
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "business_metric.importer.delete",
          entityType: "business_metric",
          entityId: metric.id,
          metadata: { key: metric.key, source: auth.source },
        });
        return ok({ ok: true });
      },
    },
  ];
}
