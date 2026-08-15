/**
 * Serialising the two things that may end a trial org's life: the reaper's
 * destroy and a claim.
 *
 * Both hold this lock for their whole critical section, so the interleavings
 * that used to be possible — the reaper purging an org mid-claim, a claim
 * re-pointing a registration the cascade is about to delete — cannot happen.
 * The lock provides *mutual exclusion only*: callers still run their inner
 * statements on the main pool, so nothing here changes atomicity or
 * visibility, and a caller that throws mid-section leaves exactly the state it
 * had written (which each caller is already designed to tolerate).
 *
 * **The lock lives on its own connection, and that is the whole point of this
 * module having a connection at all.** The obvious implementation —
 * `db.transaction(tx => { advisory lock; await fn() })` — takes a connection
 * out of the main pool and holds it for the length of the critical section
 * while `fn` goes back to that same pool for every statement it runs. With a
 * pool of 10, ten concurrent claims hold all ten connections in open
 * transactions whose inner queries queue behind connections nobody will
 * release until those queries finish: a self-inflicted deadlock that takes the
 * rest of the process's database traffic down with it. A small dedicated pool
 * removes the coupling entirely — acquiring a lock can never consume the
 * capacity the locked work needs, and if this pool saturates, callers queue for
 * a *lock* rather than deadlocking.
 *
 * Session-scoped (`pg_advisory_lock`) rather than transaction-scoped, because
 * there is no transaction here to scope to; the `finally` releases it, and a
 * connection that dies mid-section releases every lock it held anyway.
 *
 * **Re-entrancy rule**: advisory locks are held per-connection and this pool
 * hands out whichever connection is free, so a caller that already holds the
 * lock must not invoke another function that takes it — the inner acquisition
 * lands on a different connection and blocks forever on its own caller.
 * Concretely: `claimTrialOrg` holds the lock across a merge and calls
 * `destroyOrganization`, so destroy only takes the lock on its guarded reaper
 * path (`expiredTrialOnly`), never on a claim's behalf.
 */
import postgres from "postgres";

/**
 * Deliberately tiny. This pool only ever runs `pg_advisory_lock` /
 * `pg_advisory_unlock`, and its size is the cap on concurrent critical
 * sections — five is far above the real rate (claims are human-driven, and the
 * reaper is a serial loop) while staying a rounding error against Postgres's
 * connection limit.
 */
const LOCK_POOL_SIZE = 5;

let lockSql: postgres.Sql | null = null;

function lockConnection(): postgres.Sql {
  if (lockSql) return lockSql;
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  lockSql = postgres(connectionString, { max: LOCK_POOL_SIZE });
  return lockSql;
}

/** Close the lock pool. For tests and clean shutdown; safe to call twice. */
export async function closeTrialOrgLockPool(): Promise<void> {
  const sql = lockSql;
  lockSql = null;
  if (sql) await sql.end({ timeout: 5 });
}

export async function withTrialOrgLock<T>(
  organizationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const sql = lockConnection();
  const key = `infrawrench:trial-org:${organizationId}`;
  // `reserve()` pins one connection for the lock/unlock pair. It has to be the
  // same connection for both: an advisory lock is owned by the session that
  // took it, and unlocking from a different one is a no-op that logs a warning
  // and leaks the lock until the holding connection closes.
  const reserved = await sql.reserve();
  try {
    await reserved`select pg_advisory_lock(hashtextextended(${key}::text, 0))`;
    try {
      return await fn();
    } finally {
      await reserved`select pg_advisory_unlock(hashtextextended(${key}::text, 0))`;
    }
  } finally {
    reserved.release();
  }
}
