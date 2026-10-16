import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  COST_FORECAST_CONFIDENCE_LEVELS,
  FORECAST_COLOR,
  SERIES_COLORS,
  costForecastComparisonRows,
  formatBucketLabel,
  formatMoney,
  hasForecastBand,
  type CostForecast,
  type CostForecastConfidenceLevel,
  type CostForecastInput,
  type CostForecastResult,
  type CostForecastSeries,
  type CostForecastTotal,
} from "@infrawrench/client-core";
import { useChartTheme } from "../chart-theme.js";
import { niceAxis } from "../components/charts/nice-axis.js";
import { CostForecastModal } from "./CostForecastModal.js";
import type { CostReportsClient } from "./types.js";

/**
 * Named forecasts rotate through the series colours minus the automatic
 * forecast's own: it is the first series colour, so the first named forecast
 * drew in the same blue as the line it is compared against.
 */
const NAMED_FORECAST_COLORS = SERIES_COLORS.filter((c) => c !== FORECAST_COLOR);

const selectClass =
  "rounded-lg border border-border bg-surface-sunken px-2 py-1 text-xs text-on-surface focus:outline-none focus:border-blue-500";

/** Horizons offered, in days past the last observed day. */
const HORIZONS = [30, 90, 180, 365] as const;

/** Key for the selected forecast in chart rows; `null` (baseline) maps to this. */
const BASELINE_KEY = "__baseline__";

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function seriesKey(s: CostForecastSeries): string {
  return s.forecastId ?? BASELINE_KEY;
}

export interface ReportForecastsSectionProps {
  reportId: string;
  client: CostReportsClient;
}

/**
 * The report's Forecasts view: the automatic forecast and every named one,
 * side by side, with the selected one's band drawn around its line and a table
 * of window totals (low / expected / high, and the difference from the
 * automatic forecast). Opens on the report's default forecast.
 *
 * Renders nothing when the host has not wired the forecast reads.
 */
