/**
 * Metric series for the Metrics tab, all through APL:
 *
 * - Organization: hourly ingest and query compute from the `axiom-audit`
 *   dataset (`usageCalculated` events carry `properties.hourlyIngestBytes` per
 *   dataset; `runAPLQueryCost` events carry `properties.query_cost_gbms`),
 *   the queries Axiom's own docs give for usage monitoring. Reading the audit
 *   log needs the Owner role or a token allowed to query `axiom-audit`.
 * - Datasets: event count over time from the dataset itself, and the bytes
 *   it ingested from the audit log.
 * - Monitors and saved queries: their own APL re-run over the selected range,
 *   plus a monitor's threshold as a flat line.
 */

import type { MetricSeries } from "@infrawrench/plugin-base";
import type { AxiomContext } from "./api.js";
import { aplDataset, aplString, firstRows, rowsToSeries, runApl } from "./apl.js";

export const DEFAULT_METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const USAGE_METRICS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export function rangeOrDefault(range: TimeRange | undefined, windowMs: number): TimeRange {
  if (range) return range;
  const endMs = Date.now();
  return { startMs: endMs - windowMs, endMs };
}

/** An APL bin size giving roughly 100 points: `5m`, `1h`, … */
export function binFor(range: TimeRange): string {
  const minutes = Math.max(1, Math.round((range.endMs - range.startMs) / 60_000 / 100));
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

function window(range: TimeRange) {
  return {
    startTime: new Date(range.startMs).toISOString(),
    endTime: new Date(range.endMs).toISOString(),
  };
}

const AUDIT = "['axiom-audit']";

async function audit(ctx: AxiomContext, apl: string, range: TimeRange): Promise<MetricSeries[]> {
  try {
    return rowsToSeries(firstRows(await runApl(ctx, apl, window(range))), {
      labels: { ingest_gb: "Ingested (GB)", query_gbms: "Query compute (GB·ms)" },
      units: { ingest_gb: "GB", query_gbms: "GB·ms" },
    });
  } catch {
    // No access to the audit log is a normal state for a narrow token.
    return [];
  }
}

export async function organizationSeries(
  ctx: AxiomContext,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const bin = binFor(range);
  const [ingest, query] = await Promise.all([
    audit(
      ctx,
      `${AUDIT} | where action == "usageCalculated" | summarize ingest_gb = sum(tolong(['properties.hourlyIngestBytes'])) / pow(1024, 3) by bin(_time, ${bin})`,
      range,
    ),
    audit(
      ctx,
      `${AUDIT} | where action == "runAPLQueryCost" | summarize query_gbms = sum(todouble(['properties.query_cost_gbms'])) by bin(_time, ${bin})`,
      range,
    ),
  ]);
  return [...ingest, ...query];
}

export async function datasetSeries(
  ctx: AxiomContext,
  dataset: string,
  edgeUrl: string | undefined,
  range: TimeRange,
): Promise<MetricSeries[]> {
  const bin = binFor(range);
  const [events, ingest] = await Promise.all([
    runApl(ctx, `${aplDataset(dataset)} | summarize events = count() by bin(_time, ${bin})`, {
      ...window(range),
      ...(edgeUrl ? { edgeUrl } : {}),
    }).then((r) =>
      rowsToSeries(firstRows(r), { labels: { events: "Events" }, units: { events: "events" } }),
    ),
    audit(
      ctx,
      `${AUDIT} | where action == "usageCalculated" and tostring(['properties.dataset']) == ${aplString(dataset)} | summarize ingest_gb = sum(tolong(['properties.hourlyIngestBytes'])) / pow(1024, 3) by bin(_time, ${bin})`,
      range,
    ),
  ]);
  return [...events, ...ingest];
}

/** Run a stored APL query over the range and chart whatever series it returns. */
export async function aplSeries(
  ctx: AxiomContext,
  apl: string,
  range: TimeRange,
  threshold?: { value: number; label: string },
): Promise<MetricSeries[]> {
  const series = rowsToSeries(firstRows(await runApl(ctx, apl, window(range))));
  if (threshold && series.length > 0) {
    series.push({
      label: threshold.label,
      points: [
        { timestamp: range.startMs, value: threshold.value },
        { timestamp: range.endMs, value: threshold.value },
      ],
    });
  }
  return series;
}

/** Sum a single number from an audit query, or undefined without access. */
export async function auditTotal(
  ctx: AxiomContext,
  apl: string,
  startIso: string,
): Promise<number | undefined> {
  try {
    const rows = firstRows(
      await runApl(ctx, apl, { startTime: startIso, endTime: new Date().toISOString() }),
    );
    const value = rows[0] ? Object.values(rows[0]).find((v) => typeof v === "number") : undefined;
    return typeof value === "number" ? value : 0;
  } catch {
    return undefined;
  }
}

export const INGEST_TOTAL_APL = `${AUDIT} | where action == "usageCalculated" | summarize total = sum(tolong(['properties.hourlyIngestBytes'])) / pow(1024, 3)`;
export const QUERY_TOTAL_APL = `${AUDIT} | where action == "runAPLQueryCost" | summarize total = sum(todouble(['properties.query_cost_gbms'])) / 3600000`;
