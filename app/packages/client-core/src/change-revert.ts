/**
 * Reverting a change-timeline event — the pure half.
 *
 * The drift feed already records, per changed field, what the value was before
 * and after. Inverting that is arithmetic; what makes a revert honest is
 * *reconciling* the inverse against the world as it is now, because the poller
 * that saw the change may have run hours ago and the field may have moved
 * again since. `computeRevertPlan` is that reconciliation, and it is
 * deliberately pure so both the dry run and the apply path compute the plan the
 * same way — the apply recomputes against a fresh read rather than trusting the
 * preview.
 *
 * That re-read *narrows* the window in which a third party's newer value could
 * be overwritten; it does not eliminate it, because `updateResource` takes no
 * precondition and no conditional write can be expressed generically. The size
 * of the residual window and the reasoning behind leaving it are documented on
 * `buildRevertPlan` in the web app's `services/change-revert.ts`.
 *
 * Nothing provider-specific lives here. The writable field set arrives as a
 * list of keys derived from the plugin's own field schema through
 * `isFieldEditable` (plugin-base) — the same predicate that decides what the
 * Edit form offers — so a revert can never write something an edit couldn't.
 */

import type { CloudFetch } from "./fetch";
import { valuesEqual, type ResourceChangeKind, type ResourceFieldChange } from "./resource-changes";

/** Prefix the differ puts on resolved-output keys. Outputs are never writable. */
const OUTPUT_PREFIX = "outputs.";

/**
 * What would happen to one field if the revert ran now.
 *
 * - `revertible` — the field still holds the value the change moved it to, and
 *   the plugin's edit form can set it. This is the only status that writes.
 * - `already-reverted` — the field already holds the old value. A no-op, not a
 *   failure: someone (or something) put it back before you got here.
 * - `conflict` — the field changed *again* since the recorded event, so the
 *   live value is neither side of the diff. Reverting would silently discard
 *   whatever that later change was, so it is excluded and both values shown.
 * - `not-writable` — the field is outside the plugin's editable surface, or its
 *   old value isn't something the edit form can submit.
 * - `provider-derived` — an `outputs.*` entry. Outputs are computed by the
 *   provider from other state; there is nothing to write.
 */
export type RevertFieldStatus =
  "revertible" | "already-reverted" | "conflict" | "not-writable" | "provider-derived";

export interface RevertFieldPlan {
  /** Field key exactly as the change event recorded it. */
  field: string;
  /** What the field held before the recorded change — the value a revert writes. */
  revertTo: unknown;
  /** What the recorded change moved it to — what the field should still hold. */
  changedTo: unknown;
  /** What the field holds right now, read live from the provider. */
  current: unknown;
  status: RevertFieldStatus;
  /** One sentence, shown next to the field in the confirmation dialog. */
  reason: string;
}

export interface RevertPlan {
  /** Every field of the recorded diff, in the order the event recorded them. */
  fields: RevertFieldPlan[];
  /** Keys that would actually be written, in the same order. */
  revertibleFields: string[];
  /** True when at least one field would be written. */
  revertible: boolean;
  /**
   * Why nothing would be written, or null when something would. Populated for
   * whole-event refusals (a `created` event, an already-applied revert, a
   * plugin with no update path) *and* for the case where every individual
   * field turned out to be a no-op, a conflict or unwritable.
   */
  blockedReason: string | null;
}

export interface ComputeRevertPlanArgs {
  changeKind: ResourceChangeKind;
  /** The recorded per-field before/after. Empty for created/deleted events. */
  diff: readonly ResourceFieldChange[];
  /** The resource's live field bag, freshly fetched from the provider. */
  currentFields: Record<string, unknown>;
  /**
   * Field keys the plugin's Edit form exposes for this resource type — the
   * `isFieldEditable` filter over the type's declared fields. Empty when the
   * type or the plugin client has no update path at all, in which case pass
   * `supportsUpdate: false` too so the refusal reads correctly.
   */
  editableFieldKeys: readonly string[];
  /** The resource type declares `supportsUpdate` and the client implements `updateResource`. */
  supportsUpdate: boolean;
  /** This event has already been reverted (the claim column is set). */
  alreadyReverted?: boolean | undefined;
}

