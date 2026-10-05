/**
 * Bulk move and bulk delete for the Reports list (POST /cost-reports/bulk).
 *
 * Validate everything, then write everything, in one transaction. Every item
 * is checked before any row changes: it exists in the org, the caller's
 * per-object sharing allows the action on it, and (for a move) the folder tree
 * that would result keeps every folder within the nesting limit and free of
 * cycles. Any problem refuses the whole request with a list naming each item
 * that blocked it; nothing is half-applied.
 *
 * The folder rows are read `FOR UPDATE` inside the transaction, so a
 * concurrent rename/reparent of the same folders waits for this one instead of
 * slipping in between the depth check and the write. Report rows are locked
 * the same way for the same reason.
 *
 * The writes restate the single-item services rather than calling them
 * (`softDeleteCostReport`, `deleteCostReportFolder`): those hold the
 * module-level `db` and cannot join a transaction, which is the
 * `acknowledgeCostAnomaly` situation. The effects are the same ones: a deleted
 * report takes its dashboard cards, its delivery schedules and its sharing
 * rows with it; a deleted folder takes only its sharing rows, and the SET NULL
 * foreign keys drop what was inside it to the top level.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  costReportBulkMoveBlockers,
  type CostReportBulkProblem,
  type CostReportBulkRequest,
  type CostReportBulkResult,
  type CostReportFolder,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import {
  costReportFolders,
  costReports,
  dashboardWidgets,
  objectAccessGrants,
  reportNotifications,
} from "../db/schema";
import { logAudit } from "./audit";
import { loadAccessResolver, objectAccessProblem, ObjectNotVisibleError } from "./object-sharing";

/** A bulk request refused before anything was written. The API answers 400. */
export class CostReportBulkError extends Error {
  constructor(
    readonly problems: CostReportBulkProblem[],
    action: CostReportBulkRequest["action"],
  ) {
    // The message names the items itself, because it is often the only part a
    // transport keeps (the desktop IPC bridge, the CLI, an MCP tool result):
    // "some items failed" with no names is the useless version.
    const verb = action === "move" ? "moved" : "deleted";
    const shown = problems.slice(0, 3).map((p) => p.message.replace(/\.$/, ""));
    const more =
      problems.length > shown.length ? `; and ${problems.length - shown.length} more` : "";
    super(`${shown.join("; ")}${more}. Nothing was ${verb}.`);
  }
}

function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Apply a bulk move or delete for `userId`, all or nothing.
 *
 * Throws {@link CostReportBulkError} listing every blocking item. Audit rows
 * are written after the commit, one per item, so the log reads the same as
 * the single-item routes do and a reviewer can find "who moved this report"
 * by the report, with `bulk: true` in the metadata saying how.
 */
