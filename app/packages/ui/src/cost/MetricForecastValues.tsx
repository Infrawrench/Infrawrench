import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { FORECAST_COLOR, SERIES_COLORS, formatBucketLabel } from "@infrawrench/client-core";
import { useChartTheme } from "../chart-theme.js";
import { niceAxis } from "../components/charts/nice-axis.js";
import type { BusinessMetric, BusinessMetricForecastValue, BusinessMetricValue } from "./config.js";
import { MetricCsvImportModal } from "./MetricCsvImportModal.js";
import type { CostsClient } from "./types.js";

const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";

const ACTUAL_KEY = "__actual__";
const PLANNED_KEY = "__planned__";

/**
 * A metric's reported actuals (solid) beside its forecasted values (dashed),
 * on one axis. Actuals are summed across labels per day, the number a unit
 * cost divides by; the forecast has one value per day.
 */
export function MetricValuesChart({
  actuals,
  planned,
  unit,
}: {
  actuals: readonly BusinessMetricValue[];
  planned: readonly BusinessMetricForecastValue[];
  unit: string;
}) {
  const gt = useGT();
  const chart = useChartTheme();
  const rows = useMemo(() => {
    const byDay = new Map<string, Record<string, string | number>>();
    for (const v of actuals) {
      const row = byDay.get(v.day) ?? { bucket: v.day };
      row[ACTUAL_KEY] = ((row[ACTUAL_KEY] as number | undefined) ?? 0) + v.value;
      byDay.set(v.day, row);
    }
    for (const v of planned) {
      const row = byDay.get(v.day) ?? { bucket: v.day };
      row[PLANNED_KEY] = v.value;
      byDay.set(v.day, row);
    }
    return [...byDay.values()].sort((a, b) => (String(a["bucket"]) < String(b["bucket"]) ? -1 : 1));
  }, [actuals, planned]);
  const yScale = useMemo(() => {
    let max = 0;
    for (const r of rows) {
      for (const key of [ACTUAL_KEY, PLANNED_KEY]) {
        const v = r[key];
        if (typeof v === "number" && v > max) max = v;
      }
    }
    return niceAxis(0, max);
  }, [rows]);
  if (rows.length === 0) return null;
  const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return (
    <div
      className="h-40"
      role="img"
      aria-label={gt("{actual} reported days and {planned} forecasted days, in {unit}s", {
        actual: new Set(actuals.map((a) => a.day)).size,
        planned: planned.length,
        unit,
      })}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} vertical={false} />
          <XAxis
            dataKey="bucket"
            tickFormatter={(b: string) => formatBucketLabel(b, "daily")}
            tick={{ fill: chart.tick, fontSize: 10 }}
            stroke={chart.axis}
            minTickGap={24}
          />
          <YAxis
            tick={{ fill: chart.tick, fontSize: 10 }}
            stroke={chart.axis}
            domain={yScale.domain}
            ticks={yScale.ticks}
            tickFormatter={fmt}
            width={48}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: chart.tooltipBg,
              border: `1px solid ${chart.tooltipBorder}`,
              borderRadius: 8,
              fontSize: 12,
            }}
            labelFormatter={(b) => formatBucketLabel(String(b), "daily")}
            formatter={(value, name) => [
              fmt(Number(value)),
              String(name) === PLANNED_KEY ? gt("Forecast") : gt("Reported"),
            ]}
          />
          <Line
            type="monotone"
            dataKey={ACTUAL_KEY}
            name={ACTUAL_KEY}
            stroke={SERIES_COLORS[0]!}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey={PLANNED_KEY}
            name={PLANNED_KEY}
            stroke={FORECAST_COLOR}
            strokeWidth={2}
            strokeDasharray="5 5"
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * The Forecast tab of a metric's values: the planned future values a report
 * forecast driven by this metric multiplies its projected unit cost by.
 * Entered row by row here, from a CSV, or over the API.
 */
