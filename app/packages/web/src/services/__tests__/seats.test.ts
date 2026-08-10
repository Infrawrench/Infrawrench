import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
const mockUpdate = vi.fn();
vi.mock("@/db/client", () => ({
  db: {
    select: (...a: unknown[]) => mockSelect(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
  },
}));
vi.mock("@/db/schema", () => ({
  subscriptions: { id: "id", organizationId: "org" },
  organizationMembers: { organizationId: "org" },
  invitations: { organizationId: "org", acceptedAt: "accepted_at", expiresAt: "expires_at" },
}));

const mockRetrieve = vi.fn();
const mockItemUpdate = vi.fn();
const mockGetStripe = vi.fn(() => ({
  subscriptions: { retrieve: (...a: unknown[]) => mockRetrieve(...a) },
  subscriptionItems: { update: (...a: unknown[]) => mockItemUpdate(...a) },
}));
vi.mock("@/services/stripe", () => ({ getStripe: () => mockGetStripe() }));

// Prepaid capacity is its own query against its own table, so it is stubbed
// rather than threaded through selectSequence — these tests are about how seat
// accounting combines the two sources, not about the slot query itself.
const mockActiveCapacitySeats = vi.fn<() => Promise<number>>();
vi.mock("@infrawrench/server-core/billing/capacity-slots", () => ({
  activeCapacitySeats: () => mockActiveCapacitySeats(),
}));

const { releaseSeat, addSeat, checkSeatAvailability } = await import("@/services/seats");

/** Queue one select chain per query, in call order. */
function selectSequence(...rowSets: unknown[][]) {
  for (const rows of rowSets) {
    const where = vi.fn().mockResolvedValue(rows);
    const from = vi.fn().mockReturnValue({ where });
    mockSelect.mockReturnValueOnce({ from });
  }
}

function updateChain() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  mockUpdate.mockReturnValue({ set });
  return { set, where };
}

const subRow = (over: Record<string, unknown> = {}) => ({
  id: "sub-row-1",
  organizationId: "org-1",
  stripeSubscriptionId: "sub_stripe",
  status: "active",
  seatCount: 5,
  ...over,
});

const stripeSub = (items: Array<{ id: string; quantity?: number }>) => ({
  items: { data: items },
});

