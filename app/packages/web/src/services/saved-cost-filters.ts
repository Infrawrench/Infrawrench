/**
 * Org-scoped saved-cost-filter CRUD and referent scanning — shared by the HTTP
 * routes (api/routes/saved-filters.ts) and the tool registry, mirroring
 * services/cost-reports.ts.
 *
 * A saved filter is a named `CostFilter[]` that graphs, reports and budgets
 * reference **by id**; the reference is resolved at query time
 * (`@infrawrench/server-core/cost/saved-filters`), which is what makes editing
 * it here change every referent at once.
 *
 * The one policy decision worth stating: **deletion is refused while anything
 * references the filter.** The alternative — inline the rows into each
 * referent and detach — silently rewrites configs the deleter may never have
 * looked at, and turns "one object, referenced" back into the copies this
 * feature exists to remove. Worse, either alternative that *doesn't* rewrite
 * would leave dangling references, and a dangling reference resolving to "no
 * filter" would widen a budget's scope to all spend — an alert-firing change
 * nobody asked for. So the delete comes back as a 409 listing the referents,
 * and the user detaches them deliberately.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

import { formatCostQuery, type CostFilter } from "@infrawrench/ui/cost/config";
import {
  resolveSavedCostFilterInput,
  type SavedCostFilter,
  type SavedCostFilterInput,
  type SavedCostFilterReferent,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { budgets, costReports, dashboardWidgets, dashboards, savedCostFilters } from "../db/schema";

type SavedCostFilterRow = typeof savedCostFilters.$inferSelect;

/** Refused delete: the filter is still referenced. Routes map this to a 409. */
export class SavedCostFilterInUseError extends Error {
  override readonly name = "SavedCostFilterInUseError";
  readonly referents: SavedCostFilterReferent[];

  constructor(referents: SavedCostFilterReferent[]) {
    super(
      "This saved filter is still referenced. Deleting it would silently widen " +
        "every referent's scope to all spend, so detach it from them first.",
    );
    this.referents = referents;
  }
}

/** A create/update whose name is already taken by a live filter. 409. */
export class SavedCostFilterNameConflictError extends Error {
  override readonly name = "SavedCostFilterNameConflictError";

  constructor(name: string) {
    super(
      `A saved filter named "${name}" already exists. Names are how the CLI and ` +
        "humans address these, so they must be unambiguous per organization.",
    );
  }
}

/** Assemble the wire row, deriving the canonical query-language text. */
function toSavedCostFilter(row: SavedCostFilterRow): SavedCostFilter {
  const filters = (row.filters ?? []) as CostFilter[];
  let query = "";
  try {
    query = formatCostQuery(filters);
  } catch {
    // Input validation refuses the one unrenderable shape (a tag term with no
    // key), so this only happens for a corrupt row. An empty string keeps the
    // list readable — the structured filters are still returned in full.
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    filters,
    query,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** List the org's saved filters, alphabetically. */
export async function listSavedCostFilters(organizationId: string): Promise<SavedCostFilter[]> {
  const rows = await db
    .select()
    .from(savedCostFilters)
    .where(
      and(eq(savedCostFilters.organizationId, organizationId), isNull(savedCostFilters.deletedAt)),
    )
    .orderBy(asc(savedCostFilters.name));
  return rows.map(toSavedCostFilter);
}

/** Fetch one saved filter. Null when not found (or soft-deleted). */
export async function getSavedCostFilter(
  organizationId: string,
  savedFilterId: string,
): Promise<SavedCostFilter | null> {
  const [row] = await db
    .select()
    .from(savedCostFilters)
    .where(
      and(
        eq(savedCostFilters.id, savedFilterId),
        eq(savedCostFilters.organizationId, organizationId),
        isNull(savedCostFilters.deletedAt),
      ),
    )
    .limit(1);
  return row ? toSavedCostFilter(row) : null;
}

/**
 * Whether a live filter other than `excludeId` already uses `name`
 * (case-insensitively — "Prod" and "prod" addressing different filters from
 * the CLI would be a trap). The partial unique index backs this up for exact
 * matches; the check exists to answer with a message instead of a constraint
 * violation.
 */
async function nameTaken(
  organizationId: string,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: savedCostFilters.id })
    .from(savedCostFilters)
    .where(
      and(
        eq(savedCostFilters.organizationId, organizationId),
        isNull(savedCostFilters.deletedAt),
        sql`lower(${savedCostFilters.name}) = lower(${name})`,
      ),
    );
  return rows.some((r) => r.id !== excludeId);
}

