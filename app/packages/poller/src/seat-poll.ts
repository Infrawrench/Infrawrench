import {
  collectAccountSeats,
  markSeatPollFailure,
  markSeatPollSuccess,
} from "@infrawrench/server-core/seats/collect";
import type { PollAccountRow } from "./poll-account";
import {
  isGatewayOnlyError,
  runGatewayChecked,
} from "@infrawrench/server-core/runtime/gateway-only";
import { handOffToGateway } from "./gateway-handoff";

/**
 * Seat inventories are read daily, the commitments cadence: seats change on
 * human time (someone joins, leaves, is unassigned), and the activity evidence
 * the findings use is itself daily (GitLab's `last_activity_on`, Cursor's
 * per-day usage), so a faster read would only spend the provider's admin-API
 * budget. Jitter spreads the fleet after a restart.
 */
const SEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SEAT_JITTER_MS = 2 * 60 * 60 * 1000;
const SEAT_BASE_BACKOFF_MS = 60 * 60 * 1000;
const SEAT_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

export async function pollAccountSeats(account: PollAccountRow): Promise<void> {
  try {
    const result = await runGatewayChecked(() =>
      collectAccountSeats(account.id, account.organizationId),
    );
    const jitter = Math.floor(Math.random() * SEAT_JITTER_MS);
    await markSeatPollSuccess(
      account.id,
      account.organizationId,
      new Date(Date.now() + SEAT_INTERVAL_MS + jitter),
    );
    if (result.detectedSavings > 0) {
      console.log(
        `[seats] ${account.id} (${account.pluginId}): ${result.detectedSavings} flagged seat(s) removed or downgraded since the last read`,
      );
    }
  } catch (err) {
    if (isGatewayOnlyError(err)) {
      await handOffToGateway(account, "seats", err);
      return;
    }
    // Exponential backoff on the failure count, capped at a day. The plugin
    // contract throws on any partial read, so a provider incident lands here.
    const backoff = Math.min(
      SEAT_BASE_BACKOFF_MS * 2 ** account.pollFailureCount,
      SEAT_MAX_BACKOFF_MS,
    );
    await markSeatPollFailure(
      account.id,
      account.organizationId,
      err,
      new Date(Date.now() + backoff),
    );
    console.error(`[seats] read for ${account.id} (${account.pluginId}) failed:`, err);
  }
}
