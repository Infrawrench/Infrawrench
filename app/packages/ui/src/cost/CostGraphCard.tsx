import { useEffect, useMemo, useState } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useChartTheme } from "../chart-theme.js";
import {
  resolveCostDateRange,
  type CostGraphConfig,
  type CostQueryRequest,
  type CostQueryResponse,
} from "./config.js";
import {
  alignComparison,
  COMPARISON_KEY,
  FORECAST_KEY,
  formatBucketLabel,
  formatMoney,
  pivotSeries,
  spliceForecast,
  type PivotedChart,
} from "./transform.js";
import type { CostApi } from "./types.js";

/**
 * Categorical series colors — the app-wide chart theme order, assigned in
 * fixed order by series rank-at-load (API returns groups ranked with "Other"
 * last). "Other" always renders in neutral gray, never a categorical hue.
 */
const OTHER_COLOR = "#6b7280";

export interface CostGraphCardProps {
  title: string;
  config: CostGraphConfig;
  api: CostApi;
  /** Shown when some contributing account only has monthly-native data. */
  periodNativeNote?: boolean | undefined;
  onEdit?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
}

interface LoadedState {
  response: CostQueryResponse;
  pivot: PivotedChart;
}

function buildRequest(config: CostGraphConfig): CostQueryRequest {
  const { from, to } = resolveCostDateRange(config.dateRange);
  return {
    from,
    to,
    binning: config.binning,
    groupBy: config.groupBy,
    ...(config.groupByTagKey ? { groupByTagKey: config.groupByTagKey } : {}),
    filters: config.filters,
    topN: config.topN,
    comparePreviousPeriod: config.comparePreviousPeriod,
    forecast: config.showForecast,
  };
}

