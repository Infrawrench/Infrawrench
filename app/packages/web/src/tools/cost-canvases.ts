/**
 * Cost canvas tools: how the chat agent builds and edits canvases, and how an
 * MCP client reads and refreshes them.
 *
 * `write_cost_canvas` is the only way a model touches a canvas. Its spec is
 * parsed with the strict `costCanvasSpecSchema` (no SQL, no query strings,
 * every reference an id) and a failure comes back as a precise tool error the
 * model can fix. Writing to a canvas that already has blocks needs the
 * user's approval in chat, and `approvalSummary` puts the block diff on the
 * approval card: that is the "show a diff, user accepts" step, carried by
 * the chat's own approval model rather than a parallel one. The first write
 * to an empty canvas (just created from a prompt) applies directly.
 *
 * `run_cost_canvas` re-executes the saved spec; no model is involved in a
 * refresh. Permissions mirror the routes: reads `costs:read`, writes
 * `costs:write`.
 */
import { z } from "zod";
import { costCanvasSpecSchema, formatCostCanvasSpecIssues } from "@infrawrench/ui/cost/config";
import { COST_CANVAS_LIMITS } from "@infrawrench/client-core";
import {
  canvasHasBlocks,
  createCostCanvas,
  describeCanvasWrite,
  getCostCanvas,
  listCostCanvases,
  runCostCanvas,
  softDeleteCostCanvas,
  updateCostCanvas,
} from "../services/cost-canvases";
import { logAudit } from "../services/audit";
import { effectiveToolPermissions } from "./permissions";
import { ok, err, isNonBlankString, type ToolDefinition } from "./types";

const SPEC_GUIDE =
  "The spec is `{ version: 1, blocks: [...] }`, at most " +
  `${COST_CANVAS_LIMITS.maxBlocks} blocks, each with a stable \`id\` (letters, digits, - and _). Block kinds:\n` +
  "- `text`: short narrative (`#` headings, `**bold**`, `-` bullets). Quote figures only as `{{kpiId}}` or `{{kpiId.change}}`; text is never re-queried, so a typed number would go stale.\n" +
  "- `kpi`: `title` + `metric` of type `spend` (dateRange, filters), `unit_cost` (businessMetricId from list_business_metrics, dateRange, filters), `forecast` (month-end projection), `budget` (budgetId, percent used), or `anomaly_count` (days). `comparePreviousPeriod` for spend/unit_cost.\n" +
  "- `chart`: `title` + `config`, the same cost graph config a dashboard card holds (chartType, binning, dateRange, groupBy, filters, topN, comparePreviousPeriod, showForecast, unitCostMetricId for cost per unit).\n" +
  "- `table`: `title` + `query` (dateRange, binning none|daily|weekly|monthly, groupBy, filters, topN): one row per group, one column per bucket.\n" +
  "- `budgets` (optional budgetIds), `anomalies` (days, limit), `cost_report` (reportId), `custom_graph` (graphId: data from other connected tools).\n" +
  "Filters are `{dimension, op: in|not_in, values, tagKey?}` with dimension provider|account|service|region|resource|tag|charge_type|commitment; resolve values with list_cost_dimension_values. Date ranges: `{kind:'relative', preset: 7d|30d|90d|mtd|last_month|qtd|ytd|6m|12m}` (prefer these) or `{kind:'absolute', from, to}`.";

