/**
 * Push mirrors in Postgres (`git_push_mirrors`): the rows, the sealed
 * credential, and the three numbers that order runs.
 *
 * - **`pendingGeneration`** goes up with every push to the repository (and
 *   with **Sync now**, and hourly for every mirror). **`syncedGeneration`**
 *   is the pending one a finished run started from. A mirror is owed a run
 *   while the first is ahead of the second, so a push that lands while a
 *   run is under way is seen when that run ends.
 * - **The lease** (`leaseToken`, `leaseUntil`) is taken in one `UPDATE`
 *   that only succeeds when nobody holds it, so two messages for one mirror
 *   cannot both run. The holder renews it before every push it makes; a
 *   holder that died is replaced once the lease lapses.
 * - **`nextAttemptAt`** is when a failed mirror is tried again by the
 *   sweep, twice as long after each failure up to an hour.
 *
 * The credential is sealed with server-core's `encrypt` under
 * `ENCRYPTION_MASTER_KEY`, bound to its row (`gitMirror:<id>:credential`),
 * and is read in one place, `openCredential`, for a run.
 */
import { and, asc, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  type GitMirrorResult,
  type GitMirrorStatus,
  gitPushMirrors,
} from "@infrawrench/server-core/db/schema";
import { buildAad, decrypt, encrypt } from "@infrawrench/server-core/encryption";
import { db, isUniqueViolation, newId } from "../db/client";

export type MirrorRow = typeof gitPushMirrors.$inferSelect;

/** Mirrors one repository may have. */
export const MAX_MIRRORS = 5;
/** How long a run holds its mirror without renewing. Longer than a queue consumer may run. */
export const LEASE_MS = 20 * 60 * 1000;
/** The longest wait between tries of a failing mirror. */
const MAX_BACKOFF_MS = 60 * 60 * 1000;
/** Mirrors the sweep sends in one pass. */
const SWEEP_LIMIT = 200;

const aad = (id: string): string => buildAad("gitMirror", id, "credential");

export const listMirrors = (repositoryId: string): Promise<MirrorRow[]> =>
  db
    .select()
    .from(gitPushMirrors)
    .where(eq(gitPushMirrors.repositoryId, repositoryId))
    .orderBy(asc(gitPushMirrors.createdAt));

export const getMirror = async (repositoryId: string, id: string): Promise<MirrorRow | null> => {
  const [row] = await db
    .select()
    .from(gitPushMirrors)
    .where(and(eq(gitPushMirrors.repositoryId, repositoryId), eq(gitPushMirrors.id, id)));
  return row ?? null;
};

export interface NewMirror {
  readonly url: string;
  readonly username: string;
  readonly credential: string;
  readonly exclude: readonly string[];
  readonly force: boolean;
  readonly createdByUserId: string | null;
}

/** Adds a mirror, owed its first run. `"exists"` when the repository already mirrors to that address, `"full"` at the limit. */
export const createMirror = async (
  repositoryId: string,
  mirror: NewMirror,
): Promise<MirrorRow | "exists" | "full"> => {
  if ((await listMirrors(repositoryId)).length >= MAX_MIRRORS) return "full";
  const id = newId();
  const sealed = await encrypt(mirror.credential, aad(id));
  try {
    const [row] = await db
      .insert(gitPushMirrors)
      .values({
        id,
        repositoryId,
        url: mirror.url,
        username: mirror.username,
        credentialEncrypted: sealed.ciphertext,
        credentialIv: sealed.iv,
        exclude: [...mirror.exclude],
        force: mirror.force,
        createdByUserId: mirror.createdByUserId,
      })
      .returning();
    return row!;
  } catch (error) {
    if (isUniqueViolation(error)) return "exists";
    throw error;
  }
};

export interface MirrorChanges {
  readonly url?: string;
  readonly username?: string;
  /** A new credential; absent keeps the stored one. */
  readonly credential?: string;
  readonly exclude?: readonly string[];
  readonly force?: boolean;
  readonly enabled?: boolean;
}

/**
 * Changes a mirror and asks for a run: what it mirrors, or where to, is no
 * longer what the last run saw. The failure count starts over, so the new
 * settings are tried at once.
 */
