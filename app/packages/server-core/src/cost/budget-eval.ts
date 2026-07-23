/**
 * Budget threshold evaluation. Runs from the poller after each successful
 * cost collection for an org — org cost data only changes when collection
 * runs, so no separate scheduler is needed. The unique index on
 * budget_alert_events (budgetId, month, thresholdType, thresholdPercent)
 * makes each threshold fire at most once per calendar month:
 * `onConflictDoNothing` + RETURNING tells us whether this crossing is fresh,
 * and only fresh crossings notify.
 */
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/client";
import { budgetAlertEvents, budgets } from "../db/schema";
import { queryCosts, type CostFilter } from "../clickhouse/cost-readers";
import { forecastMonthTotal, type DailyPoint } from "./forecast";
import { sendBudgetAlertPage } from "../twilio-pager";
import { isoDay, addDays } from "./dates";

interface BudgetThreshold {
  type: "actual" | "forecast";
  percent: number;
}

function formatCents(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * Current-month actual + forecast for a budget's scope, in its currency.
 * Fit data spans the trailing 60 days so early-month forecasts still have a
 * full window. Shared with the budgets API routes.
 */
export async function budgetMonthStatus(
  organizationId: string,
  filters: CostFilter[],
  currency: string,
  now = new Date(),
): Promise<{ month: string; actualCents: number; forecastCents: number | null }> {
  const today = isoDay(now);
  const month = today.slice(0, 7);
  const groups = await queryCosts(organizationId, {
    from: addDays(today, -59),
    to: today,
    binning: "daily",
    groupBy: "none",
    filters,
  });

  const daily = new Map<string, number>();
  for (const g of groups) {
    if (g.currency !== currency) continue;
    for (const p of g.points) daily.set(p.bucket, (daily.get(p.bucket) ?? 0) + p.amount);
  }
  const points: DailyPoint[] = [...daily.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, amount]) => ({ day, amount }));

  const actual = points
    .filter((p) => p.day.startsWith(`${month}-`))
    .reduce((sum, p) => sum + p.amount, 0);
  const forecast = forecastMonthTotal(points, month);
  return {
    month,
    actualCents: Math.round(actual * 100),
    forecastCents: forecast === null ? null : Math.round(forecast * 100),
  };
}

/**
 * Evaluate every budget in an org. Errors are logged, never thrown — budget
 * evaluation must not break the poller's cost pass.
 */
export async function evaluateBudgetsForOrg(
  organizationId: string,
  now = new Date(),
): Promise<void> {
  let rows;
  try {
    rows = await db
      .select()
      .from(budgets)
      .where(and(eq(budgets.organizationId, organizationId), isNull(budgets.deletedAt)));
  } catch (err) {
    console.error("[budget-eval] failed to load budgets for org", organizationId, err);
    return;
  }

  for (const budget of rows) {
    try {
      const thresholds = (budget.thresholds ?? []) as BudgetThreshold[];
      if (thresholds.length === 0 || budget.amountCents <= 0) continue;

      const status = await budgetMonthStatus(
        organizationId,
        (budget.filters ?? []) as CostFilter[],
        budget.currency,
        now,
      );

      for (const threshold of thresholds) {
        const limitCents = Math.round((budget.amountCents * threshold.percent) / 100);
        const observedCents =
          threshold.type === "actual" ? status.actualCents : (status.forecastCents ?? 0);
        if (observedCents < limitCents || observedCents === 0) continue;

        const [inserted] = await db
          .insert(budgetAlertEvents)
          .values({
            id: randomUUID(),
            budgetId: budget.id,
            organizationId,
            month: status.month,
            thresholdType: threshold.type,
            thresholdPercent: threshold.percent,
            actualAmountCents: status.actualCents,
            forecastAmountCents: status.forecastCents,
          })
          .onConflictDoNothing()
          .returning({ id: budgetAlertEvents.id });
        if (!inserted) continue; // already fired this month

        const kind = threshold.type === "actual" ? "spend" : "forecasted spend";
        const notified = await sendBudgetAlertPage(
          organizationId,
          `infrawrench budget "${budget.name}": ${kind} ${formatCents(observedCents, budget.currency)} has reached ${threshold.percent}% of ${formatCents(budget.amountCents, budget.currency)} for ${status.month}`,
        );
        if (notified) {
          await db
            .update(budgetAlertEvents)
            .set({ notifiedAt: new Date() })
            .where(eq(budgetAlertEvents.id, inserted.id));
        }
      }
    } catch (err) {
      console.error(`[budget-eval] budget ${budget.id} evaluation failed:`, err);
    }
  }
}
