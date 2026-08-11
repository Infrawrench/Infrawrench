import {
  collectAccountQuotas,
  markQuotaPollFailure,
  markQuotaPollSuccess,
} from "@infrawrench/server-core/quotas/collect";
import type { PollAccountRow } from "./poll-account";

/**
 * Quotas are read roughly every six hours.
 *
 * More often than credits (twice a day) because a quota is filled by
 * *provisioning*, which happens in minutes: an autoscaler that eats the last
 * of a vCPU quota at 09:00 should not be discovered at 18:00. Not much more
 * often, because AWS quota reads are the most expensive collection in this
 * codebase — a CloudWatch call and up to two Service Quotas calls per region
 * per quota — and the trend is fitted over a fortnight, where a four-times-
 * daily series is already far denser than the signal.
 *
 * Jitter spreads the fleet so a restart doesn't stampede every account onto
 * the same tick six hours later.
 */
const QUOTA_INTERVAL_MS = 6 * 60 * 60 * 1000;
const QUOTA_JITTER_MS = 45 * 60 * 1000;
const QUOTA_BASE_BACKOFF_MS = 30 * 60 * 1000;
const QUOTA_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

export async function pollAccountQuotas(account: PollAccountRow): Promise<void> {
  try {
    const result = await collectAccountQuotas(account.id, account.organizationId);
    const jitter = Math.floor(Math.random() * QUOTA_JITTER_MS);
    await markQuotaPollSuccess(
      account.id,
      account.organizationId,
      new Date(Date.now() + QUOTA_INTERVAL_MS + jitter),
    );
    if (result.quotaCount === 0) {
      // Not an error — a Kubernetes cluster with no ResourceQuota objects, or
      // an AWS account using nothing in any region, legitimately reports none
      // — but worth a line, because the other explanation is a credential that
      // cannot see them, and those look identical on the screen.
      console.log(`[poller] quota read for ${account.id} (${account.pluginId}) returned no quotas`);
    }
    if (result.droppedCount > 0) {
      // Unusable limits (AWS `Value: 0`, GCP `limit: -1`) are expected and
      // normalised away, but a plugin that suddenly drops everything is a
      // regression, and this line is the only place it would show.
      console.log(
        `[poller] quota read for ${account.id} (${account.pluginId}) dropped ` +
          `${result.droppedCount} unusable reading(s)`,
      );
    }
  } catch (err) {
    // Exponential backoff on the failure count, capped at a day. A credential
    // that cannot read Service Quotas will keep failing, and hammering a
    // management API about it helps nobody — least of all on AWS, where the
    // retry is metered.
    const backoff = Math.min(
      QUOTA_BASE_BACKOFF_MS * 2 ** account.pollFailureCount,
      QUOTA_MAX_BACKOFF_MS,
    );
    await markQuotaPollFailure(
      account.id,
      account.organizationId,
      err,
      new Date(Date.now() + backoff),
    );
    console.error(`[poller] quota read for ${account.id} (${account.pluginId}) failed:`, err);
  }
}
