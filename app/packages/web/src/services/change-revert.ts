import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { isFieldEditable } from "@infrawrench/plugin-base";
import type { PluginClient, ResourceInstance } from "@infrawrench/plugin-base";
import { computeRevertPlan, type RevertPlan } from "@infrawrench/client-core";
import { db } from "@/db/client";
import { resourceChanges } from "@/db/schema";
import { getClientForAccount } from "./plugin-clients";

/**
 * Time-travel undo for the change timeline.
 *
 * The drift feed records what every field was before and after a change; this
 * turns one of those events back into a write. Three rules shape the whole
 * thing:
 *
 * 1. **The writable surface is the plugin's, not ours.** Whether a field can be
 *    put back is `isFieldEditable` over the resource type's declared fields —
 *    the exact predicate the Edit form filters with. A field the user can't
 *    edit by hand is not revertible either, so no provider call is ever
 *    invented for a plugin that never declared one.
 * 2. **The plan is rebuilt against a live read immediately before the write.**
 *    The dry run reads live fields to build the preview; the apply reads them
 *    *again* and rebuilds the plan from scratch, then writes through the client
 *    it already holds. A field that moved between the two reads comes back as a
 *    conflict and drops out of the patch.
 *
 *    This is a **last-moment re-read, not an atomic compare-and-swap** — see
 *    {@link buildRevertPlan} for exactly how wide the remaining window is and
 *    why it cannot be closed here.
 * 3. **The event is claimed under a lease, and the lease has an owner.** A
 *    conditional `UPDATE ... WHERE reverted_at IS NULL AND (revert_claimed_at IS
 *    NULL OR revert_claimed_at < now - lease)` decides which of two concurrent
 *    reverts gets to touch the provider, and every write that *ends* a revert is
 *    fenced on the token that claim minted. See {@link claimRevert} for why the
 *    claim and the completion are two different columns, and for what the lease
 *    does and does not promise.
 *
 * What this file deliberately does *not* do is mirror the new values into the
 * `resources` row the way `POST /api/resources/update` does. That mirror exists
 * so an interactive edit shows up immediately; here it would erase the very
 * drift the next poll is supposed to notice. Leaving the stored snapshot alone
 * means the poller diffs it against the reverted live state and records the
 * revert as an ordinary `updated` event — the undo shows up in the timeline by
 * the normal mechanism rather than by a special case.
 */

/**
 * How long a claimed event stays invisible to another revert before it can be
 * taken over.
 *
 * Generous relative to the work (one provider update call), on the same
 * reasoning as `CLAIM_LEASE_MS` in `server-core/src/alerts/pass.ts`: a lease
 * that is too short risks a second attempt while the first is still in flight,
 * and one that is too long only delays a retry after a crash.
 */
export const REVERT_CLAIM_LEASE_MS = 5 * 60_000;

export interface ChangeRow {
  id: string;
  organizationId: string;
  accountId: string;
  resourceId: string;
  pluginId: string;
  resourceTypeId: string;
  displayName: string;
  changeKind: "created" | "updated" | "deleted";
  diff: { field: string; from: unknown; to: unknown }[];
  createdAt: Date;
  revertedAt: Date | null;
  revertClaimedAt: Date | null;
  revertClaimOwner: string | null;
  revertWriteAttemptedAt: Date | null;
}

/** Failure modes the routes turn into status codes. */
export type RevertFailure =
  | { kind: "change-not-found" }
  | { kind: "account-not-found" }
  | { kind: "resource-unreadable"; message: string };

/**
 * A successful plan, plus the plugin client the live read came from.
 *
 * The client is handed back rather than looked up again on purpose: rebuilding
 * it means decrypting the account's credentials, running credential rewriters
 * and constructing host services, all of which would sit *between* the live
 * read and the provider write and widen the window described on
 * {@link buildRevertPlan}. `client` is null only when the plan was refused
 * before the provider was ever contacted.
 */
export interface RevertPlanResult {
  plan: RevertPlan;
  client: PluginClient | null;
}

