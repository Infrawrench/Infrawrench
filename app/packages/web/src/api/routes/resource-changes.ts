import { Hono } from "hono";
import type { Context } from "hono";
import { desc, eq, and, gte, lte, sql } from "drizzle-orm";
import {
  getDriftAlertSettings,
  updateDriftAlertSettings,
  type DriftAlertSettings,
  type DriftAlertSettingsPatch,
} from "@infrawrench/server-core/drift/settings";
import {
  buildRevertPatch,
  revertLooksAlreadyApplied,
  REVERT_CONFLICT_CODE,
  type RevertAuditOutcome,
} from "@infrawrench/client-core";
import { db } from "../../db/client";
import { resourceChanges, accounts } from "../../db/schema";
import { requirePermission } from "../../auth/permissions";
import { checkChangeFreeze } from "../../services/change-freezes";
import { logAudit } from "../../services/audit";
import {
  buildRevertPlan,
  claimRevert,
  completeRevert,
  loadChange,
  releaseRevert,
} from "../../services/change-revert";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

const CHANGE_KINDS = new Set(["created", "updated", "deleted"]);

/**
 * GET /api/org/:orgId/changes — org-wide change feed (paginated, filterable
 * by account, resource, change kind, and time range).
 */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");

  const page = Math.max(parseInt(c.req.query("page") ?? "1", 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(c.req.query("pageSize") ?? "50", 10) || 50, 1), 200);
  const accountId = c.req.query("accountId");
  const resourceId = c.req.query("resourceId");
  const kind = c.req.query("kind");
  const from = c.req.query("from");
  const to = c.req.query("to");

  if (kind && !CHANGE_KINDS.has(kind)) {
    return c.json({ error: `Unknown change kind "${kind}"` }, 400);
  }

  const conditions = [eq(resourceChanges.organizationId, organizationId)];
  if (accountId) conditions.push(eq(resourceChanges.accountId, accountId));
  if (resourceId) conditions.push(eq(resourceChanges.resourceId, resourceId));
  if (kind) conditions.push(eq(resourceChanges.changeKind, kind as "created")); // narrowed above
  if (from) conditions.push(gte(resourceChanges.createdAt, new Date(from)));
  if (to) conditions.push(lte(resourceChanges.createdAt, new Date(to)));

  const where = and(...conditions);

  // Independent read-only queries — race them so the page costs max(count, rows)
  // instead of the sum.
  const [countRows, entries] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(resourceChanges)
      .where(where),
    db
      .select({
        id: resourceChanges.id,
        resourceId: resourceChanges.resourceId,
        accountId: resourceChanges.accountId,
        pluginId: resourceChanges.pluginId,
        resourceTypeId: resourceChanges.resourceTypeId,
        displayName: resourceChanges.displayName,
        changeKind: resourceChanges.changeKind,
        diff: resourceChanges.diff,
        origin: resourceChanges.origin,
        createdAt: resourceChanges.createdAt,
        revertedAt: resourceChanges.revertedAt,
        accountName: accounts.displayName,
      })
      .from(resourceChanges)
      .leftJoin(accounts, eq(resourceChanges.accountId, accounts.id))
      .where(where)
      .orderBy(desc(resourceChanges.createdAt), desc(resourceChanges.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
  ]);
  const countResult = countRows[0];

  return c.json({ entries, total: countResult?.count ?? 0 });
});

/* ------------------------ drift alert settings ------------------------ *
 *
 * Registered before `/resource` only for readability; Hono matches on the
 * literal path either way. `org:settings:write` rather than `resources:read`:
 * these decide who the org's channels and phones hear from, which is the same
 * trust level as the Slack/Teams/digest settings next to them.
 */

function toWire(s: DriftAlertSettings) {
  return {
    notifyCreated: s.notifyCreated,
    notifyUpdated: s.notifyUpdated,
    notifyDeleted: s.notifyDeleted,
    cooldownMinutes: s.cooldownMinutes,
    minChanges: s.minChanges,
    accountIds: s.accountIds,
    lastNotifiedAt: s.lastNotifiedAt ? s.lastNotifiedAt.toISOString() : null,
  };
}

