/**
 * Failure bookkeeping, teardown classification, lease repair, and the
 * identity rule — every judgement about what an instance may still own and
 * what may safely be concluded about it. Delete only when identity is
 * certain; where it is not, report and leave.
 */
import type { EnvironmentInstanceStatus, EnvironmentMemberStatus } from "./types";

// ---------------------------------------------------------------------------
// Failure bookkeeping and teardown recovery
// ---------------------------------------------------------------------------

/** The row patch that records a failed member. */
export interface MemberFailureRecord {
  status: "failed";
  error: string;
  /** Present whenever the provider returned a resource before the failure. */
  resourceId?: string;
  externalId?: string | null;
  displayName?: string;
}

/**
 * Build the single write that records a member failure.
 *
 * When the create **succeeded** and something after it threw — including the
 * write that was supposed to confirm the creation — the id has to travel with
 * the failure. Recording the failure without it was a way to lose a running,
 * billing resource: teardown would see a member with no resource id and treat
 * it as nothing to do. One statement, so there is no second write to lose.
 */
export function buildMemberFailureRecord(
  error: string,
  created: { resourceId: string; externalId: string | null; displayName: string } | null,
): MemberFailureRecord {
  if (!created) return { status: "failed", error };
  return {
    status: "failed",
    error,
    resourceId: created.resourceId,
    externalId: created.externalId,
    displayName: created.displayName,
  };
}

/**
 * What teardown must do with one recorded member.
 *
 * - `skip` — already torn down.
 * - `delete` — a resource id is on record; delete it.
 * - `verify` — the member was attempted and carries **no** id, so the provider
 *   may or may not hold a resource for it. Ask the provider before concluding
 *   anything; treating this as "handled" is how a resource bills forever.
 * - `unattempted` — the run never reached this member, so nothing can exist.
 */
export type TeardownAction = "skip" | "delete" | "verify" | "unattempted";

/**
 * The highest position the run can possibly have touched.
 *
 * Instantiation stops at the first failure, so every member past that point is
 * untouched. The `+ 1` covers the member that was **in flight** when a process
 * died: its row is still `pending`, but a provider call may have gone out.
 */
export function attemptedPositionCeiling(
  members: { status: EnvironmentMemberStatus; position: number }[],
): number {
  let highest = -1;
  for (const member of members) {
    if (member.status !== "pending" && member.position > highest) highest = member.position;
  }
  return highest + 1;
}

/**
 * What our own inventory can and cannot tell us about a provider resource.
 *
 * - `present` — we hold a live row for it.
 * - `confirmed-gone` — we hold a row that is **soft-deleted**, which is the
 *   record of a deletion *we performed*. That is a positive fact.
 * - `unknown` — we hold no row at all. **This is not evidence of anything.**
 *
 * The third variant is the whole point. A missing row is the *ordinary* state
 * for a member whose bookkeeping failed — `markMemberCreated` runs before
 * `upsertCreatedResource`, so a create that succeeded and then lost its upsert
 * leaves exactly this. Reading it as "the resource is gone" is the mirror
 * image of the ownership mistake made earlier in this module's history:
 * absence of a local row was not proof a resource was *ours*, and it is not
 * proof a resource is *gone* either. Only the provider can support that claim,
 * by being asked.
 *
 * It matters because `deleted` is terminal: a member that reaches it leaves
 * lease repair and teardown permanently, so an inference that lands there
 * costs a resource that bills forever.
 */
export type InventoryDisposition = "present" | "confirmed-gone" | "unknown";

export function inventoryDisposition(
  row: { deletedAt: Date | string | null } | null | undefined,
): InventoryDisposition {
  if (!row) return "unknown";
  return row.deletedAt === null ? "present" : "confirmed-gone";
}

/**
 * May a member holding a recorded `resource_id` be marked `deleted`?
 *
 * Only on confirmation. `deleted` is a claim that something no longer exists,
 * and a local absence cannot support it — the resource was demonstrably
 * created (we recorded its id), so "we have no row" says more about our
 * bookkeeping than about the provider.
 */
export function mayConcludeMemberDeleted(disposition: InventoryDisposition): boolean {
  return disposition === "confirmed-gone";
}

