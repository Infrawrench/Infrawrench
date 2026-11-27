import { useMemo, useState } from "react";
import { T, Var, useGT } from "gt-react";
import { useDataString } from "../i18n/data-strings.js";
import {
  RUNWAY_STATUSES,
  RUNWAY_STATUS_LABELS,
  formatQuotaUtilization,
  formatRunwayAmount,
  type RunwayListResponse,
  type RunwayRow,
  type RunwayStatus,
} from "@infrawrench/client-core";
import { useRunwayDuration } from "../capacity/duration.js";

export interface RunwaySectionProps {
  /** The runway feed, or null while loading. */
  data: RunwayListResponse | null;
  error?: string | null | undefined;
  onRetry?: (() => void) | undefined;
  /** Open the resource a row belongs to. Omitted, names are plain text. */
  onOpenResource?: ((row: RunwayRow) => void) | undefined;
}

const STATUS_BADGE_CLASSES: Record<RunwayStatus, string> = {
  full: "bg-red-500/10 text-danger",
  critical: "bg-orange-500/10 text-severe",
  watch: "bg-amber-500/10 text-warning",
  ok: "bg-surface-overlay text-on-surface-tertiary",
};

const STATUS_BAR_CLASSES: Record<RunwayStatus, string> = {
  full: "bg-red-500",
  critical: "bg-orange-500",
  watch: "bg-amber-500",
  ok: "bg-on-surface-faint",
};

const STATUS_TEXT_CLASSES: Record<RunwayStatus, string> = {
  full: "text-danger",
  critical: "text-severe",
  watch: "text-warning",
  ok: "text-on-surface-tertiary",
};

/** The countdown cell: days left, the end-of-cycle projection, or why there is neither. */
function RunwayCell({ row }: { row: RunwayRow }) {
  const gt = useGT();
  const duration = useRunwayDuration();
  const tone = STATUS_TEXT_CLASSES[row.status];
  if (row.status === "full") return <span className={tone}>{gt("at the limit")}</span>;
  if (row.forecast.confidence === "short") {
    return (
      <span
        className="text-on-surface-faint"
        title={gt("Not enough history for a trend yet. This doesn't mean there's room.")}
      >
        {gt("no trend yet")}
      </span>
    );
  }
  const noisy = row.forecast.confidence === "noisy";
  const noiseTitle = noisy
    ? gt("The readings scatter as much as they trend, so this is a rough projection.")
    : undefined;
  if (row.kind === "allowance" && row.cycle) {
    const resets = new Date(row.cycle.end).toLocaleDateString();
    if (row.forecast.daysLeft !== null) {
      return (
        <span className={tone} title={noiseTitle}>
          {gt("out in {duration}, resets {date}", {
            duration: duration(row.forecast.daysLeft),
            date: resets,
          })}
        </span>
      );
    }
    return (
      <span className={tone} title={noiseTitle}>
        {gt("{percent} by {date}", {
          percent:
            row.cycle.projectedUtilization !== null
              ? formatQuotaUtilization(row.cycle.projectedUtilization)
              : "n/a",
          date: resets,
        })}
      </span>
    );
  }
  if (row.forecast.daysLeft !== null) {
    return (
      <span className={tone} title={noiseTitle}>
        {duration(row.forecast.daysLeft)}
        {noisy ? " ~" : ""}
      </span>
    );
  }
  if ((row.forecast.perDay ?? 0) > 0) {
    return <span className="text-on-surface-faint">{gt("over a year")}</span>;
  }
  return <span className="text-on-surface-faint">{gt("not rising")}</span>;
}

/** Whose number the limit is, so a published plan allowance never reads as the provider's word. */
function LimitSource({ row }: { row: RunwayRow }) {
  const gt = useGT();
  if (row.limitSource === "plan") {
    return (
      <span
        className="ml-1 text-[11px] text-on-surface-faint"
        title={gt("The provider's published allowance for this plan.")}
      >
        {row.plan ? gt("{plan} plan", { plan: row.plan }) : gt("plan")}
      </span>
    );
  }
  if (row.limitSource === "constant") {
    return (
      <span
        className="ml-1 text-[11px] text-on-surface-faint"
        title={gt("A fixed limit the provider documents for this resource type.")}
      >
        {gt("documented")}
      </span>
    );
  }
  return null;
}

/**
 * Capacity runway: every resource usage a plugin declares against the limit
 * that will stop it, soonest to run out first. Rendered on the Quotas screen
 * under the provider quotas, because both answer "what runs out, and when".
 */
