import type { QueryResult } from "@infrawrench/server-core/aws-pricing-warehouse/query";

/**
 * What the chat's server and browser halves share: saved views (a table or a
 * chart over one warehouse query), query results, and the NDJSON events
 * `POST /api/chat` streams.
 */

/** How a column's values are shown. */
export type ColumnFormat =
  | "text"
  | "number"
  | "usd_hour"
  | "usd_month"
  | "usd"
  | "gib"
  | "percent"
  | "datetime"
  | "date"
  | "instance"
  | "bool";

export const COLUMN_FORMATS: readonly ColumnFormat[] = [
  "text",
  "number",
  "usd_hour",
  "usd_month",
  "usd",
  "gib",
  "percent",
  "datetime",
  "date",
  "instance",
  "bool",
];

export interface ViewColumn {
  /** The result column it describes. */
  name: string;
  /** Header text; the column name when absent. */
  label?: string;
  format?: ColumnFormat;
}

export interface TableSpec {
  kind: "table";
  title: string;
  sql: string;
  columns?: ViewColumn[];
  sort?: { column: string; direction: "asc" | "desc" };
}

export interface ChartSpec {
  kind: "chart";
  title: string;
  sql: string;
  /** `bar`: one bar per row (x is the label); `line`: values over time (x is a DateTime). */
  chart: "bar" | "line";
  x: string;
  y: string;
  /** Splits a line chart into one line per value of this column. */
  series?: string;
  format?: ColumnFormat;
}

export type ViewSpec = TableSpec | ChartSpec;

/** A view as stored: immutable once saved, addressed by `/v/<id>`. */
export type StoredView = ViewSpec & { id: string; createdAt: number };

export type { Cell, QueryResult } from "@infrawrench/server-core/aws-pricing-warehouse/query";

export interface ViewData {
  view: StoredView;
  result: QueryResult;
  /** When the query ran, Unix ms. */
  ranAt: number;
}

/** One line of `POST /api/chat`'s response. */
export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "status"; status: "thinking" | "query"; sql?: string }
  | { type: "view"; data: ViewData; watch?: boolean }
  | { type: "error"; message: string; code?: "rate_limited" | "unavailable" | "refused" }
  | { type: "done" };

/** A view as the conversation remembers it. */
export interface ViewRef {
  id: string;
  kind: ViewSpec["kind"];
  title: string;
  sql: string;
}

/** The transcript the browser keeps and sends back with every message. */
export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  views?: ViewRef[];
}

export const viewRef = (v: StoredView): ViewRef => ({
  id: v.id,
  kind: v.kind,
  title: v.title,
  sql: v.sql,
});
