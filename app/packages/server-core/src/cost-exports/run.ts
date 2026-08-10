/**
 * Executing one cost export.
 *
 * A run is: work out which periods are in scope, stamp the collection
 * watermark, then for each period stream `cost_daily` → serialiser →
 * destination, one object per period, at a deterministic key.
 *
 * ## Restatements — the decision, and why
 *
 * Provider spend is restated for days after the fact: credits land late, tax
 * lines are recomputed, and amortization schedules shift when a commitment is
 * bought mid-month. An export that wrote each period once and never revisited
 * it would drift away from the provider's own invoice within a week, silently,
 * and a warehouse built on it would reconcile to nothing.
 *
 * Both available mitigations are implemented, because they answer different
 * halves of the problem:
 *
 *   1. **Re-export a trailing window.** Every run re-writes every period
 *      overlapping the last `restatementDays` days (default 7), *in full*, at
 *      the key that period already occupies. Because the key derives from the
 *      period start alone, that is an overwrite — the consumer's copy of July
 *      is replaced by a better copy of July, never joined by a second one.
 *   2. **Stamp the watermark.** Every row carries `exported_at` and
 *      `collection_watermark`: the newest day for which *every* account that
 *      reports spend in this org had reported when the run started. A consumer
 *      that needs certainty holds back periods whose `to` is after the
 *      watermark; one that just wants the latest numbers ignores the column.
 *
 * The window alone is not enough (a provider that restates on day 9 beats a
 * 7-day window, and the consumer would never know); the watermark alone is not
 * enough (knowing a number is stale does not replace it). Together they are the
 * difference between a warehouse that reconciles and one that quietly drifts.
 */
import type {
  CostExportDestination,
  CostExportObject,
  CostExportQuery,
  CostExportRunResult,
} from "@infrawrench/client-core";
import { getCostCoverage } from "../clickhouse/cost-readers";
import { isClickHouseConfigured } from "../clickhouse/client";
import { uploadCostExportObject, CostExportUploadError } from "./destinations";
import { nextCostExportRunAt, periodsToExport, type CostExportCadence } from "./periods";
import { resolveColumns, streamCostExportRows, type CostExportRow } from "./rows";
import { serializeRows } from "./serialize";
import {
  isCostExportInFlight,
  loadCredentials,
  markCostExportRunInFlight,
  recordCostExportRun,
  type CostExportRecord,
} from "./store";

/**
 * The newest day every cost-reporting account in the org has data for.
 *
 * The minimum of each account's latest day, not the maximum: a period is only
 * settled once the slowest collector has caught up to it. Accounts that have
 * never reported anything are invisible here — they have no last day to
 * minimise over, and their absence is the cost-status surface's problem, not
 * something to express by pinning the watermark to the epoch forever.
 *
 * Empty string means "no cost data at all", which the serialiser writes as an
 * empty column rather than a fake date.
 */
export async function costCollectionWatermark(organizationId: string): Promise<string> {
  if (!isClickHouseConfigured()) return "";
  const coverage = await getCostCoverage(organizationId);
  let watermark: string | null = null;
  for (const { lastDay } of coverage.values()) {
    if (!lastDay) continue;
    if (watermark === null || lastDay < watermark) watermark = lastDay;
  }
  return watermark ?? "";
}

/** `{prefix}/cost-export/{exportId}/{cadence}/{periodStart}.{format}` */
export function costExportObjectKey(args: {
  prefix: string;
  exportId: string;
  cadence: string;
  periodStart: string;
  format: string;
}): string {
  const parts = [
    args.prefix,
    "cost-export",
    args.exportId,
    args.cadence,
    `${args.periodStart}.${args.format}`,
  ].filter((p) => p !== "");
  return parts.join("/");
}

export interface RunCostExportOptions {
  /** Overridable for tests; defaults to the wall clock. */
  now?: Date;
  /** Overridable for tests; defaults to {@link PERSIST_RETRY_DELAYS_MS}. */
  persistRetryDelaysMs?: readonly number[];
}

/**
 * Backoff between attempts to write a run's outcome. Four attempts over ~7s.
 *
 * The window this has to cover is a database blip — a failover, a dropped
 * connection, a pool exhausted by a neighbouring pass — not an outage, and it
 * has to stay far inside `COST_EXPORT_LEASE_MS` (30 minutes) so a retrying run
 * can never still be holding the lease when it expires.
 */
const PERSIST_RETRY_DELAYS_MS = [500, 2_000, 5_000] as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Write the run's outcome, retrying a failed write. Returns null on success, or
 * the final error's message when every attempt failed.
 *
 * This is the write that ends the lease: until it lands, `next_run_at` is still
 * claim-time + lease, so an abandoned write means the export is re-claimed and
 * re-run half an hour later. That is harmless for S3 (the same period is
 * overwritten at the same key) and *not* harmless for HTTPS, which is why the
 * marker protocol in {@link runCostExport} exists on top of this.
 */
