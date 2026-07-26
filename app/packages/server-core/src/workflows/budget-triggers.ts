/**
 * Budget-triggered workflows: "when budget A goes over X%, run workflow Y".
 *
 * Cost data only moves when the poller collects it, so evaluation piggybacks on
 * the same pass that fires budget alert pages (`cost/budget-eval.ts`) and reuses
 * the month status it already computed — no extra ClickHouse queries.
 *
 * Firing exactly once per month is enforced with a conditional UPDATE on
 * `workflows.budget_last_fired_key` rather than a marker table: the key encodes
 * the month, measure, and percent, so competing poller replicas race for the
 * same row and only the winner runs the workflow, while editing the threshold
 * re-arms it immediately.
 */
import { and, eq, isNull, sql } from "drizzle-orm";

import {
  DEFAULT_BUDGET_TRIGGER_PERCENT,
  type BudgetTriggerEvent,
} from "@infrawrench/workflow-runtime/client";

import { db } from "../db/client";
import { workflows } from "../db/schema";

/** A workflow's `trigger` jsonb narrowed to the budget fields we read. */
interface BudgetTrigger {
  kind?: string;
  budgetId?: string;
  percent?: number;
  metric?: "actual" | "forecast";
}

/** The subset of a budget row a trigger needs. */
export interface BudgetTriggerBudget {
  id: string;
  name: string;
  amountCents: number;
  currency: string;
}

/** Current-month spend for a budget, as computed by `budgetMonthStatus`. */
export interface BudgetTriggerStatus {
  month: string;
  actualCents: number;
  forecastCents: number | null;
}

export interface BudgetTriggerWorkflow {
  id: string;
  organizationId: string;
  trigger: unknown;
}

/**
 * Enabled workflows in the org that watch a budget. Returns `[]` on failure —
 * a broken query here must never take down the budget-alert pass.
 */
export async function listBudgetTriggerWorkflows(
  organizationId: string,
): Promise<BudgetTriggerWorkflow[]> {
  try {
    return await db
      .select({
        id: workflows.id,
        organizationId: workflows.organizationId,
        trigger: workflows.trigger,
      })
      .from(workflows)
      .where(
        and(
          eq(workflows.organizationId, organizationId),
          eq(workflows.enabled, true),
          isNull(workflows.deletedAt),
          sql`${workflows.trigger} ->> 'kind' = 'budget'`,
        ),
      );
  } catch (err) {
    console.error("[budget-triggers] failed to load budget-trigger workflows:", err);
    return [];
  }
}

/** The observed value a trigger compares against, or null when unavailable. */
function observedCents(status: BudgetTriggerStatus, metric: "actual" | "forecast"): number | null {
  return metric === "actual" ? status.actualCents : status.forecastCents;
}

/**
 * Run every workflow whose budget trigger crossed on this evaluation. Safe to
 * call for budgets nobody watches (it does nothing). Never throws.
 */
export async function fireBudgetTriggerWorkflows(opts: {
  organizationId: string;
  budget: BudgetTriggerBudget;
  status: BudgetTriggerStatus;
  candidates: BudgetTriggerWorkflow[];
}): Promise<void> {
  const { organizationId, budget, status, candidates } = opts;
  if (budget.amountCents <= 0) return;

  for (const wf of candidates) {
    const trigger = (wf.trigger ?? {}) as BudgetTrigger;
    if (trigger.budgetId !== budget.id) continue;

    try {
      const metric = trigger.metric === "forecast" ? "forecast" : "actual";
      const percent =
        typeof trigger.percent === "number" && trigger.percent > 0
          ? trigger.percent
          : DEFAULT_BUDGET_TRIGGER_PERCENT;

      const observed = observedCents(status, metric);
      // A null forecast means there wasn't enough data to fit one — that is not
      // the same as "spend is zero", so don't treat it as below the threshold.
      if (observed === null || observed === 0) continue;
      if (observed < Math.round((budget.amountCents * percent) / 100)) continue;

      // Claim the crossing. `IS DISTINCT FROM` also covers the null (never
      // fired) case; only the replica that changes the row runs the workflow.
      const key = `${status.month}:${metric}:${percent}`;
      const claimed = await db
        .update(workflows)
        .set({ budgetLastFiredKey: key, updatedAt: new Date() })
        .where(
          and(
            eq(workflows.id, wf.id),
            sql`${workflows.budgetLastFiredKey} IS DISTINCT FROM ${key}`,
          ),
        )
        .returning({ id: workflows.id });
      if (claimed.length === 0) continue; // already fired for this crossing

      const event: BudgetTriggerEvent = {
        kind: "budget",
        budgetId: budget.id,
        budgetName: budget.name,
        month: status.month,
        currency: budget.currency,
        amountCents: budget.amountCents,
        metric,
        percent,
        observedCents: observed,
        actualCents: status.actualCents,
        forecastCents: status.forecastCents,
      };

      // Imported lazily: this module is reached from the cost/budget path,
      // which the web server pulls in for plain budget reads — the runner drags
      // in the QuickJS sandbox, and only an actual crossing needs it.
      const { runOrgWorkflow } = await import("./runner.js");
      await runOrgWorkflow({
        organizationId,
        workflowId: wf.id,
        triggerSource: "budget",
        event,
      });
    } catch (err) {
      console.error(`[budget-triggers] workflow ${wf.id} failed for budget ${budget.id}:`, err);
    }
  }
}
