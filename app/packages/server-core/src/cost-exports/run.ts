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
import { loadCredentials, recordCostExportRun, type CostExportRecord } from "./store";

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
}

/**
 * Run one export end to end and record the outcome on its row.
 *
 * Never throws: the caller is either the poller (which must not be taken down
 * by one org's bad bucket) or a "Run now" route (which wants the failure as
 * data so it can render it). The failure is written to `lastStatus`/`lastError`
 * and returned, which is what makes a silently-failing nightly export
 * impossible — the settings UI reads exactly those columns.
 */
export async function runCostExport(
  row: CostExportRecord,
  opts: RunCostExportOptions = {},
): Promise<CostExportRunResult> {
  const now = opts.now ?? new Date();
  const cadence = row.cadence as CostExportCadence;
  const format = row.format === "ndjson" ? "ndjson" : "csv";
  const query = row.query as unknown as CostExportQuery;
  const destination = row.destination as unknown as CostExportDestination;

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
  await recordCostExportRun(row.id, {
    status,
    error,
    objectCount: error === null ? objects.length : null,
    rowCount: error === null ? totalRows : null,
    // A failed run reschedules on the normal cadence rather than backing off.
    // The cadence is already at least a day, the failure is now visible in the
    // UI, and a backoff on top of a daily schedule only delays the recovery
    // once someone has fixed the credential.
    nextRunAt: row.enabled
      ? nextCostExportRunAt(cadence, row.hour, row.timezone, new Date())
      : null,
  }).catch((e) => {
    console.error(`[cost-export] ${row.id} failed to record run outcome:`, e);
  });

  return {
    exportId: row.id,
    status,
    objects,
    rowCount: totalRows,
    collectionWatermark: watermark || null,
    error,
  };
}
