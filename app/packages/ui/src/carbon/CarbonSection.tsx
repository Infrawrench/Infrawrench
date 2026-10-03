import { useGT } from "gt-react";
import {
  formatCo2e,
  type CarbonEstimate,
  type CarbonUnestimatedReason,
} from "@infrawrench/client-core";

export interface CarbonSectionProps {
  /** The estimate, or null while loading. */
  data: CarbonEstimate | null;
  error?: string | null | undefined;
  onRetry?: (() => void) | undefined;
}

/**
 * The carbon estimate.
 *
 * The design constraint is that nothing here may read as measured. The word
 * "estimated" is in the heading, the assumptions are on the page rather than
 * behind a tooltip, and the resources that could not be estimated are counted
 * beside the total rather than tucked at the bottom, because a total that
 * silently covered two thirds of an estate is the failure mode this page has.
 */
export function CarbonSection({ data, error, onRetry }: CarbonSectionProps) {
  const gt = useGT();
  const reasonLabel: Record<CarbonUnestimatedReason, string> = {
    "unsupported-provider": gt("No grid data for this provider"),
    "unknown-region": gt("Region not covered"),
    "unknown-size": gt("Size unknown"),
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-semibold mb-1">{gt("Estimated carbon")}</h2>
        <p className="text-sm text-on-surface-muted">
          {gt("Processor emissions from published grid figures. Not measured.")}
        </p>
      </div>

      {error != null && data === null && (
        <div role="alert" className="text-sm text-danger">
          {gt("Couldn't load: {error}", { error })}{" "}
          {onRetry && (
            <button type="button" onClick={onRetry} className="underline">
              {gt("Retry")}
            </button>
          )}
        </div>
      )}
      {data === null && error == null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Estimating…")}
        </p>
      )}

      {data !== null && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border p-4">
              <div className="text-xs text-on-surface-faint">
                {gt("Over {days} days", { days: data.windowDays })}
              </div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-on-surface">
                {formatCo2e(data.totalKgCo2e)}
              </div>
              <div className="mt-1 text-xs text-on-surface-tertiary">
                {gt("{kwh} kWh", { kwh: Math.round(data.totalKwh) })}
              </div>
            </div>
            <div className="rounded-xl border border-border p-4">
              <div className="text-xs text-on-surface-faint">{gt("Estimated")}</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-on-surface">
                {data.estimatedCount}
              </div>
            </div>
            <div className="rounded-xl border border-border p-4">
              <div className="text-xs text-on-surface-faint">{gt("Not estimated")}</div>
              {/* Beside the total, not at the bottom: a figure covering a third
                  of an estate must not look like a complete answer. */}
              <div
                className={`mt-1 text-2xl font-semibold tabular-nums ${
                  data.unestimatedCount > 0 ? "text-warning" : "text-on-surface"
                }`}
              >
                {data.unestimatedCount}
              </div>
              {data.duplicateCount > 0 && (
                <div className="mt-1 text-xs text-on-surface-tertiary">
                  {gt("{count} duplicate nodes skipped", { count: data.duplicateCount })}
                </div>
              )}
            </div>
          </div>

          {data.byProvider.length > 1 && (
            <div>
              <h3 className="mb-2 text-sm font-medium text-on-surface">{gt("By provider")}</h3>
              <ul className="flex flex-col gap-1 text-xs">
                {data.byProvider.map((group) => (
                  <li key={group.key} className="flex flex-wrap items-baseline gap-2">
                    <span className="text-on-surface">{group.label}</span>
                    <span className="tabular-nums text-on-surface-secondary">
                      {formatCo2e(group.kgCo2e)}
                    </span>
                    <span className="text-on-surface-faint">
                      {gt("{count} resources", { count: group.resourceCount })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.byRegion.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium text-on-surface">{gt("By region")}</h3>
              <ul className="flex flex-col gap-1 text-xs">
                {data.byRegion.slice(0, 5).map((group) => (
                  <li key={group.key} className="flex flex-wrap items-baseline gap-2">
                    <span className="text-on-surface">{group.label}</span>
                    <span className="tabular-nums text-on-surface-secondary">
                      {formatCo2e(group.kgCo2e)}
                    </span>
                    <span className="text-on-surface-faint">
                      {gt("{count} resources", { count: group.resourceCount })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.rows.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium text-on-surface">
                {gt("Heaviest resources")}
              </h3>
              <ul className="flex flex-col gap-1 text-xs">
                {data.rows.slice(0, 5).map((row) => (
                  <li key={row.resourceId} className="flex flex-wrap items-baseline gap-2">
                    <span className="text-on-surface">{row.displayName}</span>
                    <span className="tabular-nums text-on-surface-secondary">
                      {formatCo2e(row.kgCo2e)}
                    </span>
                    <span className="text-on-surface-faint">{row.gridZone}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.byAccount.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium text-on-surface">{gt("By account")}</h3>
              <ul className="flex flex-col gap-1 text-xs">
                {data.byAccount.slice(0, 5).map((group) => (
                  <li key={group.key} className="flex flex-wrap items-baseline gap-2">
                    <span className="text-on-surface">{group.label}</span>
                    <span className="tabular-nums text-on-surface-secondary">
                      {formatCo2e(group.kgCo2e)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.unestimated.length > 0 && (
            <details className="text-xs text-on-surface-tertiary">
              <summary className="cursor-pointer">
                {gt("Why {count} were not estimated", { count: data.unestimatedCount })}
              </summary>
              <ul className="mt-2 flex flex-col gap-1">
                {data.unestimated.slice(0, 50).map((row) => (
                  <li key={row.resourceId} className="flex flex-wrap items-baseline gap-2">
                    <span className="text-on-surface">{row.displayName}</span>
                    <span className="text-on-surface-faint">{reasonLabel[row.reason]}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {/* The basis stays on the page, but as two lines, not a box. */}
          <p className="text-xs text-on-surface-faint">
            {gt("Assumes {percent}% CPU utilisation. PUE: {pue}.", {
              percent: Math.round(data.assumptions.cpuUtilization * 100),
              pue: Object.entries(data.assumptions.pue)
                .map(([grid, pue]) => `${grid} ${pue}`)
                .join(", "),
            })}{" "}
            {gt("Grid figures: {source}.", { source: data.assumptions.coefficientVintage })}
          </p>
        </>
      )}
    </div>
  );
}