export async function createSavedCostFilter(
  organizationId: string,
  input: SavedCostFilterInput,
  createdByUserId: string | null,
): Promise<SavedCostFilter> {
  // Throws with a presentable message for an empty filter, both spellings at
  // once, unparseable query text, or a tag term with no key.
  const filters = resolveSavedCostFilterInput(input);
  const name = input.name.trim();
  if (await nameTaken(organizationId, name)) throw new SavedCostFilterNameConflictError(name);

  const [created] = await db
    .insert(savedCostFilters)
    .values({
      id: uuidv4(),
      organizationId,
      name,
      description: input.description?.trim() || null,
      filters,
      createdByUserId,
    })
    .returning();
  return toSavedCostFilter(created!);
}

/**
 * Replace a saved filter's name, description and filters. Null when not found.
 *
 * A full replace rather than a patch, matching budgets and reports. This is
 * the high-leverage write of the feature: every graph, report and budget
 * referencing the filter runs the new rows on its next query.
 */
export async function updateSavedCostFilter(
  organizationId: string,
  savedFilterId: string,
  input: SavedCostFilterInput,
): Promise<SavedCostFilter | null> {
  const filters = resolveSavedCostFilterInput(input);
  const name = input.name.trim();
  if (await nameTaken(organizationId, name, savedFilterId)) {
    throw new SavedCostFilterNameConflictError(name);
  }

  const [updated] = await db
    .update(savedCostFilters)
    .set({
      name,
      description: input.description?.trim() || null,
      filters,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(savedCostFilters.id, savedFilterId),
        eq(savedCostFilters.organizationId, organizationId),
        isNull(savedCostFilters.deletedAt),
      ),
    )
    .returning();
  return updated ? toSavedCostFilter(updated) : null;
}

/**
 * Everything still referencing a saved filter, in a stable order (budgets,
 * then reports, then dashboard graphs).
 *
 * Budgets carry the reference as a real column; reports and ad-hoc graph
 * widgets carry it inside their `CostGraphConfig` jsonb, so those are found by
 * scanning `config->>'savedFilterId'` — the same way budget and report
 * placements are found. There is deliberately no foreign key behind any of
 * these (see the schema comment), so this scan *is* the referential integrity.
 */
export async function listSavedCostFilterReferents(
  organizationId: string,
  savedFilterId: string,
): Promise<SavedCostFilterReferent[]> {
  const referents: SavedCostFilterReferent[] = [];

  const budgetRows = await db
    .select({ id: budgets.id, name: budgets.name })
    .from(budgets)
    .where(
      and(
        eq(budgets.organizationId, organizationId),
        isNull(budgets.deletedAt),
        eq(budgets.savedFilterId, savedFilterId),
      ),
    )
    .orderBy(asc(budgets.name));
  for (const row of budgetRows) referents.push({ kind: "budget", id: row.id, name: row.name });

  const reportRows = await db
    .select({ id: costReports.id, name: costReports.name })
    .from(costReports)
    .where(
      and(
        eq(costReports.organizationId, organizationId),
        isNull(costReports.deletedAt),
        eq(sql`${costReports.config} ->> 'savedFilterId'`, savedFilterId),
      ),
    )
    .orderBy(asc(costReports.name));
  for (const row of reportRows) referents.push({ kind: "cost_report", id: row.id, name: row.name });

  const widgetRows = await db
    .select({
      id: dashboardWidgets.id,
      title: dashboardWidgets.title,
      dashboardId: dashboardWidgets.dashboardId,
      dashboardName: dashboards.name,
    })
    .from(dashboardWidgets)
    .innerJoin(dashboards, eq(dashboards.id, dashboardWidgets.dashboardId))
    .where(
      and(
        eq(dashboardWidgets.organizationId, organizationId),
        eq(dashboardWidgets.kind, "cost_graph"),
        isNull(dashboardWidgets.deletedAt),
        isNull(dashboards.deletedAt),
        eq(sql`${dashboardWidgets.config} ->> 'savedFilterId'`, savedFilterId),
      ),
    )
    .orderBy(asc(dashboards.name));
  for (const row of widgetRows) {
    referents.push({
      kind: "cost_graph_widget",
      id: row.id,
      name: row.title,
      dashboardId: row.dashboardId,
      dashboardName: row.dashboardName,
    });
  }

  return referents;
}

/**
 * Soft-delete a saved filter. False when not found.
 *
 * @throws {SavedCostFilterInUseError} while any budget, report or dashboard
 * graph references it — see the module comment for why refusal, not detach.
 */
export async function softDeleteSavedCostFilter(
  organizationId: string,
  savedFilterId: string,
): Promise<boolean> {
  const referents = await listSavedCostFilterReferents(organizationId, savedFilterId);
  if (referents.length > 0) throw new SavedCostFilterInUseError(referents);

  const now = new Date();
  const [deleted] = await db
    .update(savedCostFilters)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(savedCostFilters.id, savedFilterId),
        eq(savedCostFilters.organizationId, organizationId),
        isNull(savedCostFilters.deletedAt),
      ),
    )
    .returning({ id: savedCostFilters.id });
  return !!deleted;
}
