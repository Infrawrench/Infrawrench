/**
 * Cost & budget tools — expose the cloud-spend surface (ClickHouse cost_daily
 * + Postgres budgets) to MCP clients and the chat agent. Unlike the resource
 * tools, these guard org-wide spend data, so every handler enforces the same
 * `costs:read` / `budgets:*` permissions as the HTTP API.
 */
import { z } from "zod";
import {
  COST_DIMENSIONS,
  budgetInputSchema,
  costQueryRequestSchema,
} from "@infrawrench/ui/cost/config";
import {
  CostQueryError,
  getOrgCostStatus,
  listCostDimensionValues,
  listCostTagKeys,
  runCostQuery,
} from "../services/cost-query";
import {
  createBudget,
  getBudgetWithStatus,
  listBudgetEvents,
  listBudgetsWithStatus,
  softDeleteBudget,
  updateBudget,
} from "../services/budgets";
import { logAudit } from "../services/audit";
import { denyUnlessPermitted } from "./permissions";
import { ok, err, type ToolDefinition } from "./types";

export function costTools(): ToolDefinition[] {
  return [
    {
      name: "query_costs",
      title: "Query costs",
      description:
        "Aggregate daily cloud spend across all connected accounts into time series. " +
        "Dates are inclusive YYYY-MM-DD. Group by provider/account/service/region/resource/tag " +
        "(groupByTagKey required for tag), filter on the same dimensions, choose " +
        "daily/weekly/monthly/cumulative binning, and optionally include the previous period " +
        "(comparePreviousPeriod) or a trend forecast (forecast). Amounts are in the returned " +
        'currency\'s major unit; groups beyond topN fold into an "Other" series.',
      inputSchema: costQueryRequestSchema.shape,
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        const parsed = costQueryRequestSchema.safeParse(input);
        if (!parsed.success) return err(`Invalid query: ${parsed.error.message}`);
        try {
          return ok(await runCostQuery(auth.organizationId, parsed.data));
        } catch (e) {
          if (e instanceof CostQueryError) return err(e.message);
          throw e;
        }
      },
    },

    {
      name: "list_cost_dimension_values",
      title: "List cost dimension values",
      description:
        "List the distinct values present in the organization's cost data for a dimension " +
        "(with display labels), or the available tag keys via dimension=tag-keys. Use this to " +
        "discover valid filter/group-by values before calling query_costs.",
      inputSchema: {
        dimension: z.enum([...COST_DIMENSIONS, "tag-keys"]),
        tagKey: z.string().optional().describe("Required when dimension is 'tag'."),
      },
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        const { dimension, tagKey } = input as { dimension: string; tagKey?: string };
        if (dimension === "tag-keys") {
          return ok(await listCostTagKeys(auth.organizationId));
        }
        try {
          return ok(await listCostDimensionValues(auth.organizationId, dimension, tagKey));
        } catch (e) {
          if (e instanceof CostQueryError) return err(e.message);
          throw e;
        }
      },
    },

    {
      name: "get_cost_status",
      title: "Get cost collection status",
      description:
        "Per-account cost data coverage: whether the provider plugin supports cost collection, " +
        "when spend was last polled, backfill state, and the date range covered. Check this when " +
        "query_costs returns empty or surprising data.",
      inputSchema: {},
      risk: "read",
      permission: "costs:read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        return ok(await getOrgCostStatus(auth.organizationId));
      },
    },

    {
      name: "list_budgets",
      title: "List budgets",
      description:
        "List the organization's monthly cost budgets with current-month actual and forecast " +
        "spend (in cents) and any alert thresholds fired this month.",
      inputSchema: {},
      risk: "read",
      permission: "budgets:read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "budgets:read");
        if (denied) return denied;
        return ok(await listBudgetsWithStatus(auth.organizationId));
      },
    },

    {
      name: "get_budget",
      title: "Get budget",
      description:
        "Fetch one budget with current-month actual/forecast status plus its alert history " +
        "(up to the last 100 fired thresholds across months).",
      inputSchema: { budgetId: z.string() },
      risk: "read",
      permission: "budgets:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "budgets:read");
        if (denied) return denied;
        const budgetId = input["budgetId"] as string;
        const budget = await getBudgetWithStatus(auth.organizationId, budgetId);
        if (!budget) return err(`Budget not found: ${budgetId}`);
        const events = await listBudgetEvents(auth.organizationId, budgetId);
        return ok({ ...budget, events: events ?? [] });
      },
    },

    {
      name: "create_budget",
      title: "Create budget",
      description:
        "Create a monthly cost budget. amountCents is the monthly limit in the currency's minor " +
        "unit. Thresholds fire once per month when actual or forecast spend crosses the given " +
        "percent of the budget. Filters (same shape as query_costs) scope the budget to a slice " +
        "of spend; empty filters cover the whole organization. Audit-logged.",
      inputSchema: budgetInputSchema.shape,
      risk: "write",
      permission: "budgets:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "budgets:write");
        if (denied) return denied;
        const parsed = budgetInputSchema.safeParse(input);
        if (!parsed.success) return err(`Invalid budget: ${parsed.error.message}`);
        const created = await createBudget(auth.organizationId, parsed.data, auth.userId);
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "budget.create",
          entityType: "budget",
          entityId: created.id,
          metadata: { name: created.name, amountCents: created.amountCents, source: auth.source },
        });
        return ok(created);
      },
    },

    {
      name: "update_budget",
      title: "Update budget",
      description:
        "Replace a budget's name, amount, currency, filters, and thresholds. Alert history is " +
        "kept. Audit-logged.",
      inputSchema: { budgetId: z.string(), ...budgetInputSchema.shape },
      risk: "write",
      permission: "budgets:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "budgets:write");
        if (denied) return denied;
        const { budgetId, ...rest } = input as { budgetId: string } & Record<string, unknown>;
        const parsed = budgetInputSchema.safeParse(rest);
        if (!parsed.success) return err(`Invalid budget: ${parsed.error.message}`);
        const updated = await updateBudget(auth.organizationId, budgetId, parsed.data);
        if (!updated) return err(`Budget not found: ${budgetId}`);
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "budget.update",
          entityType: "budget",
          entityId: updated.id,
          metadata: { name: updated.name, amountCents: updated.amountCents, source: auth.source },
        });
        return ok(updated);
      },
    },

    {
      name: "delete_budget",
      title: "Delete budget",
      description:
        "Delete a budget (soft delete — alert history is retained). Audit-logged. The chat " +
        "surface confirms with the user before invoking.",
      inputSchema: { budgetId: z.string() },
      risk: "destructive",
      permission: "budgets:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "budgets:write");
        if (denied) return denied;
        const budgetId = input["budgetId"] as string;
        const deleted = await softDeleteBudget(auth.organizationId, budgetId);
        if (!deleted) return err(`Budget not found: ${budgetId}`);
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "budget.delete",
          entityType: "budget",
          entityId: budgetId,
          metadata: { source: auth.source },
        });
        return ok({ ok: true });
      },
    },
  ];
}
