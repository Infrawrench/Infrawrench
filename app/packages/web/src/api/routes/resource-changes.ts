import { Hono } from "hono";
import type { Context } from "hono";
import { desc, eq, and, gte, lte, sql } from "drizzle-orm";
import {
  getDriftAlertSettings,
  updateDriftAlertSettings,
  type DriftAlertSettings,
  type DriftAlertSettingsPatch,
} from "@infrawrench/server-core/drift/settings";
import { loadChangeCostImpacts } from "@infrawrench/server-core/cost/change-impact-load";
import {
  buildRevertPatch,
  MAX_CHANGE_IMPACT_BATCH,
  parseCostBasis,
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
  markRevertWriteAttempted,
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
 * POST /api/org/:orgId/changes/cost-impacts — what a page of changes did to
 * the run rate.
 *
 * A POST because it takes a list of ids: a feed page carries up to 50 and a
 * query string of composite resource-change ids is neither readable nor safely
 * within URL length limits. It reads nothing and writes nothing, and is
 * recomputed on every call so that late-arriving and restated provider cost
 * keeps moving the answer — see `cost/change-impact-load.ts`.
 *
 * `costs:read` **and** `resources:read`: the response is money, but it is money
 * keyed to specific resources and their change history.
 */
app.post("/cost-impacts", async (c) => {
  requirePermission(c, "costs:read");
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");

  const body: Record<string, unknown> = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}));
  const rawIds = body["changeIds"];
  if (!Array.isArray(rawIds) || rawIds.some((v) => typeof v !== "string")) {
    return c.json({ error: "changeIds must be an array of change ids" }, 400);
  }
  if (rawIds.length > MAX_CHANGE_IMPACT_BATCH) {
    return c.json({ error: `At most ${MAX_CHANGE_IMPACT_BATCH} changeIds per request` }, 400);
  }
  const basis = parseCostBasis(body["costBasis"]);
  if (basis === null) return c.json({ error: "costBasis must be cash or amortized" }, 400);

  const impacts = await loadChangeCostImpacts(organizationId, rawIds as string[], {
    ...(typeof body["windowDays"] === "number" ? { windowDays: body["windowDays"] } : {}),
    costBasis: basis,
  });
  return c.json({ impacts });
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
 * ## Three pieces of state, each with one job
 *
 * - `revert_claimed_at` + `revert_claim_owner` — a **lock**, leased so a dead
 *   holder cannot hold it forever, fenced so a superseded holder cannot release
 *   somebody else's. It says who may act. It says nothing about what happened.
 * - `revert_write_attempted_at` — a **journal**, written immediately before the
 *   provider call. It says a write was issued and its outcome is unknown.
 * - `reverted_at` — the **fact**, written only once the provider accepted.
 *
 * Keeping these three apart is the whole design, and it was arrived at the hard
 * way: two earlier versions used the claim as its own journal, inferring "an
 * earlier attempt may have written" from "a claim is still outstanding". That
 * inference is unsound — a claim outlives an attempt that died *before* writing
 * exactly as readily as one that died after — and it failed in both directions
 * at once, wedging events behind a lease each retry renewed while also letting
 * an unrelated hand-edit be recorded as somebody's revert. A lock cannot double
 * as a journal. With the journal explicit, **every exit releases the claim
 * unconditionally** and nothing is lost by doing so.
 *
 * ## Every way an attempt can end
 *
 * | # | Provider write | Recorded | Response | Row afterwards | Recovers by |
 * |---|---|---|---|---|---|
 * | 1 | not reached (404/409/423, claim lost) | — | 404/409/423 | untouched | n/a |
 * | 1b | not reached (claim lost while planning) | — | 409 | replacement's claim | the replacement |
 * | 2 | not reached (plan failed, no client) | — | 502/404 | claim released | retry |
 * | 3 | not reached (nothing writable / conflict) | — | 409 | claim released | n/a — correct |
 * | 4 | not reached (journal says an earlier one wrote) | yes, as `reconciled` | 200 | reverted | n/a |
 * | 4b | not reached (as row 4) | no — DB threw | 500 | claim released, journal kept | retry → row 4 |
 * | 5 | threw | — | 400 | claim released, **journal kept** | retry → row 4 or a normal revert |
 * | 6 | ok | yes | 200 | reverted | n/a |
 * | 7 | ok | no — superseded | 409 | replacement's claim | the replacement |
 * | 8 | ok | no — DB threw | 500 | claim released, journal kept | retry → row 4 |
 * | 9 | ok | never attempted (process died) | — | claim expires, journal kept | lease expiry → row 4 |
 *
 * Rows 4, 5, 8 and 9 are one loop and the reason this handler is not simply
 * "write, then record". A write that lands and is not recorded would otherwise
 * leave the feed disagreeing with the provider *permanently*: the retry finds
 * nothing to do and walks away. Instead a retry that finds every field already
 * back, on an event whose **journal** says a write was issued, completes it —
 * `revertLooksAlreadyApplied` in client-core carries that judgement.
 *
 * Row 5 is now inside that loop rather than a named residual: a provider that
 * errors *after* applying is indistinguishable from one that errors instead of
 * applying, so the journal survives the throw and the next attempt can notice.
 *
 * **The invariant that binds the whole table: no provider write without a
 * journal entry that survives it.** Which makes the journal's row count a
 * decision, not a formality — row 1b is that decision. Journalling and writing
 * are fenced on the same claim and succeed or fail together, so an attempt
 * whose planning outlived the lease stops rather than issuing a write nothing
 * would ever be able to reconcile. Of the fenced writes here, only
 * `releaseRevert` discards its row count, and only because zero rows there
 * ("someone else owns it" / "it already completed") has no recovery action;
 * that is argued at its definition rather than assumed.
 *
 * The residual that remains, named rather than hidden: a process dying between
 * the journal write and the provider call leaves a journal entry for a write
 * that was never issued. If somebody then returns the field to its old value by
 * hand, the next revert attempt reconciles and records it. The window is two
 * statements wide, it requires a hand-edit that exactly matches a pending
 * revert, and the audit entry says `reconciled` — "recorded an earlier
 * attempt's write" — rather than claiming this user made the change. Closing it
 * needs a confirmation the provider cannot give us.
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
   * Did an earlier attempt at *this* event get as far as issuing a provider
   * write? A recorded fact (`revert_write_attempted_at`), never inferred from
   * the claim — see {@link markRevertWriteAttempted} for why that distinction
   * is load-bearing.
   */
  const earlierWriteAttempted = change.revertWriteAttemptedAt !== null;

  const result = await buildRevertPlan(organizationId, change);
  if (!result.ok) {
    await releaseRevert(organizationId, change.id, owner);
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
    // attempt journalled a provider write for this event and every field is now
    // back at its old value, that attempt wrote and never got to say so.
    // Recording it here is what stops the feed disagreeing with the provider
    // forever, and the journal is what keeps it from also firing on a resource
    // somebody put back by hand.
    if (revertLooksAlreadyApplied(plan, earlierWriteAttempted)) {
      const reconciledAt = new Date();
      let recorded: boolean;
      try {
        recorded = await completeRevert(organizationId, change.id, owner, reconciledAt);
      } catch (err) {
        // Recording failed. The claim goes back like any other failed exit —
        // the journal, not the claim, is what brings the next attempt back down
        // this path, so there is nothing here that letting go destroys.
        console.error("[change-revert] Failed to record a reconciled revert:", err);
        await releaseRevert(organizationId, change.id, owner);
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
      // were planning. It holds the claim and will reconcile; the release below
      // is a no-op for us anyway, since release is owner-fenced.
    }
    // Always released, including on the conflict exit. The claim is a lock and
    // nothing more, so an event can never be left wedged behind a lease that
    // each retry renews.
    await releaseRevert(organizationId, change.id, owner);
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
    await releaseRevert(organizationId, change.id, owner);
    return c.json({ error: "The account this change belongs to no longer exists" }, 404);
  }

  // Journal the intent before the call, so that whatever happens next — a
  // throw, a timeout, this process disappearing — the fact that a write was
  // *issued* for this event survives. This is the state that makes the claim a
  // pure lock and lets every failure path release it.
  //
  // Journalling and writing succeed or fail together. The journal is fenced on
  // the claim, so a zero-row result means planning outlived the lease and
  // another attempt owns the event; going on to write anyway would produce
  // precisely the unjournalled provider mutation this column exists to prevent,
  // *and* a second concurrent write while holding positive evidence the lock
  // was lost. The replacement holds the claim and will plan and write itself,
  // so nothing is dropped by stopping here — only duplicated by not.
  const journalled = await markRevertWriteAttempted(organizationId, change.id, owner, new Date());
  if (!journalled) {
    // Nothing written, so nothing to audit and nothing to release (release is
    // owner-fenced and this attempt is no longer the owner).
    return c.json(
      {
        error:
          "Another revert of this change took over while this one was being planned, so it was " +
          "not applied. Re-check the resource before retrying.",
        code: REVERT_CONFLICT_CODE,
      },
      409,
    );
  }

  try {
    await client.updateResource(change.resourceTypeId, change.resourceId, change.accountId, patch);
  } catch (err) {
    // Row 5. The claim goes back and the caller can retry at once. The journal
    // deliberately stays: a provider that errors *after* applying is
    // indistinguishable from one that errors instead of applying, so the next
    // attempt is left able to notice the fields already back and reconcile,
    // rather than the event being stranded un-reverted forever.
    await releaseRevert(organizationId, change.id, owner);
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
    // Row 8. The provider moved and we cannot say so. The claim goes back like
    // any other failure — what carries this forward is the journal written
    // before the call, which is still set, so the next attempt sees the fields
    // already back and reconciles (row 4). The event is retryable at once
    // rather than after the lease expires.
    console.error("[change-revert] Provider write landed but could not be recorded:", err);
    await releaseRevert(organizationId, change.id, owner);
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
