/**
 * The trial reaper — destroys unclaimed agent trial orgs once their 24 hours
 * are up.
 *
 * **No claim protocol between replicas, on purpose.** Every other poller pass
 * leases its rows so N replicas do disjoint work; this one does not, because
 * {@link destroyOrganization} is idempotent end to end (the ClickHouse purge is
 * a no-op the second time, WorkOS answers 404, and the Postgres delete reports
 * zero rows) and a lease here has nowhere honest to live: the only column that
 * could hold one is `trialExpiresAt`, and moving that forward would re-grant
 * paid access to an org we are in the middle of deleting. Two replicas racing
 * costs one duplicated sweep and nothing else.
 *
 * Racing a *claim* is a different matter, and is handled inside
 * `destroyOrganization` itself: the `expiredTrialOnly` guard takes the per-org
 * lock and re-checks the org is still an expired unclaimed trial before
 * touching anything, so a ceremony that completes between the due-query and
 * the destroy wins rather than being deleted underneath.
 *
 * **Failures back off instead of starving the queue.** A destroy that throws
 * leaves the org exactly as it was — see `destroy.ts` for why failing in that
 * direction is safe — but the due-query orders by `trialExpiresAt`, so a
 * handful of persistently failing orgs would otherwise occupy every slot of
 * every tick and block the trials queued behind them forever. Failed orgs are
 * skipped for an exponentially growing while (in process memory: a restart
 * retrying immediately is fine), and the log line remains the audit trail for
 * an org that is genuinely stuck.
 */
import { and, isNotNull, isNull, lte } from "drizzle-orm";

import { db } from "../db/client.js";
import { organizations } from "../db/schema.js";
import { destroyOrganization } from "./destroy.js";

export interface TrialPassOptions {
  /** Max orgs to destroy per tick. */
  limit?: number;
  /** Fixed clock for tests. */
  now?: Date;
}

export interface TrialPassResult {
  /** Orgs found due this tick, after backoff skips. */
  due: number;
  destroyed: number;
  failed: number;
}

const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

interface FailureBackoff {
  failures: number;
  nextAttemptAt: number;
}

const destroyBackoff = new Map<string, FailureBackoff>();

/** Test hook: forget every recorded failure. */
export function resetTrialDestroyBackoff(): void {
  destroyBackoff.clear();
}

/**
 * Destroy every unclaimed trial org whose clock has run out.
 *
 * The `claimedAt IS NULL` predicate is belt-and-braces: claiming clears
 * `trialExpiresAt`, so a claimed org should never match the first condition
 * anyway. It is here because the cost of the redundant check is nothing and the
 * cost of the row it would catch is a paying customer's org being deleted.
 */
export async function runTrialExpiryPass(options: TrialPassOptions = {}): Promise<TrialPassResult> {
  const limit = options.limit ?? 10;
  const now = options.now ?? new Date();

  const candidates = await db
    .select({ id: organizations.id, displayName: organizations.displayName })
    .from(organizations)
    .where(
      and(
        isNotNull(organizations.trialExpiresAt),
        lte(organizations.trialExpiresAt, now),
        isNull(organizations.claimedAt),
      ),
    )
    .orderBy(organizations.trialExpiresAt)
    // Over-fetch by the number of orgs that could be sitting out a backoff, so
    // skipping them still leaves a full batch of workable rows.
    .limit(limit + destroyBackoff.size);

  const due = candidates
    .filter((org) => {
      const backoff = destroyBackoff.get(org.id);
      return !backoff || backoff.nextAttemptAt <= now.getTime();
    })
    .slice(0, limit);

  let destroyed = 0;
  let failed = 0;

  for (const org of due) {
    try {
      const result = await destroyOrganization(org.id, { expiredTrialOnly: { now } });
      destroyBackoff.delete(org.id);
      if (result.deleted) destroyed += 1;
      // This log line is the audit trail, and it has to be: `audit_logs` is
      // org-scoped and cascades, so a row recording "this org was destroyed"
      // would be deleted by the destruction it records. Anything that needs a
      // durable history of reaped trials has to read it from here — a
      // platform-level audit table would be the real fix.
      console.log(
        `[trials] destroyed expired trial org ${org.id} (${org.displayName}): ` +
          `clickhouse=${result.clickhouseTablesPurged.length} tables, ` +
          `workos=${result.workosDeleted ? "deleted" : "left in place"}`,
      );
    } catch (e) {
      failed += 1;
      const failures = (destroyBackoff.get(org.id)?.failures ?? 0) + 1;
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
      destroyBackoff.set(org.id, { failures, nextAttemptAt: now.getTime() + delay });
      console.error(
        `[trials] failed to destroy expired trial org ${org.id} ` +
          `(attempt ${failures}, next in ${Math.round(delay / 1000)}s):`,
        e,
      );
    }
  }

  // Entries for orgs that were claimed mid-backoff never come due again and
  // would otherwise sit here for the life of the process. The map is tiny, so
  // an occasional full reset is simpler than reference counting.
  if (destroyBackoff.size > 1000) destroyBackoff.clear();

  return { due: due.length, destroyed, failed };
}
