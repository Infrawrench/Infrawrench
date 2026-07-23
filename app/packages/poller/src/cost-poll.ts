import { eq } from "drizzle-orm";
import { db } from "@infrawrench/server-core/db/client";
import { accounts } from "@infrawrench/server-core/db/schema";
import { collectAccountCosts } from "@infrawrench/server-core/cost/collect";
import { evaluateBudgetsForOrg } from "@infrawrench/server-core/cost/budget-eval";
import type { PollAccountRow } from "./poll-account";

/**
 * Cost collection runs roughly once a day per account — provider billing
 * APIs refresh daily at best and some charge per request (AWS Cost Explorer).
 * Jitter spreads the fleet so a restart doesn't stampede every account onto
 * the same tick a day later.
 */
const COST_INTERVAL_MS = 24 * 60 * 60 * 1000;
const COST_JITTER_MS = 60 * 60 * 1000;
const COST_BASE_BACKOFF_MS = 60 * 60 * 1000;
const COST_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

export async function pollAccountCosts(account: PollAccountRow): Promise<void> {
  try {
    const result = await collectAccountCosts(account.id, account.organizationId);
    if (result.backfilled) {
      console.log(
        `[poller] cost backfill for ${account.id} (${account.pluginId}) ingested ${result.rowCount} rows`,
      );
    }
    const jitter = Math.floor(Math.random() * COST_JITTER_MS);
    await db
      .update(accounts)
      .set({
        costLastPolledAt: new Date(),
        costNextPollAt: new Date(Date.now() + COST_INTERVAL_MS + jitter),
        costPollFailureCount: 0,
      })
      .where(eq(accounts.id, account.id));

    // Fresh cost data may cross budget thresholds — evaluate now (its own
    // errors are swallowed; it never fails the collection).
    await evaluateBudgetsForOrg(account.organizationId);
  } catch (e) {
    console.error(`[poller] cost collection for ${account.id} (${account.pluginId}) failed:`, e);
    const failures = account.pollFailureCount + 1;
    const backoff = Math.min(COST_BASE_BACKOFF_MS * Math.pow(2, failures - 1), COST_MAX_BACKOFF_MS);
    await db
      .update(accounts)
      .set({
        costLastPolledAt: new Date(),
        costNextPollAt: new Date(Date.now() + backoff),
        costPollFailureCount: failures,
      })
      .where(eq(accounts.id, account.id));
  }
}
