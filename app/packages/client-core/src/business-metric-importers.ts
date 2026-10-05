/**
 * Business-metric importers: a business metric fed on a schedule from a
 * connected account, instead of (or as well as) being pushed.
 *
 * One importer per metric. It names an account whose plugin declares a
 * `businessMetricSource` (CloudWatch, BigQuery, Snowflake, Postgres, …), the
 * plugin-defined `params` that say what to read (a metric and its dimensions,
 * or a SQL statement), and how the host runs it: how often, how many trailing
 * days each run restates, which timezone the days are counted in, and how
 * several points that land on one day become that day's value.
 *
 * Everything provider-specific stays in the plugin. These types are the host's
 * half, shared by the API, web, desktop, the CLI and the MCP tools.
 */
import type {
  BusinessMetricSourceDeclaration,
  BusinessMetricSourceOption,
} from "@infrawrench/plugin-base";

import type { CloudFetch } from "./fetch";

/** How often a scheduled importer runs. */
export const BUSINESS_METRIC_IMPORT_SCHEDULES = [
  "every_6_hours",
  "every_12_hours",
  "daily",
  "weekly",
] as const;
export type BusinessMetricImportSchedule = (typeof BUSINESS_METRIC_IMPORT_SCHEDULES)[number];

export const BUSINESS_METRIC_IMPORT_SCHEDULE_HOURS: Record<BusinessMetricImportSchedule, number> = {
  every_6_hours: 6,
  every_12_hours: 12,
  daily: 24,
  weekly: 168,
};

export const BUSINESS_METRIC_IMPORT_SCHEDULE_LABELS: Record<BusinessMetricImportSchedule, string> =
  {
    every_6_hours: "Every 6 hours",
    every_12_hours: "Every 12 hours",
    daily: "Daily",
    weekly: "Weekly",
  };

/**
 * How the points a source returns for one day (and label) become that day's
 * value. A SQL query that already groups by day returns one row per day and
 * every choice gives the same answer; a metric source returning hourly
 * datapoints needs to be told whether the day is their sum or their mean.
 */
export const BUSINESS_METRIC_IMPORT_AGGREGATIONS = [
  "sum",
  "average",
  "min",
  "max",
  "last",
  "count",
] as const;
export type BusinessMetricImportAggregation = (typeof BUSINESS_METRIC_IMPORT_AGGREGATIONS)[number];

export const BUSINESS_METRIC_IMPORT_AGGREGATION_LABELS: Record<
  BusinessMetricImportAggregation,
  string
> = {
  sum: "Sum",
  average: "Average",
  min: "Minimum",
  max: "Maximum",
  last: "Last value",
  count: "Count of points",
};

export const BUSINESS_METRIC_IMPORT_LIMITS = {
  minBackfillDays: 1,
  maxBackfillDays: 730,
  defaultBackfillDays: 7,
  /** The widest window "run now" may restate in one go. */
  maxRunDays: 730,
  maxParams: 20,
  maxParamKeyLength: 64,
  maxParamValueLength: 20_000,
  /** Run-history rows kept per importer. */
  runHistory: 50,
  /** Days a preview reads by default. */
  previewDays: 14,
  /** Most values a preview returns. */
  maxPreviewValues: 400,
} as const;

/** Create/replace payload for `PUT /business-metrics/{id}/importer`. */
export interface BusinessMetricImporterInput {
  /** The connected account to read from; its plugin must declare a business-metric source. */
  accountId: string;
  /** The plugin's form values, keyed by `BusinessMetricSourceField.key`. */
  params: Record<string, string>;
  /** Absent is `daily`. */
  schedule?: BusinessMetricImportSchedule | undefined;
  /** Trailing days each scheduled run restates, ending yesterday. Absent is 7. */
  backfillDays?: number | undefined;
  /** IANA timezone the days are counted in. Absent is `UTC`. */
  timezone?: string | undefined;
  /** Absent is `sum`. */
  aggregation?: BusinessMetricImportAggregation | undefined;
  /** Absent is true. */
  enabled?: boolean | undefined;
}

