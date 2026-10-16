/**
 * Background cost export jobs (`/costs/exports/jobs`).
 *
 * The streamed `POST /costs/focus-export` has to finish inside one request,
 * which a year of per-resource rows does not do comfortably and a two-year
 * native export does not do at all. A job takes the same rows off the request
 * path: the route records what to export and answers at once, a loop on the
 * session gateway (`cost-export-job-loop.ts`) writes the file in the
 * background, the client polls the job for progress, and fetches the file when
 * it is done. Files are kept for a day.
 *
 * ## Where the file lives
 *
 * In Postgres, as base64(gzip) chunks in `cost_export_job_chunks`, which is how
 * this app already stores the one other file it keeps for itself (session
 * recordings). There is no app-owned bucket to put it in, and a file that lives
 * for 24 hours does not justify one. Chunks are appended as the rows stream,
 * so the writer never holds more than one chunk, and the download streams them
 * back in order.
 *
 * ## What is resolved when
 *
 * Everything that decides *which rows* is resolved at creation, inside the
 * request: the report is read with the caller's sharing, its saved filter is
 * expanded, the range is resolved against today. The job then holds a frozen
 * description (`CostExportJobSource`), so editing the report afterwards cannot
 * change a file that is being written. *Whose* rows is re-resolved at run time
 * from the stored principal, because the loop runs outside any request: the
 * rows are read inside the creator's cost visibility, exactly as their graphs
 * are, and a scoped member's export can never contain more than they can see.
 */
import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  COST_EXPORT_JOB_LIMITS,
  FOCUS_LATEST_VERSION,
  REPORT_UNIT_COST_COLUMNS,
  costExportJobContentType,
  costExportJobFilename,
  costExportJobProgress,
  costQueryForConfig,
  isCostExportJobActive,
  reportUnitCostLookup,
  unitCostCsvCell,
  type CostExportJob,
  type CostExportJobRequest,
  type CostExportJobSource,
  type CostExportJobStatus,
  type CostGraphConfig,
  type FocusVersion,
  type ReportUnitCostColumn,
  type UnitCostQueryRequest,
} from "@infrawrench/client-core";
import { db } from "@infrawrench/server-core/db/client";
import { costExportJobChunks, costExportJobs } from "@infrawrench/server-core/db/schema";
import {
  resolveCostVisibility,
  type CostVisibilityPrincipal,
} from "@infrawrench/server-core/cost/visibility";
import { runWithCostVisibility } from "@infrawrench/server-core/cost/visibility-context";
import {
  resolveColumns,
  streamCostExportRows,
  type CostExportColumns,
  type CostExportRow,
} from "@infrawrench/server-core/cost-exports/rows";
import {
  csvCell,
  outputColumns,
  rowValues,
  type ProvenanceStamp,
} from "@infrawrench/server-core/cost-exports/serialize";
import {
  loadFocusLookups,
  mapFocusRows,
  streamFocusSourceRows,
  toFocusCsv,
  type FocusSourceRow,
} from "@infrawrench/server-core/cost-exports/focus";
import { costCollectionWatermark } from "@infrawrench/server-core/cost-exports/run";
import { CostQueryError, daySpan, resolveCostRequestFilters } from "./cost-query";
import { getCostReport } from "./cost-reports";
import { getBusinessMetric } from "./business-metrics";
import { runUnitCostQuery, runUsageUnitCostQuery } from "./unit-cost-query";

/** A request the caller can fix; `status` is the HTTP answer. */
export class CostExportJobError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "CostExportJobError";
  }
}

type JobRow = typeof costExportJobs.$inferSelect;

/**
 * How long a claim holds a job without a heartbeat. The writer renews it on
 * every chunk (a couple of MB of rows), so only a process that died or hung
 * lets it lapse, and the next claim then restarts the job.
 */
export const COST_EXPORT_JOB_LEASE_MS = 3 * 60 * 1000;

/** Claims before a job that keeps dying is failed rather than retried. */
const MAX_ATTEMPTS = 3;

/** Dimensions the native layout can carry as row identity (see `rows.ts`). */
const NATIVE_DIMENSIONS = new Set([
  "provider",
  "account",
  "service",
  "region",
  "resource",
  "charge_type",
  "commitment",
]);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

