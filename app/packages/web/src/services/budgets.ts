/**
 * Org-scoped budget CRUD + status — shared by the HTTP routes
 * (api/routes/budgets.ts) and the tool registry (tools/costs.ts).
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import type { BudgetPlacement, BudgetWithStatus } from "@infrawrench/ui/cost";
import type { BudgetInput, CostBasis, CostFilter } from "@infrawrench/ui/cost/config";
import { budgetMonthStatus } from "@infrawrench/server-core/cost/budget-eval";
import { db } from "../db/client";
import { budgetAlertEvents, budgets, dashboardWidgets, dashboards } from "../db/schema";

type BudgetRow = typeof budgets.$inferSelect;

/**
 * Which dashboards carry a card for each of `budgetIds`, keyed by budget id.
 *
 * Budget widgets store their target as `config.budgetId`, so this reads the
 * JSONB key rather than a foreign key — there is no referential integrity
 * between a budget and the cards pointing at it, which is exactly why a budget
 * can outlive every one of its cards.
 */
async function loadBudgetPlacements(
  organizationId: string,
  budgetIds: string[],
): Promise<Map<string, BudgetPlacement[]>> {
  const byBudget = new Map<string, BudgetPlacement[]>();
  if (budgetIds.length === 0) return byBudget;

  const rows = await db
    .select({
      widgetId: dashboardWidgets.id,
      dashboardId: dashboardWidgets.dashboardId,
      dashboardName: dashboards.name,
      budgetId: sql<string>`${dashboardWidgets.config} ->> 'budgetId'`,
    })
    .from(dashboardWidgets)
    .innerJoin(dashboards, eq(dashboards.id, dashboardWidgets.dashboardId))
    .where(
      and(
        eq(dashboardWidgets.organizationId, organizationId),
        eq(dashboardWidgets.kind, "budget"),
        isNull(dashboardWidgets.deletedAt),
        isNull(dashboards.deletedAt),
        inArray(sql`${dashboardWidgets.config} ->> 'budgetId'`, budgetIds),
      ),
    )
    .orderBy(dashboards.name);

  for (const row of rows) {
    const list = byBudget.get(row.budgetId) ?? [];
    list.push({
      widgetId: row.widgetId,
      dashboardId: row.dashboardId,
      dashboardName: row.dashboardName,
    });
    byBudget.set(row.budgetId, list);
  }
  return byBudget;
}

/** Assemble the wire row for one budget, given its already-loaded status. */
async function toBudgetWithStatus(
  organizationId: string,
  b: BudgetRow,
  placements: BudgetPlacement[],
): Promise<BudgetWithStatus> {
  const costBasis = (b.costBasis ?? "cash") as CostBasis;
  const status = await budgetMonthStatus(
    organizationId,
    (b.filters ?? []) as CostFilter[],
    b.currency,
    undefined,
    costBasis,
  );
  const events = await db
    .select()
    .from(budgetAlertEvents)
    .where(and(eq(budgetAlertEvents.budgetId, b.id), eq(budgetAlertEvents.month, status.month)))
    .orderBy(desc(budgetAlertEvents.triggeredAt));

  return {
    id: b.id,
    name: b.name,
    amountCents: b.amountCents,
    currency: b.currency,
    filters: (b.filters ?? []) as CostFilter[],
    thresholds: b.thresholds as BudgetWithStatus["thresholds"],
    costBasis,
    month: status.month,
    actualCents: status.actualCents,
    forecastCents: status.forecastCents,
    currentMonthEvents: events.map((e) => ({
      id: e.id,
      thresholdType: e.thresholdType,
      thresholdPercent: e.thresholdPercent,
      triggeredAt: e.triggeredAt.toISOString(),
    })),
    placements,
  };
}

/** List budgets with current-month actual/forecast status and fired events. */
export async function listBudgetsWithStatus(organizationId: string): Promise<BudgetWithStatus[]> {
  const rows = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.organizationId, organizationId), isNull(budgets.deletedAt)))
    .orderBy(budgets.createdAt);

  const placements = await loadBudgetPlacements(
    organizationId,
    rows.map((b) => b.id),
  );
  return Promise.all(
    rows.map((b) => toBudgetWithStatus(organizationId, b, placements.get(b.id) ?? [])),
  );
}

