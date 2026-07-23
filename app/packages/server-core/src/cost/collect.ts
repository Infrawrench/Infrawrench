import type { CostCapabilityDeclaration } from "@infrawrench/plugin-base";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { accounts } from "../db/schema";
import { loadAccountClient } from "../sync-resources";
import { insertCostRows, toCostDailyRows } from "../clickhouse/cost-writers";

import { addDays, isoDay, monthChunks } from "./dates";

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
    const rows = await client.fetchCostData(accountId, chunk);
    if (rows.length > 0) {
      await insertCostRows(toCostDailyRows(meta, rows));
      rowCount += rows.length;
    }
  }

  if (backfilling) {
    await db
      .update(accounts)
      .set({ costBackfilledAt: new Date(), updatedAt: new Date() })
      .where(eq(accounts.id, accountId));
  }

  return { rowCount, backfilled: backfilling };
}
