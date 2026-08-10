import { normalizeCostFetchResult, type CostCapabilityDeclaration } from "@infrawrench/plugin-base";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { accounts } from "../db/schema";
import { loadAccountClient } from "../sync-resources";
import { insertCostRows, toCostDailyRows } from "../clickhouse/cost-writers";
import { reconcileCollectedChunk } from "../clickhouse/cost-reconcile";

import { addDays, isoDay, monthChunks } from "./dates";

export { describeCostFailure, type CostFailureDescription } from "./failure";

const DEFAULT_MAX_HISTORY_DAYS = 365;
const DEFAULT_RESTATEMENT_DAYS = 3;

export interface CostCollectionResult {
  rowCount: number;
  backfilled: boolean;
}

/**
 * Collect cost data for one account and stream it into ClickHouse.
 *
 * First run (no costBackfilledAt): backfills `maxHistoryDays` of history in
 * month chunks, inserting after each chunk so a crash loses at most one
 * chunk of work — re-runs re-fetch already-ingested days and the
 * ReplacingMergeTree key dedupes them. Subsequent runs re-fetch only the
 * trailing restatement window.
 *
 * A backfill only counts as done once it has actually ingested a row — see
 * the note on the flag write below.
 *
 * Throws on failure — the caller (poller cost pass) owns backoff/reschedule.
 */
export async function collectAccountCosts(
  accountId: string,
  organizationId: string,
): Promise<CostCollectionResult> {
  const { account, plugin, client } = await loadAccountClient(accountId, organizationId);

  const capability: CostCapabilityDeclaration | undefined = plugin.manifest.costs;
  if (!capability || !client.fetchCostData) {
    throw new Error(`Plugin "${account.pluginId}" does not support cost collection`);
  }

  const today = isoDay(new Date());
  const backfilling = !account.costBackfilledAt;
  const fromDate = backfilling
    ? addDays(today, -(capability.maxHistoryDays ?? DEFAULT_MAX_HISTORY_DAYS))
    : addDays(today, -(capability.restatementDays ?? DEFAULT_RESTATEMENT_DAYS));

  const meta = { organizationId, accountId, pluginId: account.pluginId };
  let rowCount = 0;
  for (const chunk of monthChunks(fromDate, today)) {
    // A plugin may answer with a bare array or with a `CostFetchResult` that
    // says something about the pass as well — absent means "not degraded", so
    // every plugin that has not opted in behaves exactly as before.
    const { rows, degraded } = normalizeCostFetchResult(
      await client.fetchCostData(accountId, chunk),
    );
    if (rows.length > 0) {
      const mapped = toCostDailyRows(meta, rows);
      // Rows this account has stored for these days that the collection is not
      // rewriting are superseded — a cell the provider restated away, or one
      // whose key moved when the plugin started stamping charge types. They are
      // zeroed in the same insert, so that hazard needs no operator DELETE
      // against ClickHouse. See `clickhouse/cost-reconcile.ts` for the guards
      // that keep this from firing on a merely-incomplete fetch, and for what
      // it does not repair.
      //
      // `periodNative` travels with it because it changes what "a day this
      // collection restated" means: a monthly-native plugin files a whole month
      // on one day, so reconciling day-by-day would leave anything stored in
      // the month's interior standing forever — including the rows a collector
      // that once dated its in-progress total to a moving day left behind.
      //
      // A pass the plugin flagged degraded is the fourth guard, and it lives
      // here rather than in that module because only the plugin can know it:
      // the rows are correct in total but written at a *coarser* key space
      // than usual (AWS and Azure both fall back to an unattributed query when
      // the provider refuses the attributed shape). Reconciling against them
      // would zero every attribution row for the chunk, and a backfilled
      // account only re-fetches `restatementDays` of history — so a transient
      // refusal that ages past that window would destroy the attribution for
      // good. Skipping reconciliation leaves the stored rows exactly as they
      // were, which is what happened before reconciliation existed.
      const tombstones = degraded
        ? []
        : await reconcileCollectedChunk(meta, chunk, mapped, {
            periodNative: capability.periodNative,
          });
      await insertCostRows([...mapped, ...tombstones]);
      rowCount += rows.length;
    }
  }

  // Only a backfill that ingested something counts as done. A provider can
  // succeed over the whole window and still return nothing — a Cloud Billing
  // BigQuery export enabled hours ago emits no rows until Google's pipeline
  // catches up — and marking that complete drops the account to the short
  // restatement window permanently, so the history it was waiting for is
  // never fetched once it does appear. Retrying the window costs a chunk of
  // requests a day for a genuinely zero-spend account, and stops on the
  // first row that lands.
  const backfilled = backfilling && rowCount > 0;
  if (backfilled) {
    await db
      .update(accounts)
      .set({ costBackfilledAt: new Date(), updatedAt: new Date() })
      .where(eq(accounts.id, accountId));
  }

  return { rowCount, backfilled };
}
