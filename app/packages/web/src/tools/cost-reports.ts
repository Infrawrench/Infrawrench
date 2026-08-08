/**
 * Cost report tools — list, read, run and manage the org's named saved cost
 * graphs from chat and MCP.
 *
 * The point of the report object over an ad-hoc `query_costs` call is that
 * "the report we look at every Monday" is a thing a person can name, so an
 * agent can be asked to run *that* rather than be told a filter set to
 * reassemble. `run_cost_report` therefore takes only an id.
 *
 * Permissions mirror the HTTP routes exactly: reads are `costs:read`, writes
 * are `costs:write`, and every mutation is audit-logged.
 */
import { z } from "zod";

import { costReportInputSchema } from "@infrawrench/ui/cost/config";
import {
  createCostReport,
  getCostReport,
  listCostReports,
  runCostReport,
  softDeleteCostReport,
  updateCostReport,
} from "../services/cost-reports";
import { CostQueryError } from "../services/cost-query";
import { logAudit } from "../services/audit";
import { denyUnlessPermitted } from "./permissions";
import { ok, err, type ToolDefinition } from "./types";

export function costReportTools(): ToolDefinition[] {
  return [
    {
      name: "list_cost_reports",
      title: "List cost reports",
      description:
        "List the organization's saved cost reports — named, addressable cost graphs — with " +
        "their configuration and which dashboards carry a card for each. Use this to find a " +
        "report by name before running it. A report with no placements is normal: a report " +
        "exists and can be run whether or not any dashboard shows it.",
      inputSchema: {},
      risk: "read",
      permission: "costs:read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        return ok(await listCostReports(auth.organizationId));
      },
    },

    {
      name: "get_cost_report",
      title: "Get cost report",
      description:
        "Fetch one saved cost report: its name, description, saved graph configuration, and the " +
        "dashboards showing it. This returns the definition, not the numbers — use " +
        "run_cost_report for those.",
      inputSchema: { reportId: z.string() },
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        const reportId = input["reportId"] as string;
        const report = await getCostReport(auth.organizationId, reportId);
        if (!report) return err(`Cost report not found: ${reportId}`);
        return ok(report);
      },
    },

    {
      name: "run_cost_report",
      title: "Run cost report",
      description:
        "Execute a saved cost report and return its series, plus the inclusive date window its " +
        "range resolved to. Takes only the report id — the report is the query, so there is " +
        "nothing to reassemble.\n\n" +
        "A report saved with a relative range ('the last 30 days') covers a different window " +
        "every day, which is why the resolved `from`/`to` come back with the numbers: quote " +
        "them alongside any total.",
      inputSchema: { reportId: z.string() },
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        const reportId = input["reportId"] as string;
        try {
          const result = await runCostReport(auth.organizationId, reportId);
          if (!result) return err(`Cost report not found: ${reportId}`);
          return ok(result);
        } catch (e) {
          if (e instanceof CostQueryError) return err(e.message);
          throw e;
        }
      },
    },

    {
      name: "create_cost_report",
      title: "Create cost report",
      description:
        "Save a cost graph as a named report. `config` is the same graph configuration a " +
        "dashboard cost card holds (chart type, binning, date range, group-by, filters, topN, " +
        "comparison and forecast toggles, cost basis). The report can then be run by id and " +
        "shown on any number of dashboards, and editing it updates all of them. Audit-logged.",
      inputSchema: costReportInputSchema.shape,
      risk: "write",
      permission: "costs:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:write");
        if (denied) return denied;
        const parsed = costReportInputSchema.safeParse(input);
        if (!parsed.success) return err(`Invalid cost report: ${parsed.error.message}`);
        const created = await createCostReport(auth.organizationId, parsed.data, auth.userId);
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "cost_report.create",
          entityType: "cost_report",
          entityId: created.id,
          metadata: { name: created.name, source: auth.source },
        });
        return ok(created);
      },
    },

    {
      name: "update_cost_report",
      title: "Update cost report",
      description:
        "Replace a saved report's name, description and graph configuration. Every dashboard " +
        "carrying a card for the report shows the new version — that is what referencing a " +
        "report by id buys, and it is worth saying out loud before changing a shared one. " +
        "Audit-logged.",
      inputSchema: { reportId: z.string(), ...costReportInputSchema.shape },
      risk: "write",
      permission: "costs:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:write");
        if (denied) return denied;
        const { reportId, ...rest } = input as { reportId: string } & Record<string, unknown>;
        const parsed = costReportInputSchema.safeParse(rest);
        if (!parsed.success) return err(`Invalid cost report: ${parsed.error.message}`);
        const updated = await updateCostReport(auth.organizationId, reportId, parsed.data);
        if (!updated) return err(`Cost report not found: ${reportId}`);
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "cost_report.update",
          entityType: "cost_report",
          entityId: updated.id,
          metadata: { name: updated.name, source: auth.source },
        });
        return ok(updated);
      },
    },

    {
      name: "delete_cost_report",
      title: "Delete cost report",
      description:
        "Delete a saved cost report (soft delete). Every dashboard card pointing at it is " +
        "removed too, since a card whose report is gone can only render as an unavailable " +
        "tile — call list_cost_reports first if you need to tell the user which dashboards " +
        "that affects. Audit-logged. The chat surface confirms with the user before invoking.",
      inputSchema: { reportId: z.string() },
      risk: "destructive",
      permission: "costs:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:write");
        if (denied) return denied;
        const reportId = input["reportId"] as string;
        const deleted = await softDeleteCostReport(auth.organizationId, reportId);
        if (!deleted) return err(`Cost report not found: ${reportId}`);
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "cost_report.delete",
          entityType: "cost_report",
          entityId: reportId,
          metadata: { source: auth.source },
        });
        return ok({ ok: true });
      },
    },
  ];
}
