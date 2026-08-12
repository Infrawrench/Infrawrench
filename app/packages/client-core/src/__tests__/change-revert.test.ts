import { describe, expect, it } from "vitest";
import {
  buildRevertPatch,
  computeRevertPlan,
  localRevertRefusal,
  revertLooksAlreadyApplied,
  revertValueAsText,
  type ComputeRevertPlanArgs,
  type RevertFieldPlan,
  type RevertPlan,
} from "../change-revert";
import type { ResourceFieldChange } from "../resource-changes";

/**
 * The revert planner is the piece that decides whether a provider gets touched,
 * so it is tested the way `computeResourceChangeEvents` is: pure inputs, no
 * mocks, one case per outcome the UI has to render differently.
 */

const args = (over: Partial<ComputeRevertPlanArgs> = {}): ComputeRevertPlanArgs => ({
  changeKind: "updated",
  diff: [],
  currentFields: {},
  editableFieldKeys: [],
  supportsUpdate: true,
  ...over,
});

const change = (field: string, from: unknown, to: unknown): ResourceFieldChange => ({
  field,
  from,
  to,
});

describe("computeRevertPlan — whole-event refusals", () => {
  it("refuses creations, naming the thing to do instead", () => {
    const plan = computeRevertPlan(args({ changeKind: "created" }));
    expect(plan.revertible).toBe(false);
    expect(plan.fields).toEqual([]);
    expect(plan.blockedReason).toMatch(/deleting the resource/);
  });

  it("refuses deletions", () => {
    const plan = computeRevertPlan(args({ changeKind: "deleted" }));
    expect(plan.revertible).toBe(false);
    expect(plan.blockedReason).toMatch(/recreated/);
  });

  it("refuses an updated event with no diff", () => {
    const plan = computeRevertPlan(args({ diff: [] }));
    expect(plan.blockedReason).toMatch(/no field-level differences/);
  });

  it("refuses a resource type the plugin can't update", () => {
    const plan = computeRevertPlan(
      args({ diff: [change("size", "s-1vcpu", "s-4vcpu")], supportsUpdate: false }),
    );
    expect(plan.revertible).toBe(false);
    expect(plan.blockedReason).toMatch(/can't edit this resource type/);
  });

  it("refuses an event that was already reverted", () => {
    const plan = computeRevertPlan(
      args({ diff: [change("size", "a", "b")], alreadyReverted: true }),
    );
    expect(plan.blockedReason).toBe("This change has already been reverted.");
  });
});

describe("computeRevertPlan — clean revert", () => {
  it("marks a field still holding the changed value as revertible", () => {
    const plan = computeRevertPlan(
      args({
        diff: [change("size", "s-1vcpu-1gb", "s-4vcpu-8gb")],
        currentFields: { size: "s-4vcpu-8gb" },
        editableFieldKeys: ["size", "name"],
      }),
    );
    expect(plan.revertible).toBe(true);
    expect(plan.blockedReason).toBeNull();
    expect(plan.revertibleFields).toEqual(["size"]);
    expect(plan.fields[0]).toMatchObject({
      field: "size",
      status: "revertible",
      revertTo: "s-1vcpu-1gb",
      changedTo: "s-4vcpu-8gb",
      current: "s-4vcpu-8gb",
    });
    expect(buildRevertPatch(plan)).toEqual({ size: "s-1vcpu-1gb" });
  });

  it("keeps the recorded field order and reverts only the revertible ones", () => {
    const plan = computeRevertPlan(
      args({
        diff: [
          change("size", "small", "large"),
          change("region", "nyc1", "nyc1"),
          change("locked", false, true),
        ],
        currentFields: { size: "large", region: "nyc1", locked: true },
        editableFieldKeys: ["size", "region", "locked"],
      }),
    );
    expect(plan.fields.map((f) => f.field)).toEqual(["size", "region", "locked"]);
    // `region` never actually moved, so it reads as a no-op rather than a write.
    expect(plan.fields[1]?.status).toBe("already-reverted");
    expect(plan.revertibleFields).toEqual(["size", "locked"]);
    expect(buildRevertPatch(plan)).toEqual({ size: "small", locked: "false" });
  });
});

describe("computeRevertPlan — no-op", () => {
  it("reports a field already back at the old value, and writes nothing", () => {
    const plan = computeRevertPlan(
      args({
        diff: [change("size", "small", "large")],
        currentFields: { size: "small" },
        editableFieldKeys: ["size"],
      }),
    );
    expect(plan.fields[0]?.status).toBe("already-reverted");
    expect(plan.revertible).toBe(false);
    expect(plan.blockedReason).toMatch(/already back at/);
    expect(buildRevertPatch(plan)).toEqual({});
  });

  it("prefers the no-op reading over 'not writable' when the value already matches", () => {
    const plan = computeRevertPlan(
      args({
        diff: [change("name", "web-1", "web-2")],
        currentFields: { name: "web-1" },
        editableFieldKeys: [],
      }),
    );
    expect(plan.fields[0]?.status).toBe("already-reverted");
  });
});

describe("computeRevertPlan — conflict", () => {
  it("excludes a field that changed again since, and keeps both values visible", () => {
    const plan = computeRevertPlan(
      args({
        diff: [change("size", "small", "large")],
        currentFields: { size: "enormous" },
        editableFieldKeys: ["size"],
      }),
    );
    expect(plan.fields[0]).toMatchObject({
      status: "conflict",
      revertTo: "small",
      changedTo: "large",
      current: "enormous",
    });
    expect(plan.revertible).toBe(false);
    expect(plan.blockedReason).toMatch(/changed again/);
    expect(buildRevertPatch(plan)).toEqual({});
  });

  it("compares structurally, so a reordered object is not a conflict", () => {
    const plan = computeRevertPlan(
      args({
        diff: [change("tags", "a", { env: "prod", tier: "web" })],
        currentFields: { tags: { tier: "web", env: "prod" } },
        editableFieldKeys: ["tags"],
      }),
    );
    // Structurally equal to `to`, so it is not a conflict — but the old value
    // is a string here, which *is* writable, so it reverts.
    expect(plan.fields[0]?.status).toBe("revertible");
  });
});

describe("computeRevertPlan — not writable", () => {
  it("excludes a field the plugin's edit form doesn't offer", () => {
    const plan = computeRevertPlan(
      args({
        diff: [change("privateIp", "10.0.0.1", "10.0.0.2")],
        currentFields: { privateIp: "10.0.0.2" },
        editableFieldKeys: ["name"],
      }),
    );
    expect(plan.fields[0]?.status).toBe("not-writable");
    expect(plan.fields[0]?.reason).toMatch(/edit form doesn't offer/);
    expect(plan.blockedReason).toMatch(/None of the fields/);
  });

  it("excludes a previous value the text-only update path can't express", () => {
    const plan = computeRevertPlan(
      args({
        diff: [change("firewall", { rules: [1, 2] }, "open")],
        currentFields: { firewall: "open" },
        editableFieldKeys: ["firewall"],
      }),
    );
    expect(plan.fields[0]?.status).toBe("not-writable");
    expect(plan.fields[0]?.reason).toMatch(/isn't a plain value/);
  });

  it("excludes a field that had no value before — the form can't unset one", () => {
    const plan = computeRevertPlan(
      args({
        diff: [change("label", null, "staging")],
        currentFields: { label: "staging" },
        editableFieldKeys: ["label"],
      }),
    );
    expect(plan.fields[0]?.status).toBe("not-writable");
    expect(plan.fields[0]?.reason).toMatch(/can't unset/);
  });
});

describe("computeRevertPlan — provider-derived outputs", () => {
  it("never writes an outputs.* entry, even alongside a writable field", () => {
    const plan = computeRevertPlan(
      args({
        diff: [change("outputs.publicIp", "1.2.3.4", "5.6.7.8"), change("size", "small", "large")],
        currentFields: { size: "large", "outputs.publicIp": "5.6.7.8" },
        editableFieldKeys: ["size", "outputs.publicIp"],
      }),
    );
    expect(plan.fields[0]?.status).toBe("provider-derived");
    // No live value is quoted for an output — there is nothing to reconcile.
    expect(plan.fields[0]?.current).toBeUndefined();
    expect(plan.revertibleFields).toEqual(["size"]);
    expect(buildRevertPatch(plan)).toEqual({ size: "small" });
  });
});

describe("revertLooksAlreadyApplied", () => {
  const planOf = (...statuses: Array<RevertFieldPlan["status"]>): RevertPlan => ({
    fields: statuses.map((status, i) => ({
      field: `f${i}`,
      revertTo: "old",
      changedTo: "new",
      current: "old",
      status,
      reason: "",
    })),
    revertibleFields: [],
    revertible: false,
    blockedReason: null,
  });

  it("recognises an interrupted attempt whose write was journalled", () => {
    expect(revertLooksAlreadyApplied(planOf("already-reverted"), true)).toBe(true);
    expect(revertLooksAlreadyApplied(planOf("already-reverted", "provider-derived"), true)).toBe(
      true,
    );
    // Fields a revert would never have written don't spoil the reading.
    expect(revertLooksAlreadyApplied(planOf("already-reverted", "not-writable"), true)).toBe(true);
  });

  /**
   * The distinction that keeps this from attributing somebody's hand-edit to
   * whoever next opens the dialog. No journal entry means no write was ever
   * issued for this event — which is a recorded fact, not an inference from a
   * lock that an attempt dying before its write would also have left behind.
   */
  it("does not mistake a hand-reverted resource for an interrupted attempt", () => {
    expect(revertLooksAlreadyApplied(planOf("already-reverted"), false)).toBe(false);
    expect(revertLooksAlreadyApplied(planOf("already-reverted", "not-writable"), false)).toBe(
      false,
    );
  });

  it("refuses when anything is still writable or ambiguous", () => {
    // Something left to do — this is an ordinary revert, not a reconciliation.
    expect(revertLooksAlreadyApplied(planOf("already-reverted", "revertible"), true)).toBe(false);
    // A field that moved on again is evidence of nothing.
    expect(revertLooksAlreadyApplied(planOf("already-reverted", "conflict"), true)).toBe(false);
  });

  it("refuses when nothing actually moved back", () => {
    expect(revertLooksAlreadyApplied(planOf("not-writable"), true)).toBe(false);
    expect(revertLooksAlreadyApplied(planOf("provider-derived"), true)).toBe(false);
    expect(revertLooksAlreadyApplied(planOf(), true)).toBe(false);
  });
});

describe("revertValueAsText", () => {
  it("passes strings through and stringifies scalars", () => {
    expect(revertValueAsText("nyc1")).toBe("nyc1");
    expect(revertValueAsText(4)).toBe("4");
    expect(revertValueAsText(false)).toBe("false");
  });

  it("refuses anything the edit form can't submit", () => {
    expect(revertValueAsText(null)).toBeNull();
    expect(revertValueAsText(undefined)).toBeNull();
    expect(revertValueAsText({ a: 1 })).toBeNull();
    expect(revertValueAsText([1, 2])).toBeNull();
    expect(revertValueAsText(Number.NaN)).toBeNull();
  });
});

describe("localRevertRefusal", () => {
  it("passes an updated event with a diff through to the server", () => {
    expect(localRevertRefusal({ changeKind: "updated", diff: [change("a", 1, 2)] })).toBeNull();
  });

  it("refuses created, deleted, empty-diff and already-reverted rows", () => {
    expect(localRevertRefusal({ changeKind: "created", diff: [] })).toMatch(/Appearances/);
    expect(localRevertRefusal({ changeKind: "deleted", diff: [] })).toMatch(/Disappearances/);
    expect(localRevertRefusal({ changeKind: "updated", diff: [] })).toMatch(/no field-level/);
    expect(
      localRevertRefusal({
        changeKind: "updated",
        diff: [change("a", 1, 2)],
        revertedAt: "2026-08-01T00:00:00.000Z",
      }),
    ).toMatch(/Already reverted/);
  });
});
