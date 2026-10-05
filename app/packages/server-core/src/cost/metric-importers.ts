/**
 * Business-metric importers: the host half of "pull this metric from a
 * connected account on a schedule".
 *
 * The provider half lives in each plugin's `businessMetricSource` capability
 * (`plugin-base/src/business-metric-source.ts`): the form, the pickers, the
 * query. This module never learns what a CloudWatch namespace or a BigQuery
 * dataset is. It owns:
 *
 * - **Validation** of an importer against the plugin's declared form, and the
 *   read-only SQL guard on every `sql` field, re-checked on every execution
 *   rather than only on save (the query monitor rule: a row can reach the table
 *   by a route that predates the guard, and the thing being defended against
 *   is an unattended scheduled write with the account's credentials).
 * - **The window.** A scheduled run restates the trailing `backfillDays`
 *   closed days, ending yesterday in the importer's timezone. Today is never
 *   imported by the schedule: a partial day would read low until the next run
 *   restated it, and a unit cost divided by half a day of volume reads double.
 * - **Bounds.** A row cap and a timeout on every run, passed to the plugin and
 *   enforced again here.
 * - **Aggregation** of several points per day into one value
 *   (`aggregateBusinessMetricPoints`, shared with the preview).
 * - **Storage** through `restateImportedDays`, and the run history.
 *
 * Used by the HTTP routes, the MCP tools and the poller pass alike, so the
 * three cannot drift into running an importer differently.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import {
  BUSINESS_METRIC_IMPORT_AGGREGATIONS,
  BUSINESS_METRIC_IMPORT_LIMITS,
  BUSINESS_METRIC_IMPORT_SCHEDULES,
  BUSINESS_METRIC_IMPORT_SCHEDULE_HOURS,
  aggregateBusinessMetricPoints,
  type BusinessMetricImportAggregation,
  type BusinessMetricImportPreview,
  type BusinessMetricImportPreviewRequest,
  type BusinessMetricImportRun,
  type BusinessMetricImportSchedule,
  type BusinessMetricImportTrigger,
  type BusinessMetricImporter,
  type BusinessMetricImporterInput,
  type BusinessMetricImporterSummary,
  type BusinessMetricSourceAccount,
  type BusinessMetricSourceOption,
} from "@infrawrench/client-core";
import {
  BUSINESS_METRIC_SOURCE_LIMITS,
  businessMetricSqlProblem,
  isBusinessMetricDay,
  isValidTimezone,
  localDayOf,
  withBusinessMetricTimeout,
  type BusinessMetricSourceDeclaration,
  type BusinessMetricSourcePoint,
  type BusinessMetricSourceRange,
  type PluginClient,
} from "@infrawrench/plugin-base";

import { db } from "../db/client";
import {
  accounts,
  businessMetricImportRuns,
  businessMetricImporters,
  businessMetrics,
} from "../db/schema";
import { getOrgAccountClient } from "../org-accounts";
import { getPlugin } from "../plugin-loader";
import { restateImportedDays } from "./metric-ingest";

/** Anything the caller can fix about an importer or a preview. Routes map `status`. */
export class BusinessMetricImporterError extends Error {
  override readonly name = "BusinessMetricImporterError";
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.status = status;
  }
}

/** Timeout for a picker's provider call: a form should not hang for two minutes. */
const OPTIONS_TIMEOUT_MS = 30_000;
/** First retry after a failed scheduled run, doubling to the schedule's own interval. */
const FAILURE_BASE_BACKOFF_MS = 60 * 60 * 1000;

type ImporterRow = typeof businessMetricImporters.$inferSelect;
type RunRow = typeof businessMetricImportRuns.$inferSelect;

/* ------------------------------------------------------------------ *
 * Day arithmetic.
 * ------------------------------------------------------------------ */

function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function daysBetweenInclusive(from: string, to: string): number {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}

/** The window a scheduled run restates: `backfillDays` closed days ending yesterday. */
export function scheduledImportWindow(
  importer: { backfillDays: number; timezone: string },
  now: Date = new Date(),
): { from: string; to: string } {
  const today = localDayOf(now.getTime(), importer.timezone);
  const to = addDays(today, -1);
  return { from: addDays(to, -(Math.max(1, importer.backfillDays) - 1)), to };
}

