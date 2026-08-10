/**
 * Change-based cost alert tools — manage the org's "tell me when spend on
 * this scope moves more than X% (or $Y) versus the prior period" alerts from
 * chat and MCP.
 *
 * The third cost-alert family, and worth keeping distinct when describing to
 * an agent: budgets fire on an absolute monthly total, anomaly detection on
 * unconfigured statistical outliers, and these on a configured relative
 * change on a chosen scope and cadence.
 *
 * Permissions mirror the HTTP routes exactly: reads are `costs:read`, writes
 * are `costs:write`, and every mutation is audit-logged.
 */
import { z } from "zod";

import { costAlertInputSchema } from "@infrawrench/ui/cost/config";
import {
  CostAlertLimitError,
  createCostAlert,
  getCostAlert,
  listCostAlertEventsForOrg,
  listCostAlerts,
  softDeleteCostAlert,
} from "../services/cost-alerts";
import { logAudit } from "../services/audit";
import { denyUnlessPermitted } from "./permissions";
import { ok, err, type ToolDefinition } from "./types";

export function costAlertTools(): ToolDefinition[] {
  return [
    {
      name: "list_cost_alerts",
      title: "List cost change alerts",
      description:
        "List the organization's change-based cost alerts: each watches a filter scope " +
        "(optionally per group, e.g. per service) on a daily, weekly or monthly cadence and " +
        "fires when spend moves past its percent and/or absolute threshold versus the prior " +
        "period. Includes when each alert last fired. Distinct from budgets (absolute monthly " +
        "total) and anomaly detection (statistical outliers) — use list_budgets for those.",
      inputSchema: {},
      risk: "read",
      permission: "costs:read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        return ok(await listCostAlerts(auth.organizationId));
      },
    },

    {
      name: "list_cost_alert_events",
      title: "List cost change alert events",
      description:
        "Recently fired change-alert events, newest first: which alert fired, the offending " +
        "group when the alert watches groups, the compared windows, and the previous → current " +
        "amounts with the percent change (null percent means new spend with no prior baseline). " +
        "Pass alertId to scope to one alert.",
      inputSchema: {
        alertId: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        const { alertId, limit } = input as { alertId?: string; limit?: number };
        const events = await listCostAlertEventsForOrg(auth.organizationId, {
          ...(alertId ? { alertId } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        if (events === null) return err(`Cost alert not found: ${alertId}`);
        return ok(events);
      },
    },

    {
      name: "create_cost_alert",
      title: "Create cost change alert",
      description:
        "Create a change-based cost alert. `cadence` picks the comparison: daily is one " +
        "complete day vs the same weekday last week, weekly is the last 7 complete days vs the " +
        "prior 7, monthly is month-to-date vs the same number of days last month. Set " +
        "`thresholdPercent`, `thresholdAmountCents`, or both — when both are set BOTH must " +
        "hold, which is how a 50% jump on $2 of spend stays quiet. `groupBy` watches each " +
        "group (e.g. each service) separately instead of one total. Audit-logged.",
      inputSchema: costAlertInputSchema.innerType().innerType().shape,
      risk: "write",
      permission: "costs:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:write");
        if (denied) return denied;
        const parsed = costAlertInputSchema.safeParse(input);
        if (!parsed.success) return err(`Invalid cost alert: ${parsed.error.message}`);
        let created;
        try {
          created = await createCostAlert(auth.organizationId, parsed.data, auth.userId);
        } catch (e) {
          if (e instanceof CostAlertLimitError) return err(e.message);
          throw e;
        }
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "cost_alert.create",
          entityType: "cost_alert",
          entityId: created.id,
          metadata: { name: created.name, cadence: created.cadence, source: auth.source },
        });
        return ok(created);
      },
    },

    {
      name: "delete_cost_alert",
      title: "Delete cost change alert",
      description:
        "Delete a change-based cost alert (soft delete). Its fired events leave the org-wide " +
        "event feed with it. Audit-logged. The chat surface confirms with the user before " +
        "invoking.",
      inputSchema: { alertId: z.string() },
      risk: "destructive",
      permission: "costs:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:write");
        if (denied) return denied;
        const alertId = input["alertId"] as string;
        const alert = await getCostAlert(auth.organizationId, alertId);
        if (!alert) return err(`Cost alert not found: ${alertId}`);
        const deleted = await softDeleteCostAlert(auth.organizationId, alertId);
        if (!deleted) return err(`Cost alert not found: ${alertId}`);
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "cost_alert.delete",
          entityType: "cost_alert",
          entityId: alertId,
          metadata: { name: alert.name, source: auth.source },
        });
        return ok({ ok: true });
      },
    },
  ];
}
