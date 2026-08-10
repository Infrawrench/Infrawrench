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
import { costReportFolderPaths, type CostReportFolder } from "@infrawrench/client-core";
import {
  createCostReport,
  getCostReport,
  listCostReports,
  runCostReport,
  softDeleteCostReport,
  updateCostReport,
} from "../services/cost-reports";
import { CostReportFolderError, listCostReportFolders } from "../services/cost-report-folders";
import { CostQueryError } from "../services/cost-query";
import { logAudit } from "../services/audit";
import { denyUnlessPermitted } from "./permissions";
import { ok, err, type ToolDefinition } from "./types";

/**
 * Turn what an agent says about a folder — an id, a full path like
 * "Finance / Monthly", or a bare name — into a folder id. Ambiguity is an
 * error rather than a guess: filing a report in the wrong "Monthly" is a
 * mistake nobody notices until the report cannot be found.
 */
function resolveFolder(
  folders: CostReportFolder[],
  query: string,
): { id: string } | { error: string } {
  const byId = folders.find((f) => f.id === query);
  if (byId) return { id: byId.id };

  const wanted = query.trim().toLowerCase();
  const paths = costReportFolderPaths(folders);
  const byPath = folders.filter((f) => (paths.get(f.id) ?? "").toLowerCase() === wanted);
  if (byPath.length === 1) return { id: byPath[0]!.id };

  const byName = folders.filter((f) => f.name.trim().toLowerCase() === wanted);
  if (byName.length === 1) return { id: byName[0]!.id };
  if (byName.length > 1) {
    return {
      error:
        `"${query}" matches ${byName.length} folders: ` +
        byName.map((f) => paths.get(f.id) ?? f.name).join(", ") +
        ". Use the full path or the id.",
    };
  }
  return { error: `No cost-report folder matches "${query}". Use list_cost_reports to see paths.` };
}

export function costReportTools(): ToolDefinition[] {
  return [
    {
      name: "list_cost_reports",
      title: "List cost reports",
      description:
        "List the organization's saved cost reports — named, addressable cost graphs — with " +
        "their configuration, which dashboards carry a card for each, and the folder each is " +
        'filed under (`folderPath`, e.g. "Finance / Monthly"; null is the top level). Use ' +
        "this to find a report by name before running it. A report with no placements is " +
        "normal: a report exists and can be run whether or not any dashboard shows it.",
      inputSchema: {},
      risk: "read",
      permission: "costs:read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        const [reports, folders] = await Promise.all([
          listCostReports(auth.organizationId),
          listCostReportFolders(auth.organizationId),
        ]);
        const paths = costReportFolderPaths(folders);
        return ok(
          reports.map((r) => ({
            ...r,
            folderPath: r.folderId ? (paths.get(r.folderId) ?? null) : null,
          })),
        );
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
        let created;
        try {
          created = await createCostReport(auth.organizationId, parsed.data, auth.userId);
        } catch (e) {
          if (e instanceof CostReportFolderError) return err(e.message);
          throw e;
        }
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
        let updated;
        try {
          updated = await updateCostReport(auth.organizationId, reportId, parsed.data);
        } catch (e) {
          if (e instanceof CostReportFolderError) return err(e.message);
          throw e;
        }
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
      name: "move_cost_report",
      title: "Move cost report to folder",
      description:
        "File a saved cost report in a folder, or take it out of one. `folder` is a folder id, " +
        'a full path ("Finance / Monthly"), or a unique folder name; null moves the report ' +
        "to the top level of the Reports list. Filing changes nothing but where the report " +
        "appears in the list — its id, dashboards and numbers are untouched. Audit-logged.",
      inputSchema: { reportId: z.string(), folder: z.string().nullable() },
      risk: "write",
      permission: "costs:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:write");
        if (denied) return denied;
        const { reportId, folder } = input as { reportId: string; folder: string | null };

        const report = await getCostReport(auth.organizationId, reportId);
        if (!report) return err(`Cost report not found: ${reportId}`);

        let folderId: string | null = null;
        if (folder !== null) {
          const folders = await listCostReportFolders(auth.organizationId);
          const resolved = resolveFolder(folders, folder);
          if ("error" in resolved) return err(resolved.error);
          folderId = resolved.id;
        }

        const updated = await updateCostReport(auth.organizationId, reportId, {
          name: report.name,
          ...(report.description === null ? {} : { description: report.description }),
          config: report.config,
          folderId,
        });
        if (!updated) return err(`Cost report not found: ${reportId}`);
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "cost_report.update",
          entityType: "cost_report",
          entityId: updated.id,
          metadata: { name: updated.name, folderId, source: auth.source },
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
