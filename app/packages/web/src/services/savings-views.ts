/**
 * Saved views over the savings findings list: a name, a status tab, a filter
 * and a sort, shared like cost reports and canvases (`savings_view` in
 * `object-sharing.ts`; the creator is the implicit owner, and there is no
 * folder chain). Shared by the HTTP routes and org config as code.
 *
 * Names are unique per org among live views, case-insensitively, the saved
 * cost filter rule: the CLI's `--view <name>` and config documents address
 * them by name.
 */
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import {
  isSavingsFindingStatusFilter,
  normalizeSavingsFindingFilter,
  normalizeSavingsFindingSort,
  type ObjectAccessLevel,
  type SavingsView,
  type SavingsViewInput,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { savingsViews } from "../db/schema";
import {
  deleteObjectSharing,
  filterVisibleObjects,
  ObjectNotVisibleError,
  requireObjectAccess,
} from "./object-sharing";

type SavingsViewRow = typeof savingsViews.$inferSelect;

/** A create/update whose name is already taken by a live view. 409. */
export class SavingsViewNameConflictError extends Error {
  override readonly name = "SavingsViewNameConflictError";

  constructor(name: string) {
    super(`A savings view named "${name}" already exists. View names must be unique.`);
  }
}

export function toSavingsView(row: SavingsViewRow): SavingsView {
  // Stored rows were normalized on write; normalizing again on read keeps a
  // hand-edited or older row from reaching a client in a shape it rejects.
  let filter: SavingsView["filter"] = {};
  try {
    filter = normalizeSavingsFindingFilter(row.filter);
  } catch {
    filter = {};
  }
  let sort: SavingsView["sort"];
  try {
    sort = normalizeSavingsFindingSort(row.sort);
  } catch {
    sort = { field: "savings", direction: "desc" };
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: isSavingsFindingStatusFilter(row.status) ? row.status : "open",
    filter,
    sort,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadRowUnchecked(
  organizationId: string,
  viewId: string,
): Promise<SavingsViewRow | null> {
  const [row] = await db
    .select()
    .from(savingsViews)
    .where(
      and(
        eq(savingsViews.id, viewId),
        eq(savingsViews.organizationId, organizationId),
        isNull(savingsViews.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The row when the current sharing principal holds `needed`; null reads as "no such view". */
async function loadRow(
  organizationId: string,
  viewId: string,
  needed: ObjectAccessLevel | "delete" = "viewer",
): Promise<SavingsViewRow | null> {
  const row = await loadRowUnchecked(organizationId, viewId);
  if (!row) return null;
  try {
    await requireObjectAccess(
      organizationId,
      "savings_view",
      row.id,
      { createdByUserId: row.createdByUserId },
      needed,
    );
  } catch (e) {
    if (e instanceof ObjectNotVisibleError) return null;
    throw e;
  }
  return row;
}

async function nameTaken(organizationId: string, name: string, excludeId?: string) {
  const rows = await db
    .select({ id: savingsViews.id })
    .from(savingsViews)
    .where(
      and(
        eq(savingsViews.organizationId, organizationId),
        isNull(savingsViews.deletedAt),
        sql`lower(${savingsViews.name}) = lower(${name})`,
        ...(excludeId ? [ne(savingsViews.id, excludeId)] : []),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** The views the caller can see, alphabetically. */
export async function listSavingsViews(organizationId: string): Promise<SavingsView[]> {
  const rows = await db
    .select()
    .from(savingsViews)
    .where(and(eq(savingsViews.organizationId, organizationId), isNull(savingsViews.deletedAt)))
    .orderBy(asc(savingsViews.name));
  const visible = await filterVisibleObjects(
    organizationId,
    "savings_view",
    rows,
    (r) => r.id,
    (r) => ({ createdByUserId: r.createdByUserId }),
  );
  return visible.map(toSavingsView);
}

export async function getSavingsView(
  organizationId: string,
  viewId: string,
): Promise<SavingsView | null> {
  const row = await loadRow(organizationId, viewId);
  return row ? toSavingsView(row) : null;
}

/** A visible view by exact id, or by name case-insensitively (the CLI's `--view`). */
export async function findSavingsView(
  organizationId: string,
  idOrName: string,
): Promise<SavingsView | null> {
  const views = await listSavingsViews(organizationId);
  return (
    views.find((v) => v.id === idOrName) ??
    views.find((v) => v.name.toLowerCase() === idOrName.toLowerCase()) ??
    null
  );
}

export async function createSavingsView(
  organizationId: string,
  input: SavingsViewInput,
  createdByUserId: string | null,
): Promise<SavingsView> {
  if (await nameTaken(organizationId, input.name)) {
    throw new SavingsViewNameConflictError(input.name);
  }
  const [created] = await db
    .insert(savingsViews)
    .values({
      id: uuidv4(),
      organizationId,
      name: input.name,
      description: input.description ?? null,
      status: input.status,
      filter: input.filter,
      sort: input.sort,
      createdByUserId,
    })
    .returning();
  return toSavingsView(created!);
}

/** Full replace. Null when not found or not editable by the caller. */
export async function updateSavingsView(
  organizationId: string,
  viewId: string,
  input: SavingsViewInput,
): Promise<SavingsView | null> {
  if (!(await loadRow(organizationId, viewId, "editor"))) return null;
  if (await nameTaken(organizationId, input.name, viewId)) {
    throw new SavingsViewNameConflictError(input.name);
  }
  const [updated] = await db
    .update(savingsViews)
    .set({
      name: input.name,
      description: input.description ?? null,
      status: input.status,
      filter: input.filter,
      sort: input.sort,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(savingsViews.id, viewId),
        eq(savingsViews.organizationId, organizationId),
        isNull(savingsViews.deletedAt),
      ),
    )
    .returning();
  return updated ? toSavingsView(updated) : null;
}

/** Soft delete, and drop the view's sharing. False when not found or not deletable. */
export async function deleteSavingsView(organizationId: string, viewId: string): Promise<boolean> {
  if (!(await loadRow(organizationId, viewId, "delete"))) return false;
  const now = new Date();
  const [deleted] = await db
    .update(savingsViews)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(savingsViews.id, viewId),
        eq(savingsViews.organizationId, organizationId),
        isNull(savingsViews.deletedAt),
      ),
    )
    .returning({ id: savingsViews.id });
  if (!deleted) return false;
  await deleteObjectSharing(organizationId, "savings_view", viewId);
  return true;
}
