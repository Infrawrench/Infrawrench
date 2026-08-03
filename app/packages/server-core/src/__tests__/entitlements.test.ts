import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
vi.mock("../db/client", () => ({ db: { select: (...a: unknown[]) => mockSelect(...a) } }));

const { planAccess, requirePaidPlan, PlanRequiredError } = await import("../entitlements");

/** Queue one select chain per query, in call order: the org row, then subs. */
function selectSequence(...rowSets: unknown[][]) {
  for (const rows of rowSets) {
    const where = vi.fn().mockResolvedValue(rows);
    const from = vi.fn().mockReturnValue({ where });
    mockSelect.mockReturnValueOnce({ from });
  }
}

const orgRow = (complimentary: boolean) => [{ complimentary }];
const sub = (status: string, stripeSubscriptionId: string | null = "sub_live") => ({
  status,
  stripeSubscriptionId,
});

describe("planAccess", () => {
  beforeEach(() => vi.clearAllMocks());

  it("grants complimentary orgs without consulting subscriptions", async () => {
    selectSequence(orgRow(true));
    expect(await planAccess("org-1")).toEqual({ paid: true, reason: "complimentary" });
    expect(mockSelect).toHaveBeenCalledTimes(1);
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
});

describe("requirePaidPlan", () => {
  beforeEach(() => vi.clearAllMocks());

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
