/**
 * Break-glass access — time-boxed permission elevation.
 *
 * The premise is that the right steady-state role for most people is narrower
 * than the widest thing they will ever need to do, and the usual answer to
 * that ("just make them an admin") is how orgs end up with ten admins. Instead:
 * ask for the specific permissions, for a specific number of minutes, with a
 * reason; someone else approves; the elevation lapses on its own.
 *
 * Built on the approval primitive `workflow_approvals` established, generalized
 * one step: same pending row, same fan-out (`approvals/notify.ts`), same
 * conditional UPDATE that makes two racing deciders produce exactly one
 * decision. What is new is that nothing is suspended waiting on the answer, and
 * that an approval *grants* something.
 *
 * Three rules make this safe, and none of them are optional:
 *
 * 1. **You cannot approve your own request.** That is the entire point; a
 *    self-approvable elevation is just a slower way of having the permission.
 * 2. **You cannot be granted what the approver does not hold.** Checked at
 *    decision time against the approver's live permissions, so a grant can
 *    never mint authority nobody in the room had.
 * 3. **The window is evaluated, never swept.** A grant applies while now is
 *    inside it and not a moment longer. A sweeper that fell behind would be a
 *    sweeper that extended everyone's access.
 */
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { appPath, fanOutApprovalRequest, formatApprovalExpiry } from "../approvals/notify";
import { db } from "../db/client";
import { accessRequests, users } from "../db/schema";
import { hasPermission, isSubsetOfCallerPerms } from "../permissions/catalog";
import { updateSlackApprovalMessages } from "../slack-approvals";

/** Default window an undecided request stays decidable. */
export const DEFAULT_REQUEST_TIMEOUT_MINUTES = 60;

/**
 * Longest elevation anyone can ask for.
 *
 * Eight hours rather than a day: break-glass is for the incident in front of
 * you, and a window that outlives the shift that opened it is a role change
 * wearing a costume. Someone who needs it for longer should be asking for the
 * role, which is a conversation the org should have rather than one this
 * feature should quietly avoid.
 */
export const MAX_GRANT_MINUTES = 8 * 60;
export const MIN_GRANT_MINUTES = 5;

export type AccessRequestStatus = "pending" | "approved" | "denied" | "expired";

/** One request, shaped for the HTTP API and the queue UI. */
export interface AccessRequestSummary {
  id: string;
  userId: string;
  userName: string | null;
  permissions: string[];
  reason: string;
  durationMinutes: number;
  status: AccessRequestStatus;
  expiresAt: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  grantedAt: string | null;
  grantExpiresAt: string | null;
  revokedAt: string | null;
  revokedByName: string | null;
  /** True when this row is granting permissions right now. */
  active: boolean;
  createdAt: string;
}

