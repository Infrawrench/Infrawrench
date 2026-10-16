import { useMemo, useState } from "react";
import { T, Var, useGT } from "gt-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  attributionCoverage,
  formatBucketLabel,
  networkFlowSampledShare,
  niceAxis,
  NETWORK_FLOW_REPORT_OTHER_KEY,
  type NetworkFlowReportResult,
  type NetworkFlowReportSeries,
  type NetworkFlowReportTalker,
} from "@infrawrench/client-core";

import { useChartTheme } from "../chart-theme.js";
import { formatNetworkFlowFigure, useNetworkFlowReportLabels } from "./labels.js";

type ChartRow = { bucket: string } & Record<string, number | string>;
type Figure = "cost" | "bytes";

export interface NetworkFlowReportViewProps {
  result: NetworkFlowReportResult;
}

const thClass = "px-3 py-2 text-left text-xs font-medium text-on-surface-secondary";
const tdClass = "px-3 py-2 text-sm text-on-surface";
const numClass = "px-3 py-2 text-sm text-right tabular-nums text-on-surface";

/** "40% sampled", only when some of a figure came from a sampled source. */
function SampledBadge({ share }: { share: number }) {
  const gt = useGT();
  if (share <= 0) return null;
  return (
    <span
      className="ml-1 rounded px-1 py-0.5 text-[10px] font-medium text-notice bg-purple-500/10"
      title={gt("From a flow source that samples traffic: a scaled-up estimate.")}
    >
      {share >= 0.995
        ? gt("sampled")
        : gt("{percent}% sampled", { percent: Math.max(1, Math.round(share * 100)) })}
    </span>
  );
}

/**
 * One run of a network flow report: notices, the headline per currency, a
 * stacked chart of cost or bytes over time by group, the group table and the
 * top talking pairs.
 *
 * Every money figure is an estimate at list price and every surface says so;
 * a figure that came (wholly or partly) from a sampled flow source carries a
 * "sampled" mark beside it.
 */
