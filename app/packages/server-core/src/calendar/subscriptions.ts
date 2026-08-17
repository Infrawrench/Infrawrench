/**
 * iCalendar subscriptions — the one thing the operations calendar stores.
 *
 * A subscription is an unauthenticated URL, so the rules here are the API key
 * rules: the token is shown exactly once, stored as a hash, looked up in
 * constant work, and revoked rather than deleted so the audit trail still
 * resolves. What differs is the failure mode this guards against — an API key
 * leaks into a script, a calendar URL leaks into a shared team calendar, a
 * screenshot, or an intern's laptop — which is why the feed carries only
 * *scheduling* facts (names, times, kinds) and never a credential, a cost, or a
 * resource id someone could act on.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  parseCalendarKinds,
  type CalendarEventKind,
  type CalendarSubscription,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { calendarSubscriptions } from "../db/schema";

export class CalendarSubscriptionInputError extends Error {
  status: 400 | 404;
  constructor(message: string, status: 400 | 404 = 400) {
    super(message);
    this.name = "CalendarSubscriptionInputError";
    this.status = status;
  }
}

const MAX_NAME_LENGTH = 80;
const MAX_SUBSCRIPTIONS_PER_ORG = 25;

/**
 * How stale `lastAccessedAt` may get before the feed route writes it again.
 *
 * A subscribed client polls forever; a write per poll would make this the
 * busiest table in the schema to answer a question ("is anyone still using
 * this?") that an hour of staleness cannot change.
 */
export const LAST_ACCESS_WRITE_INTERVAL_MS = 3_600_000;

/** SHA-256 hex. See the schema note on why a KDF is not wanted here. */
export function hashCalendarToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

interface SubscriptionRow {
  id: string;
  name: string;
  kinds: string;
  createdAt: Date;
  lastAccessedAt: Date | null;
  revokedAt: Date | null;
}

function toWire(row: SubscriptionRow): CalendarSubscription {
  return {
    id: row.id,
    name: row.name,
    kinds: parseCalendarKinds(row.kinds),
    createdAt: row.createdAt.toISOString(),
    lastAccessedAt: row.lastAccessedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export async function listCalendarSubscriptions(
  organizationId: string,
): Promise<CalendarSubscription[]> {
  const rows = await db
    .select({
      id: calendarSubscriptions.id,
      name: calendarSubscriptions.name,
      kinds: calendarSubscriptions.kinds,
      createdAt: calendarSubscriptions.createdAt,
      lastAccessedAt: calendarSubscriptions.lastAccessedAt,
      revokedAt: calendarSubscriptions.revokedAt,
    })
    .from(calendarSubscriptions)
    .where(eq(calendarSubscriptions.organizationId, organizationId))
    .orderBy(desc(calendarSubscriptions.createdAt));
  return rows.map(toWire);
}

export interface CreatedCalendarSubscription {
  subscription: CalendarSubscription;
  /** The bare token. Returned once, never stored, never logged. */
  token: string;
}

export async function createCalendarSubscription(
  organizationId: string,
  input: { name: string; kinds?: CalendarEventKind[] },
  userId: string | null,
): Promise<CreatedCalendarSubscription> {
  const name = input.name.trim();
  if (!name) throw new CalendarSubscriptionInputError("A name is required");
  if (name.length > MAX_NAME_LENGTH) {
    throw new CalendarSubscriptionInputError(`Name must be ${MAX_NAME_LENGTH} characters or fewer`);
  }

  // Counted against *live* feeds only: revoking is how you make room, and a
  // revoked row costs nothing but its history.
  const existing = await db
    .select({ id: calendarSubscriptions.id })
    .from(calendarSubscriptions)
    .where(
      and(
        eq(calendarSubscriptions.organizationId, organizationId),
        isNull(calendarSubscriptions.revokedAt),
      ),
    );
  if (existing.length >= MAX_SUBSCRIPTIONS_PER_ORG) {
    throw new CalendarSubscriptionInputError(
      `An organization may have ${MAX_SUBSCRIPTIONS_PER_ORG} calendar subscriptions; revoke one first`,
    );
  }

  // 32 bytes, base64url — the same shape as the OAuth state nonce. Long enough
  // that the SHA-256 lookup has no guessable preimage, short enough to paste.
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const kinds = parseCalendarKinds(input.kinds ?? []);
  const [row] = await db
    .insert(calendarSubscriptions)
    .values({
      id,
      organizationId,
      userId,
      name,
      hashedToken: hashCalendarToken(token),
      prefix: token.slice(0, 8),
      kinds: kinds.join(","),
    })
    .returning({
      id: calendarSubscriptions.id,
      name: calendarSubscriptions.name,
      kinds: calendarSubscriptions.kinds,
      createdAt: calendarSubscriptions.createdAt,
      lastAccessedAt: calendarSubscriptions.lastAccessedAt,
      revokedAt: calendarSubscriptions.revokedAt,
    });
  if (!row) throw new Error("Failed to create the calendar subscription");
  return { subscription: toWire(row), token };
}

/** Revoke a subscription. Idempotent — a second revoke is not an error. */
export async function revokeCalendarSubscription(
  organizationId: string,
  subscriptionId: string,
): Promise<CalendarSubscription> {
  const [row] = await db
    .update(calendarSubscriptions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(calendarSubscriptions.organizationId, organizationId),
        eq(calendarSubscriptions.id, subscriptionId),
      ),
    )
    .returning({
      id: calendarSubscriptions.id,
      name: calendarSubscriptions.name,
      kinds: calendarSubscriptions.kinds,
      createdAt: calendarSubscriptions.createdAt,
      lastAccessedAt: calendarSubscriptions.lastAccessedAt,
      revokedAt: calendarSubscriptions.revokedAt,
    });
  if (!row) throw new CalendarSubscriptionInputError("No such calendar subscription", 404);
  return toWire(row);
}

export interface ResolvedCalendarSubscription {
  id: string;
  organizationId: string;
  name: string;
  kinds: CalendarEventKind[];
}

/**
 * Resolve a bare token to its subscription, or null.
 *
 * Null covers every failure — unknown token, revoked feed — because the caller
 * is an unauthenticated route and the difference between "never existed" and
 * "was revoked" is exactly what an attacker probing tokens would want to learn.
 */
export async function resolveCalendarToken(
  token: string,
): Promise<ResolvedCalendarSubscription | null> {
  if (!token) return null;
  const [row] = await db
    .select({
      id: calendarSubscriptions.id,
      organizationId: calendarSubscriptions.organizationId,
      name: calendarSubscriptions.name,
      kinds: calendarSubscriptions.kinds,
      revokedAt: calendarSubscriptions.revokedAt,
      lastAccessedAt: calendarSubscriptions.lastAccessedAt,
    })
    .from(calendarSubscriptions)
    .where(eq(calendarSubscriptions.hashedToken, hashCalendarToken(token)))
    .limit(1);
  if (!row || row.revokedAt) return null;

  const now = Date.now();
  const last = row.lastAccessedAt?.getTime() ?? 0;
  if (now - last >= LAST_ACCESS_WRITE_INTERVAL_MS) {
    // Best-effort and deliberately un-awaited: a calendar client waiting on a
    // bookkeeping write is a worse trade than a missed timestamp.
    void db
      .update(calendarSubscriptions)
      .set({ lastAccessedAt: new Date(now) })
      .where(eq(calendarSubscriptions.id, row.id))
      .catch((err: unknown) => {
        console.error("[calendar] failed to record subscription access:", err);
      });
  }

  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    kinds: parseCalendarKinds(row.kinds),
  };
}