async function persistRunOutcome(
  exportId: string,
  outcome: Parameters<typeof recordCostExportRun>[1],
  delays: readonly number[],
): Promise<string | null> {
  let lastError: unknown = null;
  for (let attempt = 0; ; attempt++) {
    try {
      await recordCostExportRun(exportId, outcome);
      return null;
    } catch (e) {
      lastError = e;
      const delay = delays[attempt];
      if (delay === undefined) break;
      console.warn(
        `[cost-export] ${exportId} could not record run outcome (attempt ${attempt + 1}), retrying in ${delay}ms:`,
        e,
      );
      await sleep(delay);
    }
  }
  console.error(
    `[cost-export] ${exportId} could not record run outcome after ${delays.length + 1} attempts; the row still holds a lease and stale status:`,
    lastError,
  );
  return lastError instanceof Error ? lastError.message : String(lastError);
}

/**
 * Whether re-running this destination is free of consequence.
 *
 * S3 writes each period to a key derived from the period start alone, so a
 * second run of the same periods overwrites the first — that is already the
 * mechanism restatements rely on. An HTTPS `POST`/`PUT` to somebody else's
 * endpoint carries no such promise: it is an append as far as we know, and a
 * duplicate is a duplicate row in their warehouse.
 */
function toleratesRedelivery(destination: CostExportDestination): boolean {
  return destination.kind === "s3";
}

/**
 * Run one export end to end and record the outcome on its row.
 *
 * Never throws: the caller is either the poller (which must not be taken down
 * by one org's bad bucket) or a "Run now" route (which wants the failure as
 * data so it can render it). The failure is written to `lastStatus`/`lastError`
 * and returned, which is what makes a silently-failing nightly export
 * impossible — the settings UI reads exactly those columns.
 *
 * ## Delivering exactly once to an endpoint that cannot absorb a duplicate
 *
 * The claim leases the row by pushing `next_run_at` out (`pass.ts`), and the
 * outcome write is what replaces that lease with the real schedule. So a run
 * that delivers and then fails to persist is a run that gets claimed again when
 * the lease expires — and delivers again. For S3 that is a no-op overwrite. For
 * HTTPS it is a second POST to a warehouse that has already ingested the first,
 * repeating every 30 minutes for as long as the database stays unhappy.
 *
 * Two mechanisms, because they cover different failures:
 *
 *   1. **The outcome write is retried** ({@link persistRunOutcome}). A dropped
 *      connection or a failover is the realistic cause, and a few seconds of
 *      backoff resolves it long before the lease expires.
 *   2. **A marker is written before the first byte is delivered**, for
 *      destinations that cannot tolerate a duplicate. If a later run finds the
 *      marker still in place, an earlier attempt delivered (or may have) and
 *      never recorded it: that run refuses to deliver and writes the situation
 *      to `lastStatus`/`lastError` instead.
 *
 * The order matters. A marker write that fails happens *before* any delivery,
 * so it simply fails the run — nothing was sent, and the export retries on its
 * normal schedule. Every unsafe outcome is therefore either prevented or
 * announced; the one thing that cannot happen is a silent duplicate.
 *
 * The recovery run is where the visibility actually lands, and it is reliable
 * precisely because it only runs after a claim has succeeded — which proves the
 * database is answering again. It also costs the export one cycle: the skip is
 * recorded as a failure with a message saying so, and the next scheduled run
 * proceeds normally. A "Run now" click behaves the same way, and clicking it a
 * second time runs the export, which is the right shape for a decision only a
 * human can make ("has my endpoint already got this?").
 */
