import { useGT, T } from "gt-react";
import {
  CARBON_UNESTIMATED_LABELS,
  formatCo2e,
  type CarbonEstimate,
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
 * beside the total rather than tucked at the bottom — because a total that
 * silently covered two thirds of an estate is the failure mode this page has.
 */
export function CarbonSection({ data, error, onRetry }: CarbonSectionProps) {
  const gt = useGT();

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-lg font-semibold mb-1">{gt("Estimated carbon")}</h2>
        <T>
          <p className="text-sm text-on-surface-muted">
            An estimate of the emissions from running your compute, using published grid figures for
            each region. It is not measured, and it does not cover storage, network or the emissions
            from manufacturing the hardware.
          </p>
        </T>
      </div>

      {error != null && data === null && (
        <div role="alert" className="text-sm text-danger">
          {gt("Couldn't load the carbon estimate — {error}", { error })}{" "}
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
              <div className="text-xs text-on-surface-faint">{gt("Resources estimated")}</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums text-on-surface">
                {data.estimatedCount}
              </div>
            </div>
            <div className="rounded-xl border border-border p-4">
              <div className="text-xs text-on-surface-faint">{gt("Could not be estimated")}</div>
              {/* Beside the total, not at the bottom: a figure covering a third
                  of an estate must not look like a complete answer. */}
              <div
                className={`mt-1 text-2xl font-semibold tabular-nums ${
                  data.unestimated.length > 0 ? "text-warning" : "text-on-surface"
                }`}
              >
                {data.unestimated.length}
              </div>
            </div>
          </div>

          {data.byRegion.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium text-on-surface">{gt("By region")}</h3>
              <ul className="flex flex-col gap-1 text-xs">
                {data.byRegion.slice(0, 12).map((group) => (
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

          {data.byAccount.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium text-on-surface">{gt("By account")}</h3>
              <ul className="flex flex-col gap-1 text-xs">
                {data.byAccount.slice(0, 12).map((group) => (
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
                {gt("{count} resources with no estimate, and why", {
                  count: data.unestimated.length,
                })}
              </summary>
              <ul className="mt-2 flex flex-col gap-1">
                {data.unestimated.slice(0, 50).map((row) => (
                  <li key={row.resourceId} className="flex flex-wrap items-baseline gap-2">
                    <span className="text-on-surface">{row.displayName}</span>
                    <span className="text-on-surface-faint">
                      {CARBON_UNESTIMATED_LABELS[row.reason]}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="rounded-xl border border-border p-4 text-xs text-on-surface-tertiary">
            <h3 className="mb-2 text-sm font-medium text-on-surface">{gt("What this rests on")}</h3>
            <ul className="flex flex-col gap-1">
              <li>
                {gt("Assumed average CPU utilisation: {percent}%", {
                  percent: Math.round(data.assumptions.cpuUtilization * 100),
                })}
              </li>
              {Object.entries(data.assumptions.pue).map(([plugin, pue]) => (
                <li key={plugin}>
                  {gt("{plugin} datacentre overhead (PUE): {pue}", { plugin, pue })}
                </li>
              ))}
              <li>
                {gt("Grid figures: {source} ({vintage})", {
                  source: data.assumptions.coefficientSource,
                  vintage: data.assumptions.coefficientVintage,
                })}
              </li>
              <li>{data.assumptions.scope}</li>
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