/** The org's drift alert filter; an org that never saved reads the defaults. */
app.get("/alert-settings", async (c) => {
  requirePermission(c, "org:settings:write");
  return c.json(toWire(await getDriftAlertSettings(c.get("organizationId"))));
});

/**
 * Update the drift alert filter. Every field is optional so a single toggle can
 * be saved on its own. Bounds live in server-core so the API and the poller
 * cannot disagree about what a valid cooldown is.
 */
app.put("/alert-settings", async (c) => {
  requirePermission(c, "org:settings:write");
  const body = await c.req.json<Record<string, unknown>>();
  const patch: DriftAlertSettingsPatch = {};

  for (const key of ["notifyCreated", "notifyUpdated", "notifyDeleted"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") return c.json({ error: `${key} must be a boolean` }, 400);
    patch[key] = value;
  }
  for (const key of ["cooldownMinutes", "minChanges"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "number") return c.json({ error: `${key} must be a number` }, 400);
    patch[key] = value;
  }
  if (body["accountIds"] !== undefined) {
    const value = body["accountIds"];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      return c.json({ error: "accountIds must be an array of account ids" }, 400);
    }
    patch.accountIds = value as string[];
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "No settings supplied" }, 400);
  }

  try {
    return c.json(toWire(await updateDriftAlertSettings(c.get("organizationId"), patch)));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save drift alert settings";
    return c.json({ error: message }, 400);
  }
});

/**
 * GET /api/org/:orgId/changes/resource?resourceId=… — recent changes for one
 * resource. `resourceId` is a query param because composite resource ids
 * contain slashes and colons that don't survive as path segments.
 */
app.get("/resource", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");

  const resourceId = c.req.query("resourceId");
  if (!resourceId) return c.json({ error: "resourceId is required" }, 400);
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);

  const entries = await db
    .select({
      id: resourceChanges.id,
      resourceId: resourceChanges.resourceId,
      accountId: resourceChanges.accountId,
      pluginId: resourceChanges.pluginId,
      resourceTypeId: resourceChanges.resourceTypeId,
      displayName: resourceChanges.displayName,
      changeKind: resourceChanges.changeKind,
      diff: resourceChanges.diff,
      origin: resourceChanges.origin,
      createdAt: resourceChanges.createdAt,
      revertedAt: resourceChanges.revertedAt,
    })
    .from(resourceChanges)
    .where(
      and(
        eq(resourceChanges.organizationId, organizationId),
        eq(resourceChanges.resourceId, resourceId),
      ),
    )
    .orderBy(desc(resourceChanges.createdAt), desc(resourceChanges.id))
    .limit(limit);

  return c.json({ entries });
});

/* ----------------------------- revert -------------------------------- *
 *
 * GET  /changes/:changeId/revert — the dry run
 * POST /changes/:changeId/revert — apply it
 *
 * Same path, and the verb carries the whole difference: the plan is computed
 * identically either way, the POST just rebuilds it against a fresher read and
 * then writes. That re-read is a last-moment check rather than an atomic
 * compare-and-swap — `buildRevertPlan` in `services/change-revert.ts` documents
 * the window it leaves and why the plugin contract can't close it.
 */

function revertFailureResponse(c: Context, failure: { kind: string; message?: string }) {
  if (failure.kind === "account-not-found") {
    return c.json({ error: "The account this change belongs to no longer exists" }, 404);
  }
  return c.json(
    {
      error: `Couldn't read the resource's current state, so a revert can't be planned safely — ${failure.message ?? "unknown error"}`,
    },
    502,
  );
}

/**
 * What a revert of this event would do, field by field, against the resource as
 * it is right now. Read-only: it touches the provider (to read) and nothing
 * else.
 *
 * `resources:write` rather than `resources:read` — the plan names the write it
 * is offering to make, and it costs a live provider call, so it is gated with
 * the action it previews rather than with the feed it reads from.
 */
