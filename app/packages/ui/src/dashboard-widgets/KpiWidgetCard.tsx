import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import {
  formatDashboardKpiChange,
  formatDashboardKpiChangePercent,
  formatDashboardKpiValue,
  kpiChangeTone,
  type DashboardKpiResult,
  type KpiWidgetConfig,
} from "@infrawrench/client-core";
import { ArrowIcon, CloseIcon } from "../components/icons/ChromeIcons.js";
import { kpiMeasureSummary } from "./labels.js";

/** Evaluates one KPI config on the host's transport (`POST /dashboards/kpi`). */
export type DashboardKpiEvaluator = (config: KpiWidgetConfig) => Promise<DashboardKpiResult>;

function windowLabel(from: string | undefined, to: string | undefined): string | null {
  if (!from || !to) return null;
  return from === to ? from : `${from} – ${to}`;
}

/** The change badge: signed absolute and percent, coloured by whether up is good. */
export function KpiChangeBadge({ result }: { result: DashboardKpiResult }) {
  const gt = useGT();
  const absolute = formatDashboardKpiChange(result);
  if (absolute === null) return null;
  const percent = formatDashboardKpiChangePercent(result.changePercent);
  const tone = kpiChangeTone(result);
  const colour =
    tone === "good" ? "text-success" : tone === "bad" ? "text-danger" : "text-on-surface-faint";
  const previous = formatDashboardKpiValue({ ...result, value: result.previous });
  const window = windowLabel(result.previousFrom, result.previousTo);
  return (
    <p
      className="flex flex-wrap items-center gap-x-1.5 text-xs"
      title={
        window
          ? gt("Previous: {value} ({window})", { value: previous, window })
          : gt("Previous: {value}", { value: previous })
      }
    >
      <span className={`inline-flex items-center gap-0.5 font-medium tabular-nums ${colour}`}>
        {result.change !== 0 && (
          <ArrowIcon direction={(result.change ?? 0) > 0 ? "up" : "down"} size={11} />
        )}
        {absolute}
        {percent ? ` (${percent})` : ""}
      </span>
      <span className="text-on-surface-faint">{gt("vs previous period")}</span>
      {/* Colour is not the only signal of which way is good. */}
      {tone !== "neutral" && (
        <span className="sr-only">
          {tone === "good" ? gt("an improvement") : gt("a deterioration")}
        </span>
      )}
    </p>
  );
}

/**
 * A `kpi` dashboard card: one big number, what it measures and over which
 * window, and the change against the previous window. Web and desktop both
 * render this; the host supplies `evaluate` over its own transport.
 */
export function KpiWidgetCard({
  title,
  config,
  evaluate,
  reloadToken = 0,
  onEdit,
  onRemove,
}: {
  title: string;
  config: KpiWidgetConfig;
  /** Omitted by a host with no cloud connection: the card says so. */
  evaluate?: DashboardKpiEvaluator | undefined;
  /** Bump to re-evaluate without a config change. */
  reloadToken?: number | undefined;
  onEdit?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
}) {
  const gt = useGT();
  const key = JSON.stringify(config);
  const [state, setState] = useState<{
    forKey: string;
    result: DashboardKpiResult | null;
    error: string | null;
  }>({ forKey: "", result: null, error: null });

  useEffect(() => {
    if (!evaluate) return;
    let cancelled = false;
    evaluate(JSON.parse(key) as KpiWidgetConfig)
      .then((result) => {
        if (!cancelled) setState({ forKey: key, result, error: null });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState({
            forKey: key,
            result: null,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [evaluate, key, reloadToken]);

  const current = state.forKey === key ? state : null;
  const result = current?.result ?? null;
  const summary = kpiMeasureSummary(gt, config);
  const subtitle = [
    result?.sourceName,
    title ? summary : null,
    windowLabel(result?.from, result?.to),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="group relative rounded-2xl border border-border bg-surface-raised hover:border-border-strong transition-colors flex flex-col overflow-hidden p-5 gap-1 min-h-[9rem]">
      <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all z-10">
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            title={gt("Edit KPI")}
            aria-label={gt("Edit KPI")}
            className="size-5 rounded-full text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken text-xs flex items-center justify-center focus-visible:opacity-100"
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
            className="size-5 rounded-full text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken text-xs flex items-center justify-center focus-visible:opacity-100"
          >
            <CloseIcon size={12} />
          </button>
        )}
      </div>

      <h3 className="text-sm font-medium text-on-surface-secondary truncate pr-12">
        {title || summary}
      </h3>
      {subtitle && <p className="text-[11px] text-on-surface-faint truncate">{subtitle}</p>}

      <div className="mt-auto pt-2 flex flex-col gap-1">
        {!evaluate ? (
          <p className="text-sm text-on-surface-faint">
            {gt("KPIs are measured in Infrawrench Cloud.")}
          </p>
        ) : current?.error ? (
          <p role="alert" className="text-xs text-danger">
            {current.error}
          </p>
        ) : !result ? (
          <>
            <div className="h-8 w-28 rounded bg-surface-sunken animate-pulse" />
            <span role="status" className="sr-only">
              {gt("Loading")}
            </span>
          </>
        ) : (
          <>
            <p className="text-3xl font-semibold text-on-surface tabular-nums leading-tight break-words">
              {formatDashboardKpiValue(result)}
            </p>
            {result.limit !== undefined && result.limit !== null && (
              <p className="text-xs text-on-surface-muted">
                {gt("of {limit} budget", {
                  limit: formatDashboardKpiValue({ ...result, value: result.limit }),
                })}
              </p>
            )}
            {config.comparePreviousPeriod && <KpiChangeBadge result={result} />}
            {result.note && <p className="text-[11px] text-on-surface-faint">{result.note}</p>}
          </>
        )}
      </div>
    </div>
  );
}
