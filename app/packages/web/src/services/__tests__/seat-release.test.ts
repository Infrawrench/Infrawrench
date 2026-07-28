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
}));

const mockRetrieve = vi.fn();
const mockItemUpdate = vi.fn();
const mockGetStripe = vi.fn(() => ({
  subscriptions: { retrieve: (...a: unknown[]) => mockRetrieve(...a) },
  subscriptionItems: { update: (...a: unknown[]) => mockItemUpdate(...a) },
}));
vi.mock("@/services/stripe", () => ({ getStripe: () => mockGetStripe() }));

const { releaseSeat } = await import("@/services/seat-release");

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
  beforeEach(() => vi.clearAllMocks());

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
});
