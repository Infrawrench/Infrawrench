/**
 * Unit costs as a file: one row per bucket per series, carrying the ratio
 * *and* the numerator and denominator that produced it.
 *
 * Shared by the card's download button (which serialises the response it has
 * already drawn, so the file is exactly the chart), the API's
 * `POST /business-metrics/{id}/unit-costs/export` (the CLI and scripts), and
 * the export jobs that add unit-cost columns to a report's CSV.
 *
 * The rules a chart follows hold in the file too:
 *
 * - **A gap is empty, never 0.** `value` is blank and `gap` names the reason;
 *   a spreadsheet that summed a column of zeros for unreported days would
 *   reproduce exactly the lie the chart refuses to draw.
 * - **The arithmetic travels with the answer.** `cost` and `metric_value` are
 *   the summed numerator and (unscaled) denominator, so anyone can recompute
 *   `value` and check it. `scale` says what `value` is per.
 * - **Partial buckets are flagged** (`reported_days < bucket_days`), because a
 *   weekly ratio over six days of volume reads high and nothing about the
 *   number shows it.
 */
import type { UnitCostQueryRequest, UnitCostQueryResponse } from "./business-metrics";

export const UNIT_COST_EXPORT_FORMATS = ["csv", "ndjson"] as const;
export type UnitCostExportFormat = (typeof UNIT_COST_EXPORT_FORMATS)[number];

/** Body of the `…/unit-costs/export` routes: the query, plus the file format (default CSV). */
export interface UnitCostExportRequest extends UnitCostQueryRequest {
  format?: UnitCostExportFormat | undefined;
}

/** Column order of the CSV (and key order of each NDJSON object). */
export const UNIT_COST_EXPORT_COLUMNS = [
  "bucket",
  "bucket_days",
  "reported_days",
  "partial",
  "label_key",
  "label_value",
  "label_other",
  "currency",
  "mode",
  "scale",
  "metric_key",
  "metric_unit",
  "usage_unit",
  "cost",
  "metric_value",
  "value",
  "absolute_margin",
  "gap",
] as const;
export type UnitCostExportColumn = (typeof UNIT_COST_EXPORT_COLUMNS)[number];

/** One exported row. `null` is an empty CSV cell and a JSON `null`. */
export type UnitCostExportRow = Record<UnitCostExportColumn, string | number | boolean | null>;

/** Flatten a unit-cost response to rows, series by series, buckets in order. */
export function unitCostExportRows(response: UnitCostQueryResponse): UnitCostExportRow[] {
  const rows: UnitCostExportRow[] = [];
  for (const series of response.series) {
    const points = [...series.points].sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
    for (const p of points) {
      rows.push({
        bucket: p.bucket,
        bucket_days: p.bucketDays,
        reported_days: p.reportedDays,
        partial: p.value !== null && p.reportedDays > 0 && p.reportedDays < p.bucketDays,
        label_key: series.label?.key ?? response.groupByLabel ?? null,
        label_value: series.label ? (series.label.other ? null : series.label.value) : null,
        label_other: series.label?.other === true,
        currency: series.currency,
        mode: response.mode,
        scale: response.scale,
        metric_key: response.metric?.key ?? null,
        metric_unit: response.metric?.unit ?? null,
        usage_unit: response.usageUnit ?? null,
        cost: p.cost,
        metric_value: p.metricValue,
        value: p.value,
        absolute_margin: p.absoluteMargin ?? null,
        gap: p.gap ?? null,
      });
    }
  }
  return rows;
}

/**
 * One CSV cell. Numbers and booleans are written bare; text is quoted when it
 * needs to be, and text starting with `=`, `+`, `-` or `@` is prefixed with a
 * quote mark so a spreadsheet does not execute a label value that came from a
 * customer's own data as a formula. Numbers are never prefixed: a negative
 * margin must stay a number.
 */
export function unitCostCsvCell(value: string | number | boolean | null): string {
  if (value === null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** CSV with a header line, LF-terminated. */
export function unitCostRowsToCsv(rows: readonly UnitCostExportRow[]): string {
  const lines = [UNIT_COST_EXPORT_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(UNIT_COST_EXPORT_COLUMNS.map((c) => unitCostCsvCell(row[c])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** One JSON object per line. */
export function unitCostRowsToNdjson(rows: readonly UnitCostExportRow[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

export interface UnitCostExportFile {
  body: string;
  contentType: string;
  extension: "csv" | "ndjson";
}

/** Serialise a response in `format`. */
export function unitCostExportFile(
  response: UnitCostQueryResponse,
  format: UnitCostExportFormat,
): UnitCostExportFile {
  const rows = unitCostExportRows(response);
  return format === "ndjson"
    ? { body: unitCostRowsToNdjson(rows), contentType: "application/x-ndjson", extension: "ndjson" }
    : { body: unitCostRowsToCsv(rows), contentType: "text/csv; charset=utf-8", extension: "csv" };
}

/**
 * `unit-costs-<metric or usage unit>-<from>-to-<to>.<ext>`, filesystem safe.
 * The range is the request's, which the response does not echo.
 */
export function unitCostExportFilename(
  response: Pick<UnitCostQueryResponse, "metric" | "usageUnit">,
  range: { from: string; to: string },
  format: UnitCostExportFormat,
): string {
  const subject = (response.metric?.key ?? response.usageUnit ?? "usage")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `unit-costs-${subject || "metric"}-${range.from}-to-${range.to}.${format}`;
}

/**
 * The per-day unit-cost columns appended to a cost report's export when the
 * report has a business metric attached. Each row of the report's file gets
 * the unit-cost figures of **its day across the whole report scope**, so the
 * columns repeat across the rows of one day; dividing a single resource's
 * slice by the org-wide denominator would be a number nobody asked for.
 */
export const REPORT_UNIT_COST_COLUMNS = [
  "unit_cost_metric",
  "unit_cost_mode",
  "unit_cost_scope_cost",
  "unit_cost_metric_value",
  "unit_cost_value",
  "unit_cost_gap",
] as const;
export type ReportUnitCostColumn = (typeof REPORT_UNIT_COST_COLUMNS)[number];

/**
 * Index a daily unit-cost response by `day|currency` for the report export,
 * ignoring label series (a report export is not split by metric label).
 */
export function reportUnitCostLookup(
  response: UnitCostQueryResponse,
): Map<string, Record<ReportUnitCostColumn, string | number | null>> {
  const out = new Map<string, Record<ReportUnitCostColumn, string | number | null>>();
  const metric = response.metric?.key ?? response.usageUnit ?? null;
  for (const series of response.series) {
    if (series.label) continue;
    for (const p of series.points) {
      out.set(`${p.bucket}|${series.currency}`, {
        unit_cost_metric: metric,
        unit_cost_mode: response.mode,
        unit_cost_scope_cost: p.cost,
        unit_cost_metric_value: p.metricValue,
        unit_cost_value: p.value,
        unit_cost_gap: p.gap ?? null,
      });
    }
  }
  return out;
}
