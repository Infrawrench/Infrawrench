import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Capacity slots are money, and two of the ways they can go wrong are silent:
 * a redelivered webhook granting the same paid seats twice, and a term that
 * quietly lands on the wrong date. These pin both, plus the shape of the
 * "still granting" filter that every seat check depends on.
 */

let selectResult: Array<Record<string, unknown>> = [];
const inserted: Array<Record<string, unknown>> = [];
const updated: Array<Record<string, unknown>> = [];
/** Rows the next insert pretends to have written; empty models a conflict. */
let insertReturns: Array<{ id: string }> = [{ id: "slot-1" }];
let updateReturns: Array<{ id: string }> = [];
/** The last where() argument, so filter construction can be asserted on. */
let lastSelectWhere: unknown;

const db = {
  select: () => ({
    from: () => ({
      where: (cond: unknown) => {
        lastSelectWhere = cond;
        return Promise.resolve(selectResult);
      },
      orderBy: () => Promise.resolve(selectResult),
    }),
  }),
  insert: () => ({
    values: (values: Record<string, unknown>) => {
      inserted.push(values);
      return {
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve(insertReturns),
        }),
      };
    },
  }),
  update: () => ({
    set: (values: Record<string, unknown>) => {
      updated.push(values);
      return { where: () => ({ returning: () => Promise.resolve(updateReturns) }) };
    },
  }),
};
vi.mock("../db/client", () => ({ db }));
vi.mock("../db/schema", () => ({
  capacitySlots: {
    organizationId: "organization_id",
    quantity: "quantity",
    status: "status",
    stripeCheckoutSessionId: "stripe_checkout_session_id",
    stripePaymentIntentId: "stripe_payment_intent_id",
    expiresAt: "expires_at",
    startsAt: "starts_at",
    termMonths: "term_months",
    amountPaidCents: "amount_paid_cents",
    id: "id",
  },
}));
// Comparators are recorded rather than executed: the point is that timestamps go
// through gt()/eq() (drizzle serializes them) and never a raw sql`` fragment
// with an interpolated Date, which postgres.js rejects as a bind parameter.
vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => ({ and: parts }),
  desc: (c: unknown) => ({ desc: c }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  gt: (a: unknown, b: unknown) => ({ gt: [a, b] }),
  sql: Object.assign((..._a: unknown[]) => ({ sql: true }), { raw: () => ({ sql: true }) }),
}));

const mod = await import("../billing/capacity-slots");

beforeEach(() => {
  selectResult = [];
  inserted.length = 0;
  updated.length = 0;
  insertReturns = [{ id: "slot-1" }];
  updateReturns = [];
  lastSelectWhere = undefined;
});

describe("capacitySlotExpiry", () => {
  it("lands on the same day of the month two years later", () => {
    expect(mod.capacitySlotExpiry(new Date("2026-08-06T12:30:00.000Z")).toISOString()).toBe(
      "2028-08-06T12:30:00.000Z",
    );
  });

  it("keeps the time of day, so a slot never expires early on its last day", () => {
    const start = new Date("2026-01-31T23:59:00.000Z");
    expect(mod.capacitySlotExpiry(start).toISOString()).toBe("2028-01-31T23:59:00.000Z");
  });

  it("rolls a Feb 29 purchase forward to Mar 1, favouring the customer", () => {
    // 2028 is a leap year, 2026 is not: +24 months from Feb 29 2028 has no
    // Feb 29 to land on, and month overflow gives the extra day rather than
    // silently taking one away.
    expect(mod.capacitySlotExpiry(new Date("2028-02-29T00:00:00.000Z")).toISOString()).toBe(
      "2030-03-01T00:00:00.000Z",
    );
  });

  it("honours a non-default term", () => {
    expect(mod.capacitySlotExpiry(new Date("2026-08-06T00:00:00.000Z"), 12).toISOString()).toBe(
      "2027-08-06T00:00:00.000Z",
    );
  });

  it("sells a two-year term by default", () => {
    expect(mod.CAPACITY_SLOT_TERM_MONTHS).toBe(24);
  });
});

describe("activeCapacitySeats", () => {
  it("is 0 for an org that has never bought a slot", async () => {
    selectResult = [{ seats: 0 }];
    expect(await mod.activeCapacitySeats("org-1")).toBe(0);
  });

  it("is 0 when the aggregate comes back empty", async () => {
    selectResult = [];
    expect(await mod.activeCapacitySeats("org-1")).toBe(0);
  });

  it("coerces the driver's numeric sum, which can arrive as a string", async () => {
    selectResult = [{ seats: "5" }];
    expect(await mod.activeCapacitySeats("org-1")).toBe(5);
  });

  it("filters on org, active status, and an unexpired term", async () => {
    selectResult = [{ seats: 3 }];
    await mod.activeCapacitySeats("org-1");
    const cond = lastSelectWhere as { and: unknown[] };
    expect(cond.and).toHaveLength(3);
    expect(cond.and[0]).toEqual({ eq: ["organization_id", "org-1"] });
    expect(cond.and[1]).toEqual({ eq: ["status", "active"] });
    // A Date through gt(), not interpolated into raw SQL.
    const [column, cutoff] = (cond.and[2] as { gt: [string, Date] }).gt;
    expect(column).toBe("expires_at");
    expect(cutoff).toBeInstanceOf(Date);
  });
});

describe("recordCapacitySlotPurchase", () => {
  const input = {
    organizationId: "org-1",
    quantity: 2,
    stripeCheckoutSessionId: "cs_1",
    stripePaymentIntentId: "pi_1",
    amountPaidCents: 40000,
    startsAt: new Date("2026-08-06T00:00:00.000Z"),
  };

  it("writes the purchase with its computed term", async () => {
    const { granted, expiresAt } = await mod.recordCapacitySlotPurchase(input);
    expect(granted).toBe(true);
    expect(expiresAt.toISOString()).toBe("2028-08-06T00:00:00.000Z");
    expect(inserted[0]).toMatchObject({
      organizationId: "org-1",
      quantity: 2,
      status: "active",
      stripeCheckoutSessionId: "cs_1",
      stripePaymentIntentId: "pi_1",
      amountPaidCents: 40000,
      termMonths: 24,
    });
  });

  it("reports granted: false when the session was already recorded", async () => {
    // The redelivery case: Stripe sends the same event twice and the unique
    // index turns the second insert into a no-op. Granting twice here would
    // hand out paid seats for free.
    insertReturns = [];
    const { granted } = await mod.recordCapacitySlotPurchase(input);
    expect(granted).toBe(false);
  });

  it("clamps a malformed quantity up to one seat", async () => {
    await mod.recordCapacitySlotPurchase({ ...input, quantity: 0 });
    expect(inserted[0]?.["quantity"]).toBe(1);
  });

  it("truncates a fractional quantity", async () => {
    await mod.recordCapacitySlotPurchase({ ...input, quantity: 2.7 });
    expect(inserted[0]?.["quantity"]).toBe(2);
  });
});

describe("refundCapacitySlots", () => {
  it("returns how many purchases it voided", async () => {
    updateReturns = [{ id: "slot-1" }, { id: "slot-2" }];
    expect(await mod.refundCapacitySlots("pi_1")).toBe(2);
    // Marked, not deleted: capacity stops but the purchase history stands.
    expect(updated[0]).toMatchObject({ status: "refunded" });
  });

  it("is 0 when the payment intent bought no capacity", async () => {
    updateReturns = [];
    expect(await mod.refundCapacitySlots("pi_unrelated")).toBe(0);
  });
});