/**
 * The value a revert would submit, or null when the edit form can't express
 * it.
 *
 * `updateResource` takes `Record<string, string>`: the host has exactly one
 * way to write a field and it is text. A previous value that was an object, an
 * array, or absent altogether has no faithful text form — writing `"[object
 * Object]"` or `""` would be inventing a provider call, which is the one thing
 * a generic revert must never do.
 */
export function revertValueAsText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return String(value);
  return null;
}

function planField(
  change: ResourceFieldChange,
  args: Pick<ComputeRevertPlanArgs, "currentFields" | "editableFieldKeys">,
  editable: ReadonlySet<string>,
): RevertFieldPlan {
  const base = {
    field: change.field,
    revertTo: change.from,
    changedTo: change.to,
    current: args.currentFields[change.field],
  };

  // Outputs first and unconditionally: they are provider-derived, so even one
  // that happens to be writable-looking is not a thing to write.
  if (change.field.startsWith(OUTPUT_PREFIX)) {
    return {
      ...base,
      current: undefined,
      status: "provider-derived",
      reason: "Provider-derived output — it follows the resource's state rather than setting it.",
    };
  }

  const current = base.current;

  // A field that already holds the old value needs nothing done to it, whether
  // or not it is writable — say so rather than reporting it as blocked.
  if (valuesEqual(current, change.from)) {
    return {
      ...base,
      status: "already-reverted",
      reason: "Already back at the previous value — nothing to do.",
    };
  }

  if (!editable.has(change.field)) {
    return {
      ...base,
      status: "not-writable",
      reason: "This plugin's edit form doesn't offer this field, so Infrawrench can't set it.",
    };
  }

  if (revertValueAsText(change.from) === null) {
    return {
      ...base,
      status: "not-writable",
      reason:
        change.from === null || change.from === undefined
          ? "The field had no value before this change, and the edit form can't unset a field."
          : "The previous value isn't a plain value the edit form can submit.",
    };
  }

  if (!valuesEqual(current, change.to)) {
    return {
      ...base,
      status: "conflict",
      reason: "Changed again since this event — reverting would discard the newer value.",
    };
  }

  return {
    ...base,
    status: "revertible",
    reason: "Still holds the value this change set; the revert writes the previous one back.",
  };
}

/**
 * Reconcile a recorded change against the resource's live fields and say, per
 * field, what a revert would do.
 *
 * Pure: every input is data, so the dry-run endpoint and the apply endpoint
 * differ only in when they read the live fields.
 */
export function computeRevertPlan(args: ComputeRevertPlanArgs): RevertPlan {
  const blocked = (reason: string): RevertPlan => ({
    fields: [],
    revertibleFields: [],
    revertible: false,
    blockedReason: reason,
  });

  if (args.alreadyReverted) {
    return blocked("This change has already been reverted.");
  }
  if (args.changeKind !== "updated") {
    return blocked(
      args.changeKind === "created"
        ? "Only changed resources can be reverted. Undoing an appearance means deleting the resource — do that from the resource itself."
        : "Only changed resources can be reverted. A resource that disappeared upstream has to be recreated, not reverted.",
    );
  }
  if (args.diff.length === 0) {
    return blocked("This change recorded no field-level differences to invert.");
  }
  if (!args.supportsUpdate) {
    return blocked(
      "This plugin can't edit this resource type, so there is no way to write it back.",
    );
  }

  const editable = new Set(args.editableFieldKeys);
  const fields = args.diff.map((change) => planField(change, args, editable));
  const revertibleFields = fields.filter((f) => f.status === "revertible").map((f) => f.field);

  if (revertibleFields.length > 0) {
    return { fields, revertibleFields, revertible: true, blockedReason: null };
  }

  // Nothing to write — explain which of the three reasons it was, since the
  // dialog's whole job is telling the user why the button is dead.
  const has = (status: RevertFieldStatus) => fields.some((f) => f.status === status);
  let reason: string;
  if (fields.every((f) => f.status === "already-reverted")) {
    reason = "Every changed field is already back at its previous value.";
  } else if (has("conflict")) {
    reason =
      "Every field this change touched has changed again since — reverting would discard the newer values.";
  } else {
    reason =
      "None of the fields this change touched can be written through the plugin's edit form.";
  }
  return { fields, revertibleFields, revertible: false, blockedReason: reason };
}

