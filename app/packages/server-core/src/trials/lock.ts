/**
 * Serialising the two things that may end a trial org's life: the reaper's
 * destroy and a claim.
 *
 * Both hold this lock for their whole critical section, so the interleavings
 * that used to be possible — the reaper purging an org mid-claim, a claim
 * re-pointing a registration the cascade is about to delete — cannot happen.
 * The lock provides *mutual exclusion only*: callers still run their inner
 * statements on the shared pool, so nothing here changes atomicity or
 * visibility, and a caller that throws mid-section leaves exactly the state it
 * had written (which each caller is already designed to tolerate).
 *
 * **Re-entrancy rule**: `pg_advisory_xact_lock` is held per-connection, so a
 * caller that already holds the lock must not invoke another function that
 * takes it — the inner acquisition lands on a different pooled connection and
 * deadlocks against its own caller. Concretely: `claimTrialOrg` holds the lock
 * across a merge and calls `destroyOrganization`, so destroy only takes the
 * lock on its guarded reaper path (`expiredTrialOnly`), never on a claim's
 * behalf.
 */
import { sql } from "drizzle-orm";

import { db } from "../db/client.js";

export async function withTrialOrgLock<T>(
  organizationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return await db.transaction(async (tx) => {
    // Transaction-scoped, so the lock releases when this wrapper commits or
    // rolls back — there is no unlock to forget, and a crashed connection
    // frees it automatically.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"infrawrench:trial-org:" + organizationId}::text, 0))`,
    );
    return await fn();
  });
}