/** A metric's importer, as `GET /business-metrics/{id}/importer` returns it. */
export interface BusinessMetricImporter {
  id: string;
  metricId: string;
  accountId: string;
  /** Null when the account has since been removed. */
  accountName: string | null;
  pluginId: string | null;
  sourceLabel: string | null;
  params: Record<string, string>;
  schedule: BusinessMetricImportSchedule;
  backfillDays: number;
  timezone: string;
  aggregation: BusinessMetricImportAggregation;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "success" | "error" | null;
  lastError: string | null;
  /** Failed runs in a row; reset by a success. Scheduling backs off on it. */
  consecutiveFailures: number;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const BUSINESS_METRIC_IMPORT_TRIGGERS = ["schedule", "manual"] as const;
export type BusinessMetricImportTrigger = (typeof BUSINESS_METRIC_IMPORT_TRIGGERS)[number];

export const BUSINESS_METRIC_IMPORT_RUN_STATUSES = ["running", "success", "error"] as const;
export type BusinessMetricImportRunStatus = (typeof BUSINESS_METRIC_IMPORT_RUN_STATUSES)[number];

/** One run of an importer, newest first in `GET .../importer/runs`. */
export interface BusinessMetricImportRun {
  id: string;
  importerId: string;
  trigger: BusinessMetricImportTrigger;
  status: BusinessMetricImportRunStatus;
  /** Inclusive days in the importer's timezone. */
  from: string;
  to: string;
  /** Raw points the source returned. */
  pointsRead: number;
  /** Days restated (each day counted once, however many labels it carries). */
  daysWritten: number;
  error: string | null;
  notes: string[];
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

/** `POST /business-metrics/{id}/importer/run`. Absent bounds mean the importer's own window. */
export interface BusinessMetricImportRunRequest {
  from?: string | undefined;
  to?: string | undefined;
}

/** An account that can feed a business metric, with the plugin's form. */
export interface BusinessMetricSourceAccount {
  accountId: string;
  accountName: string;
  pluginId: string;
  pluginName: string;
  source: BusinessMetricSourceDeclaration;
}

/** `POST /business-metrics/importer-options`: a picker's choices. */
export interface BusinessMetricSourceOptionsRequest {
  accountId: string;
  fieldKey: string;
  params: Record<string, string>;
}

export type { BusinessMetricSourceOption };

/** `POST /business-metrics/importer-preview`: run the query without writing anything. */
export interface BusinessMetricImportPreviewRequest {
  accountId: string;
  params: Record<string, string>;
  from?: string | undefined;
  to?: string | undefined;
  timezone?: string | undefined;
  aggregation?: BusinessMetricImportAggregation | undefined;
  /** Validate with the provider without reading data, where the source supports it. */
  dryRun?: boolean | undefined;
}

/** One aggregated day (and label) an importer would write. */
export interface BusinessMetricImportValue {
  date: string;
  value: number;
  label?: string | undefined;
}

export interface BusinessMetricImportPreview {
  from: string;
  to: string;
  /** The values a run over this window would write, oldest first (capped). */
  values: BusinessMetricImportValue[];
  pointsRead: number;
  /** Distinct days the run would restate. */
  days: number;
  notes: string[];
  durationMs: number;
  /** Set for a dry run instead of `values`. */
  dryRun?: { valid: boolean; message: string; bytesProcessed?: number | undefined } | undefined;
}

/**
 * Collapse raw source points into one value per (day, label).
 *
 * Shared so the preview, the scheduled run and the tests all agree. Output is
 * sorted by day then label; an unlabeled point keeps no label.
 */
export function aggregateBusinessMetricPoints(
  points: ReadonlyArray<{ date: string; value: number; label?: string | undefined }>,
  aggregation: BusinessMetricImportAggregation,
): BusinessMetricImportValue[] {
  const groups = new Map<string, { date: string; label: string; values: number[] }>();
  for (const point of points) {
    const label = point.label ?? "";
    const key = `${point.date}\u0000${label}`;
    let group = groups.get(key);
    if (!group) {
      group = { date: point.date, label, values: [] };
      groups.set(key, group);
    }
    group.values.push(point.value);
  }
  const out: BusinessMetricImportValue[] = [];
  for (const group of groups.values()) {
    const v = group.values;
    let value: number;
    switch (aggregation) {
      case "average":
        value = v.reduce((a, b) => a + b, 0) / v.length;
        break;
      case "min":
        value = Math.min(...v);
        break;
      case "max":
        value = Math.max(...v);
        break;
      case "last":
        value = v[v.length - 1]!;
        break;
      case "count":
        value = v.length;
        break;
      default:
        value = v.reduce((a, b) => a + b, 0);
    }
    out.push(
      group.label ? { date: group.date, value, label: group.label } : { date: group.date, value },
    );
  }
  out.sort((a, b) =>
    a.date === b.date ? (a.label ?? "").localeCompare(b.label ?? "") : a.date < b.date ? -1 : 1,
  );
  return out;
}

/** "CloudWatch metric · prod-aws · daily", for list rows and the CLI. */
export function describeBusinessMetricImporter(importer: {
  sourceLabel: string | null;
  accountName: string | null;
  schedule?: BusinessMetricImportSchedule;
}): string {
  const parts = [importer.sourceLabel ?? "Importer", importer.accountName ?? "removed account"];
  if (importer.schedule) parts.push(BUSINESS_METRIC_IMPORT_SCHEDULE_LABELS[importer.schedule]);
  return parts.join(" · ");
}

/* ------------------------------------------------------------------ *
 * Fetch helpers for anything holding a CloudFetch.
 * ------------------------------------------------------------------ */

/** A metric's importer, or null when it has none. */
export async function getBusinessMetricImporter(
  api: CloudFetch,
  orgId: string,
  metricId: string,
): Promise<BusinessMetricImporter | null> {
  const res = await api.org<{ importer: BusinessMetricImporter | null }>(
    orgId,
    `/business-metrics/${encodeURIComponent(metricId)}/importer`,
  );
  return res?.importer ?? null;
}

/* ------------------------------------------------------------------ *
 * CSV upload: parsed and mapped client-side, then written through the
 * ordinary values endpoint in batches.
 * ------------------------------------------------------------------ */

/**
 * Parse CSV text into rows of cells. Handles quoted cells, doubled quotes,
 * CRLF, and a delimiter of `,`, `;` or tab (sniffed from the first line).
 * Blank lines are dropped.
 */
export function parseMetricCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, "");
  const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", ";", "\t"].map((d) => ({ d, n: firstLine.split(d).length }));
  const delimiter = counts.sort((a, b) => b.n - a.n)[0]!.d;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && body[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

/** How the date column is written. `auto` accepts ISO dates and timestamps only. */
export const CSV_DATE_FORMATS = ["auto", "mdy", "dmy"] as const;
export type CsvDateFormat = (typeof CSV_DATE_FORMATS)[number];

export const CSV_DATE_FORMAT_LABELS: Record<CsvDateFormat, string> = {
  auto: "YYYY-MM-DD (or an ISO timestamp)",
  mdy: "MM/DD/YYYY",
  dmy: "DD/MM/YYYY",
};

function realDay(y: number, m: number, d: number): string | null {
  const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

/** A CSV date cell as YYYY-MM-DD, or null when it cannot be read in `format`. */
export function parseCsvDay(raw: string, format: CsvDateFormat): string | null {
  const text = raw.trim();
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(text);
  if (iso) return realDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  if (format === "auto") return null;
  const parts = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
  if (!parts) return null;
  const a = Number(parts[1]);
  const b = Number(parts[2]);
  const y = Number(parts[3]);
  return format === "mdy" ? realDay(y, a, b) : realDay(y, b, a);
}

/** A CSV number cell, tolerating thousands separators, spaces and a currency sign. */
export function parseCsvNumber(raw: string): number | null {
  const text = raw
    .trim()
    .replace(/^[$€£¥]/, "")
    .replace(/[\s,_]/g, "");
  if (text === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Which columns hold what. Indexes into each row; `label` is optional. */
export interface MetricCsvColumnMapping {
  date: number;
  value: number;
  label?: number | undefined;
}

/** Guess the mapping from a header row: `day`/`date`, `value`/`count`/`amount`, `label`. */
export function guessCsvMapping(header: string[]): MetricCsvColumnMapping | null {
  const lower = header.map((h) => h.trim().toLowerCase());
  const date = lower.findIndex((h) => ["day", "date", "ds", "timestamp"].includes(h));
  const value = lower.findIndex((h) =>
    ["value", "count", "amount", "total", "quantity", "revenue"].includes(h),
  );
  const label = lower.findIndex((h) => ["label", "customer", "segment", "group"].includes(h));
  if (date < 0 || value < 0) return null;
  return label >= 0 ? { date, value, label } : { date, value };
}

/** The result of mapping CSV rows to values: what will be written, and every row that will not. */
export interface CsvMappingResult {
  values: Array<{ date: string; value: number; label?: string }>;
  errors: Array<{ row: number; message: string }>;
}

/**
 * Map parsed CSV rows (header excluded) to metric values. `rowOffset` is the
 * 1-based line number of the first row, so errors point at the line the user
 * sees in their spreadsheet.
 */
export function csvRowsToMetricValues(
  rows: string[][],
  mapping: MetricCsvColumnMapping,
  format: CsvDateFormat,
  rowOffset = 2,
): CsvMappingResult {
  const values: CsvMappingResult["values"] = [];
  const errors: CsvMappingResult["errors"] = [];
  rows.forEach((row, index) => {
    const line = index + rowOffset;
    const day = parseCsvDay(row[mapping.date] ?? "", format);
    if (!day) {
      errors.push({ row: line, message: `"${row[mapping.date] ?? ""}" is not a date` });
      return;
    }
    const value = parseCsvNumber(row[mapping.value] ?? "");
    if (value === null) {
      errors.push({ row: line, message: `"${row[mapping.value] ?? ""}" is not a number` });
      return;
    }
    const label =
      mapping.label !== undefined ? (row[mapping.label] ?? "").trim().slice(0, 120) : "";
    values.push(label ? { date: day, value, label } : { date: day, value });
  });
  return { values, errors };
}