/**
 * Might this instance still own live cloud resources?
 *
 * The instance-level twin of {@link memberNeedsLeaseRepair}, and it exists for
 * the same reason: three separate passes each hand-enumerated the statuses
 * they cared about (`["active","partial"]`, `["creating","active","partial"]`,
 * `"creating"`) and **none of the three lists was complete**. A `failed`
 * instance whose first member survived a failed rollback owns a billable
 * resource; so does one stuck at `tearing-down` because the process died
 * mid-teardown. Status summarises how the *run* went, which only correlates
 * with what the instance still holds.
 *
 * Stated as the complement instead: only `deleted` is finished, because
 * reaching it requires every member to have been marked `deleted`, and a
 * `deleted` member holds nothing.
 */
export function instanceMayOwnLiveResources(status: EnvironmentInstanceStatus): boolean {
  return status !== "deleted";
}

/**
 * Does this member hold a resource with **no clock on it**?
 *
 * The question the lease-repair pass actually asks, and it keys on
 * `resourceId` rather than on `status`. Filtering on `status === "created"`
 * looked equivalent and was not: a member whose rollback failed is `failed`
 * while its resource is very much alive, so that filter let state 6 (see the
 * table in `instantiate.ts`) run past its mandatory TTL with nothing watching
 * it. Status only correlates with "a resource exists"; the id is the fact.
 */
export function memberNeedsLeaseRepair(member: {
  status: EnvironmentMemberStatus;
  resourceId: string | null;
  leaseId: string | null;
}): boolean {
  if (member.status === "pending" || member.status === "deleted") return false;
  return member.resourceId !== null && member.leaseId === null;
}

/**
 * How long to wait before retrying a failed lease repair.
 *
 * Load-bearing in a way most backoffs are not: repair is what stops a member
 * running without the TTL its instantiation promised, so **there is no
 * give-up**. The curve caps at an hour and stays there forever, with
 * `repair_error` on the row the whole time — retrying slowly beats going quiet
 * about something that is still billing.
 */
export function repairBackoffMs(attempts: number): number {
  const base = 60_000 * 2 ** Math.min(Math.max(attempts, 0), 6);
  return Math.min(base, 60 * 60_000);
}

/**
 * A deadline a lease will accept.
 *
 * Leases must expire in the future (`validateLeaseInput`), so a member found
 * after its instance already expired would be un-leasable — which is the one
 * outcome this whole path exists to prevent. It gets a short grace window
 * instead; the lease pass still announces before it deletes, just on a
 * compressed schedule.
 */
export function leaseDeadlineFor(
  preferred: Date | string,
  now: number = Date.now(),
  graceMs = 5 * 60_000,
): Date {
  const preferredMs = preferred instanceof Date ? preferred.getTime() : Date.parse(preferred);
  const floor = now + graceMs;
  return !Number.isNaN(preferredMs) && preferredMs > floor
    ? new Date(preferredMs)
    : new Date(floor);
}

export function classifyTeardownMember(
  member: { status: EnvironmentMemberStatus; resourceId: string | null; position: number },
  attemptedCeiling: number,
): TeardownAction {
  if (member.status === "deleted") return "skip";
  if (member.resourceId) return "delete";
  return member.position <= attemptedCeiling ? "verify" : "unattempted";
}

/**
 * How tearing one member down ended.
 *
 * `needs-attention` is separate from `failed` because nothing was attempted:
 * the environment declined to delete something it could not prove was its own,
 * and said so. `failed` means a delete was tried and did not work.
 */
export type MemberTeardownOutcome = "deleted" | "already-gone" | "failed" | "needs-attention";

// ---------------------------------------------------------------------------
// The identity rule
// ---------------------------------------------------------------------------