app.get("/:changeId/revert", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const changeId = c.req.param("changeId");

  const change = await loadChange(organizationId, changeId);
  if (!change) return c.json({ error: "Change not found" }, 404);

  const result = await buildRevertPlan(organizationId, change);
  if (!result.ok) return revertFailureResponse(c, result.failure);

  return c.json({
    changeId: change.id,
    resourceId: change.resourceId,
    displayName: change.displayName,
    pluginId: change.pluginId,
    resourceTypeId: change.resourceTypeId,
    accountId: change.accountId,
    plan: result.result.plan,
    revertedAt: change.revertedAt ? change.revertedAt.toISOString() : null,
  });
});

/**
 * Put the resource back, through the plugin's ordinary update path.
 *
 * Order matters and is the point of the handler:
 *
 * 1. permission, then the change freeze — a revert is a provider mutation like
 *    any other, so it goes through the same gate a delete or a resize does;
 * 2. claim the event under a lease, which settles a race between two reverts of
 *    the same event before either can reach the provider;
 * 3. rebuild the plan against a *fresh* live read — anything that moved since
 *    the preview is now a conflict and drops out of the patch;
 * 4. write **through the client that read**, so nothing (least of all a
 *    credential decrypt and a client rebuild) sits between the read and the
 *    write. The remaining gap is one provider round-trip and is documented on
 *    `buildRevertPlan`; it is a narrow window, not an absence of one.
 * 5. record completion, releasing the claim on any failure so the attempt is
 *    retryable at once rather than at lease expiry.
 *
 * ## Every way an attempt can end
 *
 * The claim, the provider write and the completion each have their own failure
 * mode, so the terminal states are worth writing down rather than reasoning
 * about one at a time. `claim` below is the row's `revert_claimed_at` /
 * `revert_claim_owner` pair.
 *
 * | # | Provider write | Recorded | Response | Row afterwards | Recovers by |
 * |---|---|---|---|---|---|
 * | 1 | not reached (404/409/423, claim lost) | — | 404/409/423 | untouched | n/a |
 * | 2 | not reached (plan failed, no client) | — | 502/404 | claim released | retry |
 * | 3 | not reached (nothing writable) | — | 409 | claim released | n/a — correct |
 * | 4 | not reached (already applied earlier) | yes, as `reconciled` | 200 | reverted | n/a |
 * | 4b | not reached (as row 4) | no — DB threw | 500 | **claim kept** | lease expiry → row 4 |
 * | 5 | threw | — | 400 | claim released* | retry |
 * | 6 | ok | yes | 200 | reverted | n/a |
 * | 7 | ok | no — superseded | 409 | replacement's claim | the replacement |
 * | 8 | ok | no — DB threw | 500 | **claim kept** | lease expiry → row 4 |
 * | 9 | ok | never attempted (process died) | — | claim expires | lease expiry → row 4 |
 *
 * Rows 4, 8 and 9 are one loop and the reason this handler is not simply
 * "write, then record". A write that lands and is not recorded leaves the feed
 * disagreeing with the provider *permanently* — the retry finds nothing to do
 * and, before this, released the claim and walked away. So a retry that finds
 * every field already back, on an event whose claim was still lying around,
 * completes it instead: `revertLooksAlreadyApplied` in client-core carries that
 * judgement and explains how it avoids mistaking a hand-edit for a revert.
 *
 * **The general rule the starred exits follow**: `revert_claimed_at` is the
 * only evidence that an earlier attempt may have written without recording, so
 * no exit may clear a claim it inherited and did not resolve. That is why rows
 * 4b and 8 hold it, and why every other release goes through
 * {@link releaseIfSafe} rather than releasing unconditionally — row 2 and row 5
 * would otherwise destroy an inherited claim on their way past. The cost is
 * five minutes of not being retryable, against a permanent disagreement.
 *
 * *Row 5's residual, named rather than hidden: a provider that errors *after*
 * applying is treated as not having applied, because that is what throwing
 * means in the plugin contract. On a first attempt (nothing inherited) the
 * claim is released, so a later retry sees the fields already back with no
 * claim to reconcile from and reports "already back at its previous value" —
 * accurate about the resource, but the event keeps no revert badge. Holding the
 * claim on every failed revert would close that at the price of a five-minute
 * lockout after every bad input, which is the common case and this is not.
 *
 * Every row that reached the provider is audit-logged whatever happened next —
 * see {@link auditOutcome}, including why attribution is best-effort.
 *
 * The stored `resources` snapshot is deliberately left alone (unlike
 * `POST /api/resources/update`), so the next poll sees the difference and
 * records the revert as an ordinary change event.
 */
