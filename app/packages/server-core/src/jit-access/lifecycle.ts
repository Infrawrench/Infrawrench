/**
 * Just-in-time access: the half that talks to providers. Granting after an
 * approval, revoking at expiry or on demand, and the `jit-access-expiry` sweep
 * that drives both forward when the inline attempt could not finish.
 *
 * Every provider call goes through the plugin's `jitAccess` methods
 * (`plugin-base/src/jit-access.ts`); there is no provider name in this file.
 *
 * **The crash-safety argument**, because the whole feature rests on it:
 *
 * - Every transition is a conditional UPDATE on the expected status, so two
 *   workers (the approving request and the sweep, or two sweeps) can never
 *   both act on one row.
 * - `next_action_at` is the lease. A worker that claims a row pushes it into
 *   the future; one that dies mid-call leaves the row due again when the lease
 *   runs out.
 * - Grant and revoke are idempotent and keyed by the request id, so redoing
 *   either after a crash is harmless. Revoke never needs the stored `grant_ref`.
 * - The standing-access check runs **once**, before the first grant attempt,
 *   and its answer (`preexisting`, and `granted_at` marking that the check is
 *   done) is written before the provider is touched. A retry therefore never
 *   mistakes its own earlier grant for standing access, which would otherwise
 *   leave the grant un-revoked forever.
 * - If the provider grant succeeds and the database write after it fails, the
 *   row stays `granting` with a window already recorded; the sweep retries the
 *   (idempotent) grant, or revokes once the window has passed. Access is never
 *   held with nothing in the database that knows to take it away.
 * - A revoke is checked afterwards (`checkJitAccess`), and a grant still
 *   present upstream is a failure, not a success.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, lte, or } from "drizzle-orm";
import type { JitGrantSpec, PluginClient } from "@infrawrench/plugin-base";
import type { JitEndReason } from "@infrawrench/client-core";

import { db } from "../db/client";
import { auditLogs } from "../db/schema";
import { jitAccessRequests } from "../db/jit-access-schema";
import { getOrgAccountClient } from "../org-accounts";
import { pluginCodeAvailable } from "../plugin-loader";
import { routeAlert } from "../alerts/route";
import { appPath } from "../app-url";

export type JitRequestRow = typeof jitAccessRequests.$inferSelect;

/** How long a claimed grant or revoke holds the row before the sweep may retry it. */
export const JIT_LEASE_MS = 5 * 60 * 1000;
/** Grant attempts (inline plus sweeps) before the request is failed and cleaned up. */
export const JIT_MAX_GRANT_ATTEMPTS = 3;
/** Revoke retries back off to this ceiling, and never stop. */
const MAX_REVOKE_BACKOFF_MS = 60 * 60 * 1000;

/** Who or what caused a transition, for the row and the audit log. */
export interface JitActor {
  userId: string | null;
  name: string | null;
  /** "the web app", "Slack", "the mobile app", "the CLI", "the expiry sweep". */
  via: string;
}

export const SWEEP_ACTOR: JitActor = { userId: null, name: null, via: "the expiry sweep" };

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 1000);
}

/**
 * One audit row per state change. Written here rather than by each route so
 * the Slack button, the HTTP route and the sweep cannot disagree about what is
 * recorded. Never throws: the change it describes already happened.
 */
export async function auditJit(
  row: Pick<
    JitRequestRow,
    | "id"
    | "organizationId"
    | "accountId"
    | "pluginId"
    | "scopeId"
    | "roleId"
    | "principalId"
    | "userId"
  >,
  action: string,
  actor: JitActor,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: randomUUID(),
      organizationId: row.organizationId,
      userId: actor.userId,
      action: `jit_access.${action}`,
      entityType: "jit-access-request",
      entityId: row.id,
      metadata: {
        requesterUserId: row.userId,
        accountId: row.accountId,
        pluginId: row.pluginId,
        scopeId: row.scopeId,
        roleId: row.roleId,
        principalId: row.principalId,
        via: actor.via,
        ...extra,
      },
    });
  } catch (err) {
    console.error(`[jit-access] audit ${action} for ${row.id} failed:`, err);
  }
}

export function grantSpec(row: JitRequestRow): JitGrantSpec {
  return {
    grantId: row.id,
    scopeId: row.scopeId,
    roleId: row.roleId,
    principal: {
      id: row.principalId,
      name: row.principalName,
      kind: row.principalKind === "group" ? "group" : "user",
    },
    expiresAt: row.grantExpiresAt ?? new Date(),
    reason: row.reason,
    ref: row.grantRef,
  };
}

