import {
  collectAccountCredits,
  markCreditPollFailure,
  markCreditPollSuccess,
} from "@infrawrench/server-core/credits/collect";
import type { PollAccountRow } from "./poll-account";

/**
 * Credit balances are read roughly twice a day.
 *
 * More often than costs (which refresh daily at best) because a prepaid pot is
 * a live gauge: an account that starts burning hard should not spend a full day
 * looking fine. Not much more often, because the burn rate is derived from the
 * *series* and a denser series does not make a 30-day rate more accurate — it
 * only makes the provider calls more frequent, and these are the same
 * rate-limited management APIs the rest of the plugin shares.
 *
 * Jitter spreads the fleet so a restart doesn't stampede every account onto
 * the same tick twelve hours later.
 */
const CREDIT_INTERVAL_MS = 12 * 60 * 60 * 1000;
const CREDIT_JITTER_MS = 60 * 60 * 1000;
const CREDIT_BASE_BACKOFF_MS = 60 * 60 * 1000;
const CREDIT_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

export async function pollAccountCredits(account: PollAccountRow): Promise<void> {
  try {
    const result = await collectAccountCredits(account.id, account.organizationId);
    const jitter = Math.floor(Math.random() * CREDIT_JITTER_MS);
    await markCreditPollSuccess(
      account.id,
      account.organizationId,
      new Date(Date.now() + CREDIT_INTERVAL_MS + jitter),
    );
    if (result.potCount === 0) {
      // Not an error — a plugin can legitimately report no pots (a project
      // with no prepaid balance) — but worth a line, because the alternative
      // explanation is a credential that cannot see them.
      console.log(`[poller] credit read for ${account.id} (${account.pluginId}) returned no pots`);
    }
  } catch (err) {
    // Exponential backoff on the failure count, capped at a day. A credential
    // that cannot see the balance will keep failing, and hammering a
    // management API about it helps nobody.
    const backoff = Math.min(
      CREDIT_BASE_BACKOFF_MS * 2 ** account.pollFailureCount,
      CREDIT_MAX_BACKOFF_MS,
    );
    await markCreditPollFailure(
      account.id,
      account.organizationId,
      err,
      new Date(Date.now() + backoff),
    );
    console.error(`[poller] credit read for ${account.id} (${account.pluginId}) failed:`, err);
  }
}