/** The API shape of a job row. */
export function toCostExportJob(row: JobRow): CostExportJob {
  const source = row.source as CostExportJobSource;
  const status = row.status as CostExportJobStatus;
  return {
    id: row.id,
    status,
    format: row.format as CostExportJob["format"],
    focusVersion: (row.focusVersion as FocusVersion | null) ?? null,
    from: row.fromDay,
    to: row.toDay,
    source: {
      kind: source.kind,
      reportId: source.reportId ?? null,
      reportName: source.reportName ?? null,
      unitCostMetric: source.unitCost?.metricName ?? null,
    },
    progress: status === "succeeded" ? 1 : row.progress,
    rowCount: row.rowCount,
    byteCount: row.byteCount,
    error: row.error,
    fileName: row.fileName,
    contentType: row.contentType,
    createdAt: row.createdAt.toISOString(),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    expiresAt: iso(row.expiresAt),
    downloadUrl:
      status === "succeeded"
        ? `/api/org/${row.organizationId}/costs/exports/jobs/${row.id}/download`
        : null,
  };
}

/* ------------------------------------------------------------------ *
 * Creation (inside the request)
 * ------------------------------------------------------------------ */

/** The native row identity a report's group-by asks for. */
function dimensionsForConfig(config: CostGraphConfig): {
  dimensions: string[];
  tagKeys: string[];
  virtualTagKeys: string[];
} {
  const groupBy = config.groupBy;
  if (groupBy === "tag" && config.groupByTagKey) {
    return { dimensions: [], tagKeys: [config.groupByTagKey], virtualTagKeys: [] };
  }
  if (groupBy === "virtual_tag" && config.groupByTagKey) {
    return { dimensions: [], tagKeys: [], virtualTagKeys: [config.groupByTagKey] };
  }
  if (groupBy && NATIVE_DIMENSIONS.has(groupBy)) {
    return { dimensions: [groupBy], tagKeys: [], virtualTagKeys: [] };
  }
  return { dimensions: [], tagKeys: [], virtualTagKeys: [] };
}

async function sourceForReport(
  organizationId: string,
  reportId: string,
  today: Date,
): Promise<{ source: CostExportJobSource; from: string; to: string }> {
  const report = await getCostReport(organizationId, reportId);
  if (!report) throw new CostExportJobError("Cost report not found", 404);
  const config = report.config;
  const q = costQueryForConfig(config, today);
  const filters = await resolveCostRequestFilters(organizationId, {
    filters: config.filters ?? [],
    ...(config.savedFilterId ? { savedFilterId: config.savedFilterId } : {}),
  });

  let unitCost: CostExportJobSource["unitCost"];
  const mode = config.unitCostMode ?? "unit_cost";
  if (mode === "usage_unit_cost" && config.unitCostUsageUnit) {
    unitCost = {
      metricId: null,
      metricName: config.unitCostUsageUnit,
      mode,
      usageUnit: config.unitCostUsageUnit,
      ...(config.unitCostScale ? { scale: config.unitCostScale } : {}),
    };
  } else if (config.unitCostMetricId) {
    const metric = await getBusinessMetric(organizationId, config.unitCostMetricId);
    // A deleted metric leaves the report drawing an error; the export just
    // goes without the columns rather than failing the whole file.
    if (metric) {
      unitCost = {
        metricId: metric.id,
        metricName: metric.key,
        mode,
        ...(config.unitCostScale && mode !== "margin" ? { scale: config.unitCostScale } : {}),
      };
    }
  }

  return {
    from: q.from,
    to: q.to,
    source: {
      kind: "report",
      reportId: report.id,
      reportName: report.name,
      filters,
      ...(config.costBasis ? { costBasis: config.costBasis } : {}),
      ...dimensionsForConfig(config),
      ...(unitCost ? { unitCost } : {}),
    },
  };
}

