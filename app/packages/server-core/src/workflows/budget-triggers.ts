/**
 * Budget-triggered workflows: "when budget A goes over X%, run workflow Y".
 *
 * Cost data only moves when the poller collects it, so evaluation piggybacks on
 * the same pass that fires budget alert pages (`cost/budget-eval.ts`) and reuses
 * the month status it already computed: no extra ClickHouse queries.
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
  /** Absent is a spend budget. */
  measure?: "cost" | "usage" | undefined;
  usageUnit?: string | null | undefined;
}

/**
 * A budget's current-period figures, as computed by the budget resolver.
 * `month` is the period key (`YYYY-MM` for a calendar-month budget), which is
 * what makes a trigger fire once per period. `limit` is the period's limit in
 * the budget's unit; absent means `budget.amountCents`, which is what every
 * monthly spend budget measures against.
 */
export interface BudgetTriggerStatus {
  month: string;
  actualCents: number;
  forecastCents: number | null;
  limit?: number | null | undefined;
  actualUsage?: number | null | undefined;
  forecastUsage?: number | null | undefined;
  periodStart?: string | null | undefined;
  periodEnd?: string | null | undefined;
}

export interface BudgetTriggerWorkflow {
  id: string;
  organizationId: string;
  trigger: unknown;
}

/**
 * Enabled workflows in the org that watch a budget. Returns `[]` on failure:
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

/**
 * The observed value a trigger compares against, in the budget's unit, or
 * null when unavailable.
 */
function observedValue(
  status: BudgetTriggerStatus,
  metric: "actual" | "forecast",
  usage: boolean,
): number | null {
  if (usage) {
    return metric === "actual" ? (status.actualUsage ?? null) : (status.forecastUsage ?? null);
  }
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
  const usage = budget.measure === "usage";
  const limit = status.limit !== undefined ? status.limit : budget.amountCents;
  if (limit === null || limit <= 0) return;

  for (const wf of candidates) {
    const trigger = (wf.trigger ?? {}) as BudgetTrigger;
    if (trigger.budgetId !== budget.id) continue;

    try {
      const metric = trigger.metric === "forecast" ? "forecast" : "actual";
      const percent =
        typeof trigger.percent === "number" && trigger.percent > 0
          ? trigger.percent
          : DEFAULT_BUDGET_TRIGGER_PERCENT;

      const observed = observedValue(status, metric, usage);
      // A null forecast means there wasn't enough data to fit one: that is not
      // the same as "spend is zero", so don't treat it as below the threshold.
      if (observed === null || observed === 0) continue;
      const bar = usage ? (limit * percent) / 100 : Math.round((limit * percent) / 100);
      if (observed < bar) continue;

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
        // The cents fields keep meaning cents: a usage budget reports 0 there
        // and its quantities in the usage fields, so a workflow written for
        // spend budgets cannot mistake 40,000 tokens for $400.
        amountCents: usage ? 0 : limit,
        metric,
        percent,
        observedCents: usage ? 0 : observed,
        actualCents: usage ? 0 : status.actualCents,
        forecastCents: usage ? null : status.forecastCents,
        measure: usage ? "usage" : "cost",
        ...(usage
          ? {
              usageUnit: budget.usageUnit ?? "",
              usageLimit: limit,
              observedUsage: observed,
              actualUsage: status.actualUsage ?? 0,
              forecastUsage: status.forecastUsage ?? null,
            }
          : {}),
        ...(status.periodStart && status.periodEnd
          ? { periodStart: status.periodStart, periodEnd: status.periodEnd }
          : {}),
      };

      // Imported lazily: this module is reached from the cost/budget path,
      // which the web server pulls in for plain budget reads; the runner drags
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
