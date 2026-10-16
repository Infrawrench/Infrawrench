/**
 * Background cost export jobs: the contract for `POST /costs/exports/jobs`
 * and `GET /costs/exports/jobs/{id}`, plus the pure helpers the server, the
 * UI and the CLI share.
 *
 * A job is the asynchronous sibling of the streamed `POST /costs/focus-export`
 * download: the same rows, written on the gateway in the background, so a year
 * of per-resource FOCUS rows or a long native export never has to finish
 * inside one HTTP request. The client polls the job, watches `progress`, and
 * fetches the file once `status` is `succeeded`. Files are kept for
 * {@link COST_EXPORT_JOB_LIMITS.retentionHours} hours, then deleted.
 */
import type { CostBasis, CostChargeType, CostFilter } from "./costs";
import type { FocusVersion } from "./cost-exports";
import type { UnitCostMode, UnitCostScale } from "./business-metrics";

/**
 * - `csv` / `ndjson`: Infrawrench's own columns (`day`, the report's group-by
 *   dimension, `currency`, `amount`, `usage_amount`, `usage_unit`, provenance),
 *   plus per-day unit-cost columns when the report draws a unit cost.
 * - `focus`: the FOCUS layout, full row grain, as CSV.
 */
export const COST_EXPORT_JOB_FORMATS = ["csv", "ndjson", "focus"] as const;
export type CostExportJobFormat = (typeof COST_EXPORT_JOB_FORMATS)[number];

export const COST_EXPORT_JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
] as const;
export type CostExportJobStatus = (typeof COST_EXPORT_JOB_STATUSES)[number];

export const COST_EXPORT_JOB_LIMITS = {
  /** Longest range one job may span, in days (inclusive): two years. */
  maxDays: 731,
  /** Jobs one person may have queued or running at once, per org. */
  maxActivePerUser: 3,
  /** How long a finished file is kept. */
  retentionHours: 24,
  /** Largest file a job writes, uncompressed. A scheduled export has no cap. */
  maxBytes: 256 * 1024 * 1024,
  /** Uncompressed bytes per stored chunk. */
  chunkBytes: 2 * 1024 * 1024,
  /** Jobs listed by `GET /costs/exports/jobs`, newest first. */
  listLimit: 20,
} as const;

/** How often clients poll a job that is still queued or running. */
export const COST_EXPORT_JOB_POLL_MS = 2000;

/** The ad-hoc scope of a job that is not a saved report: a cost query's narrowing. */
export interface CostExportJobQuery {
  filters?: CostFilter[] | undefined;
  /** Cost query language text, compiled server-side like `/costs/query`'s. */
  query?: string | undefined;
  savedFilterId?: string | undefined;
  chargeTypes?: CostChargeType[] | undefined;
  /** Which amount the native `amount` column carries. Ignored for FOCUS. */
  costBasis?: CostBasis | undefined;
  /** Row-identity dimensions for the native layout (`service`, `account`…). */
  dimensions?: string[] | undefined;
  /** Tag keys written as their own `tag_<key>` columns (native layout). */
  tagKeys?: string[] | undefined;
  /** Virtual tag keys written as `vtag_<key>` columns (native layout). */
  virtualTagKeys?: string[] | undefined;
}

/** Body of `POST /costs/exports/jobs`. Exactly one of `reportId` and `query`. */
export interface CostExportJobRequest {
  /** Export a saved report's scope: its filters, group-by and unit cost. */
  reportId?: string | undefined;
  query?: CostExportJobQuery | undefined;
  format: CostExportJobFormat;
  /** FOCUS version for `format: "focus"`; the latest when omitted. */
  focusVersion?: FocusVersion | undefined;
  /**
   * Inclusive day range. Required with `query`; with `reportId` it defaults to
   * the report's own date range resolved today.
   */
  from?: string | undefined;
  to?: string | undefined;
}

/**
 * What a job exports, resolved when it was created (a saved filter expanded, a
 * report's config read), so editing the report afterwards cannot change a file
 * that is already being written. Stored on the job; the public shape below
 * exposes only the descriptive half.
 */
export interface CostExportJobSource {
  kind: "report" | "query";
  reportId?: string | undefined;
  reportName?: string | undefined;
  filters: CostFilter[];
  chargeTypes?: CostChargeType[] | undefined;
  costBasis?: CostBasis | undefined;
  dimensions: string[];
  tagKeys: string[];
  virtualTagKeys?: string[] | undefined;
  /**
   * The report's unit cost, when it draws one: the export adds per-day
   * unit-cost columns for it (native layouts only).
   */
  unitCost?:
    | {
        metricId: string | null;
        metricName: string;
        mode: UnitCostMode;
        scale?: UnitCostScale | undefined;
        usageUnit?: string | undefined;
      }
    | undefined;
}

/** One job, as the API returns it. */
export interface CostExportJob {
  id: string;
  status: CostExportJobStatus;
  format: CostExportJobFormat;
  focusVersion: FocusVersion | null;
  from: string;
  to: string;
  source: {
    kind: "report" | "query";
    reportId: string | null;
    reportName: string | null;
    /** The metric (or usage unit) whose unit-cost columns the file carries. */
    unitCostMetric: string | null;
  };
  /** 0..1: the share of the requested days already written. */
  progress: number;
  rowCount: number;
  /** Uncompressed bytes written so far. */
  byteCount: number;
  error: string | null;
  fileName: string;
  contentType: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** When the file is deleted; set once it succeeds. */
  expiresAt: string | null;
  /**
   * Path to fetch the file from (relative to the API origin, authenticated
   * like every other route), once `status` is `succeeded`; null otherwise.
   */
  downloadUrl: string | null;
}

/** Still worth polling. */
export function isCostExportJobActive(status: CostExportJobStatus): boolean {
  return status === "queued" || status === "running";
}

/** Inclusive day count between two `YYYY-MM-DD` days. */
function daySpanInclusive(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * Progress from the newest day written. Rows stream out in day order (both
 * layouts sort by day first), so the day of the latest row is an honest
 * measure of how much of the range is done. Never reports 1 before the end:
 * the last day may still have rows to come.
 */
export function costExportJobProgress(day: string, from: string, to: string): number {
  const span = daySpanInclusive(from, to);
  if (!(span > 0) || !day) return 0;
  const done = daySpanInclusive(from, day) - 1;
  return Math.min(0.99, Math.max(0, done / span));
}

/** The file name a job is saved under. */
export function costExportJobFilename(args: {
  format: CostExportJobFormat;
  from: string;
  to: string;
  name?: string | undefined;
}): string {
  const slug = (args.name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const stem = args.format === "focus" ? "focus" : "costs";
  const ext = args.format === "ndjson" ? "ndjson" : "csv";
  return `${stem}-${slug ? `${slug}-` : ""}${args.from}-to-${args.to}.${ext}`;
}

/** MIME type of a job's file. */
export function costExportJobContentType(format: CostExportJobFormat): string {
  return format === "ndjson" ? "application/x-ndjson" : "text/csv; charset=utf-8";
}

/** Human-readable byte count for progress lines: `12.4 MB`. */
export function formatExportBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