app.post("/:changeId/revert", async (c) => {
  requirePermission(c, "resources:write");
  const organizationId = c.get("organizationId");
  const userId = (c.get("session") as { userId?: string } | undefined)?.userId;
  const changeId = c.req.param("changeId");

  const change = await loadChange(organizationId, changeId);
  if (!change) return c.json({ error: "Change not found" }, 404);
  if (change.revertedAt) {
    return c.json(
      { error: "This change has already been reverted.", code: REVERT_CONFLICT_CODE },
      409,
    );
  }

  const frozen = await checkChangeFreeze(c, {
    action: "resource.change_revert",
    entityType: "resource",
    entityId: change.resourceId,
    metadata: {
      pluginId: change.pluginId,
      resourceTypeId: change.resourceTypeId,
      changeId: change.id,
    },
  });
  if (frozen) return frozen;

  // The claim's owner token. Every write that ends this revert is fenced on it,
  // so if the lease lapses mid-request and another attempt takes the event over,
  // this one can neither release nor complete the replacement's claim.
  const owner = await claimRevert(organizationId, change.id, userId, new Date());
  if (!owner) {
    return c.json(
      {
        error: "Another revert of this change is already in flight or has completed.",
        code: REVERT_CONFLICT_CODE,
      },
      409,
    );
  }

  /**
   * Did this attempt inherit an unresolved earlier one?
   *
   * A claim outlives its holder only when that holder reached neither of its
   * exits, so a claim still lying on the row at load time means "somebody was
   * mid-revert and never recorded an outcome" — and until we know otherwise,
   * that outcome might have been a provider write. `revert_claimed_at` is the
   * only trace of it, so while it is unresolved this attempt must not clear it.
   */
  const inheritedUnresolvedAttempt = change.revertClaimedAt !== null;

  /**
   * Release the claim, unless releasing would destroy the evidence some later
   * attempt needs to reconcile.
   *
   * Releasing normally is what makes an ordinary failure retryable at once
   * rather than at lease expiry, and that is worth having. But every
   * reconciliation depends on `revert_claimed_at` still being set (see
   * `revertLooksAlreadyApplied`), so an attempt that inherited an unresolved
   * claim and did not resolve it hands the claim back by *lease expiry* instead
   * — five minutes of not being retryable, against a permanent disagreement
   * between the feed and the provider. The same trade row 8 makes.
   */
  const releaseIfSafe = async () => {
    if (inheritedUnresolvedAttempt) return;
    await releaseRevert(organizationId, change.id, owner);
  };

  const result = await buildRevertPlan(organizationId, change);
  if (!result.ok) {
    await releaseIfSafe();
    return revertFailureResponse(c, result.failure);
  }
  const { plan, client } = result.result;

  /**
   * One `resource.change_revert` entry per attempt that did something worth
   * recording, tagged with which of the four endings it was.
   *
   * **Awaited, against the repo's convention.** 168 of the 181 `logAudit` call
   * sites in this package are fire-and-forget `void`, and rightly so: almost
   * all of them record a change to Infrawrench's own database, which either
   * committed in the same request or did not happen at all. This one records an
   * irreversible mutation to somebody else's cloud infrastructure, and the
   * process ending between the provider accepting it and the insert landing
   * would leave that mutation with no actor against it. Awaiting costs one
   * insert on a route that has just made a provider round-trip.
   *
   * **Attribution here is best-effort, and that is a property of the problem
   * rather than of this code.** There is no transaction spanning a third-party
   * cloud API and our Postgres, so between "the provider accepted the write"
   * and "the audit row committed" there is a gap nothing at this layer can
   * close: a process that dies inside it leaves a real mutation unattributed,
   * and failing the response would not bring the attribution back — it would
   * only change what the caller is told about a change that already happened.
   * Guaranteeing it needs a durable outbox (a row written in the same
   * transaction as the claim, drained by the poller), which is a platform-level
   * design and not something to bolt onto one route.
   *
   * What is done instead is to make the gap **loud and recoverable** rather
   * than silent: the failure is logged at error level with the actor, the event
   * and the fields written — so the trail exists in the application log even
   * when the audit table refused it — and reported to the caller as
   * `auditRecorded: false` rather than quietly dropped.
   */
  const auditOutcome = async (
    outcome: RevertAuditOutcome,
    fieldKeys: string[],
  ): Promise<boolean> => {
    const recorded = await logAudit({
      organizationId,
      userId,
      action: "resource.change_revert",
      entityType: "resource",
      entityId: change.resourceId,
      metadata: {
        changeId: change.id,
        pluginId: change.pluginId,
        resourceTypeId: change.resourceTypeId,
        // Keys only, like `resource.update` — a reverted value can be anything
        // the plugin declared, and the audit table is not the place for it.
        fieldKeys,
        changeRecordedAt: change.createdAt.toISOString(),
        outcome,
      },
    });
    if (!recorded) {
      // The audit table would not take it. Say everything the row would have
      // said, here, where it is at least durable in the log shipper.
      console.error(
        "[change-revert] AUDIT GAP: provider mutation not attributable in the audit table.",
        JSON.stringify({
          organizationId,
          userId: userId ?? null,
          action: "resource.change_revert",
          resourceId: change.resourceId,
          changeId: change.id,
          pluginId: change.pluginId,
          resourceTypeId: change.resourceTypeId,
          fieldKeys,
          outcome,
          at: new Date().toISOString(),
        }),
      );
    }
    return recorded;
  };

  const patch = buildRevertPatch(plan);
  if (Object.keys(patch).length === 0) {
    // Row 4 of the lifecycle table. Nothing to write — but if an earlier
    // attempt's claim was still lying on this row when we took it over, and
    // every field is now back at its old value, then that attempt wrote and
    // never got to say so. Recording it here is what stops the feed disagreeing
    // with the provider forever. `revertLooksAlreadyApplied` is what keeps this
    // from also firing on a resource somebody put back by hand.
    if (revertLooksAlreadyApplied(plan, inheritedUnresolvedAttempt)) {
      const reconciledAt = new Date();
      let recorded: boolean;
      try {
        recorded = await completeRevert(organizationId, change.id, owner, reconciledAt);
      } catch (err) {
        // Row 8's rule, one branch over — and the branch where it bites
        // hardest. The claim this attempt is holding *is* the evidence that
        // brought it down this path; releasing it here would mean no later
        // attempt ever recognises the interrupted write, and the event stays
        // un-reverted forever while the provider stays reverted. So: no
        // release, and the lease expiry hands it to the next attempt intact.
        console.error("[change-revert] Failed to record a reconciled revert:", err);
        return c.json(
          {
            error:
              "This change was already applied to the provider by an earlier attempt, but " +
              "recording that against the event failed. The resource is correct; the timeline " +
              "will catch up when the revert is retried.",
          },
          500,
        );
      }
      if (recorded) {
        // No provider call was made by this request, and the audit entry says
        // so — `reconciled` is not folded into `recorded` precisely so nobody
        // reads this as "this user resized the machine".
        const audited = await auditOutcome("reconciled", []);
        return c.json({
          changeId: change.id,
          resourceId: change.resourceId,
          appliedFields: [],
          plan,
          revertedAt: reconciledAt.toISOString(),
          reconciled: true,
          ...(audited ? {} : { auditRecorded: false }),
        });
      }
      // `recorded === false` means another attempt took the event over while we
      // were planning. It holds the claim and will reconcile; `releaseIfSafe`
      // below is a no-op for us anyway, since release is owner-fenced.
    }
    await releaseIfSafe();
    return c.json(
      {
        error: plan.blockedReason ?? "Nothing about this change can be reverted.",
        plan,
      },
      409,
    );
  }

  // The client that performed the live read, reused rather than rebuilt: a
  // second `getClientForAccount` here would decrypt credentials and run
  // credential rewriters *between* the read and the write, widening the window
  // for exactly the lost update the re-read is trying to catch.
  if (!client?.updateResource) {
    await releaseIfSafe();
    return c.json({ error: "The account this change belongs to no longer exists" }, 404);
  }

  try {
    await client.updateResource(change.resourceTypeId, change.resourceId, change.accountId, patch);
  } catch (err) {
    // Row 5. A throw is taken to mean the write did not apply, which is what
    // throwing means in the plugin contract, so the claim goes back and the
    // caller can retry at once. The residual is named in the table above: a
    // provider that errors *after* applying leaves the event un-reverted with
    // nothing to reconcile from. Holding the claim on every failed revert would
    // close it, at the price of a five-minute lockout after every bad input —
    // which is the common case, and this is not.
    await releaseIfSafe();
    const message = err instanceof Error ? err.message : "The revert failed";
    return c.json({ error: message }, 400);
  }

  // The write landed. From here every exit audits, because the mutation is now
  // a fact about somebody's infrastructure regardless of what the database does
  // next — losing a lease race, or losing the database, is not a reason for the
  // actor to vanish from the record.
  const revertedAt = new Date();
  let completed: boolean;
  try {
    completed = await completeRevert(organizationId, change.id, owner, revertedAt);
  } catch (err) {
    // Row 8. The provider moved and we cannot say so. The claim is deliberately
    // *not* released: it is the only evidence that a write may have gone
    // unrecorded, and the retry after lease expiry reads it to reconcile (row
    // 4). Releasing here would trade a five-minute wait for a permanent
    // disagreement between the feed and the provider.
    console.error("[change-revert] Provider write landed but could not be recorded:", err);
    const audited = await auditOutcome("unrecorded", plan.revertibleFields);
    return c.json(
      {
        error:
          "The revert was applied to the provider, but recording it against this change failed. " +
          "The resource has been put back; the timeline will catch up when the revert is retried.",
        appliedFields: plan.revertibleFields,
        ...(audited ? {} : { auditRecorded: false }),
      },
      500,
    );
  }

  // One entry per attempt that wrote, never two per attempt: `outcome` is what
  // keeps a superseded pair from reading as two independent reverts. A
  // `superseded` entry means "this actor's write reached the provider, but
  // another attempt owns the event's recorded state" — and the attempt that
  // took over logs its own `recorded` entry only if it, too, wrote something
  // (if this write got there first, its re-read plans `already-reverted` for
  // every field, so it writes nothing and reconciles instead).
  const audited = await auditOutcome(completed ? "recorded" : "superseded", plan.revertibleFields);

  if (!completed) {
    // This request outlived its lease and another attempt took the event over
    // while the provider call was in flight. The write landed, but the outcome
    // belongs to whoever holds the claim now — saying "reverted" here would
    // overwrite their claim, and saying nothing at all would be a lie about a
    // write that did happen. Report both halves and let the caller re-read.
    return c.json(
      {
        error:
          "The revert was applied to the provider, but this attempt ran longer than its lease and " +
          "another revert of the same change took over in the meantime, so it isn't recorded " +
          "against this event. Re-check the resource before retrying.",
        code: REVERT_CONFLICT_CODE,
        appliedFields: plan.revertibleFields,
        ...(audited ? {} : { auditRecorded: false }),
      },
      409,
    );
  }

  return c.json({
    changeId: change.id,
    resourceId: change.resourceId,
    appliedFields: plan.revertibleFields,
    plan,
    revertedAt: revertedAt.toISOString(),
    ...(audited ? {} : { auditRecorded: false }),
  });
});

export { app as resourceChangeRoutes };