function toSummary(row: typeof accessRequests.$inferSelect, now: number): AccessRequestSummary {
  return {
    id: row.id,
    userId: row.userId,
    userName: row.userName,
    permissions: row.permissions ?? [],
    reason: row.reason,
    durationMinutes: row.durationMinutes,
    status: row.status as AccessRequestStatus,
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedByUserId: row.decidedByUserId,
    decidedByName: row.decidedByName,
    decisionNote: row.decisionNote,
    grantedAt: row.grantedAt?.toISOString() ?? null,
    grantExpiresAt: row.grantExpiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedByName: row.revokedByName,
    active: isGrantLive(row, now),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Whether a row is granting permissions at `now`. The one definition. */
function isGrantLive(row: typeof accessRequests.$inferSelect, now: number): boolean {
  if (row.status !== "approved") return false;
  if (row.revokedAt) return false;
  if (!row.grantedAt || !row.grantExpiresAt) return false;
  return row.grantedAt.getTime() <= now && now < row.grantExpiresAt.getTime();
}

/* ------------------------------------------------------------------ *
 * The permission-resolution hook.
 * ------------------------------------------------------------------ */

/** A live elevation, as the permission resolver reports it. */
export interface ActiveElevation {
  requestId: string;
  permissions: string[];
  /** When the window closes; the caller loses these permissions then. */
  expiresAt: string;
  reason: string;
}

/**
 * Every live grant for one member, or `[]`.
 *
 * Called on **every** permission resolution for a session principal, so it is
 * written to be one index probe: `access_requests_org_user_status_idx` covers
 * `(organization_id, user_id, status)` and the window predicates run on the
 * handful of approved rows that survives. Deliberately not cached — a revoked
 * grant has to stop applying on the next request, not when a TTL happens to
 * lapse, and "took away access a bit late" is not a failure mode worth trading
 * a query for.
 */
export async function activeElevations(
  organizationId: string,
  userId: string,
  now = new Date(),
): Promise<ActiveElevation[]> {
  try {
    const rows = await db
      .select()
      .from(accessRequests)
      .where(
        and(
          eq(accessRequests.organizationId, organizationId),
          eq(accessRequests.userId, userId),
          eq(accessRequests.status, "approved"),
          isNull(accessRequests.revokedAt),
          gt(accessRequests.grantExpiresAt, now),
        ),
      );
    return rows
      .filter((row) => isGrantLive(row, now.getTime()))
      .map((row) => ({
        requestId: row.id,
        permissions: row.permissions ?? [],
        expiresAt: row.grantExpiresAt!.toISOString(),
        reason: row.reason,
      }));
  } catch (err) {
    // Fail closed. An elevation that cannot be read is an elevation the caller
    // does not have — the alternative is granting authority on a database
    // hiccup, which is the one outcome this feature must never produce.
    console.error(`[break-glass] reading elevations for ${userId} in ${organizationId}:`, err);
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Requesting.
 * ------------------------------------------------------------------ */

export interface CreateAccessRequestInput {
  organizationId: string;
  userId: string;
  permissions: string[];
  reason: string;
  durationMinutes: number;
  /** How long the request itself stays decidable. */
  timeoutMinutes?: number;
}

export type CreateAccessRequestResult =
  | { outcome: "created"; request: AccessRequestSummary }
  | { outcome: "invalid"; error: string }
  | { outcome: "already_held"; error: string };

/**
 * Raise a request and notify the org. Returns immediately — unlike a workflow
 * approval, nothing is blocked waiting for the answer.
 */
export async function createAccessRequest(
  input: CreateAccessRequestInput,
  currentPermissions: readonly string[],
): Promise<CreateAccessRequestResult> {
  const permissions = [...new Set(input.permissions.map((p) => p.trim()).filter(Boolean))];
  if (permissions.length === 0) {
    return { outcome: "invalid", error: "Ask for at least one permission." };
  }
  const reason = input.reason.trim();
  if (reason.length < 10) {
    return {
      outcome: "invalid",
      error: "Give a reason of at least 10 characters — an unexplained elevation is not auditable.",
    };
  }
  const durationMinutes = Math.trunc(input.durationMinutes);
  if (durationMinutes < MIN_GRANT_MINUTES || durationMinutes > MAX_GRANT_MINUTES) {
    return {
      outcome: "invalid",
      error: `Duration must be between ${MIN_GRANT_MINUTES} and ${MAX_GRANT_MINUTES} minutes.`,
    };
  }
  // Asking for what you already hold is almost always a mistake (the wrong
  // permission string, or a role that changed since). Saying so beats sending
  // an approver a request that would change nothing.
  if (permissions.every((p) => hasPermission(currentPermissions, p))) {
    return {
      outcome: "already_held",
      error: "Your role already grants every permission in this request.",
    };
  }

  const id = randomUUID();
  const timeoutMinutes = input.timeoutMinutes ?? DEFAULT_REQUEST_TIMEOUT_MINUTES;
  const expiresAt = new Date(Date.now() + timeoutMinutes * 60_000);
  const userName = await lookupUserName(input.userId);

  const [row] = await db
    .insert(accessRequests)
    .values({
      id,
      organizationId: input.organizationId,
      userId: input.userId,
      userName,
      permissions,
      reason,
      durationMinutes,
      status: "pending",
      expiresAt,
    })
    .returning();

  // The request is already recorded, so a notification outage must not fail
  // the call — the queue holds it either way.
  try {
    await fanOutApprovalRequest({
      organizationId: input.organizationId,
      kind: "access",
      approvalId: id,
      title: `${userName ?? "A member"} is requesting elevated access`,
      message: reason,
      detailLines: [
        `Permissions: ${permissions.join(", ")}`,
        `Duration if granted: ${durationMinutes} minutes`,
        `Timeout: ${formatApprovalExpiry(expiresAt, timeoutMinutes)} — no decision counts as a denial.`,
      ],
      context: `${permissions.length} permission${permissions.length === 1 ? "" : "s"} · ${durationMinutes}m · ${formatApprovalExpiry(expiresAt, timeoutMinutes)}`,
      url: appPath(`/org/${input.organizationId}/settings/access-requests`),
      push: {
        type: "access_request",
        orgId: input.organizationId,
        requestId: id,
        requestedByName: userName ?? "A member",
        durationMinutes,
      },
      slackLead: `*${userName ?? "A member"}* is asking for \`${permissions.join("`, `")}\` for ${durationMinutes} minutes.`,
      teamsLead: `${userName ?? "A member"} is asking for ${permissions.join(", ")} for ${durationMinutes} minutes.`,
    });
  } catch (err) {
    console.error(`[break-glass] notifying about request ${id} failed:`, err);
  }

  return { outcome: "created", request: toSummary(row!, Date.now()) };
}

async function lookupUserName(userId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.displayName ?? row?.email ?? null;
  } catch (err) {
    // Display-only value; log like the shared-console sibling so a schema or
    // logic bug doesn't pass as "user has no name".
    console.error(`[break-glass] resolving the name of user ${userId} failed:`, err);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Listing.
 * ------------------------------------------------------------------ */

export interface ListAccessRequestsOptions {
  status?: AccessRequestStatus;
  userId?: string;
  /** Only rows granting permissions right now. */
  activeOnly?: boolean;
  limit?: number;
}

/**
 * An org's requests, newest first.
 *
 * A `pending` listing hides rows whose timeout has already passed, so the queue
 * never offers a decision that would immediately be refused — the same
 * treatment the workflow approvals inbox gives its own stale rows.
 */
export async function listAccessRequests(
  organizationId: string,
  opts: ListAccessRequestsOptions = {},
): Promise<AccessRequestSummary[]> {
  const conditions = [eq(accessRequests.organizationId, organizationId)];
  if (opts.status) conditions.push(eq(accessRequests.status, opts.status));
  if (opts.userId) conditions.push(eq(accessRequests.userId, opts.userId));

  const rows = await db
    .select()
    .from(accessRequests)
    .where(and(...conditions))
    .orderBy(desc(accessRequests.createdAt))
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));

  const now = Date.now();
  return rows
    .filter((row) => {
      if (opts.status === "pending" && row.expiresAt.getTime() <= now) return false;
      if (opts.activeOnly && !isGrantLive(row, now)) return false;
      return true;
    })
    .map((row) => toSummary(row, now));
}

export async function getAccessRequest(
  organizationId: string,
  requestId: string,
): Promise<AccessRequestSummary | null> {
  const [row] = await db
    .select()
    .from(accessRequests)
    .where(and(eq(accessRequests.id, requestId), eq(accessRequests.organizationId, organizationId)))
    .limit(1);
  return row ? toSummary(row, Date.now()) : null;
}

/* ------------------------------------------------------------------ *
 * Deciding.
 * ------------------------------------------------------------------ */

export interface AccessDecider {
  userId: string;
  name?: string | null;
  /** The decider's live permissions — the ceiling on what they can grant. */
  permissions: readonly string[];
}

export type DecideAccessRequestResult =
  | { outcome: "decided"; request: AccessRequestSummary }
  | { outcome: "conflict" }
  | { outcome: "not_found" }
  | { outcome: "self_approval" }
  | { outcome: "exceeds_approver"; missing: string[] };

/**
 * Record a decision, opening the elevation window on approval.
 *
 * The conditional UPDATE (`status = 'pending'`) is what makes two people racing
 * the same request produce exactly one decision — the loser gets `"conflict"`
 * and the UI re-lists. Deciding after the timeout has passed is also a
 * conflict: the request was already dead, and pretending otherwise would open a
 * window nobody agreed to.
 */
export async function decideAccessRequest(
  organizationId: string,
  requestId: string,
  decision: "approved" | "denied",
  decider: AccessDecider,
  opts: { note?: string | undefined; decidedVia?: "Slack" | "the web app" } = {},
): Promise<DecideAccessRequestResult> {
  const [existing] = await db
    .select()
    .from(accessRequests)
    .where(and(eq(accessRequests.id, requestId), eq(accessRequests.organizationId, organizationId)))
    .limit(1);
  if (!existing) return { outcome: "not_found" };

  // Rule 1. Checked before anything else and for denials too: a person who
  // cannot approve their own request should not be able to withdraw it through
  // the approval path either — withdrawal is its own operation with its own
  // audit action.
  if (existing.userId === decider.userId) return { outcome: "self_approval" };

  const requested = existing.permissions ?? [];
  // Rule 2. Only on approval: denying something you could not have granted is
  // always allowed, and refusing it would strand requests aimed too high.
  if (decision === "approved" && !isSubsetOfCallerPerms(requested, decider.permissions)) {
    return {
      outcome: "exceeds_approver",
      missing: requested.filter((p) => !hasPermission(decider.permissions, p)),
    };
  }

  const now = new Date();
  if (existing.expiresAt.getTime() <= now.getTime()) {
    await expireStaleRequest(organizationId, requestId, decider.name ?? null, opts.decidedVia);
    return { outcome: "conflict" };
  }

  const grant =
    decision === "approved"
      ? {
          grantedAt: now,
          grantExpiresAt: new Date(now.getTime() + existing.durationMinutes * 60_000),
        }
      : {};

  const [updated] = await db
    .update(accessRequests)
    .set({
      status: decision,
      decidedAt: now,
      decidedByUserId: decider.userId,
      decidedByName: decider.name ?? null,
      decisionNote: opts.note?.trim() || null,
      ...grant,
    })
    .where(
      and(
        eq(accessRequests.id, requestId),
        eq(accessRequests.organizationId, organizationId),
        eq(accessRequests.status, "pending"),
        // Atomic with the pre-write expiry check: a decision that started
        // before expiresAt but lands after must not open a grant window.
        gt(accessRequests.expiresAt, now),
      ),
    )
    .returning();
  if (!updated) return { outcome: "conflict" };

  // Retire every tracked Slack copy in place. Fire-and-forget: the decision is
  // landed, and a Slack outage must not make it look like it wasn't.
  void updateSlackApprovalMessages(organizationId, "access", requestId, {
    decision,
    decidedByName: decider.name ?? null,
    via: opts.decidedVia ?? "the web app",
    title: `Approval needed: ${accessRequestTitle(updated)}`,
    body: updated.reason,
  });

  return { outcome: "decided", request: toSummary(updated, now.getTime()) };
}

/** The headline the fan-out used, rebuilt for the retire-in-place update. */
function accessRequestTitle(row: { userName: string | null }): string {
  return `${row.userName ?? "A member"} is requesting elevated access`;
}

/** Mark a timed-out request expired and retire its Slack copies. */
async function expireStaleRequest(
  organizationId: string,
  requestId: string,
  decidedByName: string | null,
  via?: "Slack" | "the web app",
): Promise<void> {
  const [expired] = await db
    .update(accessRequests)
    .set({ status: "expired", decidedAt: new Date() })
    .where(and(eq(accessRequests.id, requestId), eq(accessRequests.status, "pending")))
    .returning();
  if (!expired) return;
  void updateSlackApprovalMessages(organizationId, "access", requestId, {
    decision: "expired",
    decidedByName,
    ...(via ? { via } : {}),
    title: `Approval needed: ${accessRequestTitle(expired)}`,
    body: expired.reason,
  });
}

/* ------------------------------------------------------------------ *
 * Revoking and withdrawing.
 * ------------------------------------------------------------------ */

export type RevokeAccessGrantResult =
  | { outcome: "revoked"; request: AccessRequestSummary }
  | { outcome: "not_found" }
  | { outcome: "not_active" };

/**
 * End a live grant early.
 *
 * Conditioned on `revoked_at IS NULL` so two revokers produce one revocation,
 * and applies from the next permission resolution — there is nothing to
 * invalidate because nothing is cached.
 *
 * Anyone with `access:approve` can revoke, and so can the holder: giving back
 * an elevation you no longer need should never require finding an approver.
 */
export async function revokeAccessGrant(
  organizationId: string,
  requestId: string,
  revokedBy: { userId: string; name?: string | null },
): Promise<RevokeAccessGrantResult> {
  const [existing] = await db
    .select()
    .from(accessRequests)
    .where(and(eq(accessRequests.id, requestId), eq(accessRequests.organizationId, organizationId)))
    .limit(1);
  if (!existing) return { outcome: "not_found" };
  if (!isGrantLive(existing, Date.now())) return { outcome: "not_active" };

  const [updated] = await db
    .update(accessRequests)
    .set({
      revokedAt: new Date(),
      revokedByUserId: revokedBy.userId,
      revokedByName: revokedBy.name ?? null,
    })
    .where(
      and(
        eq(accessRequests.id, requestId),
        eq(accessRequests.organizationId, organizationId),
        isNull(accessRequests.revokedAt),
      ),
    )
    .returning();
  if (!updated) return { outcome: "not_active" };
  return { outcome: "revoked", request: toSummary(updated, Date.now()) };
}

export type WithdrawAccessRequestResult =
  { outcome: "withdrawn" } | { outcome: "not_found" } | { outcome: "conflict" };

/**
 * The requester calls off their own pending request.
 *
 * Its own operation rather than a self-denial, so the audit trail distinguishes
 * "nobody would approve this" from "they decided they didn't need it" — those
 * read very differently in a review, and collapsing them loses the difference.
 */
export async function withdrawAccessRequest(
  organizationId: string,
  requestId: string,
  userId: string,
): Promise<WithdrawAccessRequestResult> {
  const [existing] = await db
    .select({ id: accessRequests.id, userId: accessRequests.userId })
    .from(accessRequests)
    .where(and(eq(accessRequests.id, requestId), eq(accessRequests.organizationId, organizationId)))
    .limit(1);
  if (!existing) return { outcome: "not_found" };
  if (existing.userId !== userId) return { outcome: "not_found" };

  const [updated] = await db
    .update(accessRequests)
    .set({ status: "expired", decidedAt: new Date(), decisionNote: "Withdrawn by the requester." })
    .where(and(eq(accessRequests.id, requestId), eq(accessRequests.status, "pending")))
    .returning({ id: accessRequests.id });
  if (!updated) return { outcome: "conflict" };

  void updateSlackApprovalMessages(organizationId, "access", requestId, {
    decision: "expired",
    decidedByName: null,
    title: "Approval needed: elevated access",
    body: "The requester withdrew this request.",
  });
  return { outcome: "withdrawn" };
}
