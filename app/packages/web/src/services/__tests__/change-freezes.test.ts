import { describe, it, expect, vi } from "vitest";

vi.mock("../../db/client", () => ({ db: {} }));
vi.mock("../audit", () => ({ logAudit: vi.fn() }));

const { schemaDeclaresDestructiveAction, freezeBlockedPayload, describeFreeze } =
  await import("../change-freezes");

const baseFreeze = {
  id: "f1",
  organizationId: "o1",
  name: "Holiday freeze",
  reason: "No changes over the holidays.",
  startsAt: new Date("2026-12-24T00:00:00Z"),
  endsAt: new Date("2027-01-02T09:00:00Z"),
  active: true,
  createdByUserId: "u1",
  endedByUserId: null,
  createdAt: new Date("2026-12-01T00:00:00Z"),
  updatedAt: new Date("2026-12-01T00:00:00Z"),
};

describe("schemaDeclaresDestructiveAction", () => {
  const detail = {
    title: "Cluster",
    tabs: [
      {
        nodes: [
          {
            kind: "action",
            label: "Delete index",
            action: { type: "plugin-action", actionId: "delete-index:foo", destructive: true },
          },
          {
            kind: "action",
            label: "Refresh index",
            action: { type: "plugin-action", actionId: "refresh-index:foo" },
          },
        ],
      },
    ],
  };

  it("finds a destructive flag on a deeply nested plugin-action", () => {
    expect(schemaDeclaresDestructiveAction(detail, "delete-index:foo")).toBe(true);
  });

  it("returns false for an unflagged action", () => {
    expect(schemaDeclaresDestructiveAction(detail, "refresh-index:foo")).toBe(false);
  });

  it("returns false for an unknown actionId", () => {
    expect(schemaDeclaresDestructiveAction(detail, "does-not-exist")).toBe(false);
  });

  it("handles nulls, arrays, and primitives without throwing", () => {
    expect(schemaDeclaresDestructiveAction(null, "x")).toBe(false);
    expect(schemaDeclaresDestructiveAction([1, "a", null], "x")).toBe(false);
  });
});

describe("freezeBlockedPayload", () => {
  it("carries the structured code and freeze summary", () => {
    const payload = freezeBlockedPayload(baseFreeze);
    expect(payload.code).toBe("change_freeze_active");
    expect(payload.freeze).toEqual({
      id: "f1",
      name: "Holiday freeze",
      reason: "No changes over the holidays.",
      startsAt: "2026-12-24T00:00:00.000Z",
      endsAt: "2027-01-02T09:00:00.000Z",
    });
    expect(payload.error).toContain("Holiday freeze");
    expect(payload.error).toContain("x-change-freeze-override");
  });

  it("describes open-ended freezes without an end time", () => {
    expect(describeFreeze({ ...baseFreeze, endsAt: null })).toContain(
      "until it is ended by an admin",
    );
  });
});