/** When the next scheduled run is due, backing off after failures. */
export function nextImportRunAt(
  schedule: BusinessMetricImportSchedule,
  consecutiveFailures: number,
  now: Date = new Date(),
): Date {
  const interval = BUSINESS_METRIC_IMPORT_SCHEDULE_HOURS[schedule] * 60 * 60 * 1000;
  const delay =
    consecutiveFailures > 0
      ? Math.min(interval, FAILURE_BASE_BACKOFF_MS * 2 ** (consecutiveFailures - 1))
      : interval;
  return new Date(now.getTime() + delay);
}

/* ------------------------------------------------------------------ *
 * Sources.
 * ------------------------------------------------------------------ */

/** What a source needs from the account: its client, plugin, and the plugin's form. */
interface SourceContext {
  client: PluginClient;
  declaration: BusinessMetricSourceDeclaration;
  pluginId: string;
}

async function resolveSource(organizationId: string, accountId: string): Promise<SourceContext> {
  const ctx = await getOrgAccountClient(accountId, organizationId);
  if (!ctx) throw new BusinessMetricImporterError("The account is no longer connected.", 404);
  const declaration = ctx.plugin.manifest.businessMetricSource;
  if (!declaration || !ctx.client.runBusinessMetricSource) {
    throw new BusinessMetricImporterError(
      `${ctx.plugin.manifest.displayName} accounts cannot feed a business metric.`,
    );
  }
  return { client: ctx.client, declaration, pluginId: ctx.plugin.manifest.id };
}

/**
 * The org's accounts whose plugin can feed a business metric, each with the
 * plugin's form. Static metadata only: no client is built and no provider is
 * called, so the picker opens instantly however many accounts there are.
 */
export async function listBusinessMetricSourceAccounts(
  organizationId: string,
): Promise<BusinessMetricSourceAccount[]> {
  const rows = await db
    .select({ id: accounts.id, name: accounts.displayName, pluginId: accounts.pluginId })
    .from(accounts)
    .where(eq(accounts.organizationId, organizationId))
    .orderBy(accounts.displayName);
  const out: BusinessMetricSourceAccount[] = [];
  for (const row of rows) {
    const loaded = await getPlugin(row.pluginId);
    const source = loaded?.plugin.manifest.businessMetricSource;
    if (!loaded || !source) continue;
    out.push({
      accountId: row.id,
      accountName: row.name,
      pluginId: row.pluginId,
      pluginName: loaded.plugin.manifest.displayName,
      source,
    });
  }
  return out;
}