export async function runCostExport(
  row: CostExportRecord,
  opts: RunCostExportOptions = {},
): Promise<CostExportRunResult> {
  const now = opts.now ?? new Date();
  const retryDelays = opts.persistRetryDelaysMs ?? PERSIST_RETRY_DELAYS_MS;
  const cadence = row.cadence as CostExportCadence;
  const format = row.format === "ndjson" ? "ndjson" : "csv";
  const query = row.query as unknown as CostExportQuery;
  const destination = row.destination as unknown as CostExportDestination;
  const guarded = !toleratesRedelivery(destination);

  // Rescheduled from the wall clock at the end of the run, not from `now`: a
  // long run must not land its next fire time in the past.
  const rescheduled = (): Date | null =>
    row.enabled ? nextCostExportRunAt(cadence, row.hour, row.timezone, new Date()) : null;

  if (guarded && isCostExportInFlight(row.lastError)) {
    const message =
      `A previous run of this export started delivering to the HTTPS destination and never recorded ` +
      `its outcome (${row.lastError}). This run was skipped rather than risk sending the endpoint ` +
      `the same objects twice — an HTTPS delivery, unlike an S3 object, cannot be overwritten. ` +
      `Check whether the destination received the last export; the next scheduled run will proceed ` +
      `normally, or use "Run now" to force one.`;
    console.error(`[cost-export] ${row.id} skipped: ${message}`);
    await persistRunOutcome(
      row.id,
      {
        status: "failed",
        error: message,
        objectCount: null,
        rowCount: null,
        nextRunAt: rescheduled(),
      },
      retryDelays,
    );
    return {
      exportId: row.id,
      status: "failed",
      objects: [],
      rowCount: 0,
      collectionWatermark: null,
      error: message,
    };
  }

  const objects: CostExportObject[] = [];
  let totalRows = 0;
  let watermark = "";
  let error: string | null = null;

  try {
    const credentials = await loadCredentials(row);
    if (!credentials) {
      throw new CostExportUploadError(
        "No destination credentials are stored (or they could not be decrypted). Re-enter them in Settings → Cost exports.",
      );
    }
    if (!isClickHouseConfigured()) {
      throw new CostExportUploadError("Cost storage is not configured on this deployment");
    }

    watermark = await costCollectionWatermark(row.organizationId);
    const exportedAt = now.toISOString();
    const columns = resolveColumns(query);
    const prefix = destination.kind === "s3" ? destination.prefix : "";

    const periods = periodsToExport({
      cadence,
      timezone: row.timezone,
      restatementDays: row.restatementDays,
      now,
    });

    // Before the first delivery, never after: a failure here throws into the
    // catch below with nothing yet sent, which is the safe half of the trade.
    if (guarded) await markCostExportRunInFlight(row.id, now);

    for (const period of periods) {
      const key = costExportObjectKey({
        prefix,
        exportId: row.id,
        cadence,
        periodStart: period.key,
        format,
      });

      // Counting wrapper. The count is a by-product of the stream rather than
      // a second COUNT(*) query: an export that reports a row count it did not
      // actually write would be worse than reporting none.
      let rowCount = 0;
      const counted = (async function* (): AsyncGenerator<CostExportRow, void, undefined> {
        for await (const r of streamCostExportRows({
          organizationId: row.organizationId,
          from: period.from,
          to: period.to,
          dimensions: query.dimensions ?? [],
          tagKeys: query.tagKeys ?? [],
          filters: query.filters ?? [],
          chargeTypes: query.chargeTypes,
          costBasis: query.costBasis,
        })) {
          rowCount++;
          yield r;
        }
      })();

      const { body, contentType } = serializeRows(format, counted, columns, {
        exportedAt,
        collectionWatermark: watermark,
      });

      const { byteCount } = await uploadCostExportObject({
        destination,
        credentials,
        key,
        contentType,
        body,
        stamp: {
          periodStart: period.key,
          from: period.from,
          to: period.to,
          exportedAt,
          collectionWatermark: watermark,
        },
      });

      totalRows += rowCount;
      objects.push({
        periodStart: period.key,
        from: period.from,
        to: period.to,
        key,
        rowCount,
        byteCount,
      });
    }
  } catch (e) {
    // One period's failure fails the run. Continuing would produce a partial
    // set whose gaps nothing records, and the usual causes (bad credentials,
    // a missing bucket, a revoked policy) apply to every period equally.
    error = e instanceof Error ? e.message : String(e);
    console.error(`[cost-export] ${row.id} run failed:`, e);
  }

  const status = error === null ? "succeeded" : "failed";
  const persistError = await persistRunOutcome(
    row.id,
    {
      status,
      error,
      objectCount: error === null ? objects.length : null,
      rowCount: error === null ? totalRows : null,
      // A failed run reschedules on the normal cadence rather than backing off.
      // The cadence is already at least a day, the failure is now visible in the
      // UI, and a backoff on top of a daily schedule only delays the recovery
      // once someone has fixed the credential.
      nextRunAt: rescheduled(),
    },
    retryDelays,
  );

  if (persistError !== null) {
    // Loud on purpose: the row now says something other than what happened, and
    // for a guarded destination the next claim will refuse to deliver until a
    // human has looked. This line is the operator's only hint before that.
    console.error(
      `[cost-export] ${row.id} ${status} with ${objects.length} object(s) delivered, but the outcome could not be recorded. ` +
        `The row keeps its lease and its previous status until the lease expires` +
        (guarded ? "; the next run will skip delivery to avoid duplicating it." : "."),
    );
  }

  return {
    exportId: row.id,
    status,
    objects,
    rowCount: totalRows,
    collectionWatermark: watermark || null,
    // `status` describes the delivery. A non-null `error` on a succeeded run
    // means the delivery happened but the record of it did not — the caller
    // ("Run now") has to be told that, or the inconsistency is invisible until
    // somebody notices the settings page disagreeing with their warehouse.
    error:
      error ??
      (persistError === null
        ? null
        : `Delivered ${objects.length} object(s), but this run's outcome could not be recorded: ${persistError}`),
  };
}
