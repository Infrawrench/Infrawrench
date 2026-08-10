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
import { billingAdjustmentsAreEmpty } from "@infrawrench/client-core";
import { resolveBillingAdjustments } from "./billing-rules";
import { convertGroups } from "./currency-convert";
import { getOrgCurrencySettings, listOrgExchangeRates } from "./currency-settings";
import { forecastDaily, forecastMonthTotal, type DailyPoint } from "./forecast";
import { resolveSavedCostFilters } from "./saved-filters";
import { forecastWithScenario, resolveCostScenarioModel } from "./scenario-forecast";
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
/*
 * ## Scenario models and budget thresholds
 *
 * `scenarioModelId` is **opt-in per budget, and null by default.** With it null
 * — which is every budget that existed before scenarios, and every budget
 * nobody deliberately opts in — this function returns exactly what it always
 * returned, and `forecastCents` is the bare trend.
 *
 * That default is a deliberate refusal, not an oversight. A scenario model is a
 * hypothesis somebody typed into a form; budget forecast thresholds decide when
 * a real person is paged. Letting the first silently move the second would mean
 * anyone with `costs:write` could change an on-call rota by editing an object
 * two screens away, and the page (or the missing page) would carry no evidence
 * of why.
 *
 * When a budget *does* opt in, three things keep it visible: `forecastCents`
 * stays the unadjusted trend so both numbers can be shown side by side, the
 * adjusted figure comes back separately as `scenarioForecastCents`, and the
 * model's name is carried out so the card and the alert body can name it.
 * `actual` thresholds are never affected — they measure money already spent,
 * which no scenario can touch.
 *
 * ## Billing rules and budget thresholds
 *
 * `useAdjustedSpend` is the same refusal, and it follows the same precedent:
 * **false by default, opt-in per budget.** With it false — every budget that
 * existed before billing rules, and every budget nobody deliberately opts in —
 * this function does not read the rules table and returns exactly what it
 * always returned.
 *
 * The reason is sharper than the scenario one. A markup is org policy that
 * changes every number the org reports; a budget threshold decides when a real
 * person is paged. If a markup silently raised measured spend, adding one
 * settings row would move every on-call rota in the org at once, and every
 * resulting page would be for money nobody actually spent.
 *
 * Unlike a scenario this affects `actual` thresholds too, and must: an opted-in
 * budget is measuring the *internal* figure, and month-to-date internal spend is
 * as marked up as the forecast is. Judging actual on collected spend and
 * forecast on adjusted spend would be a budget measuring two different things.
 * `rawActualCents` comes back beside it so the card and the alert can always
 * show what was collected.
 */
