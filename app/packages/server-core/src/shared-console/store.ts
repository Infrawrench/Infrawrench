/**
 * Database access for shared consoles.
 *
 * Everything that decides *whether* something is allowed lives in
 * `arbitration.ts` and is pure; this module only reads and writes rows. The
 * one exception is {@link setDriver}, which has to be a transaction to be
 * correct at all, and whose unique-violation is a decision the database makes
 * — see the note there.
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { db } from "../db/client";
import { sharedConsoleParticipants, sharedConsoles, users } from "../db/schema";

import {
  DEFAULT_INVITE_TTL_MINUTES,
  MAX_INVITE_TTL_MINUTES,
  MIN_INVITE_TTL_MINUTES,
  hashInviteSecret,
  mintInvite,
  parseInviteToken,
  type MintedInvite,
} from "./invites";
import type {
  ParticipantRole,
  ParticipantState,
  ParticipantStatus,
  SharedConsoleState,
  SharedConsoleStatus,
} from "./arbitration";

// Re-exported so callers have one import for "everything about a share".
export {
  DEFAULT_INVITE_TTL_MINUTES,
  MAX_INVITE_TTL_MINUTES,
  MIN_INVITE_TTL_MINUTES,
  hashInviteSecret,
  mintInvite,
  parseInviteToken,
  type MintedInvite,
};

/** A share, as the API and the UI see it. Never carries the invite digest. */
export interface SharedConsoleRow {
  id: string;
  organizationId: string;
  liveConsoleId: string;
  routingKey: string;
  ownerUserId: string | null;
  ownerName: string | null;
  accountId: string | null;
  resourceId: string | null;
  host: string;
  port: number;
  username: string;
  recordingId: string | null;
  inviteTokenPrefix: string | null;
  inviteExpiresAt: Date | null;
  inviteConsumedAt: Date | null;
  allowHandover: boolean;
  ptyCols: number;
  ptyRows: number;
  status: SharedConsoleStatus;
  revokedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
}

/** A participant, as the API and the UI see it. */
export interface ParticipantRow {
  id: string;
  sharedConsoleId: string;
  userId: string;
  userName: string | null;
  role: ParticipantRole;
  status: ParticipantStatus;
  driverRequestedAt: Date | null;
  viewportCols: number | null;
  viewportRows: number | null;
  joinedAt: Date;
  lastSeenAt: Date;
  leftAt: Date | null;
}

/** Narrow a stored string to the union, defaulting to the safe member. */
function asStatus(value: string): SharedConsoleStatus {
  return value === "revoked" || value === "ended" ? value : "active";
}

function asRole(value: string): ParticipantRole {
  return value === "driver" ? "driver" : "observer";
}

function asParticipantStatus(value: string): ParticipantStatus {
  return value === "left" || value === "removed" ? value : "joined";
}

/** The subset of a share that {@link import("./arbitration")} decisions need. */
export function toShareState(row: SharedConsoleRow, inviteTokenHash: string | null) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    status: row.status,
    ownerUserId: row.ownerUserId,
    allowHandover: row.allowHandover,
    inviteTokenHash,
    inviteExpiresAt: row.inviteExpiresAt,
    inviteConsumedAt: row.inviteConsumedAt,
  } satisfies SharedConsoleState;
}

export function toParticipantState(row: ParticipantRow): ParticipantState {
  return { id: row.id, userId: row.userId, role: row.role, status: row.status };
}

function mapShare(row: typeof sharedConsoles.$inferSelect): SharedConsoleRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    liveConsoleId: row.liveConsoleId,
    routingKey: row.routingKey,
    ownerUserId: row.ownerUserId,
    ownerName: row.ownerName,
    accountId: row.accountId,
    resourceId: row.resourceId,
    host: row.host,
    port: row.port,
    username: row.username,
    recordingId: row.recordingId,
    inviteTokenPrefix: row.inviteTokenPrefix,
    inviteExpiresAt: row.inviteExpiresAt,
    inviteConsumedAt: row.inviteConsumedAt,
    allowHandover: row.allowHandover,
    ptyCols: row.ptyCols,
    ptyRows: row.ptyRows,
    status: asStatus(row.status),
    revokedAt: row.revokedAt,
    endedAt: row.endedAt,
    createdAt: row.createdAt,
  };
}

function mapParticipant(row: typeof sharedConsoleParticipants.$inferSelect): ParticipantRow {
  return {
    id: row.id,
    sharedConsoleId: row.sharedConsoleId,
    userId: row.userId,
    userName: row.userName,
    role: asRole(row.role),
    status: asParticipantStatus(row.status),
    driverRequestedAt: row.driverRequestedAt,
    viewportCols: row.viewportCols,
    viewportRows: row.viewportRows,
    joinedAt: row.joinedAt,
    lastSeenAt: row.lastSeenAt,
    leftAt: row.leftAt,
  };
}

