import { useMemo } from "react";
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

import { formatMoney, niceAxis } from "@infrawrench/client-core";

import { useChartTheme } from "../chart-theme.js";
import { rowsExtent } from "../components/charts/nice-axis.js";
import type { CustomGraphChart as ChartSpec } from "./types.js";

/**
 * Renders one script-produced chart spec with recharts. Series arrive already
 * validated and capped by the sandbox dispatcher, so this component only has
 * to draw — no clamping, no sanitizing.
 */

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}/;

function formatX(x: string | number): string {
  if (typeof x === "number") return String(x);
  if (ISO_DAY_RE.test(x)) {
    const d = new Date(x.length > 10 ? x : `${x}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) {
      const withTime = x.length > 10;
      return d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
        ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
      });
    }
  }
  return x;
}

function formatValue(value: number, unit?: string, currency?: string): string {
  if (currency) return formatMoney(value, currency);
  const text = Math.abs(value) >= 100 ? value.toLocaleString() : String(Number(value.toFixed(2)));
  return unit ? `${text} ${unit}` : text;
}

interface SeriesDef {
  dataKey: string;
  label: string;
  color?: string | undefined;
}

/** Pivot {x,y} series into recharts rows keyed by x. */
function pivot(spec: Extract<ChartSpec, { type: "line" | "area" | "stacked_bar" | "multi_bar" }>): {
  rows: Array<Record<string, string | number | null>>;
  series: SeriesDef[];
} {
  const order: Array<string | number> = [];
  const seen = new Set<string | number>();
  for (const s of spec.series) {
    for (const p of s.points) {
      if (!seen.has(p.x)) {
        seen.add(p.x);
        order.push(p.x);
      }
    }
  }
  // Time/number axes read wrong unsorted; mixed/categorical keeps declaration order.
  const sortable =
    order.every((x) => typeof x === "number") ||
    order.every((x) => typeof x === "string" && ISO_DAY_RE.test(x));
  if (sortable) order.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const index = new Map(order.map((x, i) => [x, i]));
  const rows = order.map(
    (x) =>
      ({ __x: typeof x === "number" ? String(x) : x }) as Record<string, string | number | null>,
  );
  const series = spec.series.map((s, i) => {
    const dataKey = `s${i}`;
    for (const p of s.points) {
      const row = rows[index.get(p.x)!];
      if (row) row[dataKey] = p.y;
    }
    return { dataKey, label: s.label ?? s.key, color: s.color };
  });
  return { rows, series };
}

export function CustomGraphChart({ spec }: { spec: ChartSpec }) {
  const chart = useChartTheme();
  const colorFor = (index: number, override?: string): string =>
    override ?? chart.colors[index % chart.colors.length] ?? "#6b7280";

  const tooltipStyle = {
    backgroundColor: chart.tooltipBg,
    border: `1px solid ${chart.tooltipBorder}`,
    borderRadius: 8,
    fontSize: 12,
  };

  const pivoted = useMemo(
    () =>
      spec.type === "pie" || spec.type === "stat" || spec.type === "table" ? null : pivot(spec),
    [spec],
  );

  if (spec.type === "stat") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-1 py-4">
        <div className="text-3xl font-semibold text-on-surface tabular-nums">
          {typeof spec.value === "number"
            ? formatValue(spec.value, spec.unit, spec.currency)
            : spec.value}
        </div>
        {spec.caption && <div className="text-xs text-on-surface-faint">{spec.caption}</div>}
      </div>
    );
  }

  if (spec.type === "table") {
    return (
      <div className="flex-1 min-h-0 overflow-auto px-2 pb-2">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-on-surface-faint sticky top-0 bg-surface-raised">
              {spec.columns.map((c) => (
                <th key={c} scope="col" className="px-2 py-1.5 font-medium border-b border-border">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {spec.rows.map((row, i) => (
              <tr key={i} className="text-on-surface-secondary">
                {spec.columns.map((_, j) => (
                  <td key={j} className="px-2 py-1 border-b border-border/50 tabular-nums">
                    {row[j] === null || row[j] === undefined ? "—" : String(row[j])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {spec.rows.length === 0 && (
          <div className="text-sm text-on-surface-faint text-center py-6">No rows</div>
        )}
      </div>
    );
  }

  if (spec.type === "pie") {
    const slices = spec.slices.map((s, i) => ({
      name: s.label,
      value: s.value,
      fill: colorFor(i, s.color),
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
            {slices.map((s, i) => (
              <Cell key={`${s.name}-${i}`} fill={s.fill} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(value, name) => [
              formatValue(Number(value), spec.unit, spec.currency),
              String(name),
            ]}
          />
          <Legend
            wrapperStyle={{ fontSize: 11 }}
            formatter={(value: string) => <span style={{ color: chart.tick }}>{value}</span>}
          />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  const { rows, series } = pivoted!;
  if (rows.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-on-surface-faint">
        No data
      </div>
    );
  }

  const isBar = spec.type === "stacked_bar" || spec.type === "multi_bar";
  const stacked = spec.type === "stacked_bar" || spec.type === "area";
  const yUnit = spec.yAxis?.unit;
  const yCurrency = spec.yAxis?.currency;

  const extent = rowsExtent(rows, {
    stackedKeys: stacked ? series.map((s) => s.dataKey) : [],
    keys: stacked ? [] : series.map((s) => s.dataKey),
  });
  const yScale = niceAxis(extent.min, extent.max);

  const labelOf = (dataKey: string): string =>
    series.find((s) => s.dataKey === dataKey)?.label ?? dataKey;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={rows} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} vertical={false} />
        <XAxis
          dataKey="__x"
          tickFormatter={(x: string | number) => formatX(x)}
          tick={{ fill: chart.tick, fontSize: 11 }}
          stroke={chart.axis}
          minTickGap={24}
        />
        <YAxis
          tick={{ fill: chart.tick, fontSize: 11 }}
          stroke={chart.axis}
          tickFormatter={(v: number) => formatValue(v, yUnit, yCurrency)}
          domain={yScale.domain}
          ticks={yScale.ticks}
          width={70}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          labelFormatter={(x) => formatX(x as string | number)}
          formatter={(value, name) => [
            formatValue(Number(value), yUnit, yCurrency),
            labelOf(String(name)),
          ]}
        />
        {series.length > 1 && (
          <Legend
            wrapperStyle={{ fontSize: 11 }}
            formatter={(value: string) => (
              <span style={{ color: chart.tick }}>{labelOf(value)}</span>
            )}
          />
        )}
        {series.map((def, i) =>
          isBar ? (
            <Bar
              key={def.dataKey}
              dataKey={def.dataKey}
              name={def.dataKey}
              {...(stacked ? { stackId: "a" } : {})}
              fill={colorFor(i, def.color)}
              radius={stacked ? 0 : [3, 3, 0, 0]}
              maxBarSize={40}
            />
          ) : spec.type === "area" ? (
            <Area
              key={def.dataKey}
              type="monotone"
              dataKey={def.dataKey}
              name={def.dataKey}
              stackId="a"
              stroke={colorFor(i, def.color)}
              fill={colorFor(i, def.color)}
              fillOpacity={0.15}
              strokeWidth={2}
            />
          ) : (
            <Line
              key={def.dataKey}
              type="monotone"
              dataKey={def.dataKey}
              name={def.dataKey}
              stroke={colorFor(i, def.color)}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
            />
          ),
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