/** The account's client, or a thrown error that says why there is none. */
export async function jitClient(organizationId: string, accountId: string): Promise<PluginClient> {
  const resolved = await getOrgAccountClient(accountId, organizationId);
  if (!resolved) {
    throw new Error(
      "The account this grant was made through is no longer connected, so it cannot be " +
        "changed from Infrawrench. Remove the access in the provider's console.",
    );
  }
  if (!resolved.plugin.manifest.jitAccess) {
    throw new Error("This account's provider no longer supports just-in-time access.");
  }
  return resolved.client;
}

/* ------------------------------------------------------------------ *
 * Granting.
 * ------------------------------------------------------------------ */

/**
 * Carry an approved (`granting`) request through to `active`.
 *
 * Called inline by the approval (on the gateway) and by the sweep for rows
 * whose inline attempt did not finish. The caller must hold the lease (the
 * row's `next_action_at` was pushed out when it was claimed).
 */
export async function executeGrant(row: JitRequestRow): Promise<JitRequestRow> {
  const now = new Date();
  let current = row;
  try {
    const client = await jitClient(row.organizationId, row.accountId);

    // Stage 1, exactly once: is the access already held by other means?
    if (!current.grantedAt) {
      const presence = (await client.checkJitAccess?.(grantSpec(current))) ?? "unknown";
      const grantedAt = new Date();
      const grantExpiresAt = new Date(grantedAt.getTime() + current.durationMinutes * 60_000);
      if (presence === "present") {
        const [done] = await db
          .update(jitAccessRequests)
          .set({
            status: "active",
            preexisting: true,
            grantedAt,
            grantExpiresAt,
            nextActionAt: grantExpiresAt,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(and(eq(jitAccessRequests.id, row.id), eq(jitAccessRequests.status, "granting")))
          .returning();
        if (done) {
          await auditJit(done, "grant_preexisting", SWEEP_ACTOR, {
            grantExpiresAt: grantExpiresAt.toISOString(),
          });
        }
        return done ?? current;
      }
      const [checked] = await db
        .update(jitAccessRequests)
        .set({ grantedAt, grantExpiresAt, updatedAt: new Date() })
        .where(and(eq(jitAccessRequests.id, row.id), eq(jitAccessRequests.status, "granting")))
        .returning();
      if (!checked) return current;
      current = checked;
    }

    // The window was recorded at stage 1; a retry after it lapsed revokes.
    if (current.grantExpiresAt && current.grantExpiresAt.getTime() <= now.getTime()) {
      return executeRevoke(current, "expired", SWEEP_ACTOR, { holdsLease: true });
    }

    // Stage 2: the idempotent grant.
    const result = await client.grantJitAccess!(grantSpec(current));
    const [active] = await db
      .update(jitAccessRequests)
      .set({
        status: "active",
        grantRef: result.ref ?? null,
        grantAttempts: current.grantAttempts + 1,
        nextActionAt: current.grantExpiresAt,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(and(eq(jitAccessRequests.id, row.id), eq(jitAccessRequests.status, "granting")))
      .returning();
    if (active) {
      await auditJit(active, "granted", SWEEP_ACTOR, {
        grantExpiresAt: active.grantExpiresAt?.toISOString() ?? null,
      });
    }
    return active ?? current;
  } catch (err) {
    return recordGrantFailure(current, err);
  }
}

async function recordGrantFailure(row: JitRequestRow, err: unknown): Promise<JitRequestRow> {
  const message = errorMessage(err);
  const attempts = row.grantAttempts + 1;
  console.error(
    `[jit-access] grant ${row.id} (${row.pluginId} ${row.roleName} on ${row.scopeName}) failed, ` +
      `attempt ${attempts}/${JIT_MAX_GRANT_ATTEMPTS}: ${message}`,
  );
  if (attempts < JIT_MAX_GRANT_ATTEMPTS) {
    const [retry] = await db
      .update(jitAccessRequests)
      .set({
        grantAttempts: attempts,
        lastError: message,
        nextActionAt: new Date(Date.now() + 60_000 * attempts),
        updatedAt: new Date(),
      })
      .where(and(eq(jitAccessRequests.id, row.id), eq(jitAccessRequests.status, "granting")))
      .returning();
    return retry ?? row;
  }
  // Out of attempts. A grant can fail half way (an assignment still being
  // provisioned when the call timed out), so the failure is followed by an
  // idempotent revoke rather than assumed to have left nothing behind.
  const [failed] = await db
    .update(jitAccessRequests)
    .set({
      grantAttempts: attempts,
      lastError: message,
      endReason: "grant_failed",
      updatedAt: new Date(),
    })
    .where(and(eq(jitAccessRequests.id, row.id), eq(jitAccessRequests.status, "granting")))
    .returning();
  if (!failed) return row;
  await auditJit(failed, "grant_failed", SWEEP_ACTOR, { error: message });
  return executeRevoke(failed, "grant_failed", SWEEP_ACTOR, { holdsLease: true });
}

/* ------------------------------------------------------------------ *
 * Revoking.
 * ------------------------------------------------------------------ */

/**
 * Statuses a revoke may start from. `revoking`, and `granting`, only once the
 * lease has run out, unless the caller is the worker holding it: revoking a
 * grant whose provider call is still in flight could run before that call
 * lands and leave the access behind.
 */
const REVOCABLE = ["active", "revoke_failed"] as const;

/**
 * End a grant upstream: claim, call the plugin, check, record.
 *
 * Never throws. A failure is a stored state (`revoke_failed`) with the error,
 * a backoff, an audit row and an alert, and the sweep keeps retrying it
 * forever: giving up on a revoke would be choosing to leave somebody with
 * access nobody approved.
 */
export async function executeRevoke(
  row: JitRequestRow,
  endReason: JitEndReason,
  actor: JitActor,
  opts: { holdsLease?: boolean } = {},
): Promise<JitRequestRow> {
  const now = new Date();
  const [claimed] = await db
    .update(jitAccessRequests)
    .set({
      status: "revoking",
      nextActionAt: new Date(now.getTime() + JIT_LEASE_MS),
      // The first reason wins: an expiry retried after a manual revoke is
      // still the manual revoke.
      endReason: row.endReason ?? endReason,
      ...(actor.userId && !row.endedByUserId
        ? { endedByUserId: actor.userId, endedByName: actor.name }
        : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(jitAccessRequests.id, row.id),
        or(
          inArray(jitAccessRequests.status, [...REVOCABLE]),
          and(eq(jitAccessRequests.status, "revoking"), lte(jitAccessRequests.nextActionAt, now)),
          opts.holdsLease
            ? eq(jitAccessRequests.status, "granting")
            : and(
                eq(jitAccessRequests.status, "granting"),
                lte(jitAccessRequests.nextActionAt, now),
              ),
        ),
      ),
    )
    .returning();
  if (!claimed) return row;

  try {
    if (!claimed.preexisting) {
      const client = await jitClient(claimed.organizationId, claimed.accountId);
      const spec = grantSpec(claimed);
      await client.revokeJitAccess!(spec);
      const after = (await client.checkJitAccess?.(spec)) ?? "unknown";
      if (after === "present") {
        throw new Error(
          "The provider still reports the grant after it was revoked. Remove it in the " +
            "provider's console; Infrawrench will keep retrying.",
        );
      }
    }
    const finalStatus = claimed.endReason === "grant_failed" ? "grant_failed" : "revoked";
    const [done] = await db
      .update(jitAccessRequests)
      .set({
        status: finalStatus,
        endedAt: new Date(),
        nextActionAt: null,
        lastError: finalStatus === "grant_failed" ? claimed.lastError : null,
        updatedAt: new Date(),
      })
      .where(and(eq(jitAccessRequests.id, row.id), eq(jitAccessRequests.status, "revoking")))
      .returning();
    const result = done ?? claimed;
    if (finalStatus === "revoked") {
      await auditJit(result, claimed.endReason === "expired" ? "expired" : "revoked", actor, {
        preexisting: claimed.preexisting,
        revokeAttempts: claimed.revokeAttempts + 1,
      });
    }
    return result;
  } catch (err) {
    return recordRevokeFailure(claimed, err, actor);
  }
}

async function recordRevokeFailure(
  row: JitRequestRow,
  err: unknown,
  actor: JitActor,
): Promise<JitRequestRow> {
  const message = errorMessage(err);
  const attempts = row.revokeAttempts + 1;
  const backoff = Math.min(MAX_REVOKE_BACKOFF_MS, 60_000 * 2 ** Math.min(attempts - 1, 10));
  console.error(
    `[jit-access] REVOKE FAILED for ${row.id} in org ${row.organizationId} ` +
      `(${row.pluginId} ${row.roleName} on ${row.scopeName} for ${row.principalName}), ` +
      `attempt ${attempts}: ${message}`,
  );
  const [failed] = await db
    .update(jitAccessRequests)
    .set({
      status: "revoke_failed",
      revokeAttempts: attempts,
      lastError: message,
      nextActionAt: new Date(Date.now() + backoff),
      updatedAt: new Date(),
    })
    .where(and(eq(jitAccessRequests.id, row.id), eq(jitAccessRequests.status, "revoking")))
    .returning();
  const result = failed ?? row;
  await auditJit(result, "revoke_failed", actor, { error: message, attempt: attempts });
  // Loud, but not every minute: the first failure, then roughly daily.
  if (attempts === 1 || attempts % 24 === 0) {
    await routeAlert({
      organizationId: row.organizationId,
      trigger: "postureAlerts",
      severity: "critical",
      title: "Just-in-time access could not be revoked",
      body:
        `${row.principalName} still holds ${row.roleName} on ${row.scopeName} ` +
        `(${row.accountName ?? row.accountId}) after the window ended. ` +
        `Infrawrench will keep retrying. Last error: ${message}`,
      pushBody: `${row.principalName} still holds ${row.roleName} on ${row.scopeName}.`,
      url: appPath(`/org/${row.organizationId}/jit-access`),
      pushData: { type: "posture_alert", orgId: row.organizationId },
      facts: { key: `jit:${row.id}` },
    }).catch((alertErr: unknown) => {
      console.error(`[jit-access] alerting about revoke failure ${row.id} failed:`, alertErr);
    });
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * The sweep.
 * ------------------------------------------------------------------ */

const SWEPT_STATUSES = ["pending", "granting", "active", "revoking", "revoke_failed"] as const;

export interface JitSweepStats {
  timedOut: number;
  granted: number;
  revoked: number;
  failed: number;
}

/**
 * One tick of the `jit-access-expiry` poller pass (gateway: it runs plugin
 * code for arbitrary accounts). Picks every row whose `next_action_at` is due
 * and moves it on: undecided requests time out, unfinished grants retry,
 * ended windows are revoked, failed revokes retry on their backoff.
 *
 * `onTimeout` is injected so the request module (which owns the Slack copy
 * and the requester notification) handles the one transition that needs them
 * without a circular import.
 */
export async function runJitAccessSweep(opts: {
  limit?: number;
  now?: Date;
  onTimeout: (row: JitRequestRow) => Promise<void>;
}): Promise<JitSweepStats> {
  const stats: JitSweepStats = { timedOut: 0, granted: 0, revoked: 0, failed: 0 };
  if (!pluginCodeAvailable()) return stats;
  const now = opts.now ?? new Date();
  const rows = await db
    .select()
    .from(jitAccessRequests)
    .where(
      and(
        inArray(jitAccessRequests.status, [...SWEPT_STATUSES]),
        isNotNull(jitAccessRequests.nextActionAt),
        lte(jitAccessRequests.nextActionAt, now),
      ),
    )
    .orderBy(asc(jitAccessRequests.nextActionAt))
    .limit(opts.limit ?? 50);

  for (const row of rows) {
    try {
      if (row.status === "pending") {
        if (row.requestExpiresAt.getTime() <= now.getTime()) {
          await opts.onTimeout(row);
          stats.timedOut++;
        }
        continue;
      }
      if (row.status === "granting") {
        // Re-claim the lease before touching the provider.
        const [claimed] = await db
          .update(jitAccessRequests)
          .set({ nextActionAt: new Date(now.getTime() + JIT_LEASE_MS), updatedAt: now })
          .where(
            and(
              eq(jitAccessRequests.id, row.id),
              eq(jitAccessRequests.status, "granting"),
              lte(jitAccessRequests.nextActionAt, now),
            ),
          )
          .returning();
        if (!claimed) continue;
        const after = await executeGrant(claimed);
        if (after.status === "active") stats.granted++;
        else if (after.status === "revoke_failed") stats.failed++;
        continue;
      }
      if (row.status === "active" && row.grantExpiresAt && row.grantExpiresAt > now) {
        // Extended since it was scheduled; reschedule rather than revoke.
        await db
          .update(jitAccessRequests)
          .set({ nextActionAt: row.grantExpiresAt })
          .where(and(eq(jitAccessRequests.id, row.id), eq(jitAccessRequests.status, "active")));
        continue;
      }
      const after = await executeRevoke(row, "expired", SWEEP_ACTOR);
      if (after.status === "revoked" || after.status === "grant_failed") stats.revoked++;
      else if (after.status === "revoke_failed") stats.failed++;
    } catch (err) {
      stats.failed++;
      console.error(`[jit-access] sweep could not process ${row.id}:`, err);
    }
  }
  return stats;
}