export const updateMirror = async (
  repositoryId: string,
  id: string,
  changes: MirrorChanges,
): Promise<MirrorRow | "exists" | null> => {
  const sealed =
    changes.credential === undefined ? null : await encrypt(changes.credential, aad(id));
  try {
    const [row] = await db
      .update(gitPushMirrors)
      .set({
        ...(changes.url !== undefined ? { url: changes.url } : {}),
        ...(changes.username !== undefined ? { username: changes.username } : {}),
        ...(sealed ? { credentialEncrypted: sealed.ciphertext, credentialIv: sealed.iv } : {}),
        ...(changes.exclude !== undefined ? { exclude: [...changes.exclude] } : {}),
        ...(changes.force !== undefined ? { force: changes.force } : {}),
        ...(changes.enabled !== undefined ? { enabled: changes.enabled } : {}),
        pendingGeneration: sql`${gitPushMirrors.pendingGeneration} + 1`,
        attempts: 0,
        nextAttemptAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(gitPushMirrors.repositoryId, repositoryId), eq(gitPushMirrors.id, id)))
      .returning();
    return row ?? null;
  } catch (error) {
    if (isUniqueViolation(error)) return "exists";
    throw error;
  }
};

export const deleteMirror = async (repositoryId: string, id: string): Promise<boolean> => {
  const rows = await db
    .delete(gitPushMirrors)
    .where(and(eq(gitPushMirrors.repositoryId, repositoryId), eq(gitPushMirrors.id, id)))
    .returning({ id: gitPushMirrors.id });
  return rows.length > 0;
};

/** A push landed: every mirror of the repository that is on is owed a run. Their ids. */
export const markMirrorsPending = async (repositoryId: string): Promise<string[]> => {
  const rows = await db
    .update(gitPushMirrors)
    .set({ pendingGeneration: sql`${gitPushMirrors.pendingGeneration} + 1` })
    .where(and(eq(gitPushMirrors.repositoryId, repositoryId), eq(gitPushMirrors.enabled, true)))
    .returning({ id: gitPushMirrors.id });
  return rows.map((row) => row.id);
};

/** **Sync now**: owed a run, and due at once whatever its failures. */
export const requestMirrorSync = async (repositoryId: string, id: string): Promise<boolean> => {
  const rows = await db
    .update(gitPushMirrors)
    .set({
      pendingGeneration: sql`${gitPushMirrors.pendingGeneration} + 1`,
      attempts: 0,
      nextAttemptAt: sql`now()`,
    })
    .where(and(eq(gitPushMirrors.repositoryId, repositoryId), eq(gitPushMirrors.id, id)))
    .returning({ id: gitPushMirrors.id });
  return rows.length > 0;
};

/** The hourly check: every mirror that is on is compared with its target again. */
export const markEveryMirrorPending = async (): Promise<void> => {
  await db
    .update(gitPushMirrors)
    .set({ pendingGeneration: sql`${gitPushMirrors.pendingGeneration} + 1` })
    .where(eq(gitPushMirrors.enabled, true));
};

/** Mirrors owed a run that nobody holds and whose next try is due. */
export const mirrorsDue = async (): Promise<string[]> => {
  const rows = await db
    .select({ id: gitPushMirrors.id })
    .from(gitPushMirrors)
    .where(
      and(
        eq(gitPushMirrors.enabled, true),
        gt(gitPushMirrors.pendingGeneration, gitPushMirrors.syncedGeneration),
        lte(gitPushMirrors.nextAttemptAt, sql`now()`),
        or(isNull(gitPushMirrors.leaseUntil), lt(gitPushMirrors.leaseUntil, sql`now()`)),
      ),
    )
    .orderBy(asc(gitPushMirrors.nextAttemptAt))
    .limit(SWEEP_LIMIT);
  return rows.map((row) => row.id);
};

const leaseEnd = sql`now() + make_interval(secs => ${LEASE_MS / 1000})`;

/**
 * Takes the mirror for a run. Null when there is nothing to do or somebody
 * else has it: it is off, it is not owed a run, or its lease is held.
 */
