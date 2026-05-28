import { eq } from "drizzle-orm";
import { db } from "@infrawrench/server-core/db/client";
import { accounts } from "@infrawrench/server-core/db/schema";
import { syncAccountResources } from "@infrawrench/server-core/sync-resources";
import { getPlugin } from "@infrawrench/server-core/plugin-loader";
import { notePollOutcome } from "@infrawrench/server-core/twilio-pager";
import { TokenBucketRegistry, defaultBucketConfig, type BucketConfig } from "./token-bucket";

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

function isRateLimitError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("quota")
  );
}

function isTransientError(err: Error): boolean {
  if (isRateLimitError(err)) return true;
  const msg = err.message.toLowerCase();
  return /5\d\d/.test(msg) || msg.includes("timeout") || msg.includes("econnreset");
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