export interface CreateSharedConsoleInput {
  organizationId: string;
  liveConsoleId: string;
  routingKey: string;
  ownerUserId: string;
  accountId?: string | undefined;
  resourceId?: string | undefined;
  host: string;
  port: number;
  username: string;
  recordingId?: string | undefined;
  allowHandover: boolean;
  ptyCols: number;
  ptyRows: number;
  inviteTtlMinutes: number;
}

/**
 * Open a share on a live session and admit its owner as the first driver.
 *
 * The owner's participant row is written here rather than lazily on their next
 * frame, because the pty already has somebody typing into it and the row is
 * what says who. Without it there would be a window in which a share exists
 * with no driver and the person at the keyboard is, formally, an observer of
 * their own session.
 */
export async function createSharedConsole(
  input: CreateSharedConsoleInput,
  now = new Date(),
): Promise<{ share: SharedConsoleRow; owner: ParticipantRow; invite: MintedInvite }> {
  const id = randomUUID();
  const invite = mintInvite(id, input.inviteTtlMinutes, now);
  const ownerName = await lookupUserName(input.ownerUserId);

  const [shareRow] = await db
    .insert(sharedConsoles)
    .values({
      id,
      organizationId: input.organizationId,
      liveConsoleId: input.liveConsoleId,
      routingKey: input.routingKey,
      ownerUserId: input.ownerUserId,
      ownerName,
      accountId: input.accountId ?? null,
      resourceId: input.resourceId ?? null,
      host: input.host,
      port: input.port,
      username: input.username,
      recordingId: input.recordingId ?? null,
      inviteTokenHash: invite.hash,
      inviteTokenPrefix: invite.prefix,
      inviteExpiresAt: invite.expiresAt,
      allowHandover: input.allowHandover,
      ptyCols: input.ptyCols,
      ptyRows: input.ptyRows,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  const [ownerRow] = await db
    .insert(sharedConsoleParticipants)
    .values({
      id: randomUUID(),
      sharedConsoleId: id,
      organizationId: input.organizationId,
      userId: input.ownerUserId,
      userName: ownerName,
      role: "driver",
      status: "joined",
      viewportCols: input.ptyCols,
      viewportRows: input.ptyRows,
      joinedAt: now,
      lastSeenAt: now,
    })
    .returning();

  return { share: mapShare(shareRow!), owner: mapParticipant(ownerRow!), invite };
}

/** Display name for a snapshot column; null rather than throwing on failure. */
async function lookupUserName(userId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.displayName ?? row?.email ?? null;
  } catch (err) {
    console.error(`[shared-console] resolving the name of user ${userId} failed:`, err);
    return null;
  }
}

export async function getSharedConsole(id: string): Promise<SharedConsoleRow | null> {
  const [row] = await db.select().from(sharedConsoles).where(eq(sharedConsoles.id, id)).limit(1);
  return row ? mapShare(row) : null;
}

/** The stored invite digest, kept off {@link SharedConsoleRow} so it is never serialized. */
export async function getInviteHash(id: string): Promise<string | null> {
  const [row] = await db
    .select({ hash: sharedConsoles.inviteTokenHash })
    .from(sharedConsoles)
    .where(eq(sharedConsoles.id, id))
    .limit(1);
  return row?.hash ?? null;
}

export async function getSharedConsoleByLiveId(
  liveConsoleId: string,
): Promise<SharedConsoleRow | null> {
  const [row] = await db
    .select()
    .from(sharedConsoles)
    .where(eq(sharedConsoles.liveConsoleId, liveConsoleId))
    .limit(1);
  return row ? mapShare(row) : null;
}

export async function listParticipants(sharedConsoleId: string): Promise<ParticipantRow[]> {
  const rows = await db
    .select()
    .from(sharedConsoleParticipants)
    .where(eq(sharedConsoleParticipants.sharedConsoleId, sharedConsoleId))
    .orderBy(sharedConsoleParticipants.joinedAt);
  return rows.map(mapParticipant);
}

export async function getParticipant(
  sharedConsoleId: string,
  userId: string,
): Promise<ParticipantRow | null> {
  const [row] = await db
    .select()
    .from(sharedConsoleParticipants)
    .where(
      and(
        eq(sharedConsoleParticipants.sharedConsoleId, sharedConsoleId),
        eq(sharedConsoleParticipants.userId, userId),
      ),
    )
    .limit(1);
  return row ? mapParticipant(row) : null;
}

export async function getParticipantById(id: string): Promise<ParticipantRow | null> {
  const [row] = await db
    .select()
    .from(sharedConsoleParticipants)
    .where(eq(sharedConsoleParticipants.id, id))
    .limit(1);
  return row ? mapParticipant(row) : null;
}

/** The org's live shares, newest first — the "who is pairing right now" list. */
export async function listActiveSharedConsoles(
  organizationId: string,
): Promise<SharedConsoleRow[]> {
  const rows = await db
    .select()
    .from(sharedConsoles)
    .where(
      and(eq(sharedConsoles.organizationId, organizationId), eq(sharedConsoles.status, "active")),
    )
    .orderBy(desc(sharedConsoles.createdAt))
    .limit(100);
  return rows.map(mapShare);
}

/** Live shares among the given ids — the sweep's single query per replica. */
export async function readShareStates(
  ids: readonly string[],
): Promise<Map<string, SharedConsoleRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(sharedConsoles)
    .where(inArray(sharedConsoles.id, [...ids]));
  return new Map(rows.map((r) => [r.id, mapShare(r)]));
}