export function ReportForecastsSection({ reportId, client }: ReportForecastsSectionProps) {
  const gt = useGT();
  const uid = useId();
  const chart = useChartTheme();
  const list = client.listCostForecasts;
  const run = client.runCostForecast;
  const canWrite = Boolean(
    client.createCostForecast && client.updateCostForecast && client.deleteCostForecast,
  );

  const [forecasts, setForecasts] = useState<CostForecast[] | null>(null);
  const [result, setResult] = useState<CostForecastResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [horizon, setHorizon] = useState<(typeof HORIZONS)[number]>(90);
  const [level, setLevel] = useState<CostForecastConfidenceLevel>(80);
  /** The series whose band is drawn; undefined follows the report's default. */
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<{ forecast: CostForecast | null } | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!list || !run) return;
    try {
      const [rows, firstPass] = await Promise.all([
        list(reportId),
        run(reportId, { all: true, confidenceLevel: level }),
      ]);
      // The default window is 90 days from the last observed day; anything
      // else re-asks with an explicit `to` anchored on that same day.
      const anchor = firstPass.lastObservedDay;
      const res =
        horizon === 90 || !anchor
          ? firstPass
          : await run(reportId, {
              all: true,
              confidenceLevel: level,
              to: addDays(anchor, horizon),
            });
      setForecasts(rows);
      setResult(res);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [list, run, reportId, horizon, level]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rows = useMemo(() => (result ? costForecastComparisonRows(result) : []), [result]);
  const selectedKey =
    selected ?? (result?.forecast.forecastId ? result.forecast.forecastId : BASELINE_KEY);
  const selectedSeries = rows.find((r) => seriesKey(r) === selectedKey) ?? rows[0];
  const currency = result?.currency ?? "USD";
  const fmt = (n: number) => formatMoney(n, currency);
  const colorOf = (s: CostForecastSeries, i: number) =>
    s.forecastId === null
      ? FORECAST_COLOR
      : NAMED_FORECAST_COLORS[(i - 1) % NAMED_FORECAST_COLORS.length]!;

  const chartRows = useMemo(() => {
    const byDay = new Map<string, Record<string, number | string | null>>();
    for (const s of rows) {
      for (const p of s.points) {
        const row = byDay.get(p.day) ?? { bucket: p.day };
        row[seriesKey(s)] = p.expected;
        if (selectedSeries && seriesKey(s) === seriesKey(selectedSeries)) {
          row["__low__"] = p.low;
          row["__high__"] = p.high;
        }
        byDay.set(p.day, row);
      }
    }
    return [...byDay.values()].sort((a, b) => (String(a["bucket"]) < String(b["bucket"]) ? -1 : 1));
  }, [rows, selectedSeries]);

  const yScale = useMemo(() => {
    let max = 0;
    for (const row of chartRows) {
      for (const [k, v] of Object.entries(row)) {
        if (k !== "bucket" && typeof v === "number" && v > max) max = v;
      }
    }
    return niceAxis(0, max);
  }, [chartRows]);

  async function save(input: CostForecastInput) {
    if (!editing) return;
    if (editing.forecast) {
      await client.updateCostForecast?.(reportId, editing.forecast.id, input);
    } else {
      await client.createCostForecast?.(reportId, input);
    }
    setEditing(null);
    await refresh();
  }

  async function makeDefault(forecast: CostForecast) {
    setRowError(null);
    try {
      await client.updateCostForecast?.(reportId, forecast.id, {
        name: forecast.name,
        description: forecast.description,
        scenarioModelIds: forecast.scenarioModelIds,
        driverMetricId: forecast.driverMetricId,
        isDefault: !forecast.isDefault,
      });
      setSelected(undefined);
      await refresh();
    } catch (e: unknown) {
      setRowError(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove(forecast: CostForecast) {
    if (!window.confirm(gt('Delete the forecast "{name}"?', { name: forecast.name }))) return;
    setRowError(null);
    try {
      await client.deleteCostForecast?.(reportId, forecast.id);
      if (selected === forecast.id) setSelected(undefined);
      await refresh();
    } catch (e: unknown) {
      setRowError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!list || !run) return null;

  const rangeText = (t: CostForecastTotal) =>
    hasForecastBand(t) ? gt("{low} to {high}", { low: fmt(t.low), high: fmt(t.high) }) : "–";

  return (
    <section className="flex flex-col gap-2" aria-labelledby={`${uid}-title`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3
          id={`${uid}-title`}
          className="text-xs font-semibold uppercase tracking-wide text-on-surface-faint"
        >
          {gt("Forecasts")}
        </h3>
        <div className="flex flex-wrap items-center gap-2 text-xs text-on-surface-faint">
          <label className="flex items-center gap-1">
            {gt("Horizon")}
            <select
              className={selectClass}
              value={horizon}
              onChange={(e) => setHorizon(Number(e.target.value) as (typeof HORIZONS)[number])}
            >
              {HORIZONS.map((h) => (
                <option key={h} value={h}>
                  {gt("{days} days", { days: h })}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            {gt("Range")}
            <select
              className={selectClass}
              value={level}
              onChange={(e) => setLevel(Number(e.target.value) as CostForecastConfidenceLevel)}
            >
              {COST_FORECAST_CONFIDENCE_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {gt("{level}% interval", { level: l })}
                </option>
              ))}
            </select>
          </label>
          {canWrite && (
            <button
              type="button"
              onClick={() => setEditing({ forecast: null })}
              className="underline hover:text-on-surface-secondary"
            >
              {gt("New forecast")}
            </button>
          )}
        </div>
      </div>

      {error !== null && (
        <div role="alert" className="text-xs text-danger">
          {error}
        </div>
      )}
      {rowError !== null && (
        <div role="alert" className="text-xs text-danger">
          {rowError}
        </div>
      )}
      {result === null && error === null && (
        <p role="status" className="text-xs text-on-surface-faint">
          {gt("Projecting…")}
        </p>
      )}

      {result && (
        <>
          <p className="text-[11px] text-on-surface-faint">
            {result.lastObservedDay
              ? gt(
                  "From {from} to {to}, projected from spend through {last}. The shaded band is the {level}% prediction interval of the selected forecast.",
                  {
                    from: result.from,
                    to: result.to,
                    last: result.lastObservedDay,
                    level: result.confidenceLevel,
                  },
                )
              : gt("No spend has been collected for this report's scope yet.")}
          </p>

          {chartRows.length > 0 && (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartRows} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} vertical={false} />
                  <XAxis
                    dataKey="bucket"
                    tickFormatter={(b: string) => formatBucketLabel(b, "daily")}
                    tick={{ fill: chart.tick, fontSize: 11 }}
                    stroke={chart.axis}
                    minTickGap={24}
                  />
                  <YAxis
                    tick={{ fill: chart.tick, fontSize: 11 }}
                    stroke={chart.axis}
                    tickFormatter={(v: number) => fmt(v)}
                    domain={yScale.domain}
                    ticks={yScale.ticks}
                    width={70}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: chart.tooltipBg,
                      border: `1px solid ${chart.tooltipBorder}`,
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    labelFormatter={(b) => formatBucketLabel(String(b), "daily")}
                    formatter={(value, name) => {
                      if (String(name) === "__band__" && Array.isArray(value)) {
                        return [
                          gt("{low} to {high}", {
                            low: fmt(Number(value[0])),
                            high: fmt(Number(value[1])),
                          }),
                          gt("{level}% range", { level: result.confidenceLevel }),
                        ];
                      }
                      const s = rows.find((r) => seriesKey(r) === String(name));
                      return [fmt(Number(value)), s?.name ?? String(name)];
                    }}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 11 }}
                    formatter={(value: string) => (
                      <span style={{ color: chart.tick }}>
                        {rows.find((r) => seriesKey(r) === value)?.name ?? value}
                      </span>
                    )}
                  />
                  <Area
                    type="monotone"
                    dataKey={(row: Record<string, unknown>) =>
                      typeof row["__low__"] === "number" && typeof row["__high__"] === "number"
                        ? [row["__low__"], row["__high__"]]
                        : null
                    }
                    name="__band__"
                    stroke="none"
                    fill={
                      selectedSeries
                        ? colorOf(selectedSeries, rows.indexOf(selectedSeries))
                        : FORECAST_COLOR
                    }
                    fillOpacity={0.15}
                    legendType="none"
                    isAnimationActive={false}
                    activeDot={false}
                  />
                  {rows.map((s, i) => (
                    <Line
                      key={seriesKey(s)}
                      type="monotone"
                      dataKey={seriesKey(s)}
                      name={seriesKey(s)}
                      stroke={colorOf(s, i)}
                      strokeWidth={seriesKey(s) === selectedKey ? 2.5 : 1.5}
                      {...(s.forecastId === null ? { strokeDasharray: "5 5" } : {})}
                      dot={false}
                      isAnimationActive={false}
                    />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-on-surface-faint">
                  <th className="py-1 pr-2 font-medium">{gt("Forecast")}</th>
                  <th className="py-1 pr-2 font-medium text-right">{gt("Expected")}</th>
                  <th className="py-1 pr-2 font-medium text-right">
                    {gt("{level}% range", { level: result.confidenceLevel })}
                  </th>
                  <th className="py-1 pr-2 font-medium text-right">{gt("vs automatic")}</th>
                  <th className="py-1 font-medium" />
                </tr>
              </thead>
              <tbody>
                {rows.map((s, i) => {
                  const stored = forecasts?.find((f) => f.id === s.forecastId) ?? null;
                  const isSelected = seriesKey(s) === selectedKey;
                  return (
                    <tr key={seriesKey(s)} className="border-t border-border align-top">
                      <td className="py-1.5 pr-2">
                        <button
                          type="button"
                          onClick={() => setSelected(seriesKey(s))}
                          aria-pressed={isSelected}
                          className={`inline-flex items-center gap-1.5 text-left ${isSelected ? "font-semibold text-on-surface" : "text-on-surface-secondary hover:text-on-surface"}`}
                        >
                          <span
                            aria-hidden
                            className="inline-block size-2 rounded-full"
                            style={{ backgroundColor: colorOf(s, i) }}
                          />
                          {s.forecastId === null ? gt("Automatic (trend)") : s.name}
                        </button>
                        {s.isDefault && (
                          <span className="ml-1.5 rounded bg-surface-sunken px-1 py-0.5 text-[10px] text-on-surface-faint">
                            {gt("Default")}
                          </span>
                        )}
                        {s.driver && (
                          <span className="block text-[11px] text-on-surface-faint">
                            {s.driver.unitCost !== null
                              ? gt("Driven by {metric}: {cost} per {unit}", {
                                  metric: s.driver.metricName,
                                  cost: formatMoney(s.driver.unitCost, currency),
                                  unit: s.driver.metricUnit,
                                })
                              : gt("Driven by {metric}", { metric: s.driver.metricName })}
                          </span>
                        )}
                        {s.scenarios.length > 0 && (
                          <span className="block text-[11px] text-on-surface-faint">
                            {s.scenarios
                              .map(
                                (m) =>
                                  `${m.modelName} (${m.totalDelta >= 0 ? "+" : "−"}${fmt(Math.abs(m.totalDelta))})`,
                              )
                              .join(" → ")}
                          </span>
                        )}
                        {s.warnings.map((w) => (
                          <span key={w} className="block text-[11px] text-warning">
                            {w}
                          </span>
                        ))}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-on-surface">
                        {fmt(s.total.expected)}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-on-surface-secondary">
                        {rangeText(s.total)}
                      </td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-on-surface-secondary">
                        {s.forecastId === null
                          ? "–"
                          : `${s.deltaFromBaseline >= 0 ? "+" : "−"}${fmt(Math.abs(s.deltaFromBaseline))}`}
                      </td>
                      <td className="py-1.5 text-right whitespace-nowrap">
                        {canWrite && stored && (
                          <span className="inline-flex gap-2 text-on-surface-faint">
                            <button
                              type="button"
                              onClick={() => void makeDefault(stored)}
                              className="underline hover:text-on-surface-secondary"
                            >
                              {stored.isDefault ? gt("Unset default") : gt("Make default")}
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditing({ forecast: stored })}
                              className="underline hover:text-on-surface-secondary"
                            >
                              {gt("Edit")}
                            </button>
                            <button
                              type="button"
                              onClick={() => void remove(stored)}
                              className="underline hover:text-danger"
                            >
                              {gt("Delete")}
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {forecasts?.length === 0 && (
            <p className="text-[11px] text-on-surface-faint">
              {canWrite
                ? gt(
                    "Only the automatic forecast so far. Add a named forecast to compare a plan against it: stack scenario models, or drive it from a business metric's planned values.",
                  )
                : gt("Only the automatic forecast so far.")}
            </p>
          )}
        </>
      )}

      {editing && (
        <CostForecastModal
          forecast={editing.forecast}
          client={client}
          onSave={save}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
