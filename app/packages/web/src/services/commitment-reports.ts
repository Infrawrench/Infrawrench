/**
 * Org-scoped commitment-report CRUD and execution, shared by the HTTP routes
 * (`api/routes/commitments.ts`). Mirrors `services/cost-reports.ts`: the same
 * folder tree, the same sharing model (creator is the implicit owner, folder
 * grants inherit), the same soft delete. The arithmetic lives in client-core
 * and the scan in server-core; this file is storage and access only.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import type {
  CommitmentReport,
  CommitmentReportConfig,
  CommitmentReportInput,
  CommitmentReportRunResult,
  ObjectAccessLevel,
} from "@infrawrench/client-core";
import { runCommitmentReportConfig } from "@infrawrench/server-core/commitments/report";

import { db } from "../db/client";
import { commitmentReports } from "../db/schema";
import { assertCanFileIntoCostReportFolder } from "./cost-report-folders";
import {
  deleteObjectSharing,
  filterVisibleObjects,
  ObjectNotVisibleError,
  requireObjectAccess,
} from "./object-sharing";

type Row = typeof commitmentReports.$inferSelect;

function toReport(row: Row): CommitmentReport {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    config: row.config as CommitmentReportConfig,
    folderId: row.folderId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadRowUnchecked(organizationId: string, reportId: string): Promise<Row | null> {
  const [row] = await db
    .select()
    .from(commitmentReports)
    .where(
      and(
        eq(commitmentReports.id, reportId),
        eq(commitmentReports.organizationId, organizationId),
        isNull(commitmentReports.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The row, if the caller holds `needed` on it; null when missing or below viewer. */
async function loadRow(
  organizationId: string,
  reportId: string,
  needed: ObjectAccessLevel | "delete" = "viewer",
): Promise<Row | null> {
  const row = await loadRowUnchecked(organizationId, reportId);
  if (!row) return null;
  try {
    await requireObjectAccess(
      organizationId,
      "commitment_report",
      row.id,
      { createdByUserId: row.createdByUserId, folderId: row.folderId },
      needed,
    );
  } catch (e) {
    // Below viewer reads as "no such report", exactly like a deleted one.
    if (e instanceof ObjectNotVisibleError) return null;
    throw e;
  }
  return row;
}

/** The org's commitment reports the caller may open, alphabetically. */
export async function listCommitmentReports(organizationId: string): Promise<CommitmentReport[]> {
  const rows = await db
    .select()
    .from(commitmentReports)
    .where(
      and(
        eq(commitmentReports.organizationId, organizationId),
        isNull(commitmentReports.deletedAt),
      ),
    )
    .orderBy(asc(commitmentReports.name));
  const visible = await filterVisibleObjects(
    organizationId,
    "commitment_report",
    rows,
    (r) => r.id,
    (r) => ({ createdByUserId: r.createdByUserId, folderId: r.folderId }),
  );
  return visible.map(toReport);
}

export async function getCommitmentReport(
  organizationId: string,
  reportId: string,
): Promise<CommitmentReport | null> {
  const row = await loadRow(organizationId, reportId);
  return row ? toReport(row) : null;
}

export async function createCommitmentReport(
  organizationId: string,
  input: CommitmentReportInput,
  createdByUserId: string | null,
): Promise<CommitmentReport> {
  // A stale or cross-org folder is a CostReportFolderError (400); a folder the
  // caller only views is a 403, as for cost reports.
  if (input.folderId) await assertCanFileIntoCostReportFolder(organizationId, input.folderId);
  const [created] = await db
    .insert(commitmentReports)
    .values({
      id: uuidv4(),
      organizationId,
      name: input.name,
      description: input.description ?? null,
      config: input.config,
      folderId: input.folderId ?? null,
      createdByUserId,
    })
    .returning();
  return toReport(created!);
}

/**
 * Replace a report's name, description, config and folder; null when not
 * found. A full replace, like cost reports: the editor always holds the
 * whole object.
 */
export async function updateCommitmentReport(
  organizationId: string,
  reportId: string,
  input: CommitmentReportInput,
): Promise<CommitmentReport | null> {
  const current = await loadRow(organizationId, reportId, "editor");
  if (!current) return null;
  // Only a move is checked: re-saving in place must not fail for an editor of
  // the report who merely views its folder.
  if (input.folderId && input.folderId !== current.folderId) {
    await assertCanFileIntoCostReportFolder(organizationId, input.folderId);
  }
  const [updated] = await db
    .update(commitmentReports)
    .set({
      name: input.name,
      description: input.description ?? null,
      config: input.config,
      folderId: input.folderId ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(commitmentReports.id, reportId),
        eq(commitmentReports.organizationId, organizationId),
        isNull(commitmentReports.deletedAt),
      ),
    )
    .returning();
  return updated ? toReport(updated) : null;
}

/** Soft-delete a report and drop its sharing rows. False when not found. */
export async function softDeleteCommitmentReport(
  organizationId: string,
  reportId: string,
): Promise<boolean> {
  if (!(await loadRow(organizationId, reportId, "delete"))) return false;
  const now = new Date();
  const [deleted] = await db
    .update(commitmentReports)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(commitmentReports.id, reportId),
        eq(commitmentReports.organizationId, organizationId),
        isNull(commitmentReports.deletedAt),
      ),
    )
    .returning({ id: commitmentReports.id });
  if (!deleted) return false;
  await deleteObjectSharing(organizationId, "commitment_report", reportId);
  return true;
}

/** Run a saved report by id; null when not found or not visible. */
export async function runCommitmentReport(
  organizationId: string,
  reportId: string,
  today = new Date(),
): Promise<CommitmentReportRunResult | null> {
  const row = await loadRow(organizationId, reportId);
  if (!row) return null;
  const result = await runCommitmentReportConfig(
    organizationId,
    row.config as CommitmentReportConfig,
    today,
  );
  return { ...result, reportId: row.id, name: row.name };
}