export function CostGraphCard({
  title,
  config,
  api,
  periodNativeNote,
  onEdit,
  onRemove,
}: CostGraphCardProps) {
  const chart = useChartTheme();
  const [state, setState] = useState<LoadedState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const request = useMemo(() => buildRequest(config), [config]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .queryCosts(request)
      .then((response) => {
        if (cancelled) return;
        const pivot = pivotSeries(response.series);
        if (response.comparison && config.chartType !== "pie") {
          alignComparison(pivot.rows, response.comparison);
        }
        if (response.forecast && config.chartType !== "pie") {
          spliceForecast(pivot, response, config.binning);
        }
        setState({ response, pivot });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load costs");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, request, config.chartType, config.binning]);

  const currency = state?.response.currencies[0] ?? "USD";
  const mixedCurrency = (state?.response.currencies.length ?? 0) > 1;
  const total = state
    ? Object.entries(state.response.totals)
        .map(([cur, amt]) => formatMoney(amt, cur))
        .join(" + ")
    : null;
  const previousTotal =
    state?.response.previousTotals &&
    Object.entries(state.response.previousTotals)
      .map(([cur, amt]) => formatMoney(amt, cur))
      .join(" + ");

  const deltaPct = useMemo(() => {
    if (!state?.response.previousTotals) return null;
    const cur = state.response.totals[currency] ?? 0;
    const prev = state.response.previousTotals[currency] ?? 0;
    if (prev === 0) return null;
    return ((cur - prev) / prev) * 100;
  }, [state, currency]);

  const chartAriaLabel = useMemo(() => {
    const parts = [`${title || "Costs"} chart`];
    if (total) parts.push(`total ${total}`);
    if (deltaPct !== null) {
      parts.push(
        `${deltaPct > 0 ? "up" : "down"} ${Math.abs(deltaPct).toFixed(1)}% vs previous period`,
      );
    }
    return parts.join(", ");
  }, [title, total, deltaPct]);

  const tooltipStyle = {
    backgroundColor: chart.tooltipBg,
    border: `1px solid ${chart.tooltipBorder}`,
    borderRadius: 8,
    fontSize: 12,
  };

  const colorFor = (index: number, isOther: boolean): string =>
    isOther ? OTHER_COLOR : (chart.colors[index % chart.colors.length] ?? OTHER_COLOR);

  // The chart body is exposed as a single role="img" with a summary label
  // only when a chart is actually rendered — loading, error, and empty
  // states keep their own text visible to assistive tech.
  const hasChartData = !loading && !error && (state?.pivot.rows.length ?? 0) > 0;

  const renderChart = () => {
    if (!state) return null;
    const { pivot, response } = state;

    if (pivot.rows.length === 0) {
      return (
        <div className="flex-1 flex items-center justify-center text-sm text-on-surface-faint">
          No cost data for this period yet
        </div>
      );
    }

    if (config.chartType === "pie") {
      const slices = response.series.map((s, i) => ({
        name: s.label,
        value: s.points.reduce((sum, p) => sum + p.amount, 0),
        fill: colorFor(i, s.key === "__other__"),
      }));
      return (
        <ResponsiveContainer width="100%" height="100%">
          <PieChart margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius="45%"
              outerRadius="80%"
              paddingAngle={2}
              stroke="none"
            >
              {slices.map((s) => (
                <Cell key={s.name} fill={s.fill} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(value, name) => [formatMoney(Number(value), currency), String(name)]}
            />
            <Legend
              wrapperStyle={{ fontSize: 11 }}
              formatter={(value: string) => <span style={{ color: chart.tick }}>{value}</span>}
            />
          </PieChart>
        </ResponsiveContainer>
      );
    }

    const isBar = config.chartType === "stacked_bar" || config.chartType === "multi_bar";
    const stacked = config.chartType === "stacked_bar" || config.chartType === "area";

    return (
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={pivot.rows} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} vertical={false} />
          <XAxis
            dataKey="bucket"
            tickFormatter={(b: string) => formatBucketLabel(b, config.binning)}
            tick={{ fill: chart.tick, fontSize: 11 }}
            stroke={chart.axis}
            minTickGap={24}
          />
          <YAxis
            tick={{ fill: chart.tick, fontSize: 11 }}
            stroke={chart.axis}
            tickFormatter={(v: number) => formatMoney(v, currency)}
            width={70}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelFormatter={(b) => formatBucketLabel(String(b), config.binning)}
            formatter={(value, name) => {
              const label =
                String(name) === COMPARISON_KEY
                  ? "Previous period"
                  : String(name) === FORECAST_KEY
                    ? "Forecast"
                    : (pivot.series.find((s) => s.dataKey === String(name))?.label ?? String(name));
              return [formatMoney(Number(value), currency), label];
            }}
          />
          {pivot.series.length > 1 && (
            <Legend
              wrapperStyle={{ fontSize: 11 }}
              formatter={(value: string) => {
                const def = pivot.series.find((s) => s.dataKey === value);
                return (
                  <span style={{ color: chart.tick }}>
                    {def?.label ??
                      (value === COMPARISON_KEY
                        ? "Previous period"
                        : value === FORECAST_KEY
                          ? "Forecast"
                          : value)}
                  </span>
                );
              }}
            />
          )}
          {pivot.series.map((def, i) =>
            isBar ? (
              <Bar
                key={def.dataKey}
                dataKey={def.dataKey}
                name={def.dataKey}
                {...(stacked ? { stackId: "a" } : {})}
                fill={colorFor(i, def.isOther)}
                radius={stacked ? 0 : [3, 3, 0, 0]}
                maxBarSize={40}
              />
            ) : config.chartType === "area" ? (
              <Area
                key={def.dataKey}
                type="monotone"
                dataKey={def.dataKey}
                name={def.dataKey}
                stackId="a"
                stroke={colorFor(i, def.isOther)}
                fill={colorFor(i, def.isOther)}
                fillOpacity={0.15}
                strokeWidth={2}
              />
            ) : (
              <Line
                key={def.dataKey}
                type="monotone"
                dataKey={def.dataKey}
                name={def.dataKey}
                stroke={colorFor(i, def.isOther)}
                strokeWidth={2}
                dot={false}
              />
            ),
          )}
          {response.comparison && (
            <Line
              type="monotone"
              dataKey={COMPARISON_KEY}
              name={COMPARISON_KEY}
              stroke={chart.tick}
              strokeWidth={1.5}
              strokeDasharray="4 4"
              dot={false}
            />
          )}
          {response.forecast && (
            <Line
              type="monotone"
              dataKey={FORECAST_KEY}
              name={FORECAST_KEY}
              stroke={chart.colors[0] ?? "#60a5fa"}
              strokeWidth={2}
              strokeDasharray="5 5"
              dot={false}
              connectNulls={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    );
  };

  return (
    <div className="group relative rounded-2xl border border-border bg-surface-raised hover:border-border-strong transition-colors flex flex-col overflow-hidden col-span-2 min-h-[18rem]">
      <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all z-10">
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            title="Edit widget"
            aria-label="Edit widget"
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
            aria-label="Remove from dashboard"
            className="size-5 rounded-full text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken text-xs flex items-center justify-center"
          >
            ✕
          </button>
        )}
      </div>

      <div className="px-5 pt-4 pb-1">
        <div className="flex items-baseline gap-3 pr-14">
          <h3 className="text-base font-semibold text-on-surface leading-tight truncate">
            {title || "Costs"}
          </h3>
          {total && (
            <span className="text-sm text-on-surface-secondary flex-shrink-0">{total}</span>
          )}
          {deltaPct !== null && (
            <span
              className={`text-xs flex-shrink-0 ${deltaPct > 0 ? "text-red-400" : "text-emerald-400"}`}
              title={previousTotal ? `Previous period: ${previousTotal}` : undefined}
            >
              {deltaPct > 0 ? "▲" : "▼"} {Math.abs(deltaPct).toFixed(1)}%
            </span>
          )}
        </div>
        {(mixedCurrency || periodNativeNote) && (
          <p className="text-[11px] text-on-surface-faint mt-0.5">
            {mixedCurrency && "Mixed currencies — series are shown per currency. "}
            {periodNativeNote && "Some providers report monthly totals, shown on period dates."}
          </p>
        )}
      </div>

      <div
        className="flex-1 min-h-0 px-3 pb-3 flex flex-col"
        role={hasChartData ? "img" : undefined}
        aria-label={hasChartData ? chartAriaLabel : undefined}
      >
        {loading ? (
          <div
            role="status"
            className="flex-1 flex items-center justify-center text-sm text-on-surface-faint"
          >
            Loading costs…
          </div>
        ) : error ? (
          <div
            role="alert"
            className="flex-1 flex items-center justify-center text-sm text-red-400 px-4 text-center"
          >
            {error}
          </div>
        ) : (
          renderChart()
        )}
      </div>
    </div>
  );
}
