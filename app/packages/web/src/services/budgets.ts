/**
 * Org-scoped budget CRUD + status: shared by the HTTP routes
 * (api/routes/budgets.ts) and the tool registry (tools/costs.ts).
 */
import { visibilityOwnerCondition, visibilityUserIdForCreate } from "./cost-visibility-filter";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import type { BudgetPlacement, BudgetWithStatus } from "@infrawrench/ui/cost";
import {
  BUDGET_LIMITS,
  budgetDepth,
  budgetDescendantIds,
  budgetInputError,
  budgetSubtreeHeight,
  type BudgetInput,
  type BudgetPeriod,
  type CostBasis,
  type CostFilter,
} from "@infrawrench/ui/cost/config";
import {
  BudgetStatusResolver,
  type BudgetPeriodStatus,
} from "@infrawrench/server-core/cost/budget-eval";
import { resolveCostScenarioModel } from "@infrawrench/server-core/cost/scenario-forecast";
import { resolveSavedCostFilters } from "@infrawrench/server-core/cost/saved-filters";
import { db } from "../db/client";
import { budgetAlertEvents, budgets, dashboardWidgets, dashboards } from "../db/schema";
import {
  listBudgetAlertEventsWithNotes,
  loadAuthorNames,
  toBudgetAlertNote,
} from "./budget-alert-notes";

type BudgetRow = typeof budgets.$inferSelect;

/**
 * A budget that is well-formed but cannot be saved as asked: an invalid
 * combination of fields, or a parent that would break the hierarchy. The
 * route and the MCP tools turn it into a 400 with this message.
 */
export class BudgetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetValidationError";
  }
}

/** Every live budget in the org: the hierarchy is only checkable whole. */
async function loadOrgBudgets(organizationId: string): Promise<BudgetRow[]> {
  return db
    .select()
    .from(budgets)
    .where(and(eq(budgets.organizationId, organizationId), isNull(budgets.deletedAt)))
    .orderBy(budgets.createdAt);
}

/**
 * The live budgets the caller may see (`visibilityOwnerCondition`): all of them
 * when unrestricted, only their own when cost-scoped. What a listing shows and
 * what a parent rolls up, so a scoped member's parent never sums a budget they
 * cannot read; `budget-eval` applies the same rule per owner.
 */
async function loadVisibleBudgets(organizationId: string): Promise<BudgetRow[]> {
  return db
    .select()
    .from(budgets)
    .where(
      and(
        eq(budgets.organizationId, organizationId),
        visibilityOwnerCondition(budgets.visibilityUserId, organizationId),
        isNull(budgets.deletedAt),
      ),
    )
    .orderBy(budgets.createdAt);
}

function measureOf(b: { measure?: string | null | undefined }): "cost" | "usage" {
  return b.measure === "usage" ? "usage" : "cost";
}

/** "USD", or "tokens (usage)": what a budget's figures are counted in. */
function unitLabel(b: {
  measure?: string | null | undefined;
  currency: string;
  usageUnit?: string | null | undefined;
}): string {
  return measureOf(b) === "usage" ? `${b.usageUnit ?? ""} (usage)` : b.currency;
}

function sameUnit(
  a: {
    measure?: string | null | undefined;
    currency: string;
    usageUnit?: string | null | undefined;
  },
  b: {
    measure?: string | null | undefined;
    currency: string;
    usageUnit?: string | null | undefined;
  },
): boolean {
  if (measureOf(a) !== measureOf(b)) return false;
  return measureOf(a) === "usage" ? a.usageUnit === b.usageUnit : a.currency === b.currency;
}

/**
 * Refuse a write that the rollup could not honour. A parent sums its
 * children, so they must count the same thing (one currency, or one usage
 * unit); the tree must stay a tree; and it must stay shallow enough to read.
 * Runs on create (budgetId null) and on update, where a budget that already
 * has children may not change what it counts out from under them.
 */
