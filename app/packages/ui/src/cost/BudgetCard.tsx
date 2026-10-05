import { useState } from "react";
import { useGT } from "gt-react";
import { formatBudgetMonth, formatMoney } from "./transform.js";
import {
  budgetProgress,
  formatBudgetPeriodWindow,
  formatUsageQuantity,
  upcomingBudgetPeriod,
  type BudgetHierarchyWarning,
} from "./config.js";
import type { BudgetWithStatus } from "./types.js";
import { CloseIcon } from "../components/icons/ChromeIcons.js";

type FiredEvent = BudgetWithStatus["currentMonthEvents"][number];

export interface BudgetCardProps {
  budget: BudgetWithStatus;
  onEdit?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
  /**
   * The budget's direct children, when the host has them: a dashboard card
   * for a parent lists them (collapsed) so the rollup can be read without
   * leaving the dashboard. The Costs panel draws the full tree itself and
   * leaves this off.
   */
  childBudgets?: BudgetWithStatus[] | undefined;
  /**
   * Open the note composer for one of this month's firings. Absent on hosts
   * (and surfaces, like a dashboard card) that only show notes.
   */
  onExplain?: ((event: FiredEvent) => void) | undefined;
}

/** "Oct 3": a firing's day, short, in UTC like the budget month itself. */
function shortDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Formats a value in the budget's own unit: money, or a usage quantity. */
export function budgetValueFormatter(budget: BudgetWithStatus): (value: number) => string {
  return budget.measure === "usage"
    ? (value) => formatUsageQuantity(value, budget.usageUnit)
    : (value) => formatMoney(value, budget.currency);
}

/** The period a card is showing: "July 2026", "Oct 5 – Oct 18, 2026". */
function usePeriodLabel(budget: BudgetWithStatus): string {
  const gt = useGT();
  if (!budget.period) return formatBudgetMonth(budget.month);
  if (budget.periodStart && budget.periodEnd) {
    return formatBudgetPeriodWindow({ start: budget.periodStart, end: budget.periodEnd });
  }
  const next = upcomingBudgetPeriod(budget.period, new Date().toISOString().slice(0, 10));
  return next
    ? gt("No active period · next starts {date}", {
        date: formatBudgetPeriodWindow({ start: next.start, end: next.start }),
      })
    : gt("No active period");
}

/**
 * Budget progress card: period-to-date actual vs the period's limit, a
 * forecast marker, threshold ticks, and an alert badge when a threshold has
 * fired this period. Spend budgets read in money, usage budgets in their unit;
 * a parent says it is the sum of its children and flags children that outgrow
 * it. Status colors are reserved for state (on-track / approaching / over),
 * never used as series colors.
 */
