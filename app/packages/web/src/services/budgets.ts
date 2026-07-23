/**
 * Org-scoped budget CRUD + status — shared by the HTTP routes
 * (api/routes/budgets.ts) and the tool registry (tools/costs.ts).
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import type { BudgetInput, CostFilter } from "@infrawrench/ui/cost/config";
import { budgetMonthStatus } from "@infrawrench/server-core/cost/budget-eval";
import { db } from "../db/client";
import { budgetAlertEvents, budgets } from "../db/schema";

type BudgetRow = typeof budgets.$inferSelect;

/** List budgets with current-month actual/forecast status and fired events. */
export async function listBudgetsWithStatus(organizationId: string) {
  const rows = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.organizationId, organizationId), isNull(budgets.deletedAt)))
    .orderBy(budgets.createdAt);

  return Promise.all(
    rows.map(async (b) => {
      const status = await budgetMonthStatus(
        organizationId,
        (b.filters ?? []) as CostFilter[],
        b.currency,
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
        filters: b.filters,
        thresholds: b.thresholds,
        month: status.month,
        actualCents: status.actualCents,
        forecastCents: status.forecastCents,
        currentMonthEvents: events.map((e) => ({
          id: e.id,
          thresholdType: e.thresholdType,
          thresholdPercent: e.thresholdPercent,
          triggeredAt: e.triggeredAt.toISOString(),
        })),
      };
    }),
  );
}

/** Fetch one budget with current-month status. Null when not found. */
export async function getBudgetWithStatus(organizationId: string, budgetId: string) {
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

  const status = await budgetMonthStatus(
    organizationId,
    (budget.filters ?? []) as CostFilter[],
    budget.currency,
  );
  return { ...budget, ...status };
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

/** Soft-delete a budget. False when not found. */
export async function softDeleteBudget(organizationId: string, budgetId: string): Promise<boolean> {
  const [deleted] = await db
    .update(budgets)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(budgets.id, budgetId),
        eq(budgets.organizationId, organizationId),
        isNull(budgets.deletedAt),
      ),
    )
    .returning({ id: budgets.id });
  return !!deleted;
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