/**
 * The `updateResource` payload for a plan — only the `revertible` fields, and
 * only ever as text, because that is the shape the plugin's update path takes.
 *
 * Non-revertible entries are dropped rather than coerced: the plan already
 * decided they can't be written, and this is the last place that decision
 * could leak.
 */
export function buildRevertPatch(plan: RevertPlan): Record<string, string> {
  const patch: Record<string, string> = {};
  for (const field of plan.fields) {
    if (field.status !== "revertible") continue;
    const text = revertValueAsText(field.revertTo);
    if (text === null) continue;
    patch[field.field] = text;
  }
  return patch;
}

/**
 * Whether the most likely explanation for this plan is "an earlier attempt of
 * *this* revert wrote, and never got to record it".
 *
 * This is the reconciliation half of the claim lifecycle. A revert that reaches
 * the provider and then fails to write `reverted_at` — the database blinked,
 * the process died — leaves the resource reverted and the event marked
 * un-reverted. The retry sees every field already back at its old value, has
 * nothing to write, and would otherwise release the claim and walk away,
 * leaving the feed permanently disagreeing with the world.
 *
 * The hard part is that "already back at its old value" has an innocent
 * explanation too: somebody put it back by hand, or with Terraform, and never
 * asked Infrawrench to revert anything. Recording *that* as a revert would
 * attribute a change to a person who did not make it.
 *
 * The two are told apart by `hadInterruptedAttempt` — whether the change row
 * still carried a claim when this attempt took it over. A claim outlives only
 * one thing: a holder that never reached either of its exits (both
 * `completeRevert` and `releaseRevert` clear it). So a stale claim means "an
 * attempt was in flight and never recorded an outcome", which is exactly and
 * only the state in which an unrecorded write is possible. No stale claim means
 * nobody was mid-revert, and fields that moved back moved back by other means.
 *
 * The rest of the predicate is deliberately conservative: nothing left to write
 * (no `revertible`), nothing ambiguous (no `conflict` — a field that moved on
 * again is not evidence of anything), and at least one field that actually did
 * move back. `not-writable` and `provider-derived` entries are ignored because
 * a revert would never have written them in the first place.
 */
export function revertLooksAlreadyApplied(
  plan: RevertPlan,
  hadInterruptedAttempt: boolean,
): boolean {
  if (!hadInterruptedAttempt) return false;
  if (plan.fields.length === 0) return false;
  if (plan.fields.some((f) => f.status === "revertible" || f.status === "conflict")) return false;
  return plan.fields.some((f) => f.status === "already-reverted");
}

/* ------------------------------------------------------------------ *
 * Wire shapes
 * ------------------------------------------------------------------ */

/**
 * `GET /api/org/{orgId}/changes/{changeId}/revert` — the dry run. Carries the
 * plan plus enough identity for a host to render the dialog without a second
 * lookup.
 */
export interface RevertPreviewResponse {
  changeId: string;
  resourceId: string;
  displayName: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  plan: RevertPlan;
  /** Set when the event was already reverted, so hosts can label the row. */
  revertedAt?: string | null;
}

