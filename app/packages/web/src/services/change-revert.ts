import { and, eq, isNull } from "drizzle-orm";
import { isFieldEditable } from "@infrawrench/plugin-base";
import type { ResourceInstance } from "@infrawrench/plugin-base";
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
 * 2. **The plan is recomputed against a live read, twice.** The dry run reads
 *    live fields to build the preview; the apply reads them *again* and rebuilds
 *    the plan from scratch. A field that moved between the two reads comes back
 *    as a conflict and drops out of the patch — that is the value-level
 *    compare-and-swap, the same shape as the invoice-approval re-read.
 * 3. **The event itself is claimed.** A conditional `UPDATE ... WHERE
 *    reverted_at IS NULL` decides which of two concurrent reverts of the same
 *    event gets to touch the provider; the loser gets a 409 and the winner
 *    releases the claim if the provider call fails, so a failure stays
 *    retryable.
 *
 * What this file deliberately does *not* do is mirror the new values into the
 * `resources` row the way `POST /api/resources/update` does. That mirror exists
 * so an interactive edit shows up immediately; here it would erase the very
 * drift the next poll is supposed to notice. Leaving the stored snapshot alone
 * means the poller diffs it against the reverted live state and records the
 * revert as an ordinary `updated` event — the undo shows up in the timeline by
 * the normal mechanism rather than by a special case.
 */

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
}

/** Failure modes the routes turn into status codes. */
export type RevertFailure =
  | { kind: "change-not-found" }
  | { kind: "account-not-found" }
  | { kind: "resource-unreadable"; message: string };

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
 * Whole-event refusals (created/deleted, an empty diff, an already-claimed
 * revert) short-circuit before the provider is touched — there is no reason to
 * spend an API call to say "creations aren't revertible".
 */
export async function buildRevertPlan(
  organizationId: string,
  change: ChangeRow,
): Promise<{ ok: true; plan: RevertPlan } | { ok: false; failure: RevertFailure }> {
  const shortCircuit = computeRevertPlan({
    changeKind: change.changeKind,
    diff: change.diff ?? [],
    currentFields: {},
    editableFieldKeys: [],
    supportsUpdate: true,
    alreadyReverted: change.revertedAt !== null,
  });
  if (shortCircuit.fields.length === 0 && shortCircuit.blockedReason) {
    return { ok: true, plan: shortCircuit };
  }

  const ctx = await getClientForAccount(change.accountId, organizationId);
  if (!ctx) return { ok: false, failure: { kind: "account-not-found" } };

  const typeDef = ctx.plugin.resourceTypes.find((t) => t.id === change.resourceTypeId);
  const supportsUpdate = !!ctx.client.updateResource && !!typeDef?.supportsUpdate;
  const editableFieldKeys = supportsUpdate
    ? (typeDef?.fields ?? []).filter(isFieldEditable).map((f) => f.key)
    : [];

  if (!supportsUpdate) {
    return {
      ok: true,
      plan: computeRevertPlan({
        changeKind: change.changeKind,
        diff: change.diff ?? [],
        currentFields: {},
        editableFieldKeys: [],
        supportsUpdate: false,
      }),
    };
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
    plan: computeRevertPlan({
      changeKind: change.changeKind,
      diff: change.diff ?? [],
      currentFields: live.fields ?? {},
      editableFieldKeys,
      supportsUpdate: true,
    }),
  };
}

/**
 * Take exclusive ownership of the event.
 *
 * Returns false when someone else already holds it — which is both "a revert is
 * running right now" and "this event was reverted an hour ago". The two are the
 * same answer to the caller: don't apply.
 */
export async function claimRevert(
  organizationId: string,
  changeId: string,
  userId: string | undefined,
  at: Date,
): Promise<boolean> {
  const claimed = await db
    .update(resourceChanges)
    .set({ revertedAt: at, revertedByUserId: userId ?? null })
    .where(
      and(
        eq(resourceChanges.id, changeId),
        eq(resourceChanges.organizationId, organizationId),
        isNull(resourceChanges.revertedAt),
      ),
    )
    .returning({ id: resourceChanges.id });
  return claimed.length > 0;
}

/**
 * Hand the event back, so a failed attempt is retryable.
 *
 * Never throws: this runs on the error path, and a failed rollback must not
 * mask the error that caused it (the same rule the drift-alert cooldown claim
 * follows).
 */
export async function releaseRevert(organizationId: string, changeId: string): Promise<void> {
  try {
    await db
      .update(resourceChanges)
      .set({ revertedAt: null, revertedByUserId: null })
      .where(
        and(eq(resourceChanges.id, changeId), eq(resourceChanges.organizationId, organizationId)),
      );
  } catch (err) {
    console.error("[change-revert] Failed to release the revert claim:", err);
  }
}