/** Choices for one `select` field, given the values picked so far. */
export async function listBusinessMetricSourceOptions(
  organizationId: string,
  accountId: string,
  fieldKey: string,
  params: Record<string, string>,
): Promise<BusinessMetricSourceOption[]> {
  const source = await resolveSource(organizationId, accountId);
  const field = source.declaration.fields.find((f) => f.key === fieldKey);
  if (!field) throw new BusinessMetricImporterError(`Unknown field "${fieldKey}".`);
  if (field.options) return field.options;
  if (field.type !== "select" || !source.client.listBusinessMetricSourceOptions) return [];
  for (const dep of field.dependsOn ?? []) {
    if (!params[dep]) return [];
  }
  try {
    return await withBusinessMetricTimeout(
      source.client.listBusinessMetricSourceOptions(accountId, fieldKey, params),
      { timeoutMs: OPTIONS_TIMEOUT_MS },
    );
  } catch (err) {
    throw new BusinessMetricImporterError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * The importer's params against the plugin's form: known keys only, required
 * ones present, bounded lengths, and the read-only guard on every SQL field.
 * Returns the cleaned params.
 */
export function validateSourceParams(
  declaration: BusinessMetricSourceDeclaration,
  params: Record<string, string>,
): Record<string, string> {
  const entries = Object.entries(params ?? {});
  if (entries.length > BUSINESS_METRIC_IMPORT_LIMITS.maxParams) {
    throw new BusinessMetricImporterError("Too many source parameters.");
  }
  const fields = new Map(declaration.fields.map((f) => [f.key, f]));
  const cleaned: Record<string, string> = {};
  for (const [key, raw] of entries) {
    const field = fields.get(key);
    if (!field) throw new BusinessMetricImporterError(`Unknown source parameter "${key}".`);
    if (typeof raw !== "string") {
      throw new BusinessMetricImporterError(`"${field.label}" must be a string.`);
    }
    if (raw.length > BUSINESS_METRIC_IMPORT_LIMITS.maxParamValueLength) {
      throw new BusinessMetricImporterError(`"${field.label}" is too long.`);
    }
    if (field.type === "number" && raw.trim() !== "" && !Number.isFinite(Number(raw))) {
      throw new BusinessMetricImporterError(`"${field.label}" must be a number.`);
    }
    cleaned[key] = field.type === "sql" ? raw : raw.trim();
  }
  for (const field of declaration.fields) {
    const value = cleaned[field.key];
    if (field.required && !value) {
      throw new BusinessMetricImporterError(`"${field.label}" is required.`);
    }
    if (field.type === "sql" && value) {
      const problem = businessMetricSqlProblem(value);
      if (problem) throw new BusinessMetricImporterError(problem);
    }
  }
  return cleaned;
}

/**
 * Run a source over a window and aggregate what it returned. Throws a
 * {@link BusinessMetricImporterError} carrying the provider's message: "table
 * not found" is the single most useful thing this feature can tell somebody.
 */
async function readSource(
  source: SourceContext,
  accountId: string,
  params: Record<string, string>,
  window: { from: string; to: string; timezone: string },
  aggregation: BusinessMetricImportAggregation,
): Promise<{
  points: BusinessMetricSourcePoint[];
  values: ReturnType<typeof aggregateBusinessMetricPoints>;
  notes: string[];
}> {
  // Re-checked on every execution. See the module note.
  const cleaned = validateSourceParams(source.declaration, params);
  const controller = new AbortController();
  const range: BusinessMetricSourceRange = {
    ...window,
    maxRows: BUSINESS_METRIC_SOURCE_LIMITS.maxRows,
    timeoutMs: BUSINESS_METRIC_SOURCE_LIMITS.timeoutMs,
    signal: controller.signal,
  };
  let result;
  try {
    result = await withBusinessMetricTimeout(
      source.client.runBusinessMetricSource!(accountId, cleaned, range),
      range,
    );
  } catch (err) {
    controller.abort();
    throw new BusinessMetricImporterError(err instanceof Error ? err.message : String(err));
  }
  const points = result.points ?? [];
  if (points.length > range.maxRows) {
    throw new BusinessMetricImporterError(
      `The source returned more than ${range.maxRows} points. Aggregate per day in the query.`,
    );
  }
  for (const [index, point] of points.entries()) {
    if (!isBusinessMetricDay(point.date) || !Number.isFinite(point.value)) {
      throw new BusinessMetricImporterError(
        `The source returned an unreadable point at position ${index + 1}.`,
      );
    }
  }
  // Points outside the window are dropped rather than written: an importer
  // restates the days it was asked about and nothing else, or a query that
  // ignores {{from}} would quietly rewrite the metric's whole history.
  const inWindow = points.filter((p) => p.date >= window.from && p.date <= window.to);
  const notes = [...(result.notes ?? [])];
  if (inWindow.length < points.length) {
    notes.push(`${points.length - inWindow.length} points outside the window were ignored.`);
  }
  return { points: inWindow, values: aggregateBusinessMetricPoints(inWindow, aggregation), notes };
}

function checkWindow(from: string, to: string): void {
  if (!isBusinessMetricDay(from) || !isBusinessMetricDay(to)) {
    throw new BusinessMetricImporterError("from and to must be YYYY-MM-DD days.");
  }
  if (from > to) throw new BusinessMetricImporterError("from must not be after to.");
  if (daysBetweenInclusive(from, to) > BUSINESS_METRIC_IMPORT_LIMITS.maxRunDays) {
    throw new BusinessMetricImporterError(
      `One run reads at most ${BUSINESS_METRIC_IMPORT_LIMITS.maxRunDays} days.`,
    );
  }
}

function checkTimezone(tz: string): void {
  if (!isValidTimezone(tz)) throw new BusinessMetricImporterError(`Unknown timezone "${tz}".`);
}

/** Run a source without writing anything: what the editor's Preview button shows. */
export async function previewBusinessMetricImport(
  organizationId: string,
  request: BusinessMetricImportPreviewRequest,
): Promise<BusinessMetricImportPreview> {
  const timezone = request.timezone ?? "UTC";
  checkTimezone(timezone);
  const defaults = scheduledImportWindow({
    backfillDays: BUSINESS_METRIC_IMPORT_LIMITS.previewDays,
    timezone,
  });
  const from = request.from ?? defaults.from;
  const to = request.to ?? defaults.to;
  checkWindow(from, to);
  const source = await resolveSource(organizationId, request.accountId);
  const started = Date.now();

  if (request.dryRun) {
    if (!source.client.dryRunBusinessMetricSource || !source.declaration.supportsDryRun) {
      throw new BusinessMetricImporterError("This source has no dry run. Use Preview instead.");
    }
    const params = validateSourceParams(source.declaration, request.params);
    try {
      const dry = await withBusinessMetricTimeout(
        source.client.dryRunBusinessMetricSource(request.accountId, params, {
          from,
          to,
          timezone,
          maxRows: BUSINESS_METRIC_SOURCE_LIMITS.maxRows,
          timeoutMs: OPTIONS_TIMEOUT_MS,
        }),
        { timeoutMs: OPTIONS_TIMEOUT_MS },
      );
      return {
        from,
        to,
        values: [],
        pointsRead: 0,
        days: 0,
        notes: [],
        durationMs: Date.now() - started,
        dryRun: {
          valid: dry.valid,
          message: dry.message,
          ...(dry.bytesProcessed !== undefined ? { bytesProcessed: dry.bytesProcessed } : {}),
        },
      };
    } catch (err) {
      throw new BusinessMetricImporterError(err instanceof Error ? err.message : String(err));
    }
  }

  const { points, values, notes } = await readSource(
    source,
    request.accountId,
    request.params,
    { from, to, timezone },
    request.aggregation ?? "sum",
  );
  return {
    from,
    to,
    values: values.slice(-BUSINESS_METRIC_IMPORT_LIMITS.maxPreviewValues),
    pointsRead: points.length,
    days: new Set(values.map((v) => v.date)).size,
    notes,
    durationMs: Date.now() - started,
  };
}

/* ------------------------------------------------------------------ *
 * CRUD.
 * ------------------------------------------------------------------ */

async function accountInfo(
  organizationId: string,
  accountIds: string[],
): Promise<Map<string, { name: string; pluginId: string; sourceLabel: string | null }>> {
  const out = new Map<string, { name: string; pluginId: string; sourceLabel: string | null }>();
  if (accountIds.length === 0) return out;
  const rows = await db
    .select({ id: accounts.id, name: accounts.displayName, pluginId: accounts.pluginId })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), inArray(accounts.id, accountIds)));
  for (const row of rows) {
    const loaded = await getPlugin(row.pluginId);
    out.set(row.id, {
      name: row.name,
      pluginId: row.pluginId,
      sourceLabel: loaded?.plugin.manifest.businessMetricSource?.label ?? null,
    });
  }
  return out;
}