/** One change event, scoped to the org. */
export async function loadChange(
  organizationId: string,
  changeId: string,
): Promise<ChangeRow | null> {
  const [row] = await db
    .select({
      id: resourceChanges.id,
      organizationId: resourceChanges.organizationId,
      accountId: resourceChanges.accountId,
      resourceId: resourceChanges.resourceId,
      pluginId: resourceChanges.pluginId,
      resourceTypeId: resourceChanges.resourceTypeId,
      displayName: resourceChanges.displayName,
      changeKind: resourceChanges.changeKind,
      diff: resourceChanges.diff,
      createdAt: resourceChanges.createdAt,
      revertedAt: resourceChanges.revertedAt,
      revertClaimedAt: resourceChanges.revertClaimedAt,
      revertClaimOwner: resourceChanges.revertClaimOwner,
      revertWriteAttemptedAt: resourceChanges.revertWriteAttemptedAt,
    })
    .from(resourceChanges)
    .where(
      and(eq(resourceChanges.id, changeId), eq(resourceChanges.organizationId, organizationId)),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Read the resource live and reconcile the change's inverse against it.
 *
 * The live read is the point: a stored snapshot would tell us what the poller
 * saw, not what is true now, and "the world may have moved on" is exactly the
 * case the plan has to distinguish.
 *
 * ## The window this does not close
 *
 * The apply calls this and then writes, so the gap between reading a field and
 * writing it is one provider round-trip wide. It is **not zero**. A third party
 * — a colleague in the provider's console, a Terraform run, another
 * Infrawrench user editing the resource — can change a field inside that gap,
 * and the revert will then overwrite their value without noticing.
 *
 * That gap cannot be closed at this layer, and the honest reason is the plugin
 * contract: `PluginClient.updateResource(typeId, resourceId, accountId, fields)`
 * takes no precondition — no expected value, no ETag, no version token, no
 * `If-Match`. Several providers offer conditional writes natively, but nothing
 * in the contract can carry one, so the host has no way to ask for one
 * generically. Making the write truly atomic would mean widening
 * `updateResource` across every plugin, which is a change to the plugin
 * contract rather than a change to this feature.
 *
 * What *is* done about it: the read happens as late as possible (immediately
 * before the write, through the same client, with no credential decryption or
 * client construction in between), and the residual window is documented as a
 * window rather than described as a guarantee — in the route, in the OpenAPI
 * description, and in the user-facing docs.
 *
 * Whole-event refusals (created/deleted, an empty diff, an already-reverted
 * event) short-circuit before the provider is touched — there is no reason to
 * spend an API call to say "creations aren't revertible".
 */
export async function buildRevertPlan(
  organizationId: string,
  change: ChangeRow,
): Promise<{ ok: true; result: RevertPlanResult } | { ok: false; failure: RevertFailure }> {
  const refused = (plan: RevertPlan) => ({ ok: true as const, result: { plan, client: null } });

  const shortCircuit = computeRevertPlan({
    changeKind: change.changeKind,
    diff: change.diff ?? [],
    currentFields: {},
    editableFieldKeys: [],
    supportsUpdate: true,
    alreadyReverted: change.revertedAt !== null,
  });
  if (shortCircuit.fields.length === 0 && shortCircuit.blockedReason) {
    return refused(shortCircuit);
  }

  const ctx = await getClientForAccount(change.accountId, organizationId);
  if (!ctx) return { ok: false, failure: { kind: "account-not-found" } };

  const typeDef = ctx.plugin.resourceTypes.find((t) => t.id === change.resourceTypeId);
  const supportsUpdate = !!ctx.client.updateResource && !!typeDef?.supportsUpdate;
  const editableFieldKeys = supportsUpdate
    ? (typeDef?.fields ?? []).filter(isFieldEditable).map((f) => f.key)
    : [];

  if (!supportsUpdate) {
    return refused(
      computeRevertPlan({
        changeKind: change.changeKind,
        diff: change.diff ?? [],
        currentFields: {},
        editableFieldKeys: [],
        supportsUpdate: false,
      }),
    );
  }

  let live: ResourceInstance;
  try {
    live = await ctx.client.getResource(change.resourceTypeId, change.resourceId, change.accountId);
  } catch (err) {
    return {
      ok: false,
      failure: {
        kind: "resource-unreadable",
        message: err instanceof Error ? err.message : "Couldn't read the resource",
      },
    };
  }

  return {
    ok: true,
    result: {
      plan: computeRevertPlan({
        changeKind: change.changeKind,
        diff: change.diff ?? [],
        currentFields: live.fields ?? {},
        editableFieldKeys,
        supportsUpdate: true,
      }),
      client: ctx.client,
    },
  };
}

/**
 * Every write that ends a revert names the claim it is ending.
 *
 * A deadline on its own is only a timer: an attempt whose lease lapsed while
 * its provider call was still running would otherwise clear — or complete —
 * whatever claim had replaced it, and the event would fall open for a third
 * attempt while the second was mid-write. Fencing on the token makes a
 * superseded attempt match no row, so it can do nothing at all, which is
 * exactly what it should do. Same shape as `fencedWhere` in
 * `server-core/src/network-flow/pass.ts`.
 */
function fencedWhere(organizationId: string, changeId: string, owner: string) {
  return and(
    eq(resourceChanges.id, changeId),
    eq(resourceChanges.organizationId, organizationId),
    eq(resourceChanges.revertClaimOwner, owner),
  );
}

/**
 * Take ownership of the event for {@link REVERT_CLAIM_LEASE_MS}.
 *
 * Returns the claim's owner token, or null when the event is already reverted
 * or another attempt holds a claim that has not yet expired. The token is the
 * caller's proof of ownership and must be handed to {@link completeRevert} and
 * {@link releaseRevert}; it is fixed for the life of the claim, so there is
 * nothing about it that can go stale.
 *
 * **The claim and the completion are two columns on purpose.** `revert_claimed_at`
 * is a lease; `reverted_at` is a fact, written only once the provider actually
 * accepted the write. Collapsing them — claiming by setting `reverted_at` — was
 * the first shape of this code and it had no recovery path: a process that
 * stopped between the claim committing and the provider call returning left the
 * row marked reverted forever, blocking every retry *and* labelling an event
 * that was never applied. Anything that can leave a claim behind (a crash, a
 * deploy mid-request, a `releaseRevert` that itself failed) now resolves itself
 * at lease expiry.
 *
 * ## What the lease does and does not promise
 *
 * Dying *after* the provider accepted the write but before {@link completeRevert}
 * commits is safe by construction rather than by bookkeeping: the lease expires,
 * a retry re-reads the resource, finds every field already at its old value, and
 * plans `already-reverted` for all of them, so nothing is written a second time.
 *
 * A provider call that outlives the lease is the case the token exists for, and
 * it is worth being exact about what survives it. The token guarantees the
 * *bookkeeping* is never corrupted: a superseded attempt cannot release or
 * complete the new holder's claim, so the event can never fall open to a third
 * attempt while the second is still writing. It does **not** guarantee that two
 * provider writes never overlap — if the work outlives the lease, the second
 * holder may start its own write while the first is still in flight. What makes
 * that survivable is that both are writing *the same patch*: the values come
 * from the same recorded event, inverted the same way, so the second holder's
 * patch is a subset of the first's and an overlap is idempotent in effect rather
 * than divergent. Two attempts can race; they cannot disagree.
 */
export async function claimRevert(
  organizationId: string,
  changeId: string,
  userId: string | undefined,
  at: Date,
): Promise<string | null> {
  const owner = randomUUID();
  const staleBefore = new Date(at.getTime() - REVERT_CLAIM_LEASE_MS);
  const claimed = await db
    .update(resourceChanges)
    .set({ revertClaimedAt: at, revertClaimOwner: owner, revertedByUserId: userId ?? null })
    .where(
      and(
        eq(resourceChanges.id, changeId),
        eq(resourceChanges.organizationId, organizationId),
        isNull(resourceChanges.revertedAt),
        or(
          isNull(resourceChanges.revertClaimedAt),
          lt(resourceChanges.revertClaimedAt, staleBefore),
        ),
      ),
    )
    .returning({ id: resourceChanges.id });
  return claimed.length > 0 ? owner : null;
}

/**
 * Journal that a provider write is about to be issued for this event.
 *
 * Written immediately before the `updateResource` call and fenced on the claim
 * token. This is the piece of state that lets the claim go back to being a pure
 * lock: **its absence proves no write was issued**, so releasing a claim is
 * always safe, and its presence is the only thing that licenses a later attempt
 * to reconcile.
 *
 * The distinction is the same one `managed_invoices` draws between
 * `delivery_attempted_at` and `delivered_at`. It cost three rounds of review to
 * arrive at, because inferring it from `revert_claimed_at` instead is *almost*
 * right: a claim outlives an attempt that died before writing just as readily as
 * one that died after, so the inference wedged events behind a lease that
 * renewed itself forever on one path and mis-attributed an unrelated hand-edit
 * as somebody's revert on another.
 *
 * The write costs one primary-key UPDATE on the connection the request already
 * holds, immediately before a cross-internet provider call. It does sit inside
 * the lost-update window documented on {@link buildRevertPlan}, and is a
 * rounding error against the round-trip it precedes.
 *
 * **Returns false when this attempt no longer holds the claim, and the caller
 * must not go on to write.** The fence and the return value are one mechanism:
 * journalling and writing have to succeed or fail together, or the attempt
 * produces exactly the unjournalled provider write this column exists to
 * prevent. A caller that ignored this would be issuing a second concurrent
 * write while holding positive evidence that it had lost the lock — which is a
 * different thing from the unavoidable case where the lease lapses *during* the
 * provider call and nobody can know.
 */
export async function markRevertWriteAttempted(
  organizationId: string,
  changeId: string,
  owner: string,
  at: Date,
): Promise<boolean> {
  const marked = await db
    .update(resourceChanges)
    .set({ revertWriteAttemptedAt: at })
    .where(fencedWhere(organizationId, changeId, owner))
    .returning({ id: resourceChanges.id });
  return marked.length > 0;
}

/**
 * Record that the provider accepted the write. Only this makes an event read as
 * reverted — to the feed, to the UI badge, and to a later revert attempt.
 *
 * Returns false when this attempt no longer holds the claim, which means its
 * lease lapsed and another attempt took the event over. The caller must not
 * treat that as success: the provider write did land, but this request is no
 * longer the one that owns the outcome, and claiming it would overwrite the
 * replacement's claim.
 */
export async function completeRevert(
  organizationId: string,
  changeId: string,
  owner: string,
  at: Date,
): Promise<boolean> {
  const completed = await db
    .update(resourceChanges)
    .set({
      revertedAt: at,
      revertClaimedAt: null,
      revertClaimOwner: null,
      // The journal is spent: `reverted_at` now carries the fact it pointed at.
      revertWriteAttemptedAt: null,
    })
    .where(fencedWhere(organizationId, changeId, owner))
    .returning({ id: resourceChanges.id });
  return completed.length > 0;
}

/**
 * Hand the event back, so a failed attempt is retryable immediately rather than
 * at lease expiry.
 *
 * **Always safe to call, on every non-completing exit.** That is the point of
 * {@link markRevertWriteAttempted} existing separately: the claim carries no
 * information about whether a write happened, so letting go of it destroys
 * nothing. Making the release conditional — to protect an inference drawn from
 * the claim — is what wedged events behind a self-renewing lease.
 *
 * Deliberately leaves `revert_write_attempted_at` alone: an attempt whose write
 * threw may still have applied, so the journal outlives the lock.
 *
 * Fenced on the claim token: an attempt that was already superseded releases
 * nothing, because the claim it would be clearing is not its own. Also scoped
 * to rows that have not completed, so it can never un-revert an event whose
 * write did land.
 *
 * **Returns nothing, and that is deliberate rather than an oversight** — the
 * one fenced write here whose row count carries no decision. Zero rows means
 * either "another attempt owns this claim" or "the event already completed",
 * and in both cases the correct action is precisely the nothing that already
 * happened; there is no recovery to attempt and no invariant left broken.
 * Contrast {@link markRevertWriteAttempted}, where zero rows means a provider
 * write is about to be issued without a journal, which is a decision point.
 *
 * Never throws: this runs on the error path, and a failed rollback must not
 * mask the error that caused it (the same rule the drift-alert cooldown claim
 * follows). A release that fails is not a stuck row either — the lease is the
 * backstop, which is exactly why the lease exists.
 */
export async function releaseRevert(
  organizationId: string,
  changeId: string,
  owner: string,
): Promise<void> {
  try {
    await db
      .update(resourceChanges)
      .set({ revertClaimedAt: null, revertClaimOwner: null, revertedByUserId: null })
      .where(and(fencedWhere(organizationId, changeId, owner), isNull(resourceChanges.revertedAt)));
  } catch (err) {
    console.error("[change-revert] Failed to release the revert claim:", err);
  }
}