export function MetricForecastValuesPanel({
  metric,
  client,
  actuals,
}: {
  metric: BusinessMetric;
  client: CostsClient;
  actuals: readonly BusinessMetricValue[];
}) {
  const gt = useGT();
  const uid = useId();
  const load = client.listBusinessMetricForecastValues;
  const write = client.writeBusinessMetricForecastValues;
  const remove = client.deleteBusinessMetricForecastValues;
  const [values, setValues] = useState<BusinessMetricForecastValue[] | null>(null);
  const [day, setDay] = useState(() =>
    new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
  );
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const refresh = useCallback(async () => {
    if (!load) return;
    try {
      setValues(await load(metric.id));
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [load, metric.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function submit() {
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setError(gt("Enter a number of zero or more."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await write?.(metric.id, [{ date: day, value: parsed }]);
      setAmount("");
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteDay(target: string) {
    setError(null);
    try {
      await remove?.(metric.id, { from: target, to: target });
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function clearAll() {
    if (!window.confirm(gt("Delete every forecasted value for {name}?", { name: metric.name }))) {
      return;
    }
    setError(null);
    try {
      await remove?.(metric.id, {});
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!load) return null;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-on-surface-faint">
        {gt(
          "Planned values for future days, in {unit}s. They never feed unit costs or alerts; a report forecast driven by this metric multiplies its projected cost per {unit} by them.",
          { unit: metric.unit },
        )}
      </p>

      <MetricValuesChart actuals={actuals} planned={values ?? []} unit={metric.unit} />

      {error !== null && (
        <div role="alert" className="text-sm text-danger">
          {error}
        </div>
      )}

      {write && (
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className={labelClass} htmlFor={`${uid}-day`}>
              {gt("Day")}
            </label>
            <input
              id={`${uid}-day`}
              type="date"
              className={inputClass}
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />
          </div>
          <div className="flex-1">
            <label className={labelClass} htmlFor={`${uid}-value`}>
              {gt("Forecast")}
            </label>
            <input
              id={`${uid}-value`}
              className={inputClass}
              value={amount}
              inputMode="decimal"
              onChange={(e) => setAmount(e.target.value)}
              placeholder="1200"
            />
          </div>
          <button
            type="button"
            disabled={busy || amount.trim() === ""}
            onClick={() => void submit()}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {gt("Save")}
          </button>
        </div>
      )}
      {write && (
        <div className="flex items-center justify-between text-xs">
          <button
            type="button"
            onClick={() => setUploading(true)}
            className="text-on-surface-secondary underline hover:text-on-surface"
          >
            {gt("Upload forecast CSV")}
          </button>
          {remove && (values?.length ?? 0) > 0 && (
            <button
              type="button"
              onClick={() => void clearAll()}
              className="text-on-surface-faint underline hover:text-danger"
            >
              {gt("Clear all")}
            </button>
          )}
        </div>
      )}

      {values === null && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading forecast…")}
        </p>
      )}
      {values?.length === 0 && (
        <p className="text-sm text-on-surface-faint">{gt("No forecasted values yet.")}</p>
      )}
      <ul className="flex flex-col">
        {(values ?? []).map((value) => (
          <li
            key={value.day}
            className="flex items-center justify-between gap-3 border-b border-border py-1.5 text-sm last:border-0"
          >
            <button
              type="button"
              className="text-on-surface-secondary hover:text-on-surface"
              title={gt("Edit this day")}
              onClick={() => {
                setDay(value.day);
                setAmount(String(value.value));
              }}
            >
              {value.day}
            </button>
            <span className="flex-1 text-right text-on-surface tabular-nums">{value.value}</span>
            {remove && (
              <button
                type="button"
                onClick={() => void deleteDay(value.day)}
                className="text-xs text-on-surface-faint underline hover:text-danger"
              >
                {gt("Delete")}
              </button>
            )}
          </li>
        ))}
      </ul>

      {uploading && (
        <MetricCsvImportModal
          metric={metric}
          client={client}
          target="forecast"
          onClose={() => setUploading(false)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}
