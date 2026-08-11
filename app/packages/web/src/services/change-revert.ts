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
 * 3. **The event is claimed under a lease.** A conditional `UPDATE ... WHERE
 *    reverted_at IS NULL AND (revert_claimed_at IS NULL OR revert_claimed_at <
 *    now - lease)` decides which of two concurrent reverts gets to touch the
 *    provider. See {@link claimRevert} for why the claim and the completion are
 *    two different columns.
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
 * Take ownership of the event for {@link REVERT_CLAIM_LEASE_MS}.
 *
 * Returns false when the event is already reverted, or when another revert
 * holds a claim that has not yet expired.
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
 * The reverse failure — dying *after* the provider accepted the write but
 * before {@link completeRevert} commits — is safe by construction rather than by
 * bookkeeping: the lease expires, a retry re-reads the resource, finds every
 * field already at its old value, and plans `already-reverted` for all of them,
 * so nothing is written a second time.
 */
export async function claimRevert(
  organizationId: string,
  changeId: string,
  userId: string | undefined,
  at: Date,
): Promise<boolean> {
  const staleBefore = new Date(at.getTime() - REVERT_CLAIM_LEASE_MS);
  const claimed = await db
    .update(resourceChanges)
    .set({ revertClaimedAt: at, revertedByUserId: userId ?? null })
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
  return claimed.length > 0;
}

/**
 * Record that the provider accepted the write. Only this makes an event read as
 * reverted — to the feed, to the UI badge, and to a later revert attempt.
 */
export async function completeRevert(
  organizationId: string,
  changeId: string,
  at: Date,
): Promise<void> {
  await db
    .update(resourceChanges)
    .set({ revertedAt: at, revertClaimedAt: null })
    .where(
      and(eq(resourceChanges.id, changeId), eq(resourceChanges.organizationId, organizationId)),
    );
}

/**
 * Hand the event back, so a failed attempt is retryable immediately rather than
 * at lease expiry.
 *
 * Never throws: this runs on the error path, and a failed rollback must not
 * mask the error that caused it (the same rule the drift-alert cooldown claim
 * follows). A release that fails is not a stuck row either — the lease is the
 * backstop, which is exactly why the lease exists.
 *
 * Scoped to rows that have not completed, so it can never un-revert an event
 * whose write did land.
 */
export async function releaseRevert(organizationId: string, changeId: string): Promise<void> {
  try {
    await db
      .update(resourceChanges)
      .set({ revertClaimedAt: null, revertedByUserId: null })
      .where(
        and(
          eq(resourceChanges.id, changeId),
          eq(resourceChanges.organizationId, organizationId),
          isNull(resourceChanges.revertedAt),
        ),
      );
  } catch (err) {
    console.error("[change-revert] Failed to release the revert claim:", err);
  }
}