export function NetworkFlowReportView({ result }: NetworkFlowReportViewProps) {
  const gt = useGT();
  const labels = useNetworkFlowReportLabels();
  const chart = useChartTheme();
  const [figure, setFigure] = useState<Figure>(result.metric === "bytes" ? "bytes" : "cost");
  const showCost = result.metric !== "bytes";
  const showBytes = result.metric !== "cost";

  const grouped = result.groupBy !== "none";
  const drawn: NetworkFlowReportSeries[] = grouped ? result.series : result.overall;
  const multiCurrency = result.overall.length > 1;
  const seriesName = (s: NetworkFlowReportSeries) => {
    const base = labels.group(s.groupKey, s.label, result.groupBy);
    return multiCurrency ? `${base} (${s.currency})` : base;
  };
  const value = (t: { bytes: number; estimatedCost: number }) =>
    figure === "bytes" ? t.bytes : t.estimatedCost;

  const rows = useMemo(
    () =>
      result.buckets.map((bucket) => {
        const row: ChartRow = { bucket };
        drawn.forEach((s, i) => {
          const point = s.points.find((p) => p.bucket === bucket);
          row[`s${i}`] = point ? (figure === "bytes" ? point.bytes : point.estimatedCost) : 0;
        });
        return row;
      }),
    [result.buckets, drawn, figure],
  );

  const stackTotals = rows.map((r) =>
    drawn.reduce(
      (sum, _, i) => sum + (typeof r[`s${i}`] === "number" ? (r[`s${i}`] as number) : 0),
      0,
    ),
  );
  const yScale = niceAxis(0, Math.max(0, ...stackTotals));
  const axisCurrency = result.overall[0]?.currency ?? "USD";
  const color = (s: NetworkFlowReportSeries, i: number) =>
    s.groupKey === NETWORK_FLOW_REPORT_OTHER_KEY
      ? chart.tick
      : (chart.colors[i % chart.colors.length] ?? "#60a5fa");
  const empty = result.overall.every((s) => s.total.bytes === 0);

  return (
    <div className="flex flex-col gap-4">
      <T>
        <p className="text-xs text-on-surface-muted">
          <strong>Estimated</strong> from flow logs at list prices, so it won&rsquo;t match your
          invoice.
        </p>
      </T>

      {result.notices.length > 0 && (
        <ul className="text-xs text-warning space-y-1">
          {result.notices.map((n) => (
            <li key={n}>{labels.notice(n)}</li>
          ))}
        </ul>
      )}

      {result.overall.map((s) => {
        const coverage = attributionCoverage(s.total);
        return (
          <div
            key={s.currency}
            className="grid grid-cols-2 sm:grid-cols-4 gap-3 border border-border rounded-xl p-3"
          >
            {showCost && (
              <div>
                <p className="text-xs text-on-surface-muted">
                  {multiCurrency
                    ? gt("Estimated cost ({currency})", { currency: s.currency })
                    : gt("Estimated cost")}
                </p>
                <p className="text-lg font-semibold text-on-surface tabular-nums">
                  {formatNetworkFlowFigure("cost", s.total.estimatedCost, s.currency)}
                  <SampledBadge share={networkFlowSampledShare(s.total)} />
                </p>
              </div>
            )}
            {showBytes && (
              <div>
                <p className="text-xs text-on-surface-muted">{gt("Bytes")}</p>
                <p className="text-lg font-semibold text-on-surface tabular-nums">
                  {formatNetworkFlowFigure("bytes", s.total.bytes, s.currency)}
                  {!showCost && <SampledBadge share={networkFlowSampledShare(s.total)} />}
                </p>
              </div>
            )}
            <div>
              <p className="text-xs text-on-surface-muted">{gt("Attributed to a pair")}</p>
              <p className="text-lg font-semibold text-on-surface tabular-nums">
                {Math.round(coverage * 100)}%
              </p>
            </div>
            <div>
              <p className="text-xs text-on-surface-muted">
                {gt("Unattributed / outside top pairs")}
              </p>
              <p className="text-sm text-on-surface tabular-nums mt-1">
                {formatNetworkFlowFigure("bytes", s.total.unattributedBytes, s.currency)} /{" "}
                {formatNetworkFlowFigure("bytes", s.total.truncatedBytes, s.currency)}
              </p>
            </div>
          </div>
        );
      })}

      {result.metric === "both" && (
        <div className="flex items-center gap-2" role="group" aria-label={gt("Chart shows")}>
          {(["cost", "bytes"] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={figure === f}
              onClick={() => setFigure(f)}
              className={`rounded-lg px-2.5 py-1 text-xs border ${
                figure === f
                  ? "border-blue-500 text-on-surface"
                  : "border-border text-on-surface-secondary hover:border-border-strong"
              }`}
            >
              {f === "cost" ? gt("Estimated cost") : gt("Bytes")}
            </button>
          ))}
        </div>
      )}

      <div className="h-72">
        {empty ? (
          <T>
            <div className="h-full flex items-center justify-center text-sm text-on-surface-faint">
              No flows in this window for these filters.
            </div>
          </T>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
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
                tickFormatter={(v: number) => formatNetworkFlowFigure(figure, v, axisCurrency)}
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
                formatter={(v, name) => {
                  const s = drawn[Number(String(name).slice(1))];
                  if (!s) return [String(v), String(name)];
                  return [
                    formatNetworkFlowFigure(figure, typeof v === "number" ? v : 0, s.currency),
                    seriesName(s),
                  ];
                }}
              />
              {drawn.map((s, i) => (
                <Bar
                  key={s.id}
                  dataKey={`s${i}`}
                  name={`s${i}`}
                  stackId={s.currency}
                  fill={color(s, i)}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {grouped && result.groups.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold text-on-surface-secondary">
            {gt("Totals by {grouping}", { grouping: labels.groupBy(result.groupBy) })}
          </h4>
          <div className="overflow-x-auto border border-border rounded-xl">
            <table className="w-full">
              <thead className="bg-surface-sunken">
                <tr>
                  <th className={thClass}>{labels.groupBy(result.groupBy)}</th>
                  {showBytes && <th className={`${thClass} text-right`}>{gt("Bytes")}</th>}
                  {showCost && <th className={`${thClass} text-right`}>{gt("Estimated cost")}</th>}
                  <th className={`${thClass} text-right`}>{gt("Share")}</th>
                  <th className={`${thClass} text-right`}>{gt("Pairs")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result.groups.map((g) => {
                  const overall = result.overall.find((o) => o.currency === g.currency)?.total;
                  const base = overall ? value(overall) : 0;
                  const share = base > 0 ? value(g) / base : 0;
                  return (
                    <tr key={`${g.groupKey}\u0000${g.currency}`}>
                      <td className={tdClass}>
                        {labels.group(g.groupKey, g.label, result.groupBy)}
                        <SampledBadge share={networkFlowSampledShare(g)} />
                      </td>
                      {showBytes && (
                        <td className={numClass}>
                          {formatNetworkFlowFigure("bytes", g.bytes, g.currency)}
                        </td>
                      )}
                      {showCost && (
                        <td className={numClass}>
                          {formatNetworkFlowFigure("cost", g.estimatedCost, g.currency)}
                        </td>
                      )}
                      <td className={numClass}>{(share * 100).toFixed(1)}%</td>
                      <td className={numClass}>{g.pairCount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {result.groupCount > result.groups.length && (
            <p className="text-xs text-on-surface-faint">
              {gt("Showing the {count} largest of {total}.", {
                count: result.groups.length,
                total: result.groupCount,
              })}
            </p>
          )}
        </div>
      )}

      <TopTalkers result={result} showBytes={showBytes} showCost={showCost} />
    </div>
  );
}

function TopTalkers({
  result,
  showBytes,
  showCost,
}: {
  result: NetworkFlowReportResult;
  showBytes: boolean;
  showCost: boolean;
}) {
  const gt = useGT();
  const labels = useNetworkFlowReportLabels();
  if (result.topTalkers.length === 0) return null;
  const end = (e: NetworkFlowReportTalker["source"]) => {
    const name = labels.endpoint(e.ref, e.label);
    const where = [e.zone || e.region, e.network].filter(Boolean).join(" · ");
    return { name, where };
  };
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-semibold text-on-surface-secondary">{gt("Top talkers")}</h4>
      <div className="overflow-x-auto border border-border rounded-xl">
        <table className="w-full">
          <thead className="bg-surface-sunken">
            <tr>
              <th className={thClass}>{gt("Source")}</th>
              <th className={thClass}>{gt("Destination")}</th>
              <th className={thClass}>{gt("Traffic class")}</th>
              {showBytes && <th className={`${thClass} text-right`}>{gt("Bytes")}</th>}
              {showCost && <th className={`${thClass} text-right`}>{gt("Estimated cost")}</th>}
              <th className={`${thClass} text-right`}>{gt("Days")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {result.topTalkers.map((t) => {
              const src = end(t.source);
              const dst = end(t.destination);
              return (
                <tr
                  key={`${t.source.ref}\u0000${t.destination.ref}\u0000${t.scope}\u0000${t.direction}`}
                >
                  <td className={tdClass}>
                    <span className="font-medium">{src.name}</span>
                    {src.where && (
                      <span className="block text-xs text-on-surface-muted">{src.where}</span>
                    )}
                  </td>
                  <td className={tdClass}>
                    <span className="font-medium">{dst.name}</span>
                    {dst.where && (
                      <span className="block text-xs text-on-surface-muted">{dst.where}</span>
                    )}
                  </td>
                  <td className={tdClass}>
                    {labels.trafficClass(t.scope)}
                    <span className="block text-xs text-on-surface-muted">
                      {labels.direction(t.direction)}
                      {t.accountName ? <> · {t.accountName}</> : null}
                      {t.attribution === "unattributed" ? (
                        <>
                          {" · "}
                          <span className="text-warning">{gt("peer not identified")}</span>
                        </>
                      ) : null}
                    </span>
                  </td>
                  {showBytes && (
                    <td className={numClass}>
                      {formatNetworkFlowFigure("bytes", t.bytes, t.currency)}
                    </td>
                  )}
                  {showCost && (
                    <td className={numClass}>
                      {formatNetworkFlowFigure("cost", t.estimatedCost, t.currency)}
                      <SampledBadge share={t.sampled ? 1 : 0} />
                    </td>
                  )}
                  <td className={numClass}>{t.days}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <T>
        <p className="text-xs text-on-surface-faint">
          The largest <Var>{result.topTalkers.length}</Var> pairs. The remainder below the stored
          pair cap is never a pair, so it is counted in the totals above but not listed here.
        </p>
      </T>
    </div>
  );
}
