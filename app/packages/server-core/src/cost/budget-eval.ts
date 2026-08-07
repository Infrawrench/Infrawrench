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
import type { BudgetThreshold } from "@infrawrench/client-core";
import { db } from "../db/client";
import { budgetAlertEvents, budgets } from "../db/schema";
import { queryCosts, type CostFilter } from "../clickhouse/cost-readers";
import { forecastMonthTotal, type DailyPoint } from "./forecast";
import { sendBudgetAlertPage } from "../twilio-pager";
import { alertReached, routeAlert } from "../alerts/route";
import {
  fireBudgetTriggerWorkflows,
  listBudgetTriggerWorkflows,
} from "../workflows/budget-triggers";
import { isoDay, addDays } from "./dates";

/** Deep link to the budget, for the Slack message's button. */
function budgetUrl(organizationId: string, budgetId: string): string | null {
  const base = process.env["APP_URL"];
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/org/${organizationId}/budgets/${budgetId}`;
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
 * Evaluate every budget in an org: fire alert pages for freshly crossed
 * thresholds, and run any workflows triggered by this budget. Errors are
 * logged, never thrown — budget evaluation must not break the poller's cost
 * pass.
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

  // Loaded once for the org, not per budget. A budget with no alert thresholds
  // still needs its status computed when a workflow watches it.
  const triggerWorkflows = await listBudgetTriggerWorkflows(organizationId);

  for (const budget of rows) {
    try {
      const thresholds = (budget.thresholds ?? []) as BudgetThreshold[];
      const watchers = triggerWorkflows.filter(
        (w) => (w.trigger as { budgetId?: string } | null)?.budgetId === budget.id,
      );
      if ((thresholds.length === 0 && watchers.length === 0) || budget.amountCents <= 0) continue;

      const status = await budgetMonthStatus(
        organizationId,
        (budget.filters ?? []) as CostFilter[],
        budget.currency,
        now,
      );

      if (watchers.length > 0) {
        await fireBudgetTriggerWorkflows({
          organizationId,
          budget: {
            id: budget.id,
            name: budget.name,
            amountCents: budget.amountCents,
            currency: budget.currency,
          },
          status,
          candidates: watchers,
        });
      }

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
        const alertBody = `infrawrench budget "${budget.name}": ${kind} ${formatCents(observedCents, budget.currency)} has reached ${threshold.percent}% of ${formatCents(budget.amountCents, budget.currency)} for ${status.month}`;
        const paged = await sendBudgetAlertPage(organizationId, alertBody);
        // Routing is independent of the org's Twilio settings — dedupe already
        // happened via the budget_alert_events insert above.
        const url = budgetUrl(organizationId, budget.id);
        const routed = await routeAlert({
          organizationId,
          trigger: "budgetAlerts",
          // A budget at or past 100% is a different kind of news from one at
          // 80%, and severity is what a quiet-hours `urgentOverride` keys on —
          // so "sleep through warnings, wake me if we actually blew the budget"
          // is expressible without a second rule.
          severity: threshold.percent >= 100 ? "critical" : "warning",
          title: `Budget "${budget.name}" at ${threshold.percent}%`,
          body: alertBody,
          context: `${status.month} · ${kind}`,
          url,
          pushData: {
            type: "budget_breach",
            orgId: organizationId,
            budgetId: budget.id,
            month: status.month,
            thresholdPercent: threshold.percent,
          },
          facts: {
            amountCents: observedCents,
            currency: budget.currency,
            key: budget.name,
          },
        });
        if (paged || alertReached(routed)) {
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