export async function applyCostReportBulk(
  organizationId: string,
  request: CostReportBulkRequest,
  userId: string | null,
  auditMetadata: Record<string, unknown> = {},
): Promise<CostReportBulkResult> {
  const reportIds = dedupe(request.reportIds);
  const folderIds = dedupe(request.folderIds);

  // Sharing is resolved outside the transaction (it reads grants, which this
  // request never writes for a move) and once per object type, not per item.
  const [reportAccess, folderAccess] = await Promise.all([
    loadAccessResolver(organizationId, "cost_report"),
    loadAccessResolver(organizationId, "cost_report_folder"),
  ]);

  const now = new Date();
  const audit: Array<{ action: string; entityType: string; entityId: string; name: string }> = [];

  const result = await db.transaction(async (tx) => {
    const folderRows = await tx
      .select()
      .from(costReportFolders)
      .where(eq(costReportFolders.organizationId, organizationId))
      .for("update");
    const folders: CostReportFolder[] = folderRows.map((f) => ({
      id: f.id,
      name: f.name,
      parentFolderId: f.parentFolderId,
      createdAt: f.createdAt.toISOString(),
      updatedAt: f.updatedAt.toISOString(),
    }));
    const folderById = new Map(folders.map((f) => [f.id, f]));

    const reportRows =
      reportIds.length === 0
        ? []
        : await tx
            .select({
              id: costReports.id,
              name: costReports.name,
              folderId: costReports.folderId,
              createdByUserId: costReports.createdByUserId,
            })
            .from(costReports)
            .where(
              and(
                eq(costReports.organizationId, organizationId),
                inArray(costReports.id, reportIds),
                isNull(costReports.deletedAt),
              ),
            )
            .for("update");
    const reportById = new Map(reportRows.map((r) => [r.id, r]));

    const problems: CostReportBulkProblem[] = [];
    const needed = request.action === "delete" ? "delete" : "editor";

    for (const id of reportIds) {
      const row = reportById.get(id);
      const denied = row
        ? objectAccessProblem(
            reportAccess,
            id,
            { createdByUserId: row.createdByUserId, folderId: row.folderId },
            needed,
          )
        : new ObjectNotVisibleError();
      if (denied) {
        // Below viewer reads as "not found", exactly as the single-item routes
        // answer 404: a bulk error must not confirm what a GET would deny.
        const visible = row && !(denied instanceof ObjectNotVisibleError);
        problems.push({
          kind: "report",
          id,
          name: visible ? row.name : null,
          message: visible
            ? `"${row.name}": ${denied.message}`
            : "A selected report no longer exists.",
        });
      }
    }

    for (const id of folderIds) {
      const folder = folderById.get(id);
      const denied = folder
        ? objectAccessProblem(folderAccess, id, { folderId: folder.parentFolderId }, needed)
        : new ObjectNotVisibleError();
      if (denied) {
        const visible = folder && !(denied instanceof ObjectNotVisibleError);
        problems.push({
          kind: "folder",
          id,
          name: visible ? folder.name : null,
          message: visible
            ? `"${folder.name}": ${denied.message}`
            : "A selected folder no longer exists.",
        });
      }
    }

    if (request.action === "move") {
      const target = request.targetFolderId;
      if (target !== null) {
        const targetFolder = folderById.get(target);
        // Filing into a folder hands the folder's grantees access to what is
        // filed (folder grants inherit), so the destination needs editor, not
        // just a glimpse.
        const denied = targetFolder
          ? objectAccessProblem(
              folderAccess,
              target,
              { folderId: targetFolder.parentFolderId },
              "editor",
            )
          : new ObjectNotVisibleError();
        if (denied) {
          const visible = targetFolder && !(denied instanceof ObjectNotVisibleError);
          problems.push({
            kind: "target",
            id: target,
            name: visible ? targetFolder.name : null,
            message: visible
              ? `You can't file items into "${targetFolder.name}": ${denied.message}`
              : "Destination folder not found.",
          });
        }
      }
      // The tree rules, against the tree as it will be once every move lands.
      // Only folders that exist are judged; the missing ones are reported above.
      if (problems.every((p) => p.kind !== "target")) {
        for (const blocked of costReportBulkMoveBlockers(
          folders,
          folderIds.filter((id) => folderById.has(id)),
          target,
        )) {
          const folder = blocked.folderId ? folderById.get(blocked.folderId) : undefined;
          problems.push({
            kind: blocked.folderId ? "folder" : "target",
            id: blocked.folderId ?? target ?? "",
            name: folder?.name ?? null,
            message: folder ? `"${folder.name}": ${blocked.message}` : blocked.message,
          });
        }
      }
    }

    if (problems.length > 0) throw new CostReportBulkError(problems, request.action);

    if (request.action === "move") {
      const target = request.targetFolderId;
      if (reportIds.length > 0) {
        await tx
          .update(costReports)
          .set({ folderId: target, updatedAt: now })
          .where(
            and(eq(costReports.organizationId, organizationId), inArray(costReports.id, reportIds)),
          );
      }
      if (folderIds.length > 0) {
        await tx
          .update(costReportFolders)
          .set({ parentFolderId: target, updatedAt: now })
          .where(
            and(
              eq(costReportFolders.organizationId, organizationId),
              inArray(costReportFolders.id, folderIds),
            ),
          );
      }
      for (const id of reportIds) {
        audit.push({
          action: "cost_report.move",
          entityType: "cost_report",
          entityId: id,
          name: reportById.get(id)!.name,
        });
      }
      for (const id of folderIds) {
        audit.push({
          action: "cost_report_folder.move",
          entityType: "cost_report_folder",
          entityId: id,
          name: folderById.get(id)!.name,
        });
      }
      return { action: "move" as const, reports: reportIds.length, folders: folderIds.length };
    }

    if (reportIds.length > 0) {
      await tx
        .update(costReports)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(eq(costReports.organizationId, organizationId), inArray(costReports.id, reportIds)),
        );
      // Cards, schedules and sharing go with the report, as in
      // `softDeleteCostReport`.
      await tx
        .update(dashboardWidgets)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(
            eq(dashboardWidgets.organizationId, organizationId),
            eq(dashboardWidgets.kind, "cost_report"),
            isNull(dashboardWidgets.deletedAt),
            inArray(sql`${dashboardWidgets.config} ->> 'reportId'`, reportIds),
          ),
        );
      await tx
        .update(reportNotifications)
        .set({ enabled: false, nextSendAt: null, updatedAt: now })
        .where(
          and(
            eq(reportNotifications.organizationId, organizationId),
            inArray(reportNotifications.costReportId, reportIds),
          ),
        );
      await tx
        .delete(objectAccessGrants)
        .where(
          and(
            eq(objectAccessGrants.organizationId, organizationId),
            eq(objectAccessGrants.objectType, "cost_report"),
            inArray(objectAccessGrants.objectId, reportIds),
          ),
        );
    }
    if (folderIds.length > 0) {
      await tx
        .delete(objectAccessGrants)
        .where(
          and(
            eq(objectAccessGrants.organizationId, organizationId),
            eq(objectAccessGrants.objectType, "cost_report_folder"),
            inArray(objectAccessGrants.objectId, folderIds),
          ),
        );
      await tx
        .delete(costReportFolders)
        .where(
          and(
            eq(costReportFolders.organizationId, organizationId),
            inArray(costReportFolders.id, folderIds),
          ),
        );
    }
    for (const id of reportIds) {
      audit.push({
        action: "cost_report.delete",
        entityType: "cost_report",
        entityId: id,
        name: reportById.get(id)!.name,
      });
    }
    for (const id of folderIds) {
      audit.push({
        action: "cost_report_folder.delete",
        entityType: "cost_report_folder",
        entityId: id,
        name: folderById.get(id)!.name,
      });
    }
    return { action: "delete" as const, reports: reportIds.length, folders: folderIds.length };
  });

  const targetFolderId = request.action === "move" ? request.targetFolderId : undefined;
  await Promise.all(
    audit.map((a) =>
      logAudit({
        organizationId,
        userId: userId ?? undefined,
        action: a.action,
        entityType: a.entityType,
        entityId: a.entityId,
        metadata: {
          name: a.name,
          bulk: true,
          ...auditMetadata,
          ...(targetFolderId !== undefined ? { targetFolderId } : {}),
        },
      }),
    ),
  );
  return result;
}
