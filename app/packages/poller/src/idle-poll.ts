import {
  collectAccountIdleFindings,
  markIdlePollFailure,
  markIdlePollSuccess,
} from "@infrawrench/server-core/idle/collect";
import type { PollAccountRow } from "./poll-account";
import {
  isGatewayOnlyError,
  runGatewayChecked,
} from "@infrawrench/server-core/runtime/gateway-only";
import { handOffToGateway } from "./gateway-handoff";

/**
 * Idle verdicts are read once a day.
 *
 * The evidence is a multi-week aggregate (14 days by default), so a daily
 * reading moves the window by a fourteenth and is already far denser than the
 * signal; and every read is billed to the customer (CloudWatch GetMetricData
 * per metric, Cloud Monitoring and Azure Monitor quotas), which argues for the
 * low end. A settings change makes the org due at once, so tuning does not
 * wait for tomorrow.
 *
 * Jitter spreads the fleet so a restart does not stampede every account onto
 * the same tick a day later.
 */
const IDLE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const IDLE_JITTER_MS = 2 * 60 * 60 * 1000;
const IDLE_BASE_BACKOFF_MS = 60 * 60 * 1000;
const IDLE_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

export async function pollAccountIdleFindings(account: PollAccountRow): Promise<void> {
  try {
    const result = await runGatewayChecked(() =>
      collectAccountIdleFindings(account.id, account.organizationId),
    );
    const jitter = Math.floor(Math.random() * IDLE_JITTER_MS);
    await markIdlePollSuccess(
      account.id,
      account.organizationId,
      new Date(Date.now() + IDLE_INTERVAL_MS + jitter),
    );
    if (result.droppedCount > 0) {
      // Normalisation dropping findings is a plugin bug (an unknown rule, a
      // resource the host never handed over); this line is the only place it
      // would show.
      console.log(
        `[poller] idle read for ${account.id} (${account.pluginId}) dropped ` +
          `${result.droppedCount} malformed finding(s)`,
      );
    }
  } catch (err) {
    if (isGatewayOnlyError(err)) {
      await handOffToGateway(account, "idle", err);
      return;
    }
    // Exponential backoff on the failure count, capped at a day: a credential
    // without the metrics permission will keep failing, and the retries are
    // metered on the customer's own bill.
    const backoff = Math.min(
      IDLE_BASE_BACKOFF_MS * 2 ** account.pollFailureCount,
      IDLE_MAX_BACKOFF_MS,
    );
    await markIdlePollFailure(
      account.id,
      account.organizationId,
      err,
      new Date(Date.now() + backoff),
    );
    console.error(`[poller] idle read for ${account.id} (${account.pluginId}) failed:`, err);
  }
}
