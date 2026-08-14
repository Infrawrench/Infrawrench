import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Capacity slots are money, and two of the ways they can go wrong are silent:
 * a redelivered webhook granting the same paid seats twice, and a term that
 * quietly lands on the wrong date. These pin both, plus the shape of the
 * "still granting" filter that every seat check depends on.
 */

import { fakePostgres } from "./helpers/fake-postgres";

// Real Drizzle over a recording driver against the real schema: every chain
// renders its actual SQL (and shadow-validates under test:postgres:shadow).
// Rows fed in are what each statement returns — for the insert/update chains
// that is the `returning({ id })` result, where empty models a conflict (or a
// payment intent that bought nothing).
const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

/** The insert's params, positional in the rendered statement's column order. */
const insertParams = () =>
  pg.queries.find((q) => q.sql.startsWith('insert into "capacity_slots"'))?.params ?? [];

const mod = await import("../billing/capacity-slots");

beforeEach(() => {
  pg.reset();
  // The purchase tests' default: the insert reports one written row.
  pg.setRows([{ id: "slot-1" }]);
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
    pg.setRows([{ seats: 0 }]);
    expect(await mod.activeCapacitySeats("org-1")).toBe(0);
  });

  it("is 0 when the aggregate comes back empty", async () => {
    pg.setRows([]);
    expect(await mod.activeCapacitySeats("org-1")).toBe(0);
  });

  it("coerces the driver's numeric sum, which can arrive as a string", async () => {
    pg.setRows([{ seats: "5" }]);
    expect(await mod.activeCapacitySeats("org-1")).toBe(5);
  });

  it("filters on org, active status, and an unexpired term", async () => {
    pg.setRows([{ seats: 3 }]);
    await mod.activeCapacitySeats("org-1");
    const { sql, params } = pg.lastQuery();
    expect(sql).toContain('"organization_id" = $1');
    expect(sql).toContain('"status" = $2');
    // The cutoff arrives as a bound timestamp, not interpolated into raw SQL —
    // interpolating a Date hands postgres.js a bind parameter it rejects.
    expect(sql).toContain('"expires_at" > $3');
    expect(params[0]).toBe("org-1");
    expect(params[1]).toBe("active");
    expect(Number.isNaN(new Date(params[2] as string).getTime())).toBe(false);
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
    expect(pg.lastQuery().sql).toContain('on conflict ("stripe_checkout_session_id") do nothing');
    // (id, organization_id, quantity, status, session, payment intent,
    //  amount paid, term months, starts_at, expires_at)
    expect(insertParams().slice(1, 8)).toEqual(["org-1", 2, "active", "cs_1", "pi_1", 40000, 24]);
  });

  it("reports granted: false when the session was already recorded", async () => {
    // The redelivery case: Stripe sends the same event twice and the unique
    // index turns the second insert into a no-op. Granting twice here would
    // hand out paid seats for free.
    pg.setRows([]);
    const { granted } = await mod.recordCapacitySlotPurchase(input);
    expect(granted).toBe(false);
  });

  it("clamps a malformed quantity up to one seat", async () => {
    await mod.recordCapacitySlotPurchase({ ...input, quantity: 0 });
    expect(insertParams()[2]).toBe(1);
  });

  it("truncates a fractional quantity", async () => {
    await mod.recordCapacitySlotPurchase({ ...input, quantity: 2.7 });
    expect(insertParams()[2]).toBe(2);
  });
});

describe("refundCapacitySlots", () => {
  it("returns how many purchases it voided", async () => {
    pg.setRows([{ id: "slot-1" }, { id: "slot-2" }]);
    expect(await mod.refundCapacitySlots("pi_1")).toBe(2);
    // Marked, not deleted: capacity stops but the purchase history stands.
    // set "status" = $1, "updated_at" = $2 where intent = $3 and status = $4
    const update = pg.lastQuery();
    expect(update.sql.startsWith('update "capacity_slots"')).toBe(true);
    expect(update.params[0]).toBe("refunded");
    expect(update.params[2]).toBe("pi_1");
    expect(update.params[3]).toBe("active");
  });

  it("is 0 when the payment intent bought no capacity", async () => {
    pg.setRows([]);
    expect(await mod.refundCapacitySlots("pi_unrelated")).toBe(0);
  });
});