async function sourceForQuery(
  organizationId: string,
  query: NonNullable<CostExportJobRequest["query"]>,
): Promise<CostExportJobSource> {
  const unknown = (query.dimensions ?? []).filter((d) => !NATIVE_DIMENSIONS.has(d));
  if (unknown.length > 0) {
    throw new CostExportJobError(
      `Unknown dimension${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Use any of ${[...NATIVE_DIMENSIONS].join(", ")}; tags go in tagKeys.`,
    );
  }
  const filters = await resolveCostRequestFilters(organizationId, {
    filters: query.filters ?? [],
    ...(query.query ? { query: query.query } : {}),
    ...(query.savedFilterId ? { savedFilterId: query.savedFilterId } : {}),
  });
  return {
    kind: "query",
    filters,
    ...(query.chargeTypes && query.chargeTypes.length > 0
      ? { chargeTypes: query.chargeTypes }
      : {}),
    ...(query.costBasis ? { costBasis: query.costBasis } : {}),
    dimensions: [...new Set(query.dimensions ?? [])],
    tagKeys: [...new Set(query.tagKeys ?? [])],
    virtualTagKeys: [...new Set(query.virtualTagKeys ?? [])],
  };
}

/**
 * Validate a request, freeze what it exports, and queue it.
 *
 * @throws {CostExportJobError} for anything the caller can fix: 404 for a
 *   report they cannot see, 409 at the per-person concurrency cap.
 */
export async function createCostExportJob(
  organizationId: string,
  principal: CostVisibilityPrincipal,
  request: CostExportJobRequest,
  today = new Date(),
): Promise<CostExportJob> {
  if (Boolean(request.reportId) === Boolean(request.query)) {
    throw new CostExportJobError("Send exactly one of reportId and query.");
  }

  let resolved: { source: CostExportJobSource; from: string; to: string };
  try {
    if (request.reportId) {
      resolved = await sourceForReport(organizationId, request.reportId, today);
    } else {
      if (!request.from || !request.to) {
        throw new CostExportJobError("An export of a query needs from and to.");
      }
      resolved = {
        source: await sourceForQuery(organizationId, request.query!),
        from: request.from,
        to: request.to,
      };
    }
  } catch (e) {
    if (e instanceof CostQueryError) throw new CostExportJobError(e.message);
    throw e;
  }

  const from = request.from ?? resolved.from;
  const to = request.to ?? resolved.to;
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to)) {
    throw new CostExportJobError("from and to must be YYYY-MM-DD.");
  }
  if (from > to) throw new CostExportJobError("from must not be after to.");
  const span = daySpan(from, to);
  if (span > COST_EXPORT_JOB_LIMITS.maxDays) {
    throw new CostExportJobError(
      `An export job spans at most ${COST_EXPORT_JOB_LIMITS.maxDays} days; this one spans ${span}. ` +
        "Split the range, or set up a scheduled export, which writes one file per period.",
    );
  }

  const active = await db
    .select({ id: costExportJobs.id })
    .from(costExportJobs)
    .where(
      and(
        eq(costExportJobs.organizationId, organizationId),
        eq(costExportJobs.createdByUserId, principal.userId),
        inArray(costExportJobs.status, ["queued", "running"]),
      ),
    )
    .limit(COST_EXPORT_JOB_LIMITS.maxActivePerUser);
  if (active.length >= COST_EXPORT_JOB_LIMITS.maxActivePerUser) {
    throw new CostExportJobError(
      `You already have ${active.length} exports running. Wait for one to finish, or cancel one.`,
      409,
    );
  }

  const focusVersion =
    request.format === "focus" ? (request.focusVersion ?? FOCUS_LATEST_VERSION) : null;
  const [row] = await db
    .insert(costExportJobs)
    .values({
      id: randomUUID(),
      organizationId,
      createdByUserId: principal.userId,
      principal: {
        userId: principal.userId,
        apiKeyId: principal.apiKeyId ?? null,
        agentRegistrationId: principal.agentRegistrationId ?? null,
      },
      source: resolved.source,
      format: request.format,
      focusVersion,
      fromDay: from,
      toDay: to,
      fileName: costExportJobFilename({
        format: request.format,
        from,
        to,
        name: resolved.source.reportName,
      }),
      contentType: costExportJobContentType(request.format),
    })
    .returning();
  if (!row) throw new Error("Failed to create export job");
  return toCostExportJob(row);
}