/**
 * Admit somebody, or resume the row they already had.
 *
 * `consumesInvite` clears the stored digest in the same statement that stamps
 * `invite_consumed_at`, so the link stops working the instant it works once —
 * there is no window in which two people can redeem the same invite, because
 * the second `UPDATE ... WHERE invite_token_hash IS NOT NULL` matches nothing.
 */
export async function admitParticipant(input: {
  share: SharedConsoleRow;
  userId: string;
  role: ParticipantRole;
  consumesInvite: boolean;
  now?: Date;
}): Promise<ParticipantRow> {
  const now = input.now ?? new Date();

  if (input.consumesInvite) {
    const consumed = await db
      .update(sharedConsoles)
      .set({ inviteTokenHash: null, inviteConsumedAt: now, updatedAt: now })
      .where(
        and(
          eq(sharedConsoles.id, input.share.id),
          isNotNull(sharedConsoles.inviteTokenHash),
          eq(sharedConsoles.status, "active"),
        ),
      )
      .returning({ id: sharedConsoles.id });
    if (consumed.length === 0) {
      // Somebody redeemed it between the decision and this write.
      throw new InviteRaceLostError();
    }
  }

  const existing = await getParticipant(input.share.id, input.userId);
  if (existing) {
    const [row] = await db
      .update(sharedConsoleParticipants)
      .set({ status: "joined", lastSeenAt: now, leftAt: null })
      .where(eq(sharedConsoleParticipants.id, existing.id))
      .returning();
    return mapParticipant(row!);
  }

  const userName = await lookupUserName(input.userId);
  const [row] = await db
    .insert(sharedConsoleParticipants)
    .values({
      id: randomUUID(),
      sharedConsoleId: input.share.id,
      organizationId: input.share.organizationId,
      userId: input.userId,
      userName,
      // Always an observer on first admission, whatever the caller asked for.
      role: input.role === "driver" ? "driver" : "observer",
      status: "joined",
      joinedAt: now,
      lastSeenAt: now,
    })
    .returning();
  return mapParticipant(row!);
}

/** Raised when an invite was redeemed by somebody else first. */
export class InviteRaceLostError extends Error {
  constructor() {
    super("That invite link had just been used by somebody else.");
    this.name = "InviteRaceLostError";
  }
}

/** Raised when a handover lost the race to another concurrent handover. */
export class DriverRaceLostError extends Error {
  constructor() {
    super("Somebody else took the keyboard first.");
    this.name = "DriverRaceLostError";
  }
}

/**
 * Move the keyboard, atomically.
 *
 * Demote-then-promote inside one transaction. The partial unique index on
 * `(shared_console_id) WHERE role='driver' AND status='joined'` is what makes
 * two concurrent handovers safe: whichever transaction commits second finds
 * the index already occupied by a row it did not demote and raises a unique
 * violation, which surfaces here as {@link DriverRaceLostError} and to the
 * caller as a 409. There is no lock to take and no ordering to get right — the
 * index *is* the mutual exclusion.
 */
export async function setDriver(input: {
  sharedConsoleId: string;
  demoteParticipantId: string | null;
  promoteParticipantId: string;
  now?: Date;
}): Promise<ParticipantRow[]> {
  const now = input.now ?? new Date();
  try {
    return await db.transaction(async (tx) => {
      if (input.demoteParticipantId) {
        await tx
          .update(sharedConsoleParticipants)
          .set({ role: "observer" })
          .where(eq(sharedConsoleParticipants.id, input.demoteParticipantId));
      }
      await tx
        .update(sharedConsoleParticipants)
        .set({ role: "driver", driverRequestedAt: null, lastSeenAt: now })
        .where(
          and(
            eq(sharedConsoleParticipants.id, input.promoteParticipantId),
            eq(sharedConsoleParticipants.status, "joined"),
          ),
        );
      const rows = await tx
        .select()
        .from(sharedConsoleParticipants)
        .where(eq(sharedConsoleParticipants.sharedConsoleId, input.sharedConsoleId))
        .orderBy(sharedConsoleParticipants.joinedAt);
      return rows.map(mapParticipant);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new DriverRaceLostError();
    throw err;
  }
}

/** Postgres 23505, however the driver in use chose to surface it. */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "23505"
  );
}

