import { useMemo, useState } from "react";
import { T, Var, useGT } from "gt-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  COMMITMENT_REPORT_METRICS,
  formatBucketLabel,
  isCommitmentRatioMetric,
  niceAxis,
  type CommitmentReportMetric,
  type CommitmentReportResult,
  type CommitmentReportSeries,
} from "@infrawrench/client-core";

import { useChartTheme } from "../chart-theme.js";
import { useDataString } from "../i18n/data-strings.js";
import { formatCommitmentMetric, useCommitmentReportLabels } from "./labels.js";

/** At most this many series are drawn; the table lists every one. */
const MAX_DRAWN_SERIES = 8;

type ChartRow = { bucket: string } & Record<string, number | null | string>;

export interface CommitmentReportViewProps {
  result: CommitmentReportResult;
  /** The metric the chart starts on (the saved report's choice). */
  initialMetric: CommitmentReportMetric;
}

/**
 * One run of a commitment report: the providers it could and could not
 * measure, its notices, the headline per currency, a chart of one metric
 * over time, and a table with every metric.
 *
 * A null ratio is drawn as a gap and printed as "—", never as 0: a bucket
 * with no usage was not 0% covered, it had nothing to cover.
 */
export function CommitmentReportView({ result, initialMetric }: CommitmentReportViewProps) {
  const gt = useGT();
  const gtData = useDataString();
  const labels = useCommitmentReportLabels();
  const chart = useChartTheme();
  const [metric, setMetric] = useState<CommitmentReportMetric>(initialMetric);

  const grouped = result.groupBy !== "none";
  const source = grouped ? result.series : result.overall;
  const drawn = source.slice(0, MAX_DRAWN_SERIES);
  const multiCurrency = new Set(source.map((s) => s.currency)).size > 1;
  const seriesName = (s: CommitmentReportSeries) => {
    const base = labels.series(s, result.groupBy);
    return multiCurrency ? `${base} (${s.currency})` : base;
  };
  const isRatio = isCommitmentRatioMetric(metric);

  const rows = useMemo(() => {
    return result.buckets.map((bucket) => {
      const row: ChartRow = { bucket };
      drawn.forEach((s, i) => {
        const point = s.points.find((p) => p.bucket === bucket);
        row[`s${i}`] = point ? point.metrics[metric] : null;
      });
      return row;
    });
  }, [result.buckets, drawn, metric]);

  const observed = rows.flatMap((r) =>
    drawn.map((_, i) => r[`s${i}`]).filter((v): v is number => typeof v === "number"),
  );
  const yScale = niceAxis(Math.min(0, ...observed), Math.max(isRatio ? 1 : 0, ...observed));
  const axisCurrency = drawn[0]?.currency ?? "USD";
  const color = (i: number) => chart.colors[i % chart.colors.length] ?? "#60a5fa";
  const measured = result.providers.filter((p) => p.status === "measured");
  const inventoryOnly = result.providers.filter((p) => p.status === "inventory_only");

  return (
    <div className="flex flex-col gap-4">
      {(measured.length > 0 || inventoryOnly.length > 0) && (
        <div className="text-xs text-on-surface-muted space-y-0.5">
          {measured.length > 0 && (
            <p>
              {gt("Measured from cost data: {providers}", {
                providers: measured.map((p) => gtData(p.displayName)).join(", "),
              })}
            </p>
          )}
          {inventoryOnly.length > 0 && (
            <p>
              {gt(
                "Not measured: {providers}. Their holdings are listed below, but their cost data does not separate covered from uncovered usage, so they are left out rather than shown as 0% covered.",
                { providers: inventoryOnly.map((p) => gtData(p.displayName)).join(", ") },
              )}
            </p>
          )}
        </div>
      )}

      {result.notices.length > 0 && (
        <ul className="text-xs text-warning space-y-1">
          {result.notices.map((n) => (
            <li key={n}>{labels.notice(n)}</li>
          ))}
        </ul>
      )}

      {result.overall.map((s) => (
        <Headline key={s.currency} series={s} showCurrency={result.overall.length > 1} />
      ))}

      <div className="flex items-center gap-2 flex-wrap">
        <label
          htmlFor="commitment-report-metric"
          className="text-xs font-medium text-on-surface-secondary"
        >
          {gt("Chart")}
        </label>
        <select
          id="commitment-report-metric"
          value={metric}
          onChange={(e) => setMetric(e.target.value as CommitmentReportMetric)}
          className="rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500"
        >
          {COMMITMENT_REPORT_METRICS.map((m) => (
            <option key={m} value={m}>
              {labels.metric(m)}
            </option>
          ))}
        </select>
        <span className="text-xs text-on-surface-faint">{labels.metricHint(metric)}</span>
      </div>

      <div className="h-72">
        {drawn.length === 0 ? (
          <T>
            <div className="h-full flex items-center justify-center text-sm text-on-surface-faint">
              No commitment or usage spend in this window.
            </div>
          </T>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} vertical={false} />
              <XAxis
                dataKey="bucket"
                tickFormatter={(b: string) => formatBucketLabel(b, result.granularity)}
                tick={{ fill: chart.tick, fontSize: 11 }}
                stroke={chart.axis}
                minTickGap={24}
              />
              <YAxis
                tick={{ fill: chart.tick, fontSize: 11 }}
                stroke={chart.axis}
                tickFormatter={(v: number) => formatCommitmentMetric(metric, v, axisCurrency)}
                domain={yScale.domain}
                ticks={yScale.ticks}
                width={80}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: chart.tooltipBg,
                  border: `1px solid ${chart.tooltipBorder}`,
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelFormatter={(b) => formatBucketLabel(String(b), result.granularity)}
                formatter={(value, name) => {
                  const s = drawn[Number(String(name).slice(1))];
                  if (!s) return [String(value), String(name)];
                  return [
                    formatCommitmentMetric(
                      metric,
                      typeof value === "number" ? value : null,
                      s.currency,
                    ),
                    seriesName(s),
                  ];
                }}
              />
              {drawn.map((s, i) => (
                <Line
                  key={s.id}
                  type="monotone"
                  dataKey={`s${i}`}
                  name={`s${i}`}
                  stroke={color(i)}
                  strokeWidth={2}
                  dot={result.buckets.length < 40}
                  // A gap is a bucket with nothing to measure; bridging it
                  // would draw a measurement nobody took.
                  connectNulls={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
      {source.length > drawn.length && (
        <p className="text-xs text-on-surface-faint">
          {gt("The chart draws the {count} largest groups; the table lists all {total}.", {
            count: drawn.length,
            total: source.length,
          })}
        </p>
      )}

      <MetricsTable result={result} seriesName={seriesName} />
    </div>
  );
}

function Headline({
  series,
  showCurrency,
}: {
  series: CommitmentReportSeries;
  showCurrency: boolean;
}) {
  const gt = useGT();
  const labels = useCommitmentReportLabels();
  const m = series.total.metrics;
  const coverage =
    m.coverage !== null && m.eligibleCoverage !== null && m.eligibleCoverage - m.coverage > 0.0005
      ? gt("{low} to {high}", {
          low: formatCommitmentMetric("coverage", m.coverage, series.currency),
          high: formatCommitmentMetric("eligibleCoverage", m.eligibleCoverage, series.currency),
        })
      : formatCommitmentMetric("coverage", m.coverage, series.currency);
  // `title` is the hover explanation; `sub` is printed under the value.
  const tiles: Array<{ label: string; value: string; title?: string; sub?: string }> = [
    {
      label: labels.metric("coverage"),
      value: coverage,
      title: gt(
        "From all usage (lower bound) to usage in services and regions a commitment covered (upper bound).",
      ),
    },
    {
      label: labels.metric("utilization"),
      value: formatCommitmentMetric("utilization", m.utilization, series.currency),
    },
    {
      label: labels.metric("effectiveSavingsRate"),
      value: formatCommitmentMetric(
        "effectiveSavingsRate",
        m.effectiveSavingsRate,
        series.currency,
      ),
    },
    {
      label: labels.metric("netSavings"),
      value: formatCommitmentMetric("netSavings", m.netSavings, series.currency),
      ...(m.savingsMeasuredShare !== null && m.savingsMeasuredShare < 0.999
        ? {
            sub: gt("Measured over {pct} of covered spend", {
              pct: `${Math.round(m.savingsMeasuredShare * 100)}%`,
            }),
          }
        : {}),
    },
    {
      label: labels.metric("onDemandRemainder"),
      value: formatCommitmentMetric("onDemandRemainder", m.onDemandRemainder, series.currency),
    },
    {
      label: labels.metric("commitmentCost"),
      value: formatCommitmentMetric("commitmentCost", m.commitmentCost, series.currency),
      sub: gt("{used} used, {unused} unused", {
        used: formatCommitmentMetric("usedCommitmentCost", m.usedCommitmentCost, series.currency),
        unused: formatCommitmentMetric(
          "unusedCommitmentCost",
          m.unusedCommitmentCost,
          series.currency,
        ),
      }),
    },
  ];
  return (
    <div>
      {showCurrency && (
        <p className="text-xs font-semibold text-on-surface-secondary mb-1">{series.currency}</p>
      )}
      <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {tiles.map((tile) => (
          <div
            key={tile.label}
            className="rounded-lg border border-border bg-surface-raised px-3 py-2"
            title={tile.title}
          >
            <dt className="text-xs text-on-surface-muted">{tile.label}</dt>
            <dd className="text-base font-semibold text-on-surface tabular-nums">{tile.value}</dd>
            {tile.sub && <dd className="text-[11px] text-on-surface-faint">{tile.sub}</dd>}
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * Every metric in one table. Ungrouped, a row per bucket; grouped, a row per
 * group over the whole window. A total row closes it either way.
 */
function MetricsTable({
  result,
  seriesName,
}: {
  result: CommitmentReportResult;
  seriesName: (s: CommitmentReportSeries) => string;
}) {
  const gt = useGT();
  const labels = useCommitmentReportLabels();
  const grouped = result.groupBy !== "none";
  const rows: Array<{
    key: string;
    label: string;
    currency: string;
    metrics: CommitmentReportSeries["total"]["metrics"];
    total?: boolean;
  }> = grouped
    ? [
        ...result.series.map((s) => ({
          key: s.id,
          label: seriesName(s),
          currency: s.currency,
          metrics: s.total.metrics,
        })),
        ...result.overall.map((s) => ({
          key: `total-${s.currency}`,
          label:
            result.overall.length > 1
              ? gt("Total ({currency})", { currency: s.currency })
              : gt("Total"),
          currency: s.currency,
          metrics: s.total.metrics,
          total: true,
        })),
      ]
    : result.overall.flatMap((s) => [
        ...s.points.map((p) => ({
          key: `${s.currency}-${p.bucket}`,
          label:
            formatBucketLabel(p.bucket, result.granularity) +
            (result.overall.length > 1 ? ` (${s.currency})` : ""),
          currency: s.currency,
          metrics: p.metrics,
        })),
        {
          key: `total-${s.currency}`,
          label:
            result.overall.length > 1
              ? gt("Total ({currency})", { currency: s.currency })
              : gt("Total"),
          currency: s.currency,
          metrics: s.total.metrics,
          total: true,
        },
      ]);

  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto border border-border rounded-xl">
      <table className="min-w-full text-xs">
        <thead className="bg-surface-raised text-on-surface-secondary">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              {grouped ? labels.groupBy(result.groupBy) : gt("Period")}
            </th>
            {COMMITMENT_REPORT_METRICS.map((m) => (
              <th
                key={m}
                scope="col"
                className="px-3 py-2 text-right font-medium whitespace-nowrap"
                title={labels.metricHint(m)}
              >
                {labels.metric(m)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.key} className={row.total ? "font-semibold bg-surface-raised" : ""}>
              <th scope="row" className="px-3 py-1.5 text-left font-normal text-on-surface">
                {row.label}
              </th>
              {COMMITMENT_REPORT_METRICS.map((m) => (
                <td
                  key={m}
                  className="px-3 py-1.5 text-right tabular-nums text-on-surface-secondary whitespace-nowrap"
                >
                  {formatCommitmentMetric(m, row.metrics[m], row.currency)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <T>
        <p className="px-3 py-2 text-[11px] text-on-surface-faint border-t border-border">
          Amortized basis. A dash means there was nothing to measure, not zero. Window{" "}
          <Var>{result.from}</Var> to <Var>{result.to}</Var>.
        </p>
      </T>
    </div>
  );
}