/**
 * **Delete only when identity is certain. Where it is not, report and leave.**
 *
 * Asymmetric on purpose, because the costs are: an orphaned resource costs
 * money and money is recoverable; a wrongly deleted resource costs data and
 * data is not.
 *
 * Applied to its endpoint, that rule says **the recovery path does not delete
 * at all**, and this function is the shape of that conclusion — it has no
 * `delete` branch to reach. Deletion lives only where identity is *certain*:
 * the rollback of a resource the provider handed back seconds earlier, and any
 * member whose `resource_id` we actually recorded. Recovery is the rare
 * fallback for the one case those miss — an id lost to a failed write — and it
 * classifies, reports, and leaves the resource alone.
 *
 * Three ownership signals were proposed and all three were unsound, which is
 * what the absence of a fourth is based on:
 *
 * 1. **Provider `createdAt`** — required on `ResourceInstance`, so the many
 *    listers whose provider exposes no creation time fill it with the time of
 *    the call. For those types every candidate looks freshly created.
 * 2. **No prior `resources` row** — absence of evidence, and the *ordinary*
 *    state for a member whose bookkeeping failed, since `markMemberCreated`
 *    runs before `upsertCreatedResource`.
 * 3. **`knownSince`** (when our row was first written) — records when *we
 *    first saw* a resource, not when it was created. A newly connected
 *    account, a newly enabled resource type, a lister that only just started
 *    returning that type, or a re-sync all make a years-old user-managed
 *    resource "first discovered" after the environment started.
 *
 * Each is a proxy for creation time, and creation time is the thing we do not
 * reliably have. A unique name, unclaimed, with a plausible timestamp is a
 * good heuristic for "probably ours" — and "probably ours" is not a licence to
 * destroy someone's infrastructure.
 *
 * The one construct that *would* prove ownership is a marker we write at
 * create time and read back. It is not available generically: a tag-like
 * create field exists on a handful of resource types across all the plugins,
 * spelled differently by each, and inventing one per provider is the
 * host-side provider knowledge this codebase does not have. Doing it properly
 * means a declared "tag field" on the resource-type contract — a real answer,
 * and a much larger change than this. Recorded as a follow-up.
 *
 * **The cost, stated plainly:** a member whose id was lost *and* whose lease
 * could not be attached will sometimes leave an orphan a human has to remove.
 * That is the deliberate price of never deleting something we cannot prove is
 * ours. It is charged in visibility, not silence — the resource is named on a
 * `partial` instance with the reason.
 */
export interface RecoveryCandidate {
  /** The provider's own id, when the lister supplies one. */
  externalId: string | null;
  /** Display name that matched. Reported so an operator knows what to look at. */
  displayName?: string | undefined;
}

/**
 * What a recovery check found. Note the absence of a `delete` action — that is
 * the point, not an omission.
 */
export type RecoveryFinding =
  { action: "already-gone" } | { action: "needs-attention"; reason: string };

/**
 * Report what a name-based lookup turned up for a member whose id was lost.
 *
 * Nothing found means nothing to do: the member is settled. Anything found is
 * reported for a human, because a name match is not an identity and no
 * available signal upgrades it into one.
 */
export function classifyRecoveryCandidates(candidates: RecoveryCandidate[]): RecoveryFinding {
  if (candidates.length === 0) return { action: "already-gone" };

  const named = candidates
    .map((candidate) => candidate.externalId)
    .filter((id): id is string => typeof id === "string" && id !== "");
  const detail = named.length > 0 ? ` (${named.join(", ")})` : "";

  if (candidates.length > 1) {
    return {
      action: "needs-attention",
      reason: `${candidates.length} resources carry the name this member would have had${detail}`,
    };
  }
  return {
    action: "needs-attention",
    reason: `a resource carries the name this member would have had${detail}, but nothing proves this environment created it`,
  };
}

/**
 * Whether the member's auto-delete lease may be cancelled.
 *
 * **Only a confirmed outcome cancels it.** The lease *is* the retry machinery —
 * it re-attempts the delete at expiry, defers through change freezes and
 * reports when it gives up. Cancelling it after a failed delete turns a
 * transient provider error into a resource that bills until somebody
 * remembers to retry the teardown by hand. `needs-attention` keeps it for the
 * same reason plus a better one: nothing was deleted, so the resource is still
 * there and still wants a clock on it.
 */
export function leaseShouldBeCancelled(outcome: MemberTeardownOutcome): boolean {
  return outcome === "deleted" || outcome === "already-gone";
}
