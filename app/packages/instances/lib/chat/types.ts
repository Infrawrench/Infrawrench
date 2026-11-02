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
  /** A round of tool calls finished; the browser keeps it with the answer (`ChatTurn.steps`). */
  | { type: "tool_step"; step: SignedToolStep }
  | { type: "error"; message: string; code?: "rate_limited" | "unavailable" | "refused" }
  | { type: "done" };

/** A view as the conversation remembers it. */
export interface ViewRef {
  id: string;
  kind: ViewSpec["kind"];
  title: string;
  sql: string;
}

/** One tool call as the model made it, with the result text it was given. */
export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  result: string;
  isError?: boolean;
}

/**
 * One round of tool calls (the calls the model made in one response, which
 * run in parallel) as the browser keeps it: `data` is the JSON of its
 * `ToolCallRecord[]` and `sig` the server's HMAC over it (`lib/chat/steps.ts`),
 * so a later turn can hand the model its earlier results without trusting
 * the browser for them.
 */
export interface SignedToolStep {
  data: string;
  sig: string;
}

/**
 * Answers whose tool calls go back to the model, counting back from the
 * newest. Older answers keep only their text and the SQL of their views.
 */
export const STEP_HISTORY_ANSWERS = 3;

/** The transcript the browser keeps and sends back with every message. */
export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  views?: ViewRef[];
  /** An answer's tool calls, in order (only the last `STEP_HISTORY_ANSWERS` answers send them). */
  steps?: SignedToolStep[];
}

export const viewRef = (v: StoredView): ViewRef => ({
  id: v.id,
  kind: v.kind,
  title: v.title,
  sql: v.sql,
});
