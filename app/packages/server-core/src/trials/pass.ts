/**
 * The trial reaper — destroys unclaimed agent trial orgs once their 24 hours
 * are up.
 *
 * **No claim protocol, on purpose.** Every other poller pass leases its rows so
 * N replicas do disjoint work; this one does not, because
 * {@link destroyOrganization} is idempotent end to end (the ClickHouse purge is
 * a no-op the second time, WorkOS answers 404, and the Postgres delete reports
 * zero rows) and a lease here has nowhere honest to live: the only column that
 * could hold one is `trialExpiresAt`, and moving that forward would re-grant
 * paid access to an org we are in the middle of deleting. Two replicas racing
 * costs one duplicated sweep and nothing else.
 *
 * **Failures are left alone.** A destroy that throws leaves the org exactly as
 * it was, and the next tick finds it again — see `destroy.ts` for why failing
 * in that direction is the safe one. What that means operationally is that a
 * persistently failing destroy retries every tick forever, so the log line
 * matters: it is the only thing that will say an org is stuck.
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
  /** Orgs found due this tick. */
  due: number;
  destroyed: number;
  failed: number;
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

  const due = await db
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
    .limit(limit);

  let destroyed = 0;
  let failed = 0;

  for (const org of due) {
    try {
      const result = await destroyOrganization(org.id);
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
      console.error(`[trials] failed to destroy expired trial org ${org.id}; will retry:`, e);
    }
  }

  return { due: due.length, destroyed, failed };
}