export function costCanvasTools(): ToolDefinition[] {
  return [
    {
      name: "list_cost_canvases",
      title: "List cost canvases",
      description:
        "List the organization's cost canvases: saved reports built from a description, each a " +
        "structured spec of KPI tiles, charts, tables, budgets, anomalies and narrative. Returns " +
        "definitions and which dashboards show each; use run_cost_canvas for numbers.",
      inputSchema: {},
      risk: "read",
      permission: "costs:read",
      handler: async (_input, auth) => {
        const canvases = await listCostCanvases(auth.organizationId, auth.userId);
        return ok(
          canvases.map((c) => ({
            id: c.id,
            name: c.name,
            description: c.description,
            blocks: c.spec.blocks.length,
            placements: c.placements,
            updatedAt: c.updatedAt,
          })),
        );
      },
    },

    {
      name: "get_cost_canvas",
      title: "Get cost canvas",
      description:
        "Fetch one cost canvas with its full spec. Always read the current spec with this before " +
        "editing a canvas with write_cost_canvas.",
      inputSchema: { canvasId: z.string() },
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const canvasId = input["canvasId"] as string;
        const canvas = await getCostCanvas(auth.organizationId, canvasId, auth.userId);
        if (!canvas) return err(`Cost canvas not found: ${canvasId}`);
        return ok(canvas);
      },
    },

    {
      name: "run_cost_canvas",
      title: "Run cost canvas",
      description:
        "Re-run a saved canvas's queries and return each block's result: KPI values, table rows, " +
        "budgets, anomalies, rendered narrative. Deterministic and free of any model call; " +
        "relative ranges resolve against today, so quote the returned windows with figures. " +
        "`includeChartData` adds full chart series (large; off by default).",
      inputSchema: { canvasId: z.string(), includeChartData: z.boolean().optional() },
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const canvasId = input["canvasId"] as string;
        const result = await runCostCanvas(auth.organizationId, canvasId, {
          granted: await effectiveToolPermissions(auth),
          includeChartData: input["includeChartData"] === true,
        });
        if (!result) return err(`Cost canvas not found: ${canvasId}`);
        return ok(result);
      },
    },

    {
      name: "write_cost_canvas",
      title: "Write cost canvas",
      description:
        "Create a cost canvas (omit canvasId) or replace an existing canvas's name, description " +
        "and whole spec. The spec stores queries, never numbers, so the canvas refreshes " +
        "without you. Replacing a canvas that already has blocks waits for the user to approve " +
        "a diff; keep block ids stable so the diff is honest.\n\n" +
        SPEC_GUIDE,
      inputSchema: {
        canvasId: z.string().optional(),
        name: z.string().min(1).max(COST_CANVAS_LIMITS.maxNameLength),
        description: z.string().max(COST_CANVAS_LIMITS.maxDescriptionLength).optional(),
        spec: costCanvasSpecSchema,
      },
      risk: "write",
      permission: "costs:write",
      async requiresApproval(input, auth) {
        // Creating, or filling an empty canvas, replaces nothing.
        if (!isNonBlankString(input["canvasId"])) return false;
        return await canvasHasBlocks(auth.organizationId, input["canvasId"]);
      },
      async approvalSummary(input, auth) {
        if (!isNonBlankString(input["canvasId"])) return null;
        const parsed = costCanvasSpecSchema.safeParse(input["spec"]);
        if (!parsed.success) return null;
        return await describeCanvasWrite(auth.organizationId, input["canvasId"], {
          name: typeof input["name"] === "string" ? input["name"].trim() : "",
          spec: parsed.data,
        });
      },
      handler: async (input, auth) => {
        const parsed = costCanvasSpecSchema.safeParse(input["spec"]);
        if (!parsed.success) {
          return err(`Invalid canvas spec: ${formatCostCanvasSpecIssues(parsed.error)}`);
        }
        const name = typeof input["name"] === "string" ? input["name"].trim() : "";
        if (!name) return err("name is required");
        const body = {
          name,
          ...(typeof input["description"] === "string"
            ? { description: input["description"] }
            : {}),
          spec: parsed.data,
        };
        const canvasId = isNonBlankString(input["canvasId"]) ? input["canvasId"] : null;
        if (!canvasId) {
          const created = await createCostCanvas(auth.organizationId, body, auth.userId);
          void logAudit({
            organizationId: auth.organizationId,
            userId: auth.userId,
            action: "cost_canvas.create",
            entityType: "cost_canvas",
            entityId: created.id,
            metadata: { name: created.name, source: auth.source },
          });
          return ok({ id: created.id, name: created.name, blocks: created.spec.blocks.length });
        }
        const updated = await updateCostCanvas(auth.organizationId, canvasId, body, auth.userId);
        if (!updated) return err(`Cost canvas not found: ${canvasId}`);
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "cost_canvas.update",
          entityType: "cost_canvas",
          entityId: updated.id,
          metadata: { name: updated.name, source: auth.source },
        });
        return ok({ id: updated.id, name: updated.name, blocks: updated.spec.blocks.length });
      },
    },

    {
      name: "delete_cost_canvas",
      title: "Delete cost canvas",
      description:
        "Delete a cost canvas (soft delete). Its dashboard cards and delivery schedules go with " +
        "it. The chat surface confirms with the user before invoking.",
      inputSchema: { canvasId: z.string() },
      risk: "destructive",
      permission: "costs:write",
      handler: async (input, auth) => {
        const canvasId = input["canvasId"] as string;
        if (!(await softDeleteCostCanvas(auth.organizationId, canvasId))) {
          return err(`Cost canvas not found: ${canvasId}`);
        }
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "cost_canvas.delete",
          entityType: "cost_canvas",
          entityId: canvasId,
          metadata: { source: auth.source },
        });
        return ok({ ok: true });
      },
    },
  ];
}