export async function budgetMonthStatus(
  organizationId: string,
  filters: CostFilter[],
  currency: string,
  now = new Date(),
  costBasis?: CostBasis,
  savedFilterId?: string | null,
  scenarioModelId?: string | null,
  useAdjustedSpend?: boolean,
): Promise<{
  month: string;
  actualCents: number;
  /**
   * Month-to-date **collected** spend, set only for a budget measuring adjusted
   * spend. Null otherwise, where `actualCents` already is the collected figure.
   */
  rawActualCents: number | null;
  /** True when every figure here has the org's billing rules applied. */
  adjustedSpend: boolean;
  /** The **unadjusted trend** forecast, whether or not a scenario is applied. */
  forecastCents: number | null;
  /**
   * The scenario-adjusted month forecast, set only when this budget opted into
   * a model. Null means forecast thresholds are judged on `forecastCents`.
   */
  scenarioForecastCents: number | null;
  /** The opted-into model's name, for the card and the alert body. */
  scenarioModelName: string | null;
  /** Currencies present in scope that could not be converted, so were excluded. */
  unconvertedCurrencies: string[];
  /** True when spend in other currencies was folded in at the org's rates. */
  converted: boolean;
}> {
  const today = isoDay(now);
  const month = today.slice(0, 7);
  // A saved filter is resolved here, at evaluation time, so an edit to it
  // re-scopes the budget on the next pass. A reference that fails to resolve
  // throws — the caller must surface the failure, because evaluating this
  // budget over unfiltered spend would fire or suppress alerts it should not.
  const effectiveFilters = savedFilterId
    ? [...(await resolveSavedCostFilters(organizationId, savedFilterId)), ...filters]
    : filters;

  // Read only for a budget that opted in — an un-opted budget never touches the
  // rules table, so a markup cannot reach a threshold it was not invited to.
  const billing = useAdjustedSpend ? await resolveBillingAdjustments(organizationId) : null;
  const adjustments =
    billing && !billingAdjustmentsAreEmpty(billing.adjustments) ? billing.adjustments : undefined;

  const groups = await queryCosts(organizationId, {
    from: addDays(today, -59),
    to: today,
    binning: "daily",
    groupBy: "none",
    filters: effectiveFilters,
    ...(costBasis ? { costBasis } : {}),
    ...(adjustments ? { adjustments } : {}),
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
  // The collected series rides along from the same scan, converted through the
  // same rates, so "adjusted $12,400 (collected $10,800)" is two readings of
  // one pass rather than two queries that could disagree.
  const rawDaily = new Map<string, number>();
  for (const g of usable) {
    if (g.currency !== currency) continue;
    for (const p of g.points) daily.set(p.bucket, (daily.get(p.bucket) ?? 0) + p.amount);
    for (const p of g.rawPoints ?? []) {
      rawDaily.set(p.bucket, (rawDaily.get(p.bucket) ?? 0) + p.amount);
    }
  }
  const points: DailyPoint[] = [...daily.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, amount]) => ({ day, amount }));

  const inMonth = (day: string) => day.startsWith(`${month}-`);
  const actual = points.filter((p) => inMonth(p.day)).reduce((sum, p) => sum + p.amount, 0);
  const rawActual = [...rawDaily.entries()]
    .filter(([day]) => inMonth(day))
    .reduce((sum, [, amount]) => sum + amount, 0);
  const forecast = forecastMonthTotal(points, month);

  // The scenario overlay, computed *in addition to* the trend above and never
  // in place of it. Nothing below runs for a budget that did not opt in, so an
  // un-opted budget's numbers are byte-identical to what they have always been.
  let scenarioForecastCents: number | null = null;
  let scenarioModelName: string | null = null;
  if (scenarioModelId) {
    // Throws out to the caller when the model no longer resolves — the budget's
    // evaluation is skipped and logged rather than quietly falling back to the
    // trend, which would change which thresholds fire with no evidence at all.
    const model = await resolveCostScenarioModel(organizationId, scenarioModelId);
    scenarioModelName = model.name;
    const remaining = remainingDaysInMonth(points, month);
    const baseline = remaining > 0 ? monthBaselineProjection(points, month, remaining) : [];
    if (baseline.length === 0) {
      // Nothing left to project (the month is over, or there is no history to
      // fit): the adjusted figure is the trend figure, by construction.
      scenarioForecastCents = forecast === null ? null : Math.round(forecast * 100);
    } else {
      const projection = await forecastWithScenario({
        organizationId,
        model,
        baseline,
        filters: effectiveFilters,
        fitTo: today,
        ...(costBasis ? { costBasis } : {}),
        baselineCurrency: currency,
        displayCurrency: target,
        rates,
      });
      const projected = projection.points.reduce((sum, p) => sum + p.amount, 0);
      scenarioForecastCents = Math.round((actual + projected) * 100);
    }
  }

  return {
    month,
    actualCents: Math.round(actual * 100),
    // Null rather than a copy of `actualCents` for an un-opted budget: "there
    // is no separate collected figure because this one is it" and "the
    // collected figure happens to equal the adjusted one" are different facts,
    // and a card that showed "(collected $X)" under every budget in the org
    // would make the ones that really are adjusted invisible.
    rawActualCents: adjustments ? Math.round(rawActual * 100) : null,
    adjustedSpend: Boolean(useAdjustedSpend),
    forecastCents: forecast === null ? null : Math.round(forecast * 100),
    scenarioForecastCents,
    scenarioModelName,
    // Currencies with no rate are excluded from the figure above, so name them.
    // Without conversion on, every other currency was always excluded and
    // saying so would be new noise about long-standing behaviour — hence the
    // empty list rather than "all of them".
    unconvertedCurrencies: conversion?.unconverted ?? [],
    converted: (conversion?.converted.length ?? 0) > 0,
  };
}

