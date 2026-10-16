/**
 * Filing a fired budget alert as an issue.
 *
 * A budget alert is a finding like any other: spend crossed a line somebody
 * drew, and someone has to look at why. The issue it becomes has to read on
 * its own in a tracker, where nobody has the budget card beside it, so the
 * draft spells out the budget, the period, which threshold fired, and where
 * spend and the forecast stand against the limit right now.
 *
 * Two layers, so every surface files the same facts: {@link budgetAlertIssueFacts}
 * computes the figures (formatted in the budget's unit), and
 * {@link budgetAlertIssueDraft} lays them out in English for surfaces with no
 * translation layer (the CLI, MCP). Web and desktop build the same draft from
 * the facts with translated labels. Either result feeds `buildJiraIssueDraft`
 * (Jira and Linear) and GitHub's server-side body builder alike.
 */
import type { BuildJiraIssueDraftArgs } from "./jira";
import { budgetProgress, formatBudgetPeriodWindow, formatUsageQuantity } from "./budgets";
import { formatMoney, type BudgetWithStatus, type CostFilter } from "./costs";

/** The parts of a firing the draft reads. */
export interface BudgetAlertIssueEvent {
  id: string;
  thresholdType: "actual" | "forecast";
  thresholdPercent: number;
  triggeredAt: string;
}

/** `service in (EC2, S3)`, `tag env not in (dev)`: one scope line, compact. */
export function describeBudgetFilter(filter: CostFilter): string {
  const dimension =
    (filter.dimension === "tag" || filter.dimension === "virtual_tag") && filter.tagKey
      ? `${filter.dimension === "tag" ? "tag" : "virtual tag"} ${filter.tagKey}`
      : filter.dimension.replace(/_/g, " ");
  const values = filter.values.slice(0, 5).join(", ");
  const more = filter.values.length > 5 ? ` +${filter.values.length - 5}` : "";
  return `${dimension} ${filter.op === "in" ? "in" : "not in"} (${values}${more})`;
}

/** What an issue about one firing states, already formatted. */
export interface BudgetAlertIssueFacts {
  budgetName: string;
  /** "Oct 1 – Oct 31, 2026", or the `YYYY-MM` month for a calendar budget. */
  period: string;
  forecastThreshold: boolean;
  thresholdPercent: number;
  /** `YYYY-MM-DD` (UTC) the alert fired. */
  firedDay: string;
  /** Spend (or usage) so far, formatted in the budget's unit: "$8,120". */
  spent: string;
  /** This period's limit, formatted; null when the period has none. */
  limit: string | null;
  /** Spend as a whole percentage of the limit; null without a limit. */
  spentPercent: number | null;
  /** Projected period-end figure, formatted; null with no forecast. */
  forecast: string | null;
  /** The forecast as a whole percentage of the limit; null without one. */
  forecastPercent: number | null;
  /** The budget's filters, one line; null for an unscoped budget. */
  scope: string | null;
  adjustedSpend: boolean;
  /** Child budget count when this budget is the sum of its children. */
  rolledUpChildren: number | null;
  scenarioName: string | null;
  /** The note somebody wrote on this firing, if any. */
  firingNote: string | null;
}

/**
 * The facts for one firing, given the budget as it stands now.
 *
 * Figures are the budget's current status rather than the values at the
 * crossing: whoever triages the issue needs to know where spend *is*, and the
 * threshold line already records where it was when the alert fired.
 */
export function budgetAlertIssueFacts(
  budget: BudgetWithStatus,
  event: BudgetAlertIssueEvent,
): BudgetAlertIssueFacts {
  const progress = budgetProgress(budget);
  const fmt =
    progress.measure === "usage"
      ? (value: number) => formatUsageQuantity(value, budget.usageUnit)
      : (value: number) => formatMoney(value, budget.currency);
  const period =
    budget.periodStart && budget.periodEnd
      ? formatBudgetPeriodWindow({ start: budget.periodStart, end: budget.periodEnd })
      : budget.month;
  const scope = (budget.filters ?? []).map(describeBudgetFilter).join("; ");
  return {
    budgetName: budget.name,
    period,
    forecastThreshold: event.thresholdType === "forecast",
    thresholdPercent: event.thresholdPercent,
    firedDay: event.triggeredAt.slice(0, 10),
    spent: fmt(progress.actual),
    limit: progress.limit !== null ? fmt(progress.limit) : null,
    spentPercent: progress.limit !== null ? Math.round(progress.actualPercent) : null,
    forecast: progress.forecast !== null ? fmt(progress.forecast) : null,
    forecastPercent:
      progress.forecastPercent !== null ? Math.round(progress.forecastPercent) : null,
    scope: scope || null,
    adjustedSpend: Boolean(budget.useAdjustedSpend),
    rolledUpChildren: budget.rolledUp ? (budget.childCount ?? 0) : null,
    scenarioName: budget.scenarioModelName ?? null,
    firingNote: budget.currentMonthEvents.find((e) => e.id === event.id)?.note?.text ?? null,
  };
}

/** The English draft for one firing (CLI, MCP and any surface without translations). */
export function budgetAlertIssueDraft(
  budget: BudgetWithStatus,
  event: BudgetAlertIssueEvent,
  options: { appUrl?: string | undefined } = {},
): Omit<BuildJiraIssueDraftArgs, "sourceKind"> {
  const f = budgetAlertIssueFacts(budget, event);
  const notes: string[] = [];
  if (f.rolledUpChildren !== null) {
    notes.push(
      `This budget is the sum of ${f.rolledUpChildren} child budgets; the child budgets show where the spend is.`,
    );
  }
  if (f.scenarioName) notes.push(`The forecast includes the scenario "${f.scenarioName}".`);
  if (f.firingNote) notes.push(`Note on this alert: ${f.firingNote}`);
  return {
    title: f.forecastThreshold
      ? `"${f.budgetName}" is forecast to reach ${f.thresholdPercent}% of its budget (${f.period})`
      : `"${f.budgetName}" passed ${f.thresholdPercent}% of its budget (${f.period})`,
    details: [
      { label: "Budget", value: f.budgetName },
      { label: "Period", value: f.period },
      {
        label: "Threshold",
        value: `${f.forecastThreshold ? "Forecast" : "Actual"} ${f.thresholdPercent}%`,
      },
      { label: "Fired", value: f.firedDay },
      {
        label: "Spend so far",
        value: f.limit !== null ? `${f.spent} of ${f.limit} (${f.spentPercent}%)` : f.spent,
      },
      {
        label: "Forecast for the period",
        value:
          f.forecast === null
            ? null
            : f.forecastPercent !== null
              ? `${f.forecast} (${f.forecastPercent}% of the limit)`
              : f.forecast,
      },
      { label: "Scope", value: f.scope ?? "All spend" },
      { label: "Measured on", value: f.adjustedSpend ? "Spend with billing rules applied" : null },
    ],
    ...(notes.length > 0 ? { note: notes.join("\n\n") } : {}),
    ...(options.appUrl ? { appUrl: options.appUrl } : {}),
  };
}