describe("releaseSeat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No prepaid capacity unless a test says otherwise.
    mockActiveCapacitySeats.mockResolvedValue(0);
  });

  it("does nothing without a subscription row (free tier / self-hosted)", async () => {
    selectSequence([]);
    await releaseSeat("org-1");
    expect(mockGetStripe).not.toHaveBeenCalled();
  });

  it("does nothing for a canceled subscription", async () => {
    selectSequence([subRow({ status: "canceled" })]);
    await releaseSeat("org-1");
    expect(mockGetStripe).not.toHaveBeenCalled();
  });

  it("drops one seat and records the new count locally", async () => {
    selectSequence([subRow()], [{ n: 4 }]);
    mockRetrieve.mockResolvedValue(
      stripeSub([{ id: "si_metered" }, { id: "si_seats", quantity: 5 }]),
    );
    const { set } = updateChain();

    await releaseSeat("org-1");

    expect(mockItemUpdate).toHaveBeenCalledWith("si_seats", {
      quantity: 4,
      proration_behavior: "none",
    });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ seatCount: 4 }));
  });

  it("still drops a seat when extra seats were bought beyond the member count", async () => {
    selectSequence([subRow()], [{ n: 4 }]);
    mockRetrieve.mockResolvedValue(stripeSub([{ id: "si_seats", quantity: 10 }]));
    updateChain();

    await releaseSeat("org-1");

    expect(mockItemUpdate).toHaveBeenCalledWith("si_seats", {
      quantity: 9,
      proration_behavior: "none",
    });
  });

  it("never drops below the members still in the org", async () => {
    // Undersold org: 3 seats, 4 people remain. Shrinking further (or charging
    // upward) is not this path's job.
    selectSequence([subRow()], [{ n: 4 }]);
    mockRetrieve.mockResolvedValue(stripeSub([{ id: "si_seats", quantity: 3 }]));

    await releaseSeat("org-1");

    expect(mockItemUpdate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("never drops below one seat", async () => {
    selectSequence([subRow()], [{ n: 0 }]);
    mockRetrieve.mockResolvedValue(stripeSub([{ id: "si_seats", quantity: 1 }]));

    await releaseSeat("org-1");

    expect(mockItemUpdate).not.toHaveBeenCalled();
  });

  it("skips subscriptions with only metered items", async () => {
    selectSequence([subRow()], [{ n: 2 }]);
    mockRetrieve.mockResolvedValue(stripeSub([{ id: "si_metered" }]));

    await releaseSeat("org-1");

    expect(mockItemUpdate).not.toHaveBeenCalled();
  });

  it("shrinks past the member count when prepaid slots cover those members", async () => {
    // 4 members remain but 3 are covered by prepaid slots, so only 1 needs a
    // rented seat — the monthly floor is 1, not 4.
    mockActiveCapacitySeats.mockResolvedValue(3);
    selectSequence([subRow()], [{ n: 4 }]);
    mockRetrieve.mockResolvedValue(stripeSub([{ id: "si_seats", quantity: 4 }]));
    updateChain();

    await releaseSeat("org-1");

    expect(mockItemUpdate).toHaveBeenCalledWith("si_seats", {
      quantity: 3,
      proration_behavior: "none",
    });
  });

  it("still never drops below one seat when slots cover every member", async () => {
    mockActiveCapacitySeats.mockResolvedValue(5);
    selectSequence([subRow()], [{ n: 3 }]);
    mockRetrieve.mockResolvedValue(stripeSub([{ id: "si_seats", quantity: 1 }]));

    await releaseSeat("org-1");

    expect(mockItemUpdate).not.toHaveBeenCalled();
  });
});

describe("checkSeatAvailability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No prepaid capacity unless a test says otherwise.
    mockActiveCapacitySeats.mockResolvedValue(0);
  });

  it("is null on the free tier (no subscription row, no prepaid slots)", async () => {
    selectSequence([]);
    expect(await checkSeatAvailability("org-1")).toBeNull();
  });

  it("is null while seats remain", async () => {
    // 5 seats, 3 members + 1 pending invite = 4 used.
    selectSequence([subRow()], [{ n: 3 }], [{ n: 1 }]);
    expect(await checkSeatAvailability("org-1")).toBeNull();
  });

  it("reports the plan as full, counting pending invites as occupied seats", async () => {
    // 5 seats, 3 members + 2 pending invites.
    selectSequence([subRow()], [{ n: 3 }], [{ n: 2 }]);
    expect(await checkSeatAvailability("org-1")).toEqual({
      seatCount: 5,
      seatsUsed: 5,
      canAddSeat: true,
    });
  });

  it("counts prepaid capacity seats on top of the subscription's", async () => {
    // 5 monthly + 2 prepaid = 7 capacity, 6 used: room for one more.
    mockActiveCapacitySeats.mockResolvedValue(2);
    selectSequence([subRow()], [{ n: 5 }], [{ n: 1 }]);
    expect(await checkSeatAvailability("org-1")).toBeNull();
  });

  it("reports full at the combined capacity, not the subscription's alone", async () => {
    mockActiveCapacitySeats.mockResolvedValue(2);
    selectSequence([subRow()], [{ n: 6 }], [{ n: 1 }]);
    expect(await checkSeatAvailability("org-1")).toEqual({
      seatCount: 7,
      seatsUsed: 7,
      canAddSeat: true,
    });
  });

  it("enforces prepaid capacity for an org with no subscription at all", async () => {
    // The gap this closes: a slot-only org is paid, so the invite route's plan
    // gate lets it through — without capacity here it could invite without limit.
    mockActiveCapacitySeats.mockResolvedValue(2);
    selectSequence([], [{ n: 2 }], [{ n: 0 }]);
    expect(await checkSeatAvailability("org-1")).toEqual({
      seatCount: 2,
      seatsUsed: 2,
      // No subscription item to increment: another slot is the only remedy.
      canAddSeat: false,
    });
  });

  it("is null for a slot-only org with capacity to spare", async () => {
    mockActiveCapacitySeats.mockResolvedValue(3);
    selectSequence([], [{ n: 1 }], [{ n: 1 }]);
    expect(await checkSeatAvailability("org-1")).toBeNull();
  });
});

describe("addSeat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No prepaid capacity unless a test says otherwise.
    mockActiveCapacitySeats.mockResolvedValue(0);
  });

  it("throws without a live subscription", async () => {
    selectSequence([]);
    await expect(addSeat("org-1")).rejects.toThrow(/no live subscription/);
  });

  it("bumps the licensed quantity by one and records it locally", async () => {
    selectSequence([subRow()]);
    mockRetrieve.mockResolvedValue(
      stripeSub([{ id: "si_metered" }, { id: "si_seats", quantity: 5 }]),
    );
    const { set } = updateChain();

    await addSeat("org-1");

    expect(mockItemUpdate).toHaveBeenCalledWith("si_seats", { quantity: 6 });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ seatCount: 6 }));
  });

  it("propagates Stripe failures so the invite is not sent", async () => {
    selectSequence([subRow()]);
    mockRetrieve.mockResolvedValue(stripeSub([{ id: "si_seats", quantity: 5 }]));
    mockItemUpdate.mockRejectedValueOnce(new Error("stripe down"));

    await expect(addSeat("org-1")).rejects.toThrow("stripe down");
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