/** `POST /api/org/{orgId}/changes/{changeId}/revert` — what actually happened. */
export interface RevertApplyResponse {
  changeId: string;
  resourceId: string;
  /** The fields written, in plan order. Empty on a reconciliation. */
  appliedFields: string[];
  /** The plan as recomputed against the live read that the write raced. */
  plan: RevertPlan;
  revertedAt: string;
  /**
   * True when this request wrote nothing and instead recorded an *earlier*
   * interrupted attempt's write (see `revertLooksAlreadyApplied`). The event is
   * now marked reverted and the resource was already back; nothing was sent to
   * the provider by this request.
   */
  reconciled?: boolean;
  /**
   * Present and `false` only when the audit entry for this revert could not be
   * written. The provider change still happened — this says the *attribution*
   * for it did not reach the audit table, and the details were written to the
   * server log instead. Absent means audited normally.
   *
   * Attribution is best-effort by construction: nothing transactional spans a
   * third-party cloud API and Infrawrench's database, so the gap between the
   * provider accepting a write and the audit row committing cannot be closed
   * from here. Surfacing it beats swallowing it.
   */
  auditRecorded?: boolean;
}

/**
 * What an attempt did, as recorded in its `resource.change_revert` audit entry.
 *
 * The four values are the four ways an attempt that got as far as mattering can
 * end, and they exist so a reader of the audit log can tell them apart:
 *
 * - `recorded` — wrote to the provider and recorded it. The ordinary success.
 * - `superseded` — wrote to the provider, but its lease had lapsed and another
 *   attempt owned the event by the time it finished. The write is real; the
 *   recorded outcome belongs to the other attempt.
 * - `unrecorded` — wrote to the provider, and could not record it at all. The
 *   resource moved and the feed does not yet know; a later attempt reconciles.
 * - `reconciled` — wrote nothing, and recorded an earlier attempt's write. The
 *   only outcome that involves no provider call, which is why it is not simply
 *   folded into `recorded`.
 */
export type RevertAuditOutcome = "recorded" | "superseded" | "unrecorded" | "reconciled";

/** 409 body when another revert of the same event already claimed it. */
export const REVERT_CONFLICT_CODE = "change_revert_conflict";

/**
 * Bearer readers, for hosts that talk to the cloud API directly — mobile
 * today. Web and desktop inject their own transport into `@infrawrench/ui`'s
 * `ChangeRevertClient` instead, exactly as they do for the feed itself.
 */
export async function fetchRevertPreview(
  api: CloudFetch,
  orgId: string,
  changeId: string,
): Promise<RevertPreviewResponse | null> {
  return api.org<RevertPreviewResponse>(orgId, `/changes/${encodeURIComponent(changeId)}/revert`);
}

export async function applyRevert(
  api: CloudFetch,
  orgId: string,
  changeId: string,
): Promise<RevertApplyResponse | null> {
  return api.org<RevertApplyResponse>(orgId, `/changes/${encodeURIComponent(changeId)}/revert`, {
    method: "POST",
  });
}

/**
 * Why a row can't be reverted without asking the server, or null when it is
 * worth asking. Shared by every surface's Revert affordance so the three
 * refusals are worded once — and so no host opens the dialog just to be told
 * something the row already knew.
 */
export function localRevertRefusal(entry: {
  changeKind: ResourceChangeKind;
  diff: readonly ResourceFieldChange[];
  revertedAt?: string | null | undefined;
}): string | null {
  if (entry.revertedAt) {
    return `Already reverted on ${new Date(entry.revertedAt).toLocaleString()}.`;
  }
  if (entry.changeKind === "created") {
    return "Appearances can't be reverted — undoing one means deleting the resource, which you do from the resource itself.";
  }
  if (entry.changeKind === "deleted") {
    return "Disappearances can't be reverted — a resource that's gone upstream has to be recreated.";
  }
  if (entry.diff.length === 0) {
    return "This event recorded no field-level differences to put back.";
  }
  return null;
}
