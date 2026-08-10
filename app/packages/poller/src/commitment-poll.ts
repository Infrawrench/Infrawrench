import {
  collectAccountCommitments,
  markCommitmentPollFailure,
  markCommitmentPollSuccess,
} from "@infrawrench/server-core/commitments/collect";
import type { PollAccountRow } from "./poll-account";

/**
 * Commitment inventories are read daily.
 *
 * A reservation or savings plan changes on human cadence — a purchase, an
 * exchange, an expiry — so anything faster than daily only burns the same
 * rate-limited management APIs the rest of the plugin shares. Daily also
 * keeps the expiry story honest: a commitment lapsing tomorrow was collected
 * today.
 *
 * Jitter spreads the fleet so a restart doesn't stampede every account onto
 * the same tick a day later.
 */
const COMMITMENT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const COMMITMENT_JITTER_MS = 2 * 60 * 60 * 1000;
const COMMITMENT_BASE_BACKOFF_MS = 60 * 60 * 1000;
const COMMITMENT_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

export async function pollAccountCommitments(account: PollAccountRow): Promise<void> {
  try {
    const result = await collectAccountCommitments(account.id, account.organizationId);
    const jitter = Math.floor(Math.random() * COMMITMENT_JITTER_MS);
    await markCommitmentPollSuccess(
      account.id,
      account.organizationId,
      new Date(Date.now() + COMMITMENT_INTERVAL_MS + jitter),
    );
    if (result.recordCount === 0) {
      // Not an error — most accounts genuinely hold no commitments — but
      // worth a line, because the alternative explanation is a credential
      // that cannot see them.
      console.log(`[commitments] read for ${account.id} (${account.pluginId}) returned no records`);
    }
  } catch (err) {
    // Exponential backoff on the failure count, capped at a day. The plugin
    // contract throws on any partial failure (one region down fails the whole
    // fetch), so failures here are expected during provider incidents and
    // must not hammer the API.
    const backoff = Math.min(
      COMMITMENT_BASE_BACKOFF_MS * 2 ** account.pollFailureCount,
      COMMITMENT_MAX_BACKOFF_MS,
    );
    await markCommitmentPollFailure(
      account.id,
      account.organizationId,
      err,
      new Date(Date.now() + backoff),
    );
    console.error(`[commitments] read for ${account.id} (${account.pluginId}) failed:`, err);
  }
}
