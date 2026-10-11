import { describe, expect, it } from "vitest";
import {
  classifySeat,
  computeSeatFindings,
  seatHolderLabel,
  seatSavingsDedupeKey,
  type SeatRow,
} from "../seats";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function seat(over: Partial<SeatRow> = {}): SeatRow {
  return {
    id: "s1",
    accountId: "a1",
    accountName: "Acme GitHub",
    pluginId: "github",
    pluginName: "GitHub",
    memberId: "m1",
    seatKey: "",
    name: "Ada",
    email: "ada@acme.dev",
    login: "ada",
    product: "GitHub Copilot",
    category: "ai-coding",
    seatType: "Copilot Business",
    monthlyPrice: 19,
    currency: "USD",
    priceSource: "list-price",
    priceNote: null,
    activityBasis: "last-activity",
    lastActiveAt: daysAgo(3),
    activityWindowDays: null,
    activitySource: "Copilot last activity",
    assignedAt: daysAgo(200),
    pendingRemovalOn: null,
    removable: true,
    removalNote: null,
    downgrade: null,
    context: {},
    resource: null,
    lastSeenAt: daysAgo(0),
    ...over,
  };
}

describe("classifySeat", () => {
  it("is active inside the window and inactive at the threshold", () => {
    expect(classifySeat(seat({ lastActiveAt: daysAgo(29) }), 30, NOW).status).toBe("active");
    const out = classifySeat(seat({ lastActiveAt: daysAgo(30) }), 30, NOW);
    expect(out).toEqual({ status: "inactive", daysInactive: 30, neverActive: false });
  });

  it("never flags a provider that reports no activity", () => {
    const out = classifySeat(seat({ activityBasis: "none", lastActiveAt: null }), 30, NOW);
    expect(out.status).toBe("unknown");
  });

  it("treats a recently assigned unused seat as new", () => {
    const out = classifySeat(seat({ lastActiveAt: null, assignedAt: daysAgo(5) }), 30, NOW);
    expect(out).toEqual({ status: "new", daysInactive: 5, neverActive: true });
  });

  it("flags a never-used seat held past the window", () => {
    const out = classifySeat(seat({ lastActiveAt: null, assignedAt: daysAgo(90) }), 30, NOW);
    expect(out).toEqual({ status: "inactive", daysInactive: 90, neverActive: true });
  });

  it("cannot call a never-used seat inactive without an assignment date", () => {
    const out = classifySeat(seat({ lastActiveAt: null, assignedAt: null }), 30, NOW);
    expect(out.status).toBe("unknown");
  });

  it("only trusts a usage window as far as it reaches", () => {
    const windowed = seat({
      activityBasis: "usage-window",
      lastActiveAt: null,
      activityWindowDays: 30,
      assignedAt: null,
    });
    expect(classifySeat(windowed, 60, NOW).status).toBe("unknown");
    expect(classifySeat(windowed, 30, NOW)).toEqual({
      status: "inactive",
      daysInactive: 30,
      neverActive: false,
    });
  });

  it("leaves seats pending removal alone", () => {
    const out = classifySeat(seat({ pendingRemovalOn: "2026-11-01", lastActiveAt: null }), 30, NOW);
    expect(out.status).toBe("pending-removal");
  });
});

describe("computeSeatFindings", () => {
  it("prices inactive seats and totals per currency", () => {
    const out = computeSeatFindings(
      [
        seat({ id: "a", lastActiveAt: daysAgo(60) }),
        seat({ id: "b", memberId: "m2", email: "b@acme.dev", lastActiveAt: daysAgo(2) }),
        seat({
          id: "c",
          memberId: "m3",
          email: "c@acme.dev",
          lastActiveAt: daysAgo(45),
          monthlyPrice: null,
        }),
      ],
      { inactiveDays: 30, now: NOW },
    );
    expect(out.findings.map((f) => [f.kind, f.seatId, f.monthlySaving])).toEqual([
      ["inactive", "a", 19],
      ["inactive", "c", null],
    ]);
    expect(out.savingsMonthly).toEqual([{ currency: "USD", monthly: 19 }]);
    expect(out.spendMonthly).toEqual([{ currency: "USD", monthly: 38 }]);
    expect(out.counts).toMatchObject({ seats: 3, inactive: 2, unpriced: 1 });
  });

  it("keeps the most recently used of two tools in one category", () => {
    const out = computeSeatFindings(
      [
        seat({ id: "copilot", lastActiveAt: daysAgo(10) }),
        seat({
          id: "cursor",
          pluginId: "cursor",
          product: "Cursor",
          seatType: "Teams",
          monthlyPrice: 40,
          lastActiveAt: daysAgo(1),
        }),
      ],
      { inactiveDays: 30, now: NOW },
    );
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({
      kind: "duplicate",
      seatId: "copilot",
      monthlySaving: 19,
      duplicate: { keptSeatId: "cursor", keptProduct: "Cursor" },
    });
  });

  it("does not count an inactive seat twice, nor the same product on two accounts", () => {
    const out = computeSeatFindings(
      [
        seat({ id: "old", lastActiveAt: daysAgo(90) }),
        seat({ id: "cursor", pluginId: "cursor", product: "Cursor", monthlyPrice: 40 }),
        seat({ id: "other-org", accountId: "a2", lastActiveAt: daysAgo(4) }),
      ],
      { inactiveDays: 30, now: NOW },
    );
    // "old" is inactive; "other-org" (Copilot) duplicates Cursor across tools.
    expect(out.findings.map((f) => `${f.kind}:${f.seatId}`).sort()).toEqual([
      "duplicate:other-org",
      "inactive:old",
    ]);
  });

  it("never matches seats in the other category", () => {
    const out = computeSeatFindings(
      [
        seat({ id: "x", category: "other", product: "A" }),
        seat({ id: "y", category: "other", product: "B" }),
      ],
      { inactiveDays: 30, now: NOW },
    );
    expect(out.findings).toEqual([]);
  });

  it("offers a downgrade only when it saves money in the same currency", () => {
    const downgrade = {
      seatType: "Copilot Business",
      price: { monthly: 19, currency: "USD", source: "list-price" as const },
      reason: "No premium features used",
    };
    const out = computeSeatFindings(
      [
        seat({ id: "ent", seatType: "Copilot Enterprise", monthlyPrice: 39, downgrade }),
        seat({
          id: "eur",
          memberId: "m2",
          email: "e@acme.dev",
          monthlyPrice: 39,
          currency: "EUR",
          downgrade,
        }),
      ],
      { inactiveDays: 30, now: NOW },
    );
    expect(out.findings).toEqual([
      {
        kind: "downgrade",
        seatId: "ent",
        monthlySaving: 20,
        currency: "USD",
        targetSeatType: "Copilot Business",
        reason: "No premium features used",
      },
    ]);
  });
});

describe("helpers", () => {
  it("labels the holder and builds a stable dedupe key", () => {
    expect(seatHolderLabel({ name: null, email: null, login: "ada", memberId: "1" })).toBe("ada");
    expect(seatSavingsDedupeKey({ accountId: "a", memberId: "m", seatKey: "" })).toBe(
      "seat_removal:a:m",
    );
    expect(seatSavingsDedupeKey({ accountId: "a", memberId: "m", seatKey: "k" })).toBe(
      "seat_removal:a:m:k",
    );
  });
});