export const claimMirror = async (id: string, token: string): Promise<MirrorRow | null> => {
  const [row] = await db
    .update(gitPushMirrors)
    .set({ leaseToken: token, leaseUntil: leaseEnd, lastAttemptAt: sql`now()` })
    .where(
      and(
        eq(gitPushMirrors.id, id),
        eq(gitPushMirrors.enabled, true),
        gt(gitPushMirrors.pendingGeneration, gitPushMirrors.syncedGeneration),
        or(isNull(gitPushMirrors.leaseUntil), lt(gitPushMirrors.leaseUntil, sql`now()`)),
      ),
    )
    .returning();
  return row ?? null;
};

/** Renews the lease. False once the mirror is somebody else's, off, changed address or gone: the run stops. */
export const renewLease = async (claimed: MirrorRow, token: string): Promise<boolean> => {
  const rows = await db
    .update(gitPushMirrors)
    .set({ leaseUntil: leaseEnd })
    .where(
      and(
        eq(gitPushMirrors.id, claimed.id),
        eq(gitPushMirrors.leaseToken, token),
        eq(gitPushMirrors.enabled, true),
        eq(gitPushMirrors.url, claimed.url),
      ),
    )
    .returning({ id: gitPushMirrors.id });
  return rows.length > 0;
};

/**
 * Gives the mirror back without recording a run: the run stopped because
 * the mirror was changed or turned off under it. True when it was still
 * this run's to give.
 */
export const releaseLease = async (id: string, token: string): Promise<boolean> => {
  const rows = await db
    .update(gitPushMirrors)
    .set({ leaseToken: null, leaseUntil: null })
    .where(and(eq(gitPushMirrors.id, id), eq(gitPushMirrors.leaseToken, token)))
    .returning({ id: gitPushMirrors.id });
  return rows.length > 0;
};

export interface MirrorRunRecord {
  readonly status: GitMirrorStatus | "partial";
  readonly error: string | null;
  readonly result: GitMirrorResult | null;
}

/**
 * Records a run and gives the mirror back. Answers whether another run is
 * owed already (a push landed meanwhile, or this one did not finish), or
 * null when the lease was no longer this run's and nothing was written.
 *
 * `ok` moves `syncedGeneration` to the generation the run started from.
 * `partial` leaves it, so the next run carries on. `error` leaves it too and
 * sets when to try again.
 */
export const finishMirrorRun = async (
  claimed: MirrorRow,
  token: string,
  record: MirrorRunRecord,
): Promise<{ readonly owed: boolean } | null> => {
  const attempts = record.status === "error" ? claimed.attempts + 1 : 0;
  const backoffMs =
    record.status === "error"
      ? Math.min(60_000 * 2 ** Math.min(attempts - 1, 10), MAX_BACKOFF_MS)
      : 0;
  const [row] = await db
    .update(gitPushMirrors)
    .set({
      leaseToken: null,
      leaseUntil: null,
      attempts,
      nextAttemptAt: sql`now() + make_interval(secs => ${backoffMs / 1000})`,
      ...(record.status === "ok"
        ? {
            syncedGeneration: claimed.pendingGeneration,
            lastSyncedAt: sql`now()`,
            lastStatus: "ok" as const,
            lastError: null,
          }
        : record.status === "error"
          ? { lastStatus: "error" as const, lastError: record.error }
          : {}),
      ...(record.result !== null ? { lastResult: record.result } : {}),
    })
    .where(and(eq(gitPushMirrors.id, claimed.id), eq(gitPushMirrors.leaseToken, token)))
    .returning({
      pending: gitPushMirrors.pendingGeneration,
      synced: gitPushMirrors.syncedGeneration,
    });
  if (!row) return null;
  return { owed: record.status !== "error" && row.pending > row.synced };
};

/** The mirror's credential, for a run. Null when it cannot be opened (the master key changed). */
export const openCredential = async (row: MirrorRow): Promise<string | null> => {
  try {
    return await decrypt(row.credentialEncrypted, row.credentialIv, aad(row.id));
  } catch {
    return null;
  }
};
