import { describe, it, expect, vi, beforeEach } from "vitest";

import { fakePostgres } from "./helpers/fake-postgres";

// Real Drizzle over a recording driver: the org and subscription lookups render
// their actual SQL (and shadow-validate under test:postgres:shadow).
const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

// Prepaid capacity queries its own table, so it is stubbed rather than queued
// into selectSequence — these tests are about which source wins.
const mockActiveCapacitySeats = vi.fn<() => Promise<number>>();
vi.mock("../billing/capacity-slots", () => ({
  activeCapacitySeats: () => mockActiveCapacitySeats(),
}));

const { planAccess, requirePaidPlan, PlanRequiredError } = await import("../entitlements");

/** Queue one query's rows, in call order: the org row, then subs. Keys in projection order. */
function selectSequence(...rowSets: Array<Array<Record<string, unknown>>>) {
  for (const rows of rowSets) pg.queueRows(rows);
}

const orgRow = (complimentary: boolean) => [{ complimentary }];
const sub = (status: string, stripeSubscriptionId: string | null = "sub_live") => ({
  status,
  stripeSubscriptionId,
});

describe("planAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pg.reset();
    // No prepaid capacity unless a test says otherwise.
    mockActiveCapacitySeats.mockResolvedValue(0);
  });

  it("grants complimentary orgs without consulting subscriptions", async () => {
    selectSequence(orgRow(true));
    expect(await planAccess("org-1")).toEqual({ paid: true, reason: "complimentary" });
    expect(pg.queries).toHaveLength(1);
    expect(pg.lastQuery().sql).toContain('from "organizations"');
  });

  it("denies with reason none when there are no subscription rows", async () => {
    selectSequence(orgRow(false), []);
    expect(await planAccess("org-1")).toEqual({ paid: false, reason: "none" });
  });

  it("denies a placeholder trialing row from an abandoned checkout", async () => {
    // The checkout route inserts status "trialing" with no Stripe subscription
    // before payment; if checkout is abandoned that row lingers forever and
    // must grant nothing — including the "reactivate" reason, since this org
    // never subscribed.
    selectSequence(orgRow(false), [sub("trialing", null)]);
    expect(await planAccess("org-1")).toEqual({ paid: false, reason: "none" });
  });

  it("grants a trial that Stripe itself reported", async () => {
    selectSequence(orgRow(false), [sub("trialing", "sub_123")]);
    expect(await planAccess("org-1")).toEqual({
      paid: true,
      reason: "subscription",
      status: "trialing",
    });
  });

  it("grants active subscriptions", async () => {
    selectSequence(orgRow(false), [sub("active")]);
    expect(await planAccess("org-1")).toEqual({
      paid: true,
      reason: "subscription",
      status: "active",
    });
  });

  it("keeps past_due paid while Stripe retries the card — even without the id check", async () => {
    // Only `trialing` needs the stripeSubscriptionId backstop; active/past_due
    // are only ever written by the webhooks and keep their semantics.
    selectSequence(orgRow(false), [sub("past_due", null)]);
    expect(await planAccess("org-1")).toEqual({
      paid: true,
      reason: "subscription",
      status: "past_due",
    });
  });

  it("grants access when a stale canceled row sits alongside a live active one", async () => {
    selectSequence(orgRow(false), [sub("canceled"), sub("active")]);
    expect(await planAccess("org-1")).toEqual({
      paid: true,
      reason: "subscription",
      status: "active",
    });
  });

  it("grants access regardless of the order rows come back in", async () => {
    selectSequence(orgRow(false), [sub("active"), sub("canceled")]);
    expect(await planAccess("org-1")).toEqual({
      paid: true,
      reason: "subscription",
      status: "active",
    });
  });

  it("reports a lapsed subscription as inactive", async () => {
    selectSequence(orgRow(false), [sub("canceled")]);
    expect(await planAccess("org-1")).toEqual({
      paid: false,
      reason: "inactive",
      status: "canceled",
    });
  });

  it("prefers the lapsed row's status over a placeholder's when both exist", async () => {
    selectSequence(orgRow(false), [sub("trialing", null), sub("canceled")]);
    expect(await planAccess("org-1")).toEqual({
      paid: false,
      reason: "inactive",
      status: "canceled",
    });
  });

  it("grants an org holding only a prepaid capacity slot", async () => {
    // The slot was bought outright. With no subscription row at all this org
    // still has to be paid, or it could not use the seat it paid for.
    mockActiveCapacitySeats.mockResolvedValue(1);
    selectSequence(orgRow(false), []);
    expect(await planAccess("org-1")).toEqual({ paid: true, reason: "capacity_slot" });
  });

  it("grants a prepaid slot even when the subscription has lapsed", async () => {
    // A slot outlives the monthly plan by design — cancelling the subscription
    // cannot revoke a term that is already paid for.
    mockActiveCapacitySeats.mockResolvedValue(2);
    selectSequence(orgRow(false), [sub("canceled")]);
    expect(await planAccess("org-1")).toEqual({ paid: true, reason: "capacity_slot" });
  });

  it("reports the subscription, not the slot, when both are live", async () => {
    // Reason drives the message shown on denial; a live subscription is the
    // more useful thing to name, and this path never reaches the slot query.
    mockActiveCapacitySeats.mockResolvedValue(2);
    selectSequence(orgRow(false), [sub("active")]);
    expect(await planAccess("org-1")).toEqual({
      paid: true,
      reason: "subscription",
      status: "active",
    });
    expect(mockActiveCapacitySeats).not.toHaveBeenCalled();
  });

  it("denies once every slot has lapsed or been refunded", async () => {
    // activeCapacitySeats excludes expired and refunded rows, so an org whose
    // last term ran out reads as never having subscribed.
    mockActiveCapacitySeats.mockResolvedValue(0);
    selectSequence(orgRow(false), []);
    expect(await planAccess("org-1")).toEqual({ paid: false, reason: "none" });
  });

  it("does not consult slots for a complimentary org", async () => {
    selectSequence(orgRow(true));
    await planAccess("org-1");
    expect(mockActiveCapacitySeats).not.toHaveBeenCalled();
  });
});

describe("requirePaidPlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pg.reset();
    // No prepaid capacity unless a test says otherwise.
    mockActiveCapacitySeats.mockResolvedValue(0);
  });

  it("passes silently for a paid org", async () => {
    selectSequence(orgRow(false), [sub("active")]);
    await expect(requirePaidPlan("org-1", "Custom graphs")).resolves.toBeUndefined();
  });

  it("tells an abandoned-checkout org to upgrade, not to reactivate", async () => {
    selectSequence(orgRow(false), [sub("trialing", null)]);
    await expect(requirePaidPlan("org-1", "Custom graphs")).rejects.toThrow(
      /available on the paid plan/,
    );
  });

  it("tells a lapsed org to reactivate", async () => {
    selectSequence(orgRow(false), [sub("canceled")]);
    const err = await requirePaidPlan("org-1", "Custom graphs").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanRequiredError);
    expect((err as Error).message).toMatch(/subscription is canceled/);
  });
});