/**
 * Fetch one budget with current-month status. Null when not found.
 *
 * Returns the same {@link BudgetWithStatus} shape as the list endpoint. It used
 * to spread the raw Drizzle row, which both leaked internal columns
 * (organizationId, createdByUserId, timestamps) past the route's own strict
 * OpenAPI schema and omitted `currentMonthEvents`, so a client could not tell
 * from this endpoint whether a threshold had fired.
 */
export async function getBudgetWithStatus(
  organizationId: string,
  budgetId: string,
): Promise<BudgetWithStatus | null> {
  const [budget] = await db
    .select()
    .from(budgets)
    .where(
      and(
        eq(budgets.id, budgetId),
        eq(budgets.organizationId, organizationId),
        isNull(budgets.deletedAt),
      ),
    )
    .limit(1);
  if (!budget) return null;

  const placements = await loadBudgetPlacements(organizationId, [budget.id]);
  return toBudgetWithStatus(organizationId, budget, placements.get(budget.id) ?? []);
}

export async function createBudget(
  organizationId: string,
  input: BudgetInput,
  createdByUserId: string | null,
): Promise<BudgetRow> {
  const [created] = await db
    .insert(budgets)
    .values({
      id: uuidv4(),
      organizationId,
      name: input.name,
      amountCents: input.amountCents,
      currency: input.currency,
      filters: input.filters,
      thresholds: input.thresholds,
      // Absent means cash — the column's own default, restated here so the
      // insert doesn't depend on which of the two defaults applies.
      costBasis: input.costBasis ?? "cash",
      createdByUserId,
    })
    .returning();
  return created!;
}

/** Update a budget. Null when not found. */
export async function updateBudget(
  organizationId: string,
  budgetId: string,
  input: BudgetInput,
): Promise<BudgetRow | null> {
  const [updated] = await db
    .update(budgets)
    .set({
      name: input.name,
      amountCents: input.amountCents,
      currency: input.currency,
      filters: input.filters,
      thresholds: input.thresholds,
      costBasis: input.costBasis ?? "cash",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(budgets.id, budgetId),
        eq(budgets.organizationId, organizationId),
        isNull(budgets.deletedAt),
      ),
    )
    .returning();
  return updated ?? null;
}

/**
 * Soft-delete a budget and every dashboard card pointing at it. False when not
 * found.
 *
 * The cards go with it because nothing else would ever remove them: a budget
 * widget resolves its row by `config.budgetId`, so a card left behind renders
 * as a permanent "budget unavailable" tile that no amount of dashboard editing
 * explains. Removing a *card* still leaves the budget alone — that direction is
 * the whole point of the Costs panel.
 */
export async function softDeleteBudget(organizationId: string, budgetId: string): Promise<boolean> {
  const now = new Date();
  const [deleted] = await db
    .update(budgets)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(budgets.id, budgetId),
        eq(budgets.organizationId, organizationId),
        isNull(budgets.deletedAt),
      ),
    )
    .returning({ id: budgets.id });
  if (!deleted) return false;

  await db
    .update(dashboardWidgets)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(dashboardWidgets.organizationId, organizationId),
        eq(dashboardWidgets.kind, "budget"),
        isNull(dashboardWidgets.deletedAt),
        eq(sql`${dashboardWidgets.config} ->> 'budgetId'`, budgetId),
      ),
    );
  return true;
}

/** Alert history for a budget (last 100 events). Null when budget not found. */
export async function listBudgetEvents(organizationId: string, budgetId: string) {
  const [budget] = await db
    .select({ id: budgets.id })
    .from(budgets)
    .where(and(eq(budgets.id, budgetId), eq(budgets.organizationId, organizationId)))
    .limit(1);
  if (!budget) return null;

  const events = await db
    .select()
    .from(budgetAlertEvents)
    .where(eq(budgetAlertEvents.budgetId, budget.id))
    .orderBy(desc(budgetAlertEvents.triggeredAt))
    .limit(100);
  return events.map((e) => ({
    id: e.id,
    month: e.month,
    thresholdType: e.thresholdType,
    thresholdPercent: e.thresholdPercent,
    actualAmountCents: e.actualAmountCents,
    forecastAmountCents: e.forecastAmountCents,
    triggeredAt: e.triggeredAt.toISOString(),
  }));
}
