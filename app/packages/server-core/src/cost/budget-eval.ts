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
import { queryCosts, type CostBasis, type CostFilter } from "../clickhouse/cost-readers";
import { convertGroups } from "./currency-convert";
import { getOrgCurrencySettings, listOrgExchangeRates } from "./currency-settings";
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
 *
 * `costBasis` is the budget's own, defaulting to cash. It has to be threaded
 * all the way down here rather than applied afterwards: the forecast is fit on
 * these same daily points, and fitting a trend through a cash series that
 * contains one enormous commitment purchase projects a month-end total that
 * will never happen.
 *
 * ## The budget currency vs. the org display currency
 *
 * A budget already has its own `currency`, and **that does not change.** It is
 * the unit of `amountCents`, of every threshold comparison, and of every alert
 * message. The org's display currency does not override it and cannot
 * re-denominate a budget somebody set.
 *
 * What the display currency does is narrower, and deliberately so. Today a
 * budget counts only spend already in its own currency and silently discards
 * the rest — so a USD budget in an org that also bills in EUR tracks a number
 * that is not the org's spend. When (and only when) **the budget's currency is
 * the org's display currency**, this function now converts the other
 * currencies' spend into it first, using the org's own stated rates.
 *
 * Why gate it on that equality rather than converting into any budget's
 * currency: rates are stated *to* the display currency in one hop, and nothing
 * inverts or chains them. There are simply no rates pointing at a GBP budget in
 * a USD-display org, so "convert into the budget's currency" would have no
 * rates to use. Gating on the equality makes the rule honest instead of
 * sometimes-working.
 *
 * The consequence worth stating plainly: an org that has not set a display
 * currency, or whose budget is in some other currency, gets byte-identical
 * behaviour to before — including the old drop-other-currencies behaviour.
 * Enabling conversion can only ever make a budget count *more* spend, never
 * less, so it cannot silently un-fire an alert that would have fired.
 *
 * `unconvertedCurrencies` names the currencies that were dropped anyway
 * because the org holds no rate for them. A budget is a single number and
 * cannot carry a second currency alongside it, so this is the one place a
 * currency really is excluded from a total — and it is reported rather than
 * hidden, so the budget card can say the figure is short.
 */
export async function budgetMonthStatus(
  organizationId: string,
  filters: CostFilter[],
  currency: string,
  now = new Date(),
  costBasis?: CostBasis,
): Promise<{
  month: string;
  actualCents: number;
  forecastCents: number | null;
  /** Currencies present in scope that could not be converted, so were excluded. */
  unconvertedCurrencies: string[];
  /** True when spend in other currencies was folded in at the org's rates. */
  converted: boolean;
}> {
  const today = isoDay(now);
  const month = today.slice(0, 7);
  const groups = await queryCosts(organizationId, {
    from: addDays(today, -59),
    to: today,
    binning: "daily",
    groupBy: "none",
    filters,
    ...(costBasis ? { costBasis } : {}),
  });

  // Conversion is attempted only when the budget is denominated in the org's
  // display currency — see the doc comment above.
  const settings = await getOrgCurrencySettings(organizationId).catch(() => ({
    displayCurrency: null as string | null,
  }));
  const target = settings.displayCurrency === currency ? currency : null;
  const rates = target ? await listOrgExchangeRates(organizationId) : [];
  const { groups: usable, conversion } = convertGroups(groups, target, rates);

  const daily = new Map<string, number>();
  for (const g of usable) {
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
    // Currencies with no rate are excluded from the figure above, so name them.
    // Without conversion on, every other currency was always excluded and
    // saying so would be new noise about long-standing behaviour — hence the
    // empty list rather than "all of them".
    unconvertedCurrencies: conversion?.unconverted ?? [],
    converted: (conversion?.converted.length ?? 0) > 0,
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
        (budget.costBasis ?? undefined) as CostBasis | undefined,
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
        // A converted figure has to say so in the message itself. The alert is
        // often the only place this number is ever read, and a total that
        // quietly folded in three currencies at rates somebody set months ago
        // is not a number to page on without the caveat attached.
        const caveats = [
          ...(status.converted
            ? ["converted to the org display currency at your stated rates"]
            : []),
          ...(status.unconvertedCurrencies.length > 0
            ? [`excludes spend in ${status.unconvertedCurrencies.join(", ")} — no rate configured`]
            : []),
        ];
        const suffix = caveats.length > 0 ? ` (${caveats.join("; ")})` : "";
        const alertBody = `infrawrench budget "${budget.name}": ${kind} ${formatCents(observedCents, budget.currency)} has reached ${threshold.percent}% of ${formatCents(budget.amountCents, budget.currency)} for ${status.month}${suffix}`;
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
