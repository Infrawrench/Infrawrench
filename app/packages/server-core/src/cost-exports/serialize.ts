/**
 * Row → bytes for scheduled cost exports.
 *
 * Both serialisers are async generators over the row stream, so the object body
 * is produced incrementally and never exists as one string. They also both
 * append the two provenance columns that make a restated export reconcilable:
 *
 *   * `exported_at` — when *this copy* of the object was produced.
 *   * `collection_watermark` — the newest day for which every cost-collecting
 *     account in the org had reported when the run started. Rows dated after it
 *     are still arriving, so a consumer can hold back a period rather than
 *     publishing a number that is about to change.
 *
 * Putting them in the rows rather than only in object metadata is deliberate:
 * object metadata does not survive a `COPY INTO` or a Spark read, and a
 * warehouse that cannot see the watermark cannot act on it.
 */
import { COST_EXPORT_BASE_COLUMNS, COST_EXPORT_PROVENANCE_COLUMNS } from "@infrawrench/client-core";
import type { CostExportColumns, CostExportRow } from "./rows";

export interface ProvenanceStamp {
  /** ISO timestamp of the run producing this object. */
  exportedAt: string;
  /** ISO date, or "" when the org has no collecting accounts yet. */
  collectionWatermark: string;
}

/**
 * The full ordered column list an object's header declares: `day`, then the
 * chosen identity columns, then the measures, then provenance. Identity first
 * and measures last is what makes the file readable by eye and diffable between
 * two exports whose dimension sets differ.
 */
export function outputColumns(columns: CostExportColumns): string[] {
  return [
    "day",
    ...columns.dimensions,
    ...columns.tagColumns,
    ...COST_EXPORT_BASE_COLUMNS,
    ...COST_EXPORT_PROVENANCE_COLUMNS,
  ];
}

/**
 * RFC 4180 quoting: wrap in double quotes and double any embedded quote,
 * whenever the value contains a quote, comma, CR or LF. Resource ids and tag
 * values routinely contain commas, so this is the common path, not an edge.
 */
export function csvCell(value: string | number | undefined): string {
  if (value === undefined || value === null) return "";
  const s = String(value);
  if (!/[",\r\n]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function rowValues(
  row: CostExportRow,
  columns: CostExportColumns,
  stamp: ProvenanceStamp,
): Array<string | number> {
  const out: Array<string | number> = [row["day"] ?? ""];
  for (const dim of columns.dimensions) out.push(row[dim] ?? "");
  for (const tag of columns.tagColumns) out.push(row[tag] ?? "");
  out.push(row["currency"] ?? "");
  // ClickHouse returns aggregate sums as numbers in JSONEachRow, but Decimal
  // and large-UInt columns come back as strings; Number() normalises both so
  // the object never mixes `1.5` and `"1.5"` in one column.
  out.push(Number(row["amount"] ?? 0));
  out.push(Number(row["usage_amount"] ?? 0));
  out.push(row["usage_unit"] ?? "");
  out.push(stamp.exportedAt, stamp.collectionWatermark);
  return out;
}

/** CSV with a header line. Newline-terminated, so concatenation stays valid. */
export async function* toCsv(
  rows: AsyncIterable<CostExportRow>,
  columns: CostExportColumns,
  stamp: ProvenanceStamp,
): AsyncGenerator<string, void, undefined> {
  yield `${outputColumns(columns).join(",")}\n`;
  for await (const row of rows) {
    yield `${rowValues(row, columns, stamp).map(csvCell).join(",")}\n`;
  }
}

/** One JSON object per line — the shape BigQuery, Snowflake and DuckDB all load. */
export async function* toNdjson(
  rows: AsyncIterable<CostExportRow>,
  columns: CostExportColumns,
  stamp: ProvenanceStamp,
): AsyncGenerator<string, void, undefined> {
  const names = outputColumns(columns);
  for await (const row of rows) {
    const values = rowValues(row, columns, stamp);
    const obj: Record<string, string | number> = {};
    names.forEach((name, i) => {
      obj[name] = values[i] ?? "";
    });
    yield `${JSON.stringify(obj)}\n`;
  }
}

/** Pick the serialiser and the MIME type for a format. */
export function serializeRows(
  format: "csv" | "ndjson",
  rows: AsyncIterable<CostExportRow>,
  columns: CostExportColumns,
  stamp: ProvenanceStamp,
): { body: AsyncIterable<string>; contentType: string } {
  return format === "ndjson"
    ? { body: toNdjson(rows, columns, stamp), contentType: "application/x-ndjson" }
    : { body: toCsv(rows, columns, stamp), contentType: "text/csv; charset=utf-8" };
}