async function validateBudgetWrite(
  organizationId: string,
  input: BudgetInput,
  budgetId: string | null,
): Promise<void> {
  const shapeError = budgetInputError(input);
  if (shapeError) throw new BudgetValidationError(shapeError);

  const parentId = input.parentBudgetId;
  const touchesHierarchy = parentId !== undefined || budgetId !== null;
  if (!touchesHierarchy) return;
  const all = await loadOrgBudgets(organizationId);
  const self = { measure: input.measure, currency: input.currency, usageUnit: input.usageUnit };

  if (budgetId) {
    const mismatched = all.filter((b) => b.parentBudgetId === budgetId && !sameUnit(b, self));
    if (mismatched.length > 0) {
      throw new BudgetValidationError(
        `This budget has child budgets counted in ${unitLabel(mismatched[0]!)}; a parent must count the same thing as its children.`,
      );
    }
  }

  if (!parentId) return;
  if (parentId === budgetId) throw new BudgetValidationError("A budget cannot be its own parent.");
  // The parent must be one the caller can see; a hidden one reads as absent.
  // The structural checks below still run over the whole tree, which is what
  // has to stay consistent.
  const visibleIds = new Set((await loadVisibleBudgets(organizationId)).map((b) => b.id));
  const parent = visibleIds.has(parentId) ? all.find((b) => b.id === parentId) : undefined;
  if (!parent) throw new BudgetValidationError("Parent budget not found.");
  if (budgetId && budgetDescendantIds(all, budgetId).has(parentId)) {
    throw new BudgetValidationError("A budget cannot roll up into one of its own children.");
  }
  if (!sameUnit(parent, self)) {
    throw new BudgetValidationError(
      `The parent budget counts ${unitLabel(parent)}; a child must count the same thing.`,
    );
  }
  const depth = budgetDepth(all, parentId) + (budgetId ? budgetSubtreeHeight(all, budgetId) : 1);
  if (depth > BUDGET_LIMITS.maxDepth) {
    throw new BudgetValidationError(
      `Budget hierarchies are limited to ${BUDGET_LIMITS.maxDepth} levels.`,
    );
  }
}

/** The new columns of a budget write, shared by create and update. */
function shapeColumns(input: BudgetInput) {
  const usage = input.measure === "usage";
  return {
    measure: usage ? ("usage" as const) : ("cost" as const),
    // Absent clears, like every other field of a full-replace PUT: a budget
    // switched back to spend must not keep a stale unit around.
    usageUnit: usage ? (input.usageUnit ?? null) : null,
    usageAmount: usage ? (input.usageAmount ?? null) : null,
    period: (input.period ?? null) as BudgetPeriod | null,
    parentBudgetId: input.parentBudgetId ?? null,
  };
}

/**
 * Which dashboards carry a card for each of `budgetIds`, keyed by budget id.
 *
 * Budget widgets store their target as `config.budgetId`, so this reads the
 * JSONB key rather than a foreign key: there is no referential integrity
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
  resolver: BudgetStatusResolver,
  b: BudgetRow,
  placements: BudgetPlacement[],
): Promise<BudgetWithStatus> {
  const costBasis = (b.costBasis ?? "cash") as CostBasis;
  // A saved-filter reference that fails to resolve throws out of here rather
  // than evaluating the budget over all spend: the error is the honest answer.
  const status: BudgetPeriodStatus = await resolver.status(b.id);
  // Events of the period being shown; none when no period covers today.
  const events = status.periodKey
    ? await db
        .select()
        .from(budgetAlertEvents)
        .where(
          and(eq(budgetAlertEvents.budgetId, b.id), eq(budgetAlertEvents.month, status.periodKey)),
        )
        .orderBy(desc(budgetAlertEvents.triggeredAt))
    : [];
  const authors = await loadAuthorNames(events.map((e) => e.notedByUserId));

  return {
    id: b.id,
    name: b.name,
    amountCents: b.amountCents,
    currency: b.currency,
    filters: (b.filters ?? []) as CostFilter[],
    thresholds: b.thresholds as BudgetWithStatus["thresholds"],
    costBasis,
    savedFilterId: b.savedFilterId,
    // Both numbers, always: `forecastCents` is the bare trend even for a budget
    // that opted into a scenario, so a card can show what the model moved.
    scenarioModelId: b.scenarioModelId,
    scenarioModelName: status.scenarioModelName,
    // Both numbers again, for the same reason: `rawActualCents` is the
    // collected figure and is non-null only for a budget measuring adjusted
    // spend, so a card can never render an adjusted amount without it.
    useAdjustedSpend: b.useAdjustedSpend,
    rawActualCents: status.rawActualCents,
    month: status.month,
    actualCents: status.actualCents,
    forecastCents: status.forecastCents,
    scenarioForecastCents: status.scenarioForecastCents,
    currentMonthEvents: events.map((e) => ({
      id: e.id,
      thresholdType: e.thresholdType,
      thresholdPercent: e.thresholdPercent,
      triggeredAt: e.triggeredAt.toISOString(),
      // The note shows on the card itself: the alert badge answers "did it
      // fire", the note answers "and do we know why".
      note: toBudgetAlertNote(e, e.notedByUserId ? (authors.get(e.notedByUserId) ?? null) : null),
    })),
    placements,
    measure: status.measure,
    usageUnit: b.usageUnit,
    usageAmount: b.usageAmount,
    period: (b.period ?? null) as BudgetPeriod | null,
    parentBudgetId: b.parentBudgetId,
    periodStart: status.periodStart,
    periodEnd: status.periodEnd,
    periodLimit: status.limit,
    actualUsage: status.actualUsage,
    forecastUsage: status.forecastUsage,
    rolledUp: status.rolledUp,
    childCount: status.childCount,
    hierarchyWarnings: status.hierarchyWarnings,
  };
}

/** List budgets with current-month actual/forecast status and fired events. */
export async function listBudgetsWithStatus(organizationId: string): Promise<BudgetWithStatus[]> {
  const rows = await loadVisibleBudgets(organizationId);

  const placements = await loadBudgetPlacements(
    organizationId,
    rows.map((b) => b.id),
  );
  // One resolver for the whole list, so a parent and its children share reads.
  const resolver = new BudgetStatusResolver(organizationId, rows);
  return Promise.all(rows.map((b) => toBudgetWithStatus(resolver, b, placements.get(b.id) ?? [])));
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
  // The caller's visible budgets, not one row: a parent's figures are its
  // children's, and only the children the caller can see.
  const rows = await loadVisibleBudgets(organizationId);
  const budget = rows.find((b) => b.id === budgetId);
  if (!budget) return null;

  const placements = await loadBudgetPlacements(organizationId, [budget.id]);
  const resolver = new BudgetStatusResolver(organizationId, rows);
  return toBudgetWithStatus(resolver, budget, placements.get(budget.id) ?? []);
}

