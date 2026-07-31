import { eq } from "drizzle-orm";
import { db } from "@infrawrench/server-core/db/client";
import { accounts } from "@infrawrench/server-core/db/schema";
import { syncAccountResources } from "@infrawrench/server-core/sync-resources";
import { getPlugin } from "@infrawrench/server-core/plugin-loader";
import { notePollOutcome } from "@infrawrench/server-core/twilio-pager";
import { notifyResourceDrift } from "@infrawrench/server-core/drift/alerts";
import { TokenBucketRegistry, defaultBucketConfig, type BucketConfig } from "./token-bucket";
import { isRateLimitError, isTransientError } from "./error-classification";

const BASE_INTERVAL_MS = 15_000;
const MAX_BACKOFF_MS = 10 * 60 * 1000;
const PENALTY_DURATION_MS = 5 * 60 * 1000;

export interface PollAccountRow {
  id: string;
  organizationId: string;
  pluginId: string;
  displayName: string;
  pollFailureCount: number;
}

export async function pollAccount(
  account: PollAccountRow,
  buckets: TokenBucketRegistry,
): Promise<void> {
  const loaded = await getPlugin(account.pluginId);
  const manifestLimit = loaded?.plugin.manifest.rateLimit;
  const config: BucketConfig = manifestLimit
    ? { capacity: manifestLimit.capacity, refillPerSecond: manifestLimit.refillPerSecond }
    : defaultBucketConfig;

  let transientFailure = false;

  const result = await syncAccountResources(account.id, account.organizationId, {
    canListType: () => buckets.tryTake(account.pluginId, account.id, config),
    // Poller-driven syncs are the only ones that raise drift notifications; a
    // manual refresh from the UI still writes the change timeline but stays
    // silent, the same line notePollOutcome draws for sync incidents.
    //
    // Fire-and-forget: the notifier swallows its own errors and rate-limits
    // itself per org, so it can never block or break the poll loop.
    onChanges: (events) => {
      void notifyResourceDrift(account.organizationId, account.id, events);
    },
    onTypeDone: (typeId, outcome, err) => {
      if (outcome === "error" && err && isTransientError(err)) {
        transientFailure = true;
        if (isRateLimitError(err)) {
          buckets.penalize(account.pluginId, account.id, PENALTY_DURATION_MS);
        }
      }
      // Fire-and-forget — the pager swallows its own errors so it can never
      // block or break the poll loop.
      void notePollOutcome({
        organizationId: account.organizationId,
        accountId: account.id,
        accountLabel: account.displayName,
        resourceTypeId: typeId,
        outcome,
        ...(err ? { error: err } : {}),
      });
    },
  });

  const hardFailure = !!result.firstError && transientFailure;

  if (hardFailure) {
    const failures = account.pollFailureCount + 1;
    const backoff = Math.min(BASE_INTERVAL_MS * Math.pow(2, failures - 1), MAX_BACKOFF_MS);
    // The only record of *why* an account is failing. `notePollOutcome` stores
    // per-type errors, but it returns early when the org has no paging set up,
    // so without this line a backed-off account is undiagnosable from prod.
    console.error(
      `[poller] sync for ${account.id} (${account.pluginId}) failed ${failures}x, ` +
        `retrying in ${Math.round(backoff / 1000)}s:`,
      result.firstError,
    );
    await db
      .update(accounts)
      .set({
        lastPolledAt: new Date(),
        nextPollAt: new Date(Date.now() + backoff),
        pollFailureCount: failures,
      })
      .where(eq(accounts.id, account.id));
  } else {
    await db
      .update(accounts)
      .set({
        lastPolledAt: new Date(),
        nextPollAt: new Date(Date.now() + BASE_INTERVAL_MS),
        pollFailureCount: 0,
      })
      .where(eq(accounts.id, account.id));
  }
}
