/**
 * Running APL. Axiom's query endpoint answers `?format=tabular` with
 * `tables[]`, each holding `fields[]` (name, type) and `columns[]`: one array
 * per field, column-major. Everything here turns that into rows.
 *
 * Where a query runs: the edge deployment the dataset lives in
 * (`https://<edge host>/v1/query/_apl`), which only accepts API tokens.
 * Personal access tokens fall back to `https://api.axiom.co/v1/datasets/_apl`,
 * which serves the organization's default edge deployment.
 */

import type { MetricSeries, MetricSeriesPoint } from "@infrawrench/plugin-base";
import type { AxiomContext } from "./api.js";
import { axFetch, isPersonalToken } from "./api.js";

export interface AplTable {
  name?: string;
  fields?: Array<{ name?: string; type?: string; agg?: { name?: string } }>;
  columns?: unknown[][];
}

export interface AplResult {
  format?: string;
  status?: {
    elapsedTime?: number;
    rowsExamined?: number;
    rowsMatched?: number;
    isPartial?: boolean;
  };
  tables?: AplTable[];
}

/** Base URL a query should be sent to, from a dataset's edge deployment URL. */
export function queryBase(edgeUrl: string | undefined): string | undefined {
  if (!edgeUrl) return undefined;
  const url = edgeUrl.startsWith("http") ? edgeUrl : `https://${edgeUrl}`;
  try {
    const u = new URL(url);
    // Only Axiom's own edge hosts: never send the token anywhere else.
    if (!u.hostname.endsWith(".axiom.co")) return undefined;
    return `https://${u.hostname}`;
  } catch {
    return undefined;
  }
}

export async function runApl(
  ctx: AxiomContext,
  apl: string,
  opts: { startTime?: string; endTime?: string; edgeUrl?: string } = {},
): Promise<AplResult> {
  const body = JSON.stringify({
    apl,
    ...(opts.startTime ? { startTime: opts.startTime } : {}),
    ...(opts.endTime ? { endTime: opts.endTime } : {}),
  });
  const base = queryBase(opts.edgeUrl);
  if (base && !isPersonalToken(ctx.token)) {
    return axFetch<AplResult>(ctx, "/v1/query/_apl", {
      method: "POST",
      body,
      baseUrl: base,
      query: { format: "tabular" },
    });
  }
  return axFetch<AplResult>(ctx, "/v1/datasets/_apl", {
    method: "POST",
    body,
    query: { format: "tabular" },
  });
}

/** Rows of one tabular table, keyed by field name. */
export function tableRows(table: AplTable | undefined): Array<Record<string, unknown>> {
  if (!table) return [];
  const names = (table.fields ?? []).map((f, i) => f.name ?? `col${i}`);
  const cols = table.columns ?? [];
  const length = Math.max(0, ...cols.map((c) => (Array.isArray(c) ? c.length : 0)));
  const rows: Array<Record<string, unknown>> = [];
  for (let r = 0; r < length; r++) {
    const row: Record<string, unknown> = {};
    names.forEach((name, c) => {
      row[name] = cols[c]?.[r];
    });
    rows.push(row);
  }
  return rows;
}

/** The first table that has rows (time-series results come first). */
export function firstRows(result: AplResult): Array<Record<string, unknown>> {
  for (const t of result.tables ?? []) {
    const rows = tableRows(t);
    if (rows.length > 0) return rows;
  }
  return [];
}

const TIME_FIELDS = ["_time", "bin_auto__time", "time"];

/**
 * Turn rows of a `summarize … by bin(_time, …)` result into series: every
 * numeric column other than the time becomes one series, split by the
 * remaining string columns (the group-by keys), busiest groups first.
 */
export function rowsToSeries(
  rows: Array<Record<string, unknown>>,
  opts: {
    units?: Record<string, string>;
    labels?: Record<string, string>;
    maxGroups?: number;
  } = {},
): MetricSeries[] {
  if (rows.length === 0) return [];
  const sample = rows[0] ?? {};
  const keys = Object.keys(sample);
  const timeKey = keys.find((k) => TIME_FIELDS.includes(k) || /time/i.test(k));
  if (!timeKey) return [];
  const numeric = keys.filter((k) => k !== timeKey && rows.some((r) => typeof r[k] === "number"));
  const groupKeys = keys.filter((k) => k !== timeKey && !numeric.includes(k));
  const out = new Map<string, { total: number; points: MetricSeriesPoint[]; unit?: string }>();
  for (const row of rows) {
    const ts = Date.parse(String(row[timeKey] ?? ""));
    if (!Number.isFinite(ts)) continue;
    const group = groupKeys
      .map((k) => row[k])
      .filter((v) => v !== null && v !== undefined && v !== "")
      .map(String)
      .join(", ");
    for (const k of numeric) {
      const v = row[k];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const base = opts.labels?.[k] ?? k;
      const label = group ? `${base} (${group})` : base;
      let e = out.get(label);
      if (!e) {
        const unit = opts.units?.[k];
        e = { total: 0, points: [], ...(unit ? { unit } : {}) };
        out.set(label, e);
      }
      e.total += Math.abs(v);
      e.points.push({ timestamp: ts, value: v });
    }
  }
  const max = (opts.maxGroups ?? 8) * Math.max(1, numeric.length);
  return [...out.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, max)
    .map(([label, e]) => ({
      label,
      ...(e.unit ? { unit: e.unit } : {}),
      points: e.points.sort((a, b) => a.timestamp - b.timestamp),
    }));
}

/** Quote a dataset name for APL: `['name']`. */
export function aplDataset(name: string): string {
  return `['${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`;
}

/** An APL string literal. */
export function aplString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