export function RunwaySection({ data, error, onRetry, onOpenResource }: RunwaySectionProps) {
  const gt = useGT();
  const gtData = useDataString();
  const [onlyAtRisk, setOnlyAtRisk] = useState(false);

  const visible = useMemo(
    () => (data ? (onlyAtRisk ? data.rows.filter((r) => r.status !== "ok") : data.rows) : []),
    [data, onlyAtRisk],
  );
  const counts = useMemo(() => {
    const out: Record<RunwayStatus, number> = { full: 0, critical: 0, watch: 0, ok: 0 };
    for (const row of data?.rows ?? []) out[row.status] += 1;
    return out;
  }, [data]);

  return (
    <section aria-labelledby="capacity-runway-heading" className="mt-10">
      <h2 id="capacity-runway-heading" className="text-lg font-semibold mb-4">
        {gt("Capacity runway")}
      </h2>

      {error != null && data === null && (
        <T>
          <div role="alert" className="text-sm text-danger">
            Couldn&apos;t load the capacity runway: <Var>{error}</Var>{" "}
            <Var>
              {onRetry ? (
                <button type="button" onClick={onRetry} className="underline">
                  {gt("Retry")}
                </button>
              ) : null}
            </Var>
          </div>
        </T>
      )}
      {data === null && error == null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Reading recorded usage…")}
        </p>
      )}
      {error != null && data !== null && (
        <T>
          <p role="alert" className="mb-4 text-xs text-danger">
            Couldn&apos;t refresh; showing the last loaded runway. <Var>{error}</Var>
          </p>
        </T>
      )}

      {data !== null &&
        (data.rows.length === 0 ? (
          <p className="text-sm text-on-surface-faint">
            {gt("No resources with a tracked usage and limit yet.")}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div className="flex flex-wrap items-center gap-2">
                {RUNWAY_STATUSES.map((status) => (
                  <span
                    key={status}
                    className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium ${STATUS_BADGE_CLASSES[status]}`}
                  >
                    <span className="tabular-nums">{counts[status]}</span>
                    {gtData(RUNWAY_STATUS_LABELS[status])}
                  </span>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setOnlyAtRisk((v) => !v)}
                aria-pressed={onlyAtRisk}
                className="rounded-lg border border-border px-2.5 py-1 text-xs text-on-surface-tertiary hover:text-on-surface-secondary transition-colors"
              >
                {onlyAtRisk ? gt("Showing at risk only") : gt("Show all")}
              </button>
            </div>

            {visible.length === 0 ? (
              <p className="text-sm text-on-surface-faint">{gt("Nothing is running out.")}</p>
            ) : (
              <div className="border border-border rounded-xl overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-on-surface-faint">
                      <th className="px-4 py-2 font-normal">{gt("Resource")}</th>
                      <th className="px-3 py-2 font-normal">{gt("Usage")}</th>
                      <th className="px-3 py-2 font-normal w-full">{gt("Used")}</th>
                      <th className="px-3 py-2 font-normal text-right">{gt("Of limit")}</th>
                      <th className="px-4 py-2 font-normal text-right">{gt("Runway")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((row) => (
                      <tr
                        key={`${row.resourceId}:${row.key}`}
                        className="border-b border-border last:border-b-0"
                      >
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          {onOpenResource ? (
                            <button
                              type="button"
                              onClick={() => onOpenResource(row)}
                              className="font-medium text-on-surface hover:underline"
                            >
                              {row.resourceName}
                            </button>
                          ) : (
                            <span className="font-medium text-on-surface">{row.resourceName}</span>
                          )}
                          <span className="ml-2 text-xs text-on-surface-tertiary">
                            {row.accountName}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-xs text-on-surface-tertiary">
                          {gtData(row.label)}
                          {row.kind === "allowance" && (
                            <span className="ml-1 text-on-surface-faint">{gt("monthly")}</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <div
                            className="relative h-2 w-full min-w-24 overflow-hidden rounded-full bg-surface-overlay"
                            role="img"
                            aria-label={gt("{value} of the limit used", {
                              value: formatQuotaUtilization(row.utilization),
                            })}
                          >
                            <div
                              className={`h-full rounded-full ${STATUS_BAR_CLASSES[row.status]}`}
                              style={{
                                width: `${Math.min(1, Math.max(0, row.utilization)) * 100}%`,
                              }}
                            />
                          </div>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-right tabular-nums text-on-surface-secondary">
                          {formatRunwayAmount(row.used, row.unit)}
                          <T>
                            <span className="text-on-surface-faint">
                              {" "}
                              / <Var>{formatRunwayAmount(row.limit, row.unit)}</Var>
                            </span>
                          </T>
                          <LimitSource row={row} />
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-right text-xs">
                          <RunwayCell row={row} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="mt-4 text-xs text-on-surface-faint">
              {gt(
                "Recorded on every sync. Trends fit the last {windowDays} days; monthly allowances project to the end of their billing cycle. Alerts at {runwayDays} days of runway or {allowance} of an allowance.",
                {
                  windowDays: data.windowDays,
                  runwayDays: data.runwayDays,
                  allowance: formatQuotaUtilization(data.allowanceThreshold),
                },
              )}
            </p>
          </>
        ))}
    </section>
  );
}