export async function createBudget(
  organizationId: string,
  input: BudgetInput,
  createdByUserId: string | null,
): Promise<BudgetRow> {
  await validateBudgetWrite(organizationId, input, null);
  // Reject a dangling reference at write time (SavedCostFilterResolutionError
  // → 400 in the route): a budget born pointing at nothing would error every
  // evaluation from its first day.
  if (input.savedFilterId) await resolveSavedCostFilters(organizationId, input.savedFilterId);
  // Same rule for a scenario reference, and for a sharper reason: a budget born
  // pointing at a model that does not exist would error every evaluation from
  // its first day, and a budget is the one object where a failed evaluation
  // means an alert nobody receives.
  if (input.scenarioModelId) {
    await resolveCostScenarioModel(organizationId, input.scenarioModelId);
  }
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
      // Absent means cash: the column's own default, restated here so the
      // insert doesn't depend on which of the two defaults applies.
      costBasis: input.costBasis ?? "cash",
      savedFilterId: input.savedFilterId ?? null,
      scenarioModelId: input.scenarioModelId ?? null,
      useAdjustedSpend: input.useAdjustedSpend ?? false,
      // A cost-scoped creator's budget measures only what they can see.
      visibilityUserId: visibilityUserIdForCreate(organizationId),
      ...shapeColumns(input),
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
  await validateBudgetWrite(organizationId, input, budgetId);
  if (input.savedFilterId) await resolveSavedCostFilters(organizationId, input.savedFilterId);
  if (input.scenarioModelId) {
    await resolveCostScenarioModel(organizationId, input.scenarioModelId);
  }
  const [updated] = await db
    .update(budgets)
    .set({
      name: input.name,
      amountCents: input.amountCents,
      currency: input.currency,
      filters: input.filters,
      thresholds: input.thresholds,
      costBasis: input.costBasis ?? "cash",
      // A PUT is a full replace, so absent clears the reference: the editor
      // always sends the whole object, including the chip it still shows.
      savedFilterId: input.savedFilterId ?? null,
      // Absent clears the opt-in, which is the safe direction: a budget stops
      // measuring somebody's assumptions and goes back to the bare trend.
      scenarioModelId: input.scenarioModelId ?? null,
      // Same rule, same safe direction: absent clears the opt-in and the budget
      // goes back to measuring what the providers actually charged.
      useAdjustedSpend: input.useAdjustedSpend ?? false,
      ...shapeColumns(input),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(budgets.id, budgetId),
        eq(budgets.organizationId, organizationId),
        visibilityOwnerCondition(budgets.visibilityUserId, organizationId),
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
 * explains. Removing a *card* still leaves the budget alone: that direction is
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
        visibilityOwnerCondition(budgets.visibilityUserId, organizationId),
        isNull(budgets.deletedAt),
      ),
    )
    .returning({ id: budgets.id, parentBudgetId: budgets.parentBudgetId });
  if (!deleted) return false;

  // Children move up a level rather than becoming roots: they were part of
  // whatever the deleted budget rolled up into, and still are.
  await db
    .update(budgets)
    .set({ parentBudgetId: deleted.parentBudgetId, updatedAt: now })
    .where(
      and(
        eq(budgets.organizationId, organizationId),
        eq(budgets.parentBudgetId, budgetId),
        isNull(budgets.deletedAt),
      ),
    );

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

/**
 * Alert history for a budget (last 100 events), each with its note. Null when
 * budget not found.
 */
export async function listBudgetEvents(organizationId: string, budgetId: string) {
  return listBudgetAlertEventsWithNotes(organizationId, budgetId);
}
