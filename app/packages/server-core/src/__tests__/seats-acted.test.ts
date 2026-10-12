import { describe, expect, it } from "vitest";
import type { SeatFinding, SeatRow } from "@infrawrench/client-core";
import type { SeatRecord } from "@infrawrench/plugin-base";
import { actedOnFindings } from "../seats/acted";

function row(over: Partial<SeatRow> = {}): SeatRow {
  return {
    id: "s1",
    accountId: "a1",
    accountName: "Acme",
    pluginId: "cursor",
    pluginName: "Cursor",
    memberId: "m1",
    seatKey: "",
    name: null,
    email: "a@acme.dev",
    login: null,
    product: "Cursor",
    category: "ai-coding",
    seatType: "Premium",
    monthlyPrice: 120,
    currency: "USD",
    priceSource: "configured",
    priceNote: null,
    activityBasis: "usage-window",
    lastActiveAt: null,
    activityWindowDays: 30,
    activitySource: "",
    assignedAt: null,
    pendingRemovalOn: null,
    removable: true,
    removalNote: null,
    downgrade: {
      seatType: "Standard",
      price: { monthly: 40, currency: "USD", source: "configured" },
      reason: "Low usage",
    },
    context: {},
    resource: null,
    lastSeenAt: "2026-10-01T00:00:00Z",
    ...over,
  };
}

function record(over: Partial<SeatRecord> = {}): SeatRecord {
  return {
    memberId: "m1",
    name: null,
    email: "a@acme.dev",
    product: "Cursor",
    category: "ai-coding",
    seatType: "Premium",
    price: null,
    activity: { basis: "usage-window", lastActiveAt: null, source: "" },
    assignedAt: null,
    removable: true,
    ...over,
  };
}

const inactive: SeatFinding = {
  kind: "inactive",
  seatId: "s1",
  monthlySaving: 120,
  currency: "USD",
};
const downgrade: SeatFinding = { ...inactive, kind: "downgrade", monthlySaving: 80 };

describe("actedOnFindings", () => {
  it("credits a flagged seat that disappeared", () => {
    const out = actedOnFindings([row()], [inactive], []);
    expect(out.map((o) => o.action)).toEqual(["remove"]);
  });

  it("credits a flagged seat newly pending removal, but not one already pending", () => {
    const next = [record({ pendingRemovalOn: "2026-11-01" })];
    expect(actedOnFindings([row()], [inactive], next)).toHaveLength(1);
    expect(
      actedOnFindings([row({ pendingRemovalOn: "2026-10-30T00:00:00Z" })], [inactive], next),
    ).toHaveLength(0);
  });

  it("credits nothing for a flagged seat still held", () => {
    expect(actedOnFindings([row()], [inactive], [record()])).toEqual([]);
  });

  it("credits a downgrade only when the seat moved to the suggested tier", () => {
    expect(actedOnFindings([row()], [downgrade], [record({ seatType: "Standard" })])).toHaveLength(
      1,
    );
    expect(actedOnFindings([row()], [downgrade], [record()])).toHaveLength(0);
    // A downgrade finding whose seat was removed outright is not a downgrade.
    expect(actedOnFindings([row()], [downgrade], [])).toHaveLength(0);
  });

  it("matches on seat key as well as member id", () => {
    const keyed = row({ seatKey: "k" });
    expect(actedOnFindings([keyed], [inactive], [record({ seatKey: "k" })])).toEqual([]);
    expect(actedOnFindings([keyed], [inactive], [record()])).toHaveLength(1);
  });
});
