/**
 * Org-scoped cost-report-folder CRUD — shared by the HTTP routes
 * (api/routes/cost-report-folders.ts) and the report services/tools that need
 * to check a folder id, mirroring services/cost-reports.ts.
 *
 * Folders organize the Reports list and nothing else: a report's identity,
 * URL, dashboard cards and run-by-id behaviour are unchanged by where it is
 * filed. That is why a folder delete is safe enough to be a hard delete — both
 * foreign keys pointing at `cost_report_folders` are ON DELETE SET NULL, so
 * the folder's reports and subfolders fall back to the top level and nothing
 * the org authored is destroyed or blocked.
 *
 * The tree rules — nesting bounded at COST_REPORT_FOLDER_LIMITS.maxDepth, and
 * no reparenting a folder under itself or its own descendant (the only write
 * that could make `parent_folder_id` cyclic) — live in
 * `costReportFolderMoveBlocker` in client-core, so the move menu in the UI can
 * grey out exactly the targets these functions would reject with a 400.
 */
import { and, asc, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

import { costReportFolderMoveBlocker, type CostReportFolder } from "@infrawrench/client-core";

import { db } from "../db/client";
import { costReportFolders } from "../db/schema";

/** A folder write the API should refuse with a 400 and this message. */
export class CostReportFolderError extends Error {}

export interface CostReportFolderWriteInput {
  name: string;
  parentFolderId?: string | null | undefined;
}

type FolderRow = typeof costReportFolders.$inferSelect;

function toFolder(row: FolderRow): CostReportFolder {
  return {
    id: row.id,
    name: row.name,
    parentFolderId: row.parentFolderId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** List the org's folders, alphabetically. Clients build the tree themselves. */
export async function listCostReportFolders(organizationId: string): Promise<CostReportFolder[]> {
  const rows = await db
    .select()
    .from(costReportFolders)
    .where(eq(costReportFolders.organizationId, organizationId))
    .orderBy(asc(costReportFolders.name));
  return rows.map(toFolder);
}

/**
 * Throw {@link CostReportFolderError} unless `folderId` is one of the org's
 * folders — the check report create/update runs before filing a report, so a
 * cross-org or stale folder id is a clean 400 rather than an FK violation
 * surfacing as a 500.
 */
export async function assertCostReportFolderInOrg(
  organizationId: string,
  folderId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: costReportFolders.id })
    .from(costReportFolders)
    .where(
      and(eq(costReportFolders.id, folderId), eq(costReportFolders.organizationId, organizationId)),
    )
    .limit(1);
  if (!row) throw new CostReportFolderError("Unknown folder.");
}

export async function createCostReportFolder(
  organizationId: string,
  input: CostReportFolderWriteInput,
): Promise<CostReportFolder> {
  const parentFolderId = input.parentFolderId ?? null;
  const folders = await listCostReportFolders(organizationId);
  const blocked = costReportFolderMoveBlocker(folders, null, parentFolderId);
  if (blocked) throw new CostReportFolderError(blocked);

  const [created] = await db
    .insert(costReportFolders)
    .values({
      id: uuidv4(),
      organizationId,
      name: input.name.trim(),
      parentFolderId,
    })
    .returning();
  return toFolder(created!);
}

/**
 * Rename and/or reparent a folder. Null when not found; throws
 * {@link CostReportFolderError} when the move would nest past the depth limit
 * or place the folder inside its own subtree.
 */
export async function updateCostReportFolder(
  organizationId: string,
  folderId: string,
  input: CostReportFolderWriteInput,
): Promise<CostReportFolder | null> {
  const parentFolderId = input.parentFolderId ?? null;
  const folders = await listCostReportFolders(organizationId);
  if (!folders.some((f) => f.id === folderId)) return null;

  const blocked = costReportFolderMoveBlocker(folders, folderId, parentFolderId);
  if (blocked) throw new CostReportFolderError(blocked);

  const [updated] = await db
    .update(costReportFolders)
    .set({ name: input.name.trim(), parentFolderId, updatedAt: new Date() })
    .where(
      and(eq(costReportFolders.id, folderId), eq(costReportFolders.organizationId, organizationId)),
    )
    .returning();
  return updated ? toFolder(updated) : null;
}

/**
 * Delete a folder. False when not found.
 *
 * Contents are never deleted and never block the delete: the SET NULL foreign
 * keys drop the folder's reports and immediate subfolders to the top level.
 * "Refuse until empty" was the alternative and it loses on both counts — it
 * turns one delete into a bottom-up chore, and the failure ("folder not
 * empty") teaches people to move things out first, which is exactly the state
 * SET NULL produces in one step with nothing at risk.
 */
export async function deleteCostReportFolder(
  organizationId: string,
  folderId: string,
): Promise<boolean> {
  const [deleted] = await db
    .delete(costReportFolders)
    .where(
      and(eq(costReportFolders.id, folderId), eq(costReportFolders.organizationId, organizationId)),
    )
    .returning({ id: costReportFolders.id });
  return Boolean(deleted);
}
