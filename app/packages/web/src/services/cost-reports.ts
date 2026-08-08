/**
 * Org-scoped cost-report CRUD and execution — shared by the HTTP routes
 * (api/routes/cost-reports.ts) and the tool registry (tools/cost-reports.ts),
 * mirroring services/budgets.ts.
 *
 * A report is the named, addressable form of a cost graph: the ad-hoc
 * `cost_graph` widget keeps its config inline, while a `cost_report` widget is
 * a view onto a row here. That is the same relationship a budget widget has to
 * a `budgets` row, and the placement/soft-delete rules below are deliberately
 * the same rules.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

import { costQueryForConfig, type CostGraphConfig } from "@infrawrench/ui/cost/config";
import type {
  CostReport,
  CostReportInput,
  CostReportPlacement,
  CostReportRunResult,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { costReports, dashboardWidgets, dashboards } from "../db/schema";
import { runCostQuery } from "./cost-query";

type CostReportRow = typeof costReports.$inferSelect;

/**
 * Which dashboards carry a card for each of `reportIds`, keyed by report id.
 *
 * Cost-report widgets store their target as `config.reportId`, so this reads
 * the JSONB key rather than a foreign key — there is no referential integrity
 * between a report and the cards pointing at it, which is exactly what lets a
 * report outlive every one of its cards.
 */
async function loadReportPlacements(
  organizationId: string,
  reportIds: string[],
): Promise<Map<string, CostReportPlacement[]>> {
  const byReport = new Map<string, CostReportPlacement[]>();
  if (reportIds.length === 0) return byReport;

  const rows = await db
    .select({
      widgetId: dashboardWidgets.id,
      dashboardId: dashboardWidgets.dashboardId,
      dashboardName: dashboards.name,
      reportId: sql<string>`${dashboardWidgets.config} ->> 'reportId'`,
    })
    .from(dashboardWidgets)
    .innerJoin(dashboards, eq(dashboards.id, dashboardWidgets.dashboardId))
    .where(
      and(
        eq(dashboardWidgets.organizationId, organizationId),
        eq(dashboardWidgets.kind, "cost_report"),
        isNull(dashboardWidgets.deletedAt),
        isNull(dashboards.deletedAt),
        inArray(sql`${dashboardWidgets.config} ->> 'reportId'`, reportIds),
      ),
    )
    .orderBy(dashboards.name);

  for (const row of rows) {
    const list = byReport.get(row.reportId) ?? [];
    list.push({
      widgetId: row.widgetId,
      dashboardId: row.dashboardId,
      dashboardName: row.dashboardName,
    });
    byReport.set(row.reportId, list);
  }
  return byReport;
}

/** Assemble the wire row for one report. */
function toCostReport(row: CostReportRow, placements: CostReportPlacement[]): CostReport {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    config: row.config as CostGraphConfig,
    folderId: row.folderId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    placements,
  };
}

/** List the org's reports, alphabetically, each with its dashboard placements. */
export async function listCostReports(organizationId: string): Promise<CostReport[]> {
  const rows = await db
    .select()
    .from(costReports)
    .where(and(eq(costReports.organizationId, organizationId), isNull(costReports.deletedAt)))
    .orderBy(asc(costReports.name));

  const placements = await loadReportPlacements(
    organizationId,
    rows.map((r) => r.id),
  );
  return rows.map((row) => toCostReport(row, placements.get(row.id) ?? []));
}

/** Fetch one report. Null when not found (or soft-deleted). */
export async function getCostReport(
  organizationId: string,
  reportId: string,
): Promise<CostReport | null> {
  const row = await loadReportRow(organizationId, reportId);
  if (!row) return null;
  const placements = await loadReportPlacements(organizationId, [row.id]);
  return toCostReport(row, placements.get(row.id) ?? []);
}

async function loadReportRow(
  organizationId: string,
  reportId: string,
): Promise<CostReportRow | null> {
  const [row] = await db
    .select()
    .from(costReports)
    .where(
      and(
        eq(costReports.id, reportId),
        eq(costReports.organizationId, organizationId),
        isNull(costReports.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function createCostReport(
  organizationId: string,
  input: CostReportInput,
  createdByUserId: string | null,
): Promise<CostReport> {
  const [created] = await db
    .insert(costReports)
    .values({
      id: uuidv4(),
      organizationId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      config: input.config,
      folderId: input.folderId ?? null,
      createdByUserId,
    })
    .returning();
  // A brand-new report is on no dashboard yet, so there is nothing to look up.
  return toCostReport(created!, []);
}

/**
 * Replace a report's name, description, config and folder. Null when not found.
 *
 * A full replace rather than a patch, matching `updateBudget`: the editor
 * always holds the whole object, and a partial update would let two concurrent
 * editors merge into a config neither of them authored.
 */
export async function updateCostReport(
  organizationId: string,
  reportId: string,
  input: CostReportInput,
): Promise<CostReport | null> {
  const [updated] = await db
    .update(costReports)
    .set({
      name: input.name.trim(),
      description: input.description?.trim() || null,
      config: input.config,
      folderId: input.folderId ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(costReports.id, reportId),
        eq(costReports.organizationId, organizationId),
        isNull(costReports.deletedAt),
      ),
    )
    .returning();
  if (!updated) return null;
  const placements = await loadReportPlacements(organizationId, [updated.id]);
  return toCostReport(updated, placements.get(updated.id) ?? []);
}

/**
 * Soft-delete a report and every dashboard card pointing at it. False when not
 * found.
 *
 * The cards go with it for the reason budget and custom-graph cards do: a
 * `cost_report` widget resolves its row by `config.reportId`, so a card left
 * behind renders as a permanent "report unavailable" tile that no amount of
 * dashboard editing explains. Removing a *card* still leaves the report alone —
 * that direction is the whole point of the object.
 */
export async function softDeleteCostReport(
  organizationId: string,
  reportId: string,
): Promise<boolean> {
  const now = new Date();
  const [deleted] = await db
    .update(costReports)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(costReports.id, reportId),
        eq(costReports.organizationId, organizationId),
        isNull(costReports.deletedAt),
      ),
    )
    .returning({ id: costReports.id });
  if (!deleted) return false;

  await db
    .update(dashboardWidgets)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(dashboardWidgets.organizationId, organizationId),
        eq(dashboardWidgets.kind, "cost_report"),
        isNull(dashboardWidgets.deletedAt),
        eq(sql`${dashboardWidgets.config} ->> 'reportId'`, reportId),
      ),
    );
  return true;
}

/**
 * Run a report by id and return its series. Null when the report is not found.
 *
 * The point of executing by id is that no caller has to reassemble the config
 * to run it — chat, the CLI and (later) scheduled delivery all ask for the same
 * report and get the same numbers. The resolved `from`/`to` ride along because
 * a relative preset means a different window tomorrow, and a consumer quoting
 * the total needs to know which days it covered.
 */
export async function runCostReport(
  organizationId: string,
  reportId: string,
  today = new Date(),
): Promise<CostReportRunResult | null> {
  const row = await loadReportRow(organizationId, reportId);
  if (!row) return null;

  const request = costQueryForConfig(row.config as CostGraphConfig, today);
  const result = await runCostQuery(organizationId, request);
  return {
    reportId: row.id,
    name: row.name,
    from: request.from,
    to: request.to,
    result,
  };
}
