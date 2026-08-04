/**
 * The poller's lease pass — walks auto-delete leases through their
 * announcement schedule and deletes the resource at expiry.
 *
 * Only leases with `auto_delete = true` and `status = "active"` are ever
 * claimed; nag-only leases need no pass — the expiry radar (which active
 * leases ride as kind `"lease"`) nags them through the existing alert pass.
 *
 * Correctness properties, in the order they bite:
 *
 * - **One claim per step.** `next_check_at` doubles as the claim lease (the
 *   `resource_schedules.next_transition_at` protocol): N poller replicas
 *   claim disjoint rows, a replica that dies mid-work lets the row come due
 *   again at lease expiry, and every completion write is guarded on the
 *   column still holding the claimed value — so an edit (which resets
 *   `next_check_at`) always beats a stale run.
 * - **Two announcements before any delete, always.** The schedule lives in
 *   `./timing.ts` (pure, unit-tested): first warning ~72h out, final ~24h
 *   out, proportionally compressed for short leases, and a delete is never
 *   yielded until both warning stamps are set AND `expires_at` has passed —
 *   even when that pushes the delete later.
 * - **Freezes are respected.** An in-effect org change freeze *defers* the
 *   delete (bumps `next_check_at`, records the deferral in `last_error`) —
 *   unlike a missed sleep-window transition, the delete is still wanted the
 *   moment the freeze lifts, so it is deferred and surfaced, never skipped
 *   and never silently executed.
 * - **Failures are never silent.** Every failure logs `[leases]`-prefixed
 *   and lands in `last_error`; a failing delete retries on a short lease
 *   until {@link LEASE_GIVE_UP_MS} of retrying is spent, then the row goes
 *   `status = "failed"` and the org is told.
 */