function toImporter(
  row: ImporterRow,
  info: { name: string; pluginId: string; sourceLabel: string | null } | undefined,
): BusinessMetricImporter {
  return {
    id: row.id,
    metricId: row.metricId,
    accountId: row.accountId,
    accountName: info?.name ?? null,
    pluginId: info?.pluginId ?? null,
    sourceLabel: info?.sourceLabel ?? null,
    params: (row.params ?? {}) as Record<string, string>,
    schedule: (BUSINESS_METRIC_IMPORT_SCHEDULES as readonly string[]).includes(row.schedule)
      ? (row.schedule as BusinessMetricImportSchedule)
      : "daily",
    backfillDays: row.backfillDays,
    timezone: row.timezone,
    aggregation: (BUSINESS_METRIC_IMPORT_AGGREGATIONS as readonly string[]).includes(
      row.aggregation,
    )
      ? (row.aggregation as BusinessMetricImportAggregation)
      : "sum",
    enabled: row.enabled,
    nextRunAt: row.enabled ? row.nextRunAt.toISOString() : null,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastStatus: row.lastStatus === "success" || row.lastStatus === "error" ? row.lastStatus : null,
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRun(row: RunRow): BusinessMetricImportRun {
  return {
    id: row.id,
    importerId: row.importerId,
    trigger: row.trigger === "manual" ? "manual" : "schedule",
    status: row.status === "success" || row.status === "error" ? row.status : "running",
    from: row.fromDay,
    to: row.toDay,
    pointsRead: row.pointsRead,
    daysWritten: row.daysWritten,
    error: row.error,
    notes: (row.notes ?? []) as string[],
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    durationMs: row.durationMs,
  };
}

async function importerRow(organizationId: string, metricId: string): Promise<ImporterRow | null> {
  const [row] = await db
    .select()
    .from(businessMetricImporters)
    .where(
      and(
        eq(businessMetricImporters.organizationId, organizationId),
        eq(businessMetricImporters.metricId, metricId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** A metric's importer, or null when its values are only pushed. */
export async function getBusinessMetricImporter(
  organizationId: string,
  metricId: string,
): Promise<BusinessMetricImporter | null> {
  const row = await importerRow(organizationId, metricId);
  if (!row) return null;
  const info = await accountInfo(organizationId, [row.accountId]);
  return toImporter(row, info.get(row.accountId));
}

/** Importer summaries for every metric in the org that has one, keyed by metric id. */
export async function getBusinessMetricImporterSummaries(
  organizationId: string,
): Promise<Map<string, BusinessMetricImporterSummary>> {
  const rows = await db
    .select()
    .from(businessMetricImporters)
    .where(eq(businessMetricImporters.organizationId, organizationId));
  const info = await accountInfo(organizationId, [...new Set(rows.map((r) => r.accountId))]);
  const out = new Map<string, BusinessMetricImporterSummary>();
  for (const row of rows) {
    const full = toImporter(row, info.get(row.accountId));
    out.set(row.metricId, {
      accountId: full.accountId,
      accountName: full.accountName,
      pluginId: full.pluginId,
      sourceLabel: full.sourceLabel,
      enabled: full.enabled,
      lastRunAt: full.lastRunAt,
      lastStatus: full.lastStatus,
      lastError: full.lastError,
    });
  }
  return out;
}

/**
 * Create or replace a metric's importer. A full replace: what was not sent
 * takes its default. Changing the source or the query re-arms the schedule so
 * the new configuration runs promptly rather than at the old next-run time.
 */
export async function upsertBusinessMetricImporter(
  organizationId: string,
  metricId: string,
  input: BusinessMetricImporterInput,
  userId: string | null,
): Promise<BusinessMetricImporter> {
  const [metric] = await db
    .select({ id: businessMetrics.id })
    .from(businessMetrics)
    .where(
      and(
        eq(businessMetrics.id, metricId),
        eq(businessMetrics.organizationId, organizationId),
        isNull(businessMetrics.deletedAt),
      ),
    )
    .limit(1);
  if (!metric) throw new BusinessMetricImporterError("Not found", 404);

  const timezone = input.timezone?.trim() || "UTC";
  checkTimezone(timezone);
  const backfillDays = input.backfillDays ?? BUSINESS_METRIC_IMPORT_LIMITS.defaultBackfillDays;
  if (
    !Number.isInteger(backfillDays) ||
    backfillDays < BUSINESS_METRIC_IMPORT_LIMITS.minBackfillDays ||
    backfillDays > BUSINESS_METRIC_IMPORT_LIMITS.maxBackfillDays
  ) {
    throw new BusinessMetricImporterError(
      `backfillDays must be a whole number between ${BUSINESS_METRIC_IMPORT_LIMITS.minBackfillDays} and ${BUSINESS_METRIC_IMPORT_LIMITS.maxBackfillDays}.`,
    );
  }
  // Resolving the source is also the org check on the account: an importer
  // runs with its credentials, so an id from elsewhere must not resolve.
  const source = await resolveSource(organizationId, input.accountId);
  const params = validateSourceParams(source.declaration, input.params);

  const schedule = input.schedule ?? "daily";
  const values = {
    accountId: input.accountId,
    params,
    schedule,
    backfillDays,
    timezone,
    aggregation: input.aggregation ?? "sum",
    enabled: input.enabled ?? true,
  };

  const existing = await importerRow(organizationId, metricId);
  const now = new Date();
  if (existing) {
    const rearm =
      existing.accountId !== values.accountId ||
      JSON.stringify(existing.params) !== JSON.stringify(values.params) ||
      existing.schedule !== values.schedule ||
      (!existing.enabled && values.enabled);
    await db
      .update(businessMetricImporters)
      .set({
        ...values,
        ...(rearm ? { nextRunAt: now, consecutiveFailures: 0 } : {}),
        updatedAt: now,
      })
      .where(eq(businessMetricImporters.id, existing.id));
  } else {
    await db.insert(businessMetricImporters).values({
      id: randomUUID(),
      organizationId,
      metricId,
      ...values,
      // Due straight away: someone who just configured an importer wants to
      // see whether it works, not wait a day for the first run.
      nextRunAt: now,
      createdByUserId: userId,
    });
  }
  const saved = await getBusinessMetricImporter(organizationId, metricId);
  if (!saved) throw new Error("Failed to save the importer");
  return saved;
}

/** Remove a metric's importer and its history. Its imported values stay. */
export async function deleteBusinessMetricImporter(
  organizationId: string,
  metricId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(businessMetricImporters)
    .where(
      and(
        eq(businessMetricImporters.organizationId, organizationId),
        eq(businessMetricImporters.metricId, metricId),
      ),
    )
    .returning({ id: businessMetricImporters.id });
  return deleted.length > 0;
}

/** A metric's recent runs, newest first. */
export async function listBusinessMetricImportRuns(
  organizationId: string,
  metricId: string,
  limit: number = 20,
): Promise<BusinessMetricImportRun[]> {
  const row = await importerRow(organizationId, metricId);
  if (!row) return [];
  const rows = await db
    .select()
    .from(businessMetricImportRuns)
    .where(eq(businessMetricImportRuns.importerId, row.id))
    .orderBy(desc(businessMetricImportRuns.startedAt))
    .limit(Math.min(Math.max(1, Math.round(limit)), BUSINESS_METRIC_IMPORT_LIMITS.runHistory));
  return rows.map(toRun);
}

/* ------------------------------------------------------------------ *
 * Running.
 * ------------------------------------------------------------------ */

/**
 * Run one importer now and record the outcome. Never throws for a source
 * failure: a failed run is an outcome with an error, recorded in the history
 * and on the importer, and the scheduler backs off on it.
 */
export async function runBusinessMetricImporter(opts: {
  organizationId: string;
  importer: Pick<
    ImporterRow,
    | "id"
    | "metricId"
    | "accountId"
    | "params"
    | "schedule"
    | "backfillDays"
    | "timezone"
    | "aggregation"
    | "consecutiveFailures"
  >;
  trigger: BusinessMetricImportTrigger;
  userId: string | null;
  window?: { from: string; to: string };
}): Promise<BusinessMetricImportRun> {
  const { organizationId, importer, trigger, userId } = opts;
  const window = opts.window ?? scheduledImportWindow(importer);
  checkWindow(window.from, window.to);

  const runId = randomUUID();
  const started = new Date();
  await db.insert(businessMetricImportRuns).values({
    id: runId,
    organizationId,
    importerId: importer.id,
    trigger,
    status: "running",
    fromDay: window.from,
    toDay: window.to,
    triggeredByUserId: userId,
    startedAt: started,
  });

  let status: "success" | "error" = "success";
  let error: string | null = null;
  let pointsRead = 0;
  let daysWritten = 0;
  let notes: string[] = [];
  try {
    const source = await resolveSource(organizationId, importer.accountId);
    const read = await readSource(
      source,
      importer.accountId,
      (importer.params ?? {}) as Record<string, string>,
      { ...window, timezone: importer.timezone },
      (BUSINESS_METRIC_IMPORT_AGGREGATIONS as readonly string[]).includes(importer.aggregation)
        ? (importer.aggregation as BusinessMetricImportAggregation)
        : "sum",
    );
    pointsRead = read.points.length;
    notes = read.notes;
    const written = await restateImportedDays({
      organizationId,
      metricId: importer.metricId,
      values: read.values,
      userId,
    });
    daysWritten = written.days;
    if (daysWritten === 0) notes.push("The source returned no values for this window.");
  } catch (err) {
    status = "error";
    error = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
  }

  const finished = new Date();
  await db
    .update(businessMetricImportRuns)
    .set({
      status,
      error,
      pointsRead,
      daysWritten,
      notes,
      finishedAt: finished,
      durationMs: finished.getTime() - started.getTime(),
    })
    .where(eq(businessMetricImportRuns.id, runId));

  const failures = status === "error" ? importer.consecutiveFailures + 1 : 0;
  const schedule = (BUSINESS_METRIC_IMPORT_SCHEDULES as readonly string[]).includes(
    importer.schedule,
  )
    ? (importer.schedule as BusinessMetricImportSchedule)
    : "daily";
  await db
    .update(businessMetricImporters)
    .set({
      lastRunAt: finished,
      lastStatus: status,
      lastError: error,
      consecutiveFailures: failures,
      // A scheduled run's next time was already pushed forward by the claim;
      // a failure pulls it in to the backoff, and a manual run restarts the
      // interval so the schedule does not run the same window again at once.
      ...(status === "error" || trigger === "manual"
        ? { nextRunAt: nextImportRunAt(schedule, failures, finished) }
        : {}),
    })
    .where(eq(businessMetricImporters.id, importer.id));

  await pruneRuns(importer.id);

  const [row] = await db
    .select()
    .from(businessMetricImportRuns)
    .where(eq(businessMetricImportRuns.id, runId))
    .limit(1);
  return toRun(row!);
}

/** Keep the newest `runHistory` runs for an importer. */
async function pruneRuns(importerId: string): Promise<void> {
  const keep = await db
    .select({ startedAt: businessMetricImportRuns.startedAt })
    .from(businessMetricImportRuns)
    .where(eq(businessMetricImportRuns.importerId, importerId))
    .orderBy(desc(businessMetricImportRuns.startedAt))
    .offset(BUSINESS_METRIC_IMPORT_LIMITS.runHistory - 1)
    .limit(1);
  const cutoff = keep[0]?.startedAt;
  if (!cutoff) return;
  await db
    .delete(businessMetricImportRuns)
    .where(
      and(
        eq(businessMetricImportRuns.importerId, importerId),
        lt(businessMetricImportRuns.startedAt, cutoff),
      ),
    );
}

/** "Run now" from the API, the CLI or a tool: the importer's window, or the one asked for. */
export async function runBusinessMetricImporterNow(
  organizationId: string,
  metricId: string,
  userId: string | null,
  window?: { from?: string | undefined; to?: string | undefined },
): Promise<BusinessMetricImportRun> {
  const row = await importerRow(organizationId, metricId);
  if (!row) throw new BusinessMetricImporterError("This metric has no importer.", 404);
  let resolved: { from: string; to: string } | undefined;
  if (window?.from || window?.to) {
    const defaults = scheduledImportWindow(row);
    resolved = { from: window.from ?? defaults.from, to: window.to ?? defaults.to };
    checkWindow(resolved.from, resolved.to);
  }
  // A manual run on a running importer is fine: restatement is idempotent,
  // so the worst case is the same days written twice with the same numbers.
  return runBusinessMetricImporter({
    organizationId,
    importer: row,
    trigger: "manual",
    userId,
    ...(resolved ? { window: resolved } : {}),
  });
}

/** Mark runs left `running` by a crashed process as failed. */
export async function failStaleImportRuns(olderThanMs: number = 30 * 60 * 1000): Promise<void> {
  await db
    .update(businessMetricImportRuns)
    .set({
      status: "error",
      error: "The run did not finish (the process stopped).",
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(businessMetricImportRuns.status, "running"),
        lt(
          businessMetricImportRuns.startedAt,
          sql`now() - make_interval(secs => ${Math.round(olderThanMs / 1000)})`,
        ),
      ),
    );
}