export async function requestDriver(participantId: string, now = new Date()): Promise<void> {
  await db
    .update(sharedConsoleParticipants)
    .set({ driverRequestedAt: now, lastSeenAt: now })
    .where(eq(sharedConsoleParticipants.id, participantId));
}

export async function recordViewport(
  participantId: string,
  cols: number,
  rows: number,
  now = new Date(),
): Promise<void> {
  await db
    .update(sharedConsoleParticipants)
    .set({ viewportCols: cols, viewportRows: rows, lastSeenAt: now })
    .where(eq(sharedConsoleParticipants.id, participantId));
}

export async function touchParticipant(participantId: string, now = new Date()): Promise<void> {
  await db
    .update(sharedConsoleParticipants)
    .set({ lastSeenAt: now })
    .where(eq(sharedConsoleParticipants.id, participantId));
}

/**
 * Mark somebody off the console.
 *
 * `left` for a voluntary departure — the row survives so they can come back
 * without burning a fresh invite. `removed` for an ejection or a lapsed
 * permission, which does require a new invite. A departing driver is demoted
 * in the same write; leaving the keyboard with somebody who has closed the tab
 * would strand the session with nobody able to type into it.
 */
export async function detachParticipant(
  participantId: string,
  status: Extract<ParticipantStatus, "left" | "removed">,
  now = new Date(),
): Promise<void> {
  await db
    .update(sharedConsoleParticipants)
    .set({ status, role: "observer", leftAt: now, lastSeenAt: now, driverRequestedAt: null })
    .where(eq(sharedConsoleParticipants.id, participantId));
}

export async function setPtySize(
  sharedConsoleId: string,
  cols: number,
  rows: number,
  now = new Date(),
): Promise<void> {
  await db
    .update(sharedConsoles)
    .set({ ptyCols: cols, ptyRows: rows, updatedAt: now })
    .where(eq(sharedConsoles.id, sharedConsoleId));
}

export async function replaceInvite(
  sharedConsoleId: string,
  ttlMinutes: number,
  now = new Date(),
): Promise<MintedInvite> {
  const invite = mintInvite(sharedConsoleId, ttlMinutes, now);
  await db
    .update(sharedConsoles)
    .set({
      inviteTokenHash: invite.hash,
      inviteTokenPrefix: invite.prefix,
      inviteExpiresAt: invite.expiresAt,
      inviteConsumedAt: null,
      updatedAt: now,
    })
    .where(eq(sharedConsoles.id, sharedConsoleId));
  return invite;
}

/** Withdraw the outstanding invite without touching the session itself. */
export async function withdrawInvite(sharedConsoleId: string, now = new Date()): Promise<void> {
  await db
    .update(sharedConsoles)
    .set({ inviteTokenHash: null, inviteTokenPrefix: null, inviteExpiresAt: null, updatedAt: now })
    .where(eq(sharedConsoles.id, sharedConsoleId));
}

/**
 * End the share.
 *
 * `revoked` is somebody deciding to; `ended` is the underlying SSH session
 * closing. Both stop the fan-out, and both clear the invite in the same write
 * so a link in flight cannot land on a dead session. Only ever moves a share
 * *out* of `active`, so a revoke that races the session closing does not
 * resurrect it.
 */
export async function closeSharedConsole(
  sharedConsoleId: string,
  status: Extract<SharedConsoleStatus, "revoked" | "ended">,
  revokedByUserId?: string,
  now = new Date(),
): Promise<SharedConsoleRow | null> {
  const [row] = await db
    .update(sharedConsoles)
    .set({
      status,
      inviteTokenHash: null,
      inviteExpiresAt: null,
      updatedAt: now,
      ...(status === "revoked"
        ? { revokedAt: now, revokedByUserId: revokedByUserId ?? null }
        : { endedAt: now }),
    })
    .where(and(eq(sharedConsoles.id, sharedConsoleId), eq(sharedConsoles.status, "active")))
    .returning();
  if (!row) return null;
  await db
    .update(sharedConsoleParticipants)
    .set({ status: "left", role: "observer", leftAt: now })
    .where(
      and(
        eq(sharedConsoleParticipants.sharedConsoleId, sharedConsoleId),
        isNull(sharedConsoleParticipants.leftAt),
      ),
    );
  return mapShare(row);
}