import { sql, and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/client";
import { auditLogs, resourceLeases, resources } from "../db/schema";
import { findActiveChangeFreeze } from "../change-freezes";
import { getOrgAccountClient } from "../org-accounts";
import { sendPushToOrg } from "../push/dispatch";
import { sendSlackToOrg } from "../slack";
import { sendMsTeamsToOrg } from "../msteams";
import type { LeaseRecord } from "./store";
import {
  leaseOutcomeMessage,
  leaseWarningMessage,
  nextLeaseStep,
  type LeaseMessage,
} from "./timing";

/** Lease written into `next_check_at` by the claim. */
export const LEASE_PASS_LEASE_MS = 10 * 60 * 1000;
/** Retry cadence for a delete whose provider call failed (and freeze deferrals). */
export const LEASE_RETRY_MS = 10 * 60 * 1000;
/** How long a failing delete is retried before the pass gives up on it. */
export const LEASE_GIVE_UP_MS = 60 * 60 * 1000;
/** Retries the give-up window buys at the retry cadence. */
export const LEASE_MAX_DELETE_ATTEMPTS = Math.ceil(LEASE_GIVE_UP_MS / LEASE_RETRY_MS);

export interface LeasePassOptions {
  /** Max leases to process per tick. */
  limit?: number;
  /** Fixed clock for tests. */
  now?: number;
}

export interface LeasePassResult {
  claimed: number;
  warned: number;
  deleted: number;
  deferredFreeze: number;
  failed: number;
}

/** A claimed row: its id plus the claim token the completion must present. */
interface ClaimedLease {
  id: string;
  /** Postgres' own text rendering of the lease instant — the claim token. */
  claimToken: string;
}

/** Claim due auto-delete leases — the `claimDueAccounts` protocol. */
async function claimDueLeases(limit: number): Promise<ClaimedLease[]> {
  const rows = await db.execute(sql`
    UPDATE resource_leases
    SET next_check_at = now() + ${LEASE_PASS_LEASE_MS}::float8 * interval '1 millisecond',
        updated_at = now()
    WHERE id IN (
      SELECT id FROM resource_leases
      WHERE auto_delete = true
        AND status = 'active'
        AND (next_check_at IS NULL OR next_check_at <= now())
      ORDER BY next_check_at ASC NULLS FIRST, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, next_check_at::text AS claim_token
  `);
  return Array.from(rows as Iterable<Record<string, unknown>>, (r) => ({
    id: String(r["id"]),
    claimToken: String(r["claim_token"]),
  }));
}

/**
 * WHERE fragment shared by every completion write: the row is only touched
 * while it still carries our claim lease. A lease edit resets
 * `next_check_at`, so a superseded run's completion matches nothing and the
 * edit's re-armed schedule wins.
 */
function claimGuard(rowId: string, claimToken: string) {
  return and(
    eq(resourceLeases.id, rowId),
    sql`${resourceLeases.nextCheckAt} = ${claimToken}::timestamp`,
  );
}

/** Guarded partial update; warns when a concurrent edit superseded the run. */
async function guardedUpdate(
  row: LeaseRecord,
  claimToken: string,
  set: Partial<{
    nextCheckAt: Date | null;
    firstWarningAt: Date;
    finalWarningAt: Date;
    status: "deleted" | "failed";
    completedAt: Date;
    deleteAttempts: number;
    lastError: string | null;
  }>,
  now: number,
): Promise<boolean> {
  const updated = await db
    .update(resourceLeases)
    .set({ ...set, updatedAt: new Date(now) })
    .where(claimGuard(row.id, claimToken))
    .returning({ id: resourceLeases.id });
  if (updated.length === 0) {
    console.warn(
      `[leases] completion for lease ${row.id} superseded by a concurrent edit; ` +
        `leaving the edited row's schedule in place`,
    );
    return false;
  }
  return true;
}

/**
 * Fan a lease message out on the `expiryAlerts` trigger — the same trio of
 * transports the expiry radar's daily digest uses. Returns how many
 * destinations were reached; a zero is logged, never thrown, and never blocks
 * the schedule (an org with no transports still gets its lease honored).
 */
async function notifyOrg(organizationId: string, message: LeaseMessage): Promise<number> {
  let succeeded = 0;
  const body = message.lines.join("\n");
  try {
    const push = await sendPushToOrg(organizationId, "expiryAlerts", {
      title: message.title,
      body,
      data: { type: "expiry_alert", orgId: organizationId },
    });
    succeeded += push.succeeded;
  } catch (e) {
    console.error(`[leases] push fan-out failed for org ${organizationId}:`, e);
  }
  try {
    const slack = await sendSlackToOrg(organizationId, "expiryAlerts", {
      title: message.title,
      body,
    });
    succeeded += slack.succeeded;
  } catch (e) {
    console.error(`[leases] Slack fan-out failed for org ${organizationId}:`, e);
  }
  try {
    const msTeams = await sendMsTeamsToOrg(organizationId, "expiryAlerts", {
      title: message.title,
      body,
    });
    succeeded += msTeams.succeeded;
  } catch (e) {
    console.error(`[leases] Teams fan-out failed for org ${organizationId}:`, e);
  }
  if (succeeded === 0) {
    console.warn(
      `[leases] lease announcement for org ${organizationId} reached no transports: ${message.title}`,
    );
  }
  return succeeded;
}

/** Best-effort audit row for the poller-side delete — no request context. */
async function auditAutoDelete(row: LeaseRecord, outcome: "deleted" | "failed", now: number) {
  try {
    await db.insert(auditLogs).values({
      id: randomUUID(),
      organizationId: row.organizationId,
      userId: row.createdByUserId,
      action: outcome === "deleted" ? "resource_lease.auto_delete" : "resource_lease.give_up",
      entityType: "resource_lease",
      entityId: row.id,
      metadata: {
        resourceId: row.resourceId,
        pluginId: row.pluginId,
        resourceTypeId: row.resourceTypeId,
        displayName: row.displayName,
        expiresAt: row.expiresAt.toISOString(),
        ...(outcome === "failed" ? { lastError: row.lastError } : {}),
      },
      createdAt: new Date(now),
    });
  } catch (e) {
    console.error(`[leases] audit write failed for lease ${row.id}:`, e);
  }
}

function messageInput(row: LeaseRecord) {
  return {
    displayName: row.displayName,
    note: row.note,
    expiresAt: row.expiresAt.getTime(),
  };
}

async function executeLease(
  row: LeaseRecord,
  now: number,
  claimToken: string,
): Promise<"warned" | "deleted" | "deferred_freeze" | "failed" | "noop"> {
  const step = nextLeaseStep(
    {
      createdAt: row.createdAt.getTime(),
      expiresAt: row.expiresAt.getTime(),
      firstWarningAt: row.firstWarningAt ? row.firstWarningAt.getTime() : null,
      finalWarningAt: row.finalWarningAt ? row.finalWarningAt.getTime() : null,
    },
    now,
  );

  if (step.kind === "wait") {
    await guardedUpdate(row, claimToken, { nextCheckAt: new Date(step.until) }, now);
    return "noop";
  }

  if (step.kind === "warn1" || step.kind === "warn2") {
    // Record the announcement first, then fan out: a crash between the two
    // costs one announcement's delivery, never a delete without its two
    // announcements — and a failed transport must not re-announce forever.
    const stamp = new Date(now);
    const after = nextLeaseStep(
      {
        createdAt: row.createdAt.getTime(),
        expiresAt: row.expiresAt.getTime(),
        firstWarningAt: step.kind === "warn1" ? now : row.firstWarningAt!.getTime(),
        finalWarningAt: step.kind === "warn2" ? now : null,
      },
      now,
    );
    const nextAt = after.kind === "wait" ? new Date(after.until) : new Date(now);
    const recorded = await guardedUpdate(
      row,
      claimToken,
      step.kind === "warn1"
        ? { firstWarningAt: stamp, nextCheckAt: nextAt }
        : { finalWarningAt: stamp, nextCheckAt: nextAt },
      now,
    );
    if (!recorded) return "noop"; // superseded by an edit — its schedule wins
    await notifyOrg(row.organizationId, leaseWarningMessage(step.kind, messageInput(row), now));
    console.log(
      `[leases] ${step.kind === "warn1" ? "first" : "final"} auto-delete warning sent for ` +
        `resource ${row.resourceId} (lease ${row.id})`,
    );
    return "warned";
  }

  // step.kind === "delete" — both announcements are on record and the lease
  // has expired. Respect an in-effect change freeze by *deferring*: the
  // delete is still wanted once the freeze lifts, so bump the check time and
  // surface the deferral; never silently delete during a freeze.
  const freeze = await findActiveChangeFreeze(row.organizationId, new Date(now));
  if (freeze) {
    console.warn(
      `[leases] deferring auto-delete of resource ${row.resourceId} (lease ${row.id}): ` +
        `change freeze "${freeze.name}" is in effect`,
    );
    await guardedUpdate(
      row,
      claimToken,
      {
        nextCheckAt: new Date(now + LEASE_RETRY_MS),
        lastError: `Deferred: change freeze "${freeze.name}" is in effect`,
      },
      now,
    );
    return "deferred_freeze";
  }

  const [resource] = await db
    .select({ id: resources.id, deletedAt: resources.deletedAt })
    .from(resources)
    .where(and(eq(resources.id, row.resourceId), eq(resources.organizationId, row.organizationId)))
    .limit(1);
  if (!resource || resource.deletedAt !== null) {
    // Already gone (deleted upstream or by hand) — the lease's goal is met.
    console.log(
      `[leases] resource ${row.resourceId} (lease ${row.id}) is already gone; completing without a provider call`,
    );
    await guardedUpdate(
      row,
      claimToken,
      { status: "deleted", completedAt: new Date(now), nextCheckAt: null, lastError: null },
      now,
    );
    return "deleted";
  }

  const fail = async (message: string, giveUp: boolean): Promise<"failed"> => {
    console.error(
      `[leases] auto-delete failed for resource ${row.resourceId} (lease ${row.id}): ${message}`,
    );
    if (giveUp) {
      await guardedUpdate(
        row,
        claimToken,
        {
          status: "failed",
          completedAt: new Date(now),
          nextCheckAt: null,
          deleteAttempts: row.deleteAttempts + 1,
          lastError: message,
        },
        now,
      );
      await auditAutoDelete({ ...row, lastError: message }, "failed", now);
      await notifyOrg(
        row.organizationId,
        leaseOutcomeMessage("failed", messageInput(row), message),
      );
    } else {
      await guardedUpdate(
        row,
        claimToken,
        {
          nextCheckAt: new Date(now + LEASE_RETRY_MS),
          deleteAttempts: row.deleteAttempts + 1,
          lastError: message,
        },
        now,
      );
    }
    return "failed";
  };

  try {
    const ctx = await getOrgAccountClient(row.accountId, row.organizationId);
    if (!ctx) throw new Error("Account not found or its plugin failed to load");
    if (!ctx.client.deleteResource) {
      // Retrying cannot help — the plugin has no delete. Give up immediately.
      return fail(`Plugin ${row.pluginId} does not support deletion`, true);
    }
    await ctx.client.deleteResource(row.resourceTypeId, row.resourceId, row.accountId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return fail(message, row.deleteAttempts + 1 >= LEASE_MAX_DELETE_ATTEMPTS);
  }

  // Soft-delete the stored row so the radar and listings stop showing a
  // resource that no longer exists, without waiting for the next sync.
  // Best-effort: a bookkeeping failure must not turn a succeeded provider
  // delete into a failed lease.
  try {
    await db
      .update(resources)
      .set({ deletedAt: new Date(now) })
      .where(
        and(eq(resources.id, row.resourceId), eq(resources.organizationId, row.organizationId)),
      );
  } catch (e) {
    console.error(`[leases] failed to soft-delete stored resource ${row.resourceId}:`, e);
  }

  console.log(`[leases] auto-deleted resource ${row.resourceId} (lease ${row.id}) at lease expiry`);
  await guardedUpdate(
    row,
    claimToken,
    { status: "deleted", completedAt: new Date(now), nextCheckAt: null, lastError: null },
    now,
  );
  await auditAutoDelete(row, "deleted", now);
  await notifyOrg(row.organizationId, leaseOutcomeMessage("deleted", messageInput(row)));
  return "deleted";
}

/**
 * One lease-pass tick: claim due auto-delete leases and advance each one a
 * step (announce, defer, or delete). Every lease is individually guarded —
 * one failure never blocks the rest of the batch, and nothing here throws
 * into the poller's tick.
 */
export async function runLeasePass(options: LeasePassOptions = {}): Promise<LeasePassResult> {
  const limit = options.limit ?? 4;
  const result: LeasePassResult = {
    claimed: 0,
    warned: 0,
    deleted: 0,
    deferredFreeze: 0,
    failed: 0,
  };

  let claimed: ClaimedLease[];
  try {
    claimed = await claimDueLeases(limit);
  } catch (e) {
    console.error("[leases] claiming due leases failed:", e);
    return result;
  }
  result.claimed = claimed.length;
  if (claimed.length === 0) return result;

  for (const { id, claimToken } of claimed) {
    const now = options.now ?? Date.now();
    try {
      const rows = await db.select().from(resourceLeases).where(eq(resourceLeases.id, id)).limit(1);
      const row = rows[0] as LeaseRecord | undefined;
      if (!row || row.status !== "active" || !row.autoDelete) continue;
      const outcome = await executeLease(row, now, claimToken);
      if (outcome === "warned") result.warned += 1;
      else if (outcome === "deleted") result.deleted += 1;
      else if (outcome === "deferred_freeze") result.deferredFreeze += 1;
      else if (outcome === "failed") result.failed += 1;
    } catch (e) {
      result.failed += 1;
      console.error(`[leases] pass failed for lease ${id}:`, e);
    }
  }
  return result;
}