/* ------------------------------------------------------------------ *
 * Reads (inside the request; a job is its creator's alone)
 * ------------------------------------------------------------------ */

async function loadOwnJob(
  organizationId: string,
  userId: string,
  jobId: string,
): Promise<JobRow | null> {
  const [row] = await db
    .select()
    .from(costExportJobs)
    .where(
      and(
        eq(costExportJobs.id, jobId),
        eq(costExportJobs.organizationId, organizationId),
        eq(costExportJobs.createdByUserId, userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** One job, or null when it is not the caller's (or does not exist). */
export async function getCostExportJob(
  organizationId: string,
  userId: string,
  jobId: string,
): Promise<CostExportJob | null> {
  const row = await loadOwnJob(organizationId, userId, jobId);
  return row ? toCostExportJob(row) : null;
}

/** The caller's recent jobs, newest first. */
export async function listCostExportJobs(
  organizationId: string,
  userId: string,
): Promise<CostExportJob[]> {
  const rows = await db
    .select()
    .from(costExportJobs)
    .where(
      and(
        eq(costExportJobs.organizationId, organizationId),
        eq(costExportJobs.createdByUserId, userId),
      ),
    )
    .orderBy(desc(costExportJobs.createdAt))
    .limit(COST_EXPORT_JOB_LIMITS.listLimit);
  return rows.map(toCostExportJob);
}

/**
 * Cancel a queued or running job, or delete a finished one's file early.
 * The writer notices a cancelled job at its next chunk and stops. Returns null
 * when the job is not the caller's.
 */
export async function cancelCostExportJob(
  organizationId: string,
  userId: string,
  jobId: string,
  now = new Date(),
): Promise<CostExportJob | null> {
  const row = await loadOwnJob(organizationId, userId, jobId);
  if (!row) return null;
  const status = row.status as CostExportJobStatus;
  const next: CostExportJobStatus = isCostExportJobActive(status)
    ? "cancelled"
    : status === "succeeded"
      ? "expired"
      : status;
  const [updated] = await db
    .update(costExportJobs)
    .set({ status: next, leaseUntil: null, finishedAt: row.finishedAt ?? now, updatedAt: now })
    .where(eq(costExportJobs.id, row.id))
    .returning();
  await db.delete(costExportJobChunks).where(eq(costExportJobChunks.jobId, row.id));
  return updated ? toCostExportJob(updated) : null;
}

/**
 * The finished file, as a stream of decompressed chunks in order. Null when
 * the job is not the caller's, or has no file (not finished, or expired).
 * Each chunk is read with its own query, so a large file is never in memory.
 */
export async function openCostExportJobFile(
  organizationId: string,
  userId: string,
  jobId: string,
): Promise<{ job: CostExportJob; chunks: AsyncIterable<Uint8Array> } | null> {
  const row = await loadOwnJob(organizationId, userId, jobId);
  if (!row || row.status !== "succeeded") return null;
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for (let seq = 0; seq < row!.chunkCount; seq++) {
      const [chunk] = await db
        .select({ payload: costExportJobChunks.payload })
        .from(costExportJobChunks)
        .where(and(eq(costExportJobChunks.jobId, row!.id), eq(costExportJobChunks.seq, seq)))
        .limit(1);
      // A chunk missing mid-file means the job expired while being read: end
      // the stream with an error rather than handing over a truncated file.
      if (!chunk) throw new Error("The export file is no longer available.");
      yield new Uint8Array(gunzipSync(Buffer.from(chunk.payload, "base64")));
    }
  }
  return { job: toCostExportJob(row), chunks: chunks() };
}

/* ------------------------------------------------------------------ *
 * The runner (in the gateway loop)
 * ------------------------------------------------------------------ */

/**
 * Claim up to `limit` jobs: queued ones, and running ones whose lease lapsed
 * (a process died mid-file). `FOR UPDATE SKIP LOCKED`, so concurrent gateway
 * processes never claim the same job.
 */
export async function claimCostExportJobs(limit: number, now = new Date()): Promise<JobRow[]> {
  if (limit <= 0) return [];
  // A raw `sql` template hands values straight to the driver, which takes
  // strings, not `Date`s (drizzle only converts them for typed columns). The
  // columns are `timestamp` without zone holding UTC, as drizzle writes them.
  const nowAt = now.toISOString();
  const leaseUntil = new Date(now.getTime() + COST_EXPORT_JOB_LEASE_MS).toISOString();
  const rows = await db.execute(sql`
    UPDATE cost_export_jobs
    SET status = 'running',
        lease_until = ${leaseUntil}::timestamp,
        attempts = attempts + 1,
        started_at = COALESCE(started_at, ${nowAt}::timestamp),
        updated_at = ${nowAt}::timestamp
    WHERE id IN (
      SELECT id FROM cost_export_jobs
      WHERE status = 'queued'
         OR (status = 'running' AND lease_until IS NOT NULL AND lease_until < ${nowAt}::timestamp)
      ORDER BY created_at ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `);
  const ids = Array.from(rows as Iterable<Record<string, unknown>>, (r) => String(r["id"]));
  if (ids.length === 0) return [];
  return await db.select().from(costExportJobs).where(inArray(costExportJobs.id, ids));
}

/** Thrown inside the writer when the job was cancelled under it. */
class JobCancelled extends Error {}

/**
 * Buffers text into chunks, compresses and stores each, and renews the lease
 * with the progress every time it does. One instance per run.
 */
class ChunkWriter {
  private parts: string[] = [];
  private pendingBytes = 0;
  private seq = 0;
  bytes = 0;
  rows = 0;
  progress = 0;

  constructor(
    private readonly job: JobRow,
    private readonly encoder = new TextEncoder(),
  ) {}

  async write(text: string): Promise<void> {
    this.parts.push(text);
    this.pendingBytes += Buffer.byteLength(text, "utf8");
    if (this.pendingBytes >= COST_EXPORT_JOB_LIMITS.chunkBytes) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.parts.length === 0) return;
    const bytes = this.encoder.encode(this.parts.join(""));
    this.parts = [];
    this.pendingBytes = 0;
    this.bytes += bytes.byteLength;
    if (this.bytes > COST_EXPORT_JOB_LIMITS.maxBytes) {
      throw new CostExportJobError(
        `The file passed ${Math.round(COST_EXPORT_JOB_LIMITS.maxBytes / (1024 * 1024))} MB. ` +
          "Narrow the range or the filters, or set up a scheduled export to a bucket, which has no size limit.",
      );
    }
    await db.insert(costExportJobChunks).values({
      id: randomUUID(),
      jobId: this.job.id,
      organizationId: this.job.organizationId,
      seq: this.seq,
      payload: gzipSync(bytes).toString("base64"),
      byteLength: bytes.byteLength,
    });
    this.seq += 1;
    await this.heartbeat();
  }

  /** Record progress and renew the lease; notice a cancellation. */
  async heartbeat(): Promise<void> {
    const now = new Date();
    const updated = await db
      .update(costExportJobs)
      .set({
        progress: this.progress,
        rowCount: this.rows,
        byteCount: this.bytes,
        chunkCount: this.seq,
        leaseUntil: new Date(now.getTime() + COST_EXPORT_JOB_LEASE_MS),
        updatedAt: now,
      })
      .where(and(eq(costExportJobs.id, this.job.id), eq(costExportJobs.status, "running")))
      .returning({ id: costExportJobs.id });
    if (updated.length === 0) throw new JobCancelled();
  }

  get chunkCount(): number {
    return this.seq;
  }
}

/** Pass rows through while recording the newest day seen as progress. */
async function* tapDays<T>(
  rows: AsyncIterable<T>,
  dayOf: (row: T) => string | undefined,
  job: JobRow,
  writer: ChunkWriter,
): AsyncGenerator<T> {
  for await (const row of rows) {
    const day = dayOf(row);
    if (day) writer.progress = costExportJobProgress(day, job.fromDay, job.toDay);
    writer.rows += 1;
    yield row;
  }
}

/**
 * The report's unit cost per day and currency, for the native layout's extra
 * columns. Never throws: a unit-cost query that fails (a metric deleted since,
 * a currency it cannot convert) leaves the columns empty with the reason,
 * rather than failing a spend export over its optional half.
 */
async function loadUnitCostColumns(
  organizationId: string,
  job: JobRow,
  source: CostExportJobSource,
): Promise<{
  lookup: Map<string, Record<ReportUnitCostColumn, string | number | null>>;
  failure: string | null;
} | null> {
  const unit = source.unitCost;
  if (!unit) return null;
  const request: UnitCostQueryRequest = {
    from: job.fromDay,
    to: job.toDay,
    binning: "daily",
    mode: unit.mode,
    filters: source.filters,
    ...(unit.scale ? { scale: unit.scale } : {}),
    ...(source.costBasis ? { costBasis: source.costBasis } : {}),
    ...(source.chargeTypes ? { chargeTypes: source.chargeTypes } : {}),
    ...(unit.usageUnit ? { usageUnit: unit.usageUnit } : {}),
  };
  try {
    const response =
      unit.mode === "usage_unit_cost"
        ? await runUsageUnitCostQuery(organizationId, request)
        : await runUnitCostQuery(organizationId, unit.metricId ?? "", request);
    return { lookup: reportUnitCostLookup(response), failure: null };
  } catch (e) {
    console.error(`[cost-export-jobs] unit cost columns failed for job ${job.id}:`, e);
    return { lookup: new Map(), failure: "unavailable" };
  }
}

/**
 * The native layout as text, with the report's unit-cost columns when it has
 * them. Exported for its tests.
 */
export async function* nativeLines(
  rows: AsyncIterable<CostExportRow>,
  columns: CostExportColumns,
  stamp: ProvenanceStamp,
  format: "csv" | "ndjson",
  unit: Awaited<ReturnType<typeof loadUnitCostColumns>>,
  metricName: string | null,
): AsyncGenerator<string> {
  const names = [...outputColumns(columns), ...(unit ? REPORT_UNIT_COST_COLUMNS : [])];
  if (format === "csv") yield `${names.join(",")}\n`;
  for await (const row of rows) {
    const values: Array<string | number | null> = rowValues(row, columns, stamp);
    if (unit) {
      const hit = unit.lookup.get(`${row["day"]}|${row["currency"]}`);
      for (const column of REPORT_UNIT_COST_COLUMNS) {
        if (hit) values.push(hit[column]);
        else if (column === "unit_cost_metric") values.push(metricName);
        else if (column === "unit_cost_gap") values.push(unit.failure ?? "no_unit_cost");
        else values.push(null);
      }
    }
    if (format === "csv") {
      yield `${values
        .map((v) => (v === null ? "" : typeof v === "number" ? unitCostCsvCell(v) : csvCell(v)))
        .join(",")}\n`;
    } else {
      const obj: Record<string, string | number | null> = {};
      names.forEach((name, i) => {
        obj[name] = values[i] ?? null;
      });
      yield `${JSON.stringify(obj)}\n`;
    }
  }
}

/** Write one claimed job's file, then settle its status. Never throws. */
export async function runCostExportJob(job: JobRow, now = () => new Date()): Promise<void> {
  const writer = new ChunkWriter(job);
  try {
    if (job.attempts > MAX_ATTEMPTS) {
      throw new CostExportJobError(
        "The export stopped several times before finishing. Try a shorter range.",
      );
    }
    // A reclaimed job restarts from scratch: chunks from a run that died are
    // a prefix of a file nobody will finish.
    await db.delete(costExportJobChunks).where(eq(costExportJobChunks.jobId, job.id));

    const source = job.source as CostExportJobSource;
    const principal = job.principal as CostVisibilityPrincipal;
    const visibility = await resolveCostVisibility(job.organizationId, principal);
    await runWithCostVisibility(visibility, async () => {
      const watermark = await costCollectionWatermark(job.organizationId);
      const stamp = { exportedAt: now().toISOString(), collectionWatermark: watermark };
      let lines: AsyncIterable<string>;
      if (job.format === "focus") {
        const version = (job.focusVersion as FocusVersion | null) ?? FOCUS_LATEST_VERSION;
        const lookups = await loadFocusLookups(job.organizationId);
        const raw = tapDays<FocusSourceRow>(
          streamFocusSourceRows({
            organizationId: job.organizationId,
            from: job.fromDay,
            to: job.toDay,
            filters: source.filters,
            chargeTypes: source.chargeTypes,
          }),
          (r) => r.day,
          job,
          writer,
        );
        lines = toFocusCsv(mapFocusRows(raw, lookups, stamp, version), version);
      } else {
        const query = {
          organizationId: job.organizationId,
          from: job.fromDay,
          to: job.toDay,
          dimensions: source.dimensions,
          tagKeys: source.tagKeys,
          virtualTagKeys: source.virtualTagKeys ?? [],
          filters: source.filters,
          chargeTypes: source.chargeTypes,
          costBasis: source.costBasis,
        };
        const unit = await loadUnitCostColumns(job.organizationId, job, source);
        lines = nativeLines(
          tapDays<CostExportRow>(
            streamCostExportRows(query),
            (r) => (typeof r["day"] === "string" ? r["day"] : undefined),
            job,
            writer,
          ),
          resolveColumns(query),
          stamp,
          job.format === "ndjson" ? "ndjson" : "csv",
          unit,
          source.unitCost?.metricName ?? null,
        );
      }
      for await (const line of lines) await writer.write(line);
      await writer.flush();
    });

    const finished = now();
    await db
      .update(costExportJobs)
      .set({
        status: "succeeded",
        progress: 1,
        rowCount: writer.rows,
        byteCount: writer.bytes,
        chunkCount: writer.chunkCount,
        leaseUntil: null,
        error: null,
        finishedAt: finished,
        expiresAt: new Date(
          finished.getTime() + COST_EXPORT_JOB_LIMITS.retentionHours * 60 * 60 * 1000,
        ),
        updatedAt: finished,
      })
      .where(and(eq(costExportJobs.id, job.id), eq(costExportJobs.status, "running")));
  } catch (e) {
    if (e instanceof JobCancelled) {
      // The cancel already set the status; drop whatever this run wrote.
      await db
        .delete(costExportJobChunks)
        .where(eq(costExportJobChunks.jobId, job.id))
        .catch(() => undefined);
      return;
    }
    const message =
      e instanceof CostExportJobError || e instanceof CostQueryError
        ? e.message
        : e instanceof Error && /virtual tag/i.test(e.message)
          ? e.message
          : "The export failed. Try again; if it keeps failing, narrow the range.";
    if (!(e instanceof CostExportJobError)) {
      console.error(`[cost-export-jobs] job ${job.id} failed:`, e);
    }
    const finished = now();
    await db
      .update(costExportJobs)
      .set({
        status: "failed",
        error: message,
        leaseUntil: null,
        finishedAt: finished,
        updatedAt: finished,
      })
      .where(and(eq(costExportJobs.id, job.id), eq(costExportJobs.status, "running")))
      .catch((err: unknown) => console.error("[cost-export-jobs] failed to record failure:", err));
    await db
      .delete(costExportJobChunks)
      .where(eq(costExportJobChunks.jobId, job.id))
      .catch(() => undefined);
  }
}

/**
 * Expire finished files past their retention (delete the chunks, keep the row
 * a while so the list says "expired" rather than the job vanishing), and drop
 * job rows a week old. Bounded per call; idempotent across processes.
 */
export async function pruneCostExportJobs(now = new Date()): Promise<void> {
  const due = await db
    .select({ id: costExportJobs.id })
    .from(costExportJobs)
    .where(and(eq(costExportJobs.status, "succeeded"), lt(costExportJobs.expiresAt, now)))
    .orderBy(asc(costExportJobs.expiresAt))
    .limit(100);
  if (due.length > 0) {
    const ids = due.map((r) => r.id);
    await db.delete(costExportJobChunks).where(inArray(costExportJobChunks.jobId, ids));
    await db
      .update(costExportJobs)
      .set({ status: "expired", updatedAt: now })
      .where(inArray(costExportJobs.id, ids));
  }
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  await db
    .delete(costExportJobs)
    .where(
      and(
        lt(costExportJobs.createdAt, weekAgo),
        or(
          inArray(costExportJobs.status, ["succeeded", "failed", "cancelled", "expired"]),
          lt(costExportJobs.updatedAt, weekAgo),
        ),
      ),
    );
}
