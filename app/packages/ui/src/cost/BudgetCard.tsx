import { formatMoney } from "./transform.js";
import type { BudgetWithStatus } from "./types.js";

export interface BudgetCardProps {
  budget: BudgetWithStatus;
  onEdit?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
}

/**
 * Budget progress card: month-to-date actual vs the budget amount, a
 * forecast marker, threshold ticks, and an alert badge when a threshold has
 * fired this month. Status colors are reserved for state (on-track /
 * approaching / over) — never used as series colors.
 */
export function BudgetCard({ budget, onEdit, onRemove }: BudgetCardProps) {
  const amount = budget.amountCents / 100;
  const actual = budget.actualCents / 100;
  const forecast = budget.forecastCents === null ? null : budget.forecastCents / 100;

  const actualPct = amount > 0 ? (actual / amount) * 100 : 0;
  const forecastPct = forecast !== null && amount > 0 ? (forecast / amount) * 100 : null;
  const fired = budget.currentMonthEvents.length > 0;

  const barColor =
    actualPct >= 100 ? "bg-red-500" : actualPct >= 80 ? "bg-amber-500" : "bg-emerald-500";
  const monthLabel = new Date(`${budget.month}-01T00:00:00Z`).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <div className="group relative rounded-2xl border border-border bg-surface-raised hover:border-border-strong transition-colors flex flex-col overflow-hidden">
      <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all z-10">
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            title="Edit budget"
            className="size-5 rounded-full text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken text-xs flex items-center justify-center"
          >
            ✎
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            title="Remove from dashboard"
            className="size-5 rounded-full text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken text-xs flex items-center justify-center"
          >
            ✕
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
          {fired && (
            <span
              className="flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-500/15 text-red-400"
              title={budget.currentMonthEvents
                .map((e) => `${e.thresholdType} ≥ ${e.thresholdPercent}%`)
                .join(", ")}
            >
              ⚠ Alert
            </span>
          )}
        </div>

        <div>
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="text-xl font-semibold text-on-surface">
              {formatMoney(actual, budget.currency)}
            </span>
            <span className="text-xs text-on-surface-faint">
              of {formatMoney(amount, budget.currency)} · {monthLabel}
            </span>
          </div>

          <div className="relative h-2.5 rounded-full bg-surface-sunken overflow-visible">
            <div
              className={`absolute inset-y-0 left-0 rounded-full ${barColor}`}
              style={{ width: `${Math.min(100, actualPct)}%` }}
            />
            {forecastPct !== null && forecastPct > actualPct && (
              <div
                className="absolute inset-y-0 border-r-2 border-dashed border-on-surface-faint"
                style={{ left: `${Math.min(100, forecastPct)}%` }}
                title={`Forecast: ${formatMoney(forecast!, budget.currency)}`}
              />
            )}
            {budget.thresholds.map((t, i) => (
              <div
                key={i}
                className="absolute -top-0.5 -bottom-0.5 w-px bg-on-surface-faint/60"
                style={{ left: `${Math.min(100, t.percent)}%` }}
                title={`${t.type === "actual" ? "Actual" : "Forecast"} threshold at ${t.percent}%`}
              />
            ))}
          </div>

          <div className="flex items-center justify-between mt-1.5 text-[11px] text-on-surface-faint">
            <span>{actualPct.toFixed(0)}% used</span>
            {forecast !== null && (
              <span title="Projected month-end total based on the recent trend">
                Forecast {formatMoney(forecast, budget.currency)}
                {amount > 0 && ` (${((forecast / amount) * 100).toFixed(0)}%)`}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