/**
 * Days of `month` still to come after the last observed day — the region a
 * scenario may touch, and nothing else. Zero once the month is complete, which
 * is what makes "a scenario never alters recorded history" true for budgets as
 * well as for charts.
 */
function remainingDaysInMonth(points: DailyPoint[], month: string): number {
  const monthPoints = points.filter((p) => p.day.startsWith(`${month}-`));
  const lastDay = monthPoints[monthPoints.length - 1]?.day;
  if (!lastDay) return 0;
  const d = new Date(`${lastDay}T00:00:00.000Z`);
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return Math.max(0, daysInMonth - d.getUTCDate());
}

/**
 * The trend projection for the rest of the month, in the same shape a chart's
 * forecast has.
 *
 * Mirrors `forecastMonthTotal` exactly — the fit first, the month-to-date daily
 * average as the fallback — so that a scenario with no adjustments active would
 * reproduce the trend figure rather than a differently-derived one. Nothing
 * would be more confusing on a budget card than two "forecasts" that disagree
 * before any assumption has been applied.
 */
function monthBaselineProjection(
  points: DailyPoint[],
  month: string,
  remaining: number,
): DailyPoint[] {
  const projected = forecastDaily(points, remaining);
  if (projected.length > 0) return projected;

  const monthPoints = points.filter((p) => p.day.startsWith(`${month}-`));
  if (monthPoints.length === 0) return [];
  const mtd = monthPoints.reduce((sum, p) => sum + p.amount, 0);
  const dailyAvg = mtd / monthPoints.length;
  const lastDay = monthPoints[monthPoints.length - 1]!.day;
  return Array.from({ length: remaining }, (_, i) => ({
    day: addDays(lastDay, i + 1),
    amount: dailyAvg,
  }));
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

      // A budget referencing a saved filter that no longer resolves throws
      // out of budgetMonthStatus into this budget's catch below: the
      // evaluation is skipped and logged, never silently run over all spend.
      const status = await budgetMonthStatus(
        organizationId,
        (budget.filters ?? []) as CostFilter[],
        budget.currency,
        now,
        (budget.costBasis ?? undefined) as CostBasis | undefined,
        budget.savedFilterId,
        budget.scenarioModelId,
        budget.useAdjustedSpend,
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
        // `actual` is money already spent, which no scenario can touch.
        // `forecast` uses the adjusted figure **only** for a budget that opted
        // into a model — `scenarioForecastCents` is null for every other one,
        // so this reads as the bare trend exactly as it always did.
        const observedCents =
          threshold.type === "actual"
            ? status.actualCents
            : (status.scenarioForecastCents ?? status.forecastCents ?? 0);
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
          // A threshold crossed on a scenario-adjusted number must say whose
          // assumptions moved it. This is often the only place the figure is
          // ever read, and "why was I paged" has to be answerable from the
          // message itself.
          ...(threshold.type === "forecast" && status.scenarioModelName
            ? [`includes scenario "${status.scenarioModelName}"`]
            : []),
          // A page fired on a marked-up number must say so, and say what was
          // actually collected. Without this the recipient is looking at money
          // the organisation charged itself and has no way to tell.
          ...(status.adjustedSpend
            ? [
                status.rawActualCents === null
                  ? "billing rules applied"
                  : `billing rules applied — collected spend ${formatCents(status.rawActualCents, budget.currency)}`,
              ]
            : []),
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