export function BudgetCard({ budget, onEdit, onRemove, childBudgets, onExplain }: BudgetCardProps) {
  const gt = useGT();
  const progress = budgetProgress(budget);
  const fmt = budgetValueFormatter(budget);
  const { limit, actual, forecast, trendForecast, actualPercent: actualPct } = progress;
  const forecastPct = progress.forecastPercent;
  const fired = budget.currentMonthEvents.length > 0;

  const barColor =
    actualPct >= 100 ? "bg-red-500" : actualPct >= 80 ? "bg-amber-500" : "bg-emerald-500";
  const periodLabel = usePeriodLabel(budget);

  return (
    <div className="group relative rounded-2xl border border-border bg-surface-raised hover:border-border-strong transition-colors flex flex-col overflow-hidden">
      <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all z-10">
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            title={gt("Edit budget")}
            aria-label={gt("Edit budget")}
            className="size-5 rounded-full text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken text-xs flex items-center justify-center"
          >
            ✎
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            title={gt("Remove from dashboard")}
            aria-label={gt("Remove from dashboard")}
            className="size-5 rounded-full text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken text-xs flex items-center justify-center"
          >
            <CloseIcon size={12} />
          </button>
        )}
      </div>

      <div className="px-5 pt-5 pb-4 flex flex-col gap-3 flex-1">
        <div className="flex items-center gap-2 pr-12">
          <h3
            className="text-base font-semibold text-on-surface leading-tight truncate"
            title={budget.name}
          >
            {budget.name}
          </h3>
          {budget.measure === "usage" && (
            <span className="flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-sunken text-on-surface-secondary">
              {gt("Usage")}
            </span>
          )}
          {fired && (
            <span
              className="flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-500/15 text-danger"
              title={budget.currentMonthEvents
                .map((e) =>
                  gt("{type} ≥ {percent}%", {
                    type: e.thresholdType,
                    percent: e.thresholdPercent,
                  }),
                )
                .join(", ")}
            >
              {gt("⚠ Alert")}
            </span>
          )}
        </div>

        <div>
          <div className="flex items-baseline justify-between gap-2 mb-1.5">
            <span className="text-xl font-semibold text-on-surface">
              {progress.active ? fmt(actual) : "—"}
            </span>
            <span className="text-xs text-on-surface-faint text-right">
              {limit !== null
                ? gt("of {amount} · {month}", { amount: fmt(limit), month: periodLabel })
                : periodLabel}
            </span>
          </div>

          <div className="relative h-2.5 rounded-full bg-surface-sunken overflow-visible">
            <div
              className={`absolute inset-y-0 left-0 rounded-full ${barColor}`}
              style={{ width: `${Math.min(100, actualPct)}%` }}
            />
            {forecastPct !== null && forecast !== null && forecastPct > actualPct && (
              <div
                className="absolute inset-y-0 border-r-2 border-dashed border-on-surface-faint"
                style={{ left: `${Math.min(100, forecastPct)}%` }}
                title={gt("Forecast: {amount}", { amount: fmt(forecast) })}
              />
            )}
            {budget.thresholds.map((t, i) => (
              <div
                key={i}
                className="absolute -top-0.5 -bottom-0.5 w-px bg-on-surface-faint/60"
                style={{ left: `${Math.min(100, t.percent)}%` }}
                title={gt("{type} threshold at {percent}%", {
                  type: t.type === "actual" ? gt("Actual") : gt("Forecast"),
                  percent: t.percent,
                })}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-3 mt-1.5 text-[11px] text-on-surface-faint">
            <span>{gt("{percent}% used", { percent: actualPct.toFixed(0) })}</span>
            {forecast !== null && (
              <span
                title={
                  budget.scenarioModelName
                    ? gt(
                        'Projected month-end total, including scenario "{scenario}". Trend alone: {trend}',
                        {
                          scenario: budget.scenarioModelName,
                          trend: trendForecast !== null ? fmt(trendForecast) : "—",
                        },
                      )
                    : budget.period
                      ? gt("Projected period-end total based on the recent trend")
                      : gt("Projected month-end total based on the recent trend")
                }
              >
                {gt("Forecast {amount}", { amount: fmt(forecast) })}
                {forecastPct !== null && gt(" ({percent}%)", { percent: forecastPct.toFixed(0) })}
              </span>
            )}
            {/* Named on the card, not just in the tooltip: the figure the
                thresholds fire on contains somebody's assumptions, and that
                has to be visible without hovering. */}
            {budget.scenarioModelName && (
              <span className="text-warning">
                {gt("incl. scenario “{scenario}”", { scenario: budget.scenarioModelName })}
                {trendForecast !== null && gt(" · trend {amount}", { amount: fmt(trendForecast) })}
              </span>
            )}
          </div>

          {budget.rolledUp && (
            <p className="mt-1.5 text-[11px] text-on-surface-faint">
              {gt("Sum of {count} child budgets", { count: budget.childCount ?? 0 })}
            </p>
          )}
          {(budget.hierarchyWarnings ?? []).map((w) => (
            <HierarchyWarning key={w.kind} warning={w} format={fmt} budget={budget} />
          ))}
        </div>

        {childBudgets && childBudgets.length > 0 && <ChildBudgetList budgets={childBudgets} />}
        {/* This month's firings, each with its note (or the way to add one).
            On the card itself rather than behind the badge's tooltip: "did it
            fire" and "do we know why" are read together. */}
        {fired && (onExplain || budget.currentMonthEvents.some((e) => e.note)) && (
          <ul className="flex flex-col gap-1.5 border-t border-border pt-2 text-[11px]">
            {budget.currentMonthEvents.map((e) => (
              <li key={e.id} className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between gap-2 text-on-surface-faint">
                  <span>
                    {gt("{type} {percent}% on {day}", {
                      type: e.thresholdType === "actual" ? gt("Actual") : gt("Forecast"),
                      percent: e.thresholdPercent,
                      day: shortDay(e.triggeredAt),
                    })}
                  </span>
                  {onExplain && (
                    <button
                      type="button"
                      onClick={() => onExplain(e)}
                      className="shrink-0 underline hover:text-on-surface-secondary"
                    >
                      {e.note ? gt("Edit note") : gt("Explain")}
                    </button>
                  )}
                </div>
                {e.note && (
                  <p className="text-on-surface-secondary">
                    <span className="break-words">{e.note.text}</span>{" "}
                    <span className="text-on-surface-faint">
                      {e.note.notedByName
                        ? gt("({name}, {day})", {
                            name: e.note.notedByName,
                            day: shortDay(e.note.notedAt),
                          })
                        : gt("({day})", { day: shortDay(e.note.notedAt) })}
                    </span>
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function HierarchyWarning({
  warning,
  format,
  budget,
}: {
  warning: BudgetHierarchyWarning;
  format: (value: number) => string;
  budget: BudgetWithStatus;
}) {
  const gt = useGT();
  // Both figures are in the API's unit: cents for money, the quantity for usage.
  const scale = budget.measure === "usage" ? 1 : 100;
  const total = format(warning.childTotal / scale);
  const limit = format(warning.parentLimit / scale);
  const text =
    warning.kind === "allocation"
      ? gt("Child budgets allocate {total}, more than this budget's {limit}", { total, limit })
      : warning.kind === "actual"
        ? gt("Child budgets have reached {total}, past this budget's {limit}", { total, limit })
        : gt("Child budgets are forecast to reach {total}, past this budget's {limit}", {
            total,
            limit,
          });
  return (
    <p role="status" className="mt-1 text-[11px] text-warning">
      ⚠ {text}
    </p>
  );
}

/** A dashboard card's collapsed list of its children, one row each. */
function ChildBudgetList({ budgets }: { budgets: BudgetWithStatus[] }) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-border pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-[11px] text-on-surface-secondary hover:text-on-surface"
      >
        {open ? "▾" : "▸"} {gt("{count} child budgets", { count: budgets.length })}
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1.5">
          {budgets.map((child) => (
            <ChildBudgetRow key={child.id} budget={child} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ChildBudgetRow({ budget }: { budget: BudgetWithStatus }) {
  const gt = useGT();
  const progress = budgetProgress(budget);
  const fmt = budgetValueFormatter(budget);
  const pct = progress.actualPercent;
  const color = pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <li className="text-[11px]">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-on-surface-secondary" title={budget.name}>
          {budget.name}
        </span>
        <span className="flex-shrink-0 text-on-surface-faint">
          {progress.limit !== null
            ? gt("{actual} of {limit}", {
                actual: fmt(progress.actual),
                limit: fmt(progress.limit),
              })
            : fmt(progress.actual)}
        </span>
      </div>
      <div className="mt-0.5 h-1 rounded-full bg-surface-sunken overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </li>
  );
}

export interface BudgetWidgetCardProps {
  /** Undefined while the dashboard's budget list is still loading. */
  budget: BudgetWithStatus | undefined;
  onEdit?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
  /** Every budget the dashboard loaded, so a parent's card can list its children. */
  allBudgets?: Iterable<BudgetWithStatus> | undefined;
}

/**
 * A budget widget's slot in the dashboard grid. Budget rows load separately
 * from the widgets that reference them, so the placeholder holds the card's
 * position (and its drag handle) until the row arrives.
 */
export function BudgetWidgetCard({ budget, onEdit, onRemove, allBudgets }: BudgetWidgetCardProps) {
  const gt = useGT();
  if (!budget) {
    return (
      <div className="rounded-2xl border border-border bg-surface-raised flex items-center justify-center text-xs text-on-surface-faint min-h-[140px]">
        {gt("Loading budget…")}
      </div>
    );
  }
  const children = allBudgets
    ? [...allBudgets].filter((b) => b.parentBudgetId === budget.id)
    : undefined;
  return <BudgetCard budget={budget} onEdit={onEdit} onRemove={onRemove} childBudgets={children} />;
}
