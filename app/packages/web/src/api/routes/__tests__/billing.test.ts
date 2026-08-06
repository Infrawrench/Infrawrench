import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

const mockSelect = vi.fn();
const mockInsert = vi.fn();
vi.mock("@/db/client", () => ({
  db: {
    select: (...a: unknown[]) => mockSelect(...a),
    insert: (...a: unknown[]) => mockInsert(...a),
  },
}));

const mockCustomersCreate = vi.fn();
const mockCheckoutCreate = vi.fn();
const mockPortalCreate = vi.fn();
const stripeClient = {
  customers: { create: (...a: unknown[]) => mockCustomersCreate(...a) },
  checkout: { sessions: { create: (...a: unknown[]) => mockCheckoutCreate(...a) } },
  billingPortal: { sessions: { create: (...a: unknown[]) => mockPortalCreate(...a) } },
};
const mockChatPriceId = vi.fn<() => string | null>(() => "price_chat");
const mockCapacityPriceId = vi.fn<() => string | null>(() => "price_capacity");
vi.mock("@/services/stripe", () => ({
  getStripe: () => stripeClient,
  getStripePriceId: () => "price_123",
  getStripeChatPriceId: () => mockChatPriceId(),
  // Unset by default: the build line item is opt-in, same as chat's.
  getStripeBuildPriceId: () => null,
  getStripeCapacitySlotPriceId: () => mockCapacityPriceId(),
}));

const mockActiveCapacitySeats = vi.fn<() => Promise<number>>();
const mockListCapacitySlots = vi.fn<() => Promise<unknown[]>>();
vi.mock("@infrawrench/server-core/billing/capacity-slots", () => ({
  CAPACITY_SLOT_TERM_MONTHS: 24,
  CAPACITY_SLOT_PRICE_USD: 200,
  activeCapacitySeats: () => mockActiveCapacitySeats(),
  listCapacitySlots: () => mockListCapacitySlots(),
}));

vi.mock("uuid", () => ({ v4: () => "sub-uuid-1" }));

const { billingRoutes } = await import("@/api/routes/billing");
const buildApp = () => buildTestApp(billingRoutes);

function selectReturns(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  mockSelect.mockReturnValue({ from });
}

/** Queue one select chain per query, in call order. */
function selectSequence(...rowSets: unknown[][]) {
  for (const rows of rowSets) {
    const where = vi.fn().mockResolvedValue(rows);
    const from = vi.fn().mockReturnValue({ where });
    mockSelect.mockReturnValueOnce({ from });
  }
}

const orgRow = (complimentary: boolean) => [{ complimentary }];

/** The capacity envelope for an org that has never bought a slot. */
const noCapacity = {
  purchasable: true,
  termMonths: 24,
  priceUsd: 200,
  seats: 0,
  slots: [],
};

describe("Billing routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveCapacitySeats.mockResolvedValue(0);
    mockListCapacitySlots.mockResolvedValue([]);
  });

  describe("GET /status", () => {
    it("returns a null subscription when none exists", async () => {
      selectSequence(orgRow(false), []);
      const res = await buildApp().request("/status");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        complimentary: false,
        subscription: null,
        capacity: noCapacity,
      });
    });

    it("returns subscription summary fields", async () => {
      selectSequence(orgRow(false), [
        {
          status: "active",
          seatCount: 5,
          currentPeriodEnd: null,
          stripeCustomerId: "cus_1",
        },
      ]);
      const res = await buildApp().request("/status");
      const body = await res.json();
      expect(body).toMatchObject({
        complimentary: false,
        subscription: { status: "active", seatCount: 5, stripeCustomerId: "cus_1" },
      });
    });

    it("flags complimentary orgs", async () => {
      selectSequence(orgRow(true), []);
      const res = await buildApp().request("/status");
      expect(await res.json()).toEqual({
        complimentary: true,
        subscription: null,
        capacity: noCapacity,
      });
    });

    it("reports prepaid capacity seats and purchase history", async () => {
      const slot = {
        id: "slot-1",
        quantity: 2,
        status: "active",
        startsAt: "2026-08-01T00:00:00.000Z",
        expiresAt: "2028-08-01T00:00:00.000Z",
        termMonths: 24,
        amountPaidCents: 40000,
      };
      mockActiveCapacitySeats.mockResolvedValue(2);
      mockListCapacitySlots.mockResolvedValue([slot]);
      selectSequence(orgRow(false), []);

      const res = await buildApp().request("/status");
      expect(await res.json()).toEqual({
        complimentary: false,
        // Prepaid capacity with no subscription at all — the shape a slot-only
        // org returns, which clients must not read as "free".
        subscription: null,
        capacity: { ...noCapacity, seats: 2, slots: [slot] },
      });
    });

    it("reports capacity as unpurchasable when no one-time price is configured", async () => {
      mockCapacityPriceId.mockReturnValueOnce(null);
      selectSequence(orgRow(false), []);
      const res = await buildApp().request("/status");
      expect((await res.json()).capacity.purchasable).toBe(false);
    });
  });

  describe("POST /checkout", () => {
    it("rejects checkout for complimentary orgs", async () => {
      selectSequence(orgRow(true));
      const res = await buildApp().request("/checkout", { method: "POST" });
      expect(res.status).toBe(400);
      expect(mockCheckoutCreate).not.toHaveBeenCalled();
    });

    it("creates a customer + subscription row when none exists", async () => {
      selectSequence(orgRow(false), []);
      const values = vi.fn().mockResolvedValue(undefined);
      mockInsert.mockReturnValue({ values });
      mockCustomersCreate.mockResolvedValue({ id: "cus_new" });
      mockCheckoutCreate.mockResolvedValue({ url: "https://stripe/checkout" });

      const res = await buildApp().request("/checkout", { method: "POST" });
      expect(res.status).toBe(200);
      expect((await res.json()).url).toBe("https://stripe/checkout");
      expect(mockCustomersCreate).toHaveBeenCalled();
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({ stripeCustomerId: "cus_new", status: "trialing" }),
      );
      expect(mockCheckoutCreate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: "cus_new", mode: "subscription" }),
      );
    });

    it("reuses an existing customer id without creating a new one", async () => {
      selectSequence(orgRow(false), [{ stripeCustomerId: "cus_existing" }]);
      mockCheckoutCreate.mockResolvedValue({ url: "https://stripe/checkout2" });
      const res = await buildApp().request("/checkout", { method: "POST" });
      expect(res.status).toBe(200);
      expect(mockCustomersCreate).not.toHaveBeenCalled();
      expect(mockCheckoutCreate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: "cus_existing" }),
      );
    });

    it("re-opens checkout on a placeholder row without inserting a second one", async () => {
      // An abandoned checkout leaves a "trialing" row with no Stripe
      // subscription. Coming back to upgrade must reuse that row's customer,
      // not create another customer or row.
      selectSequence(orgRow(false), [
        { stripeCustomerId: "cus_placeholder", status: "trialing", stripeSubscriptionId: null },
      ]);
      mockCheckoutCreate.mockResolvedValue({ url: "https://stripe/checkout-again" });
      const res = await buildApp().request("/checkout", { method: "POST" });
      expect(res.status).toBe(200);
      expect(mockCustomersCreate).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
      expect(mockCheckoutCreate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: "cus_placeholder" }),
      );
    });

    it("sends adjustable seat quantity plus the metered chat price", async () => {
      selectSequence(orgRow(false), [{ stripeCustomerId: "cus_existing" }]);
      mockCheckoutCreate.mockResolvedValue({ url: "https://stripe/checkout3" });
      await buildApp().request("/checkout", { method: "POST" });
      expect(mockCheckoutCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          line_items: [
            {
              price: "price_123",
              quantity: 1,
              adjustable_quantity: { enabled: true, minimum: 1 },
            },
            { price: "price_chat" },
          ],
        }),
      );
    });

    it("omits the chat line item when STRIPE_CHAT_PRICE_ID is unset", async () => {
      mockChatPriceId.mockReturnValueOnce(null);
      selectSequence(orgRow(false), [{ stripeCustomerId: "cus_existing" }]);
      mockCheckoutCreate.mockResolvedValue({ url: "https://stripe/checkout4" });
      await buildApp().request("/checkout", { method: "POST" });
      const args = mockCheckoutCreate.mock.calls[0]?.[0] as {
        line_items: Array<{ price: string }>;
      };
      expect(args.line_items).toHaveLength(1);
      expect(args.line_items[0]?.price).toBe("price_123");
    });

    it("returns 500 when Stripe yields no checkout url", async () => {
      selectSequence(orgRow(false), [{ stripeCustomerId: "cus_existing" }]);
      mockCheckoutCreate.mockResolvedValue({ url: null });
      const res = await buildApp().request("/checkout", { method: "POST" });
      expect(res.status).toBe(500);
    });
  });

  describe("POST /capacity/checkout", () => {
    const post = (body?: unknown) =>
      buildApp().request("/capacity/checkout", {
        method: "POST",
        ...(body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });

    it("rejects the purchase for complimentary orgs", async () => {
      selectSequence(orgRow(true));
      const res = await post();
      expect(res.status).toBe(400);
      expect(mockCheckoutCreate).not.toHaveBeenCalled();
    });

    it("returns 503 when no one-time capacity price is configured", async () => {
      mockCapacityPriceId.mockReturnValueOnce(null);
      selectSequence(orgRow(false));
      const res = await post();
      expect(res.status).toBe(503);
      expect(mockCheckoutCreate).not.toHaveBeenCalled();
    });

    it("opens a one-time payment session for one slot by default", async () => {
      selectSequence(orgRow(false), [{ stripeCustomerId: "cus_existing" }]);
      mockCheckoutCreate.mockResolvedValue({ url: "https://stripe/capacity" });

      const res = await post();
      expect(res.status).toBe(200);
      expect((await res.json()).url).toBe("https://stripe/capacity");
      expect(mockCheckoutCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: "cus_existing",
          // `payment`, not `subscription`: a slot is bought outright.
          mode: "payment",
          invoice_creation: { enabled: true },
          metadata: { organizationId: "org-1", kind: "capacity_slot" },
          // Mirrored so charge.refunded can find the purchase.
          payment_intent_data: { metadata: { organizationId: "org-1", kind: "capacity_slot" } },
          line_items: [
            {
              price: "price_capacity",
              quantity: 1,
              adjustable_quantity: { enabled: true, minimum: 1, maximum: 25 },
            },
          ],
        }),
      );
    });

    it("passes a requested quantity through", async () => {
      selectSequence(orgRow(false), [{ stripeCustomerId: "cus_existing" }]);
      mockCheckoutCreate.mockResolvedValue({ url: "https://stripe/capacity" });
      await post({ quantity: 3 });
      const args = mockCheckoutCreate.mock.calls[0]?.[0] as {
        line_items: Array<{ quantity: number }>;
      };
      expect(args.line_items[0]?.quantity).toBe(3);
    });

    it.each([0, -1, 1.5, 26, "2"])("rejects the invalid quantity %p", async (quantity) => {
      selectSequence(orgRow(false));
      const res = await post({ quantity });
      expect(res.status).toBe(400);
      expect(mockCheckoutCreate).not.toHaveBeenCalled();
    });

    it("creates the Stripe customer when the org has never paid for anything", async () => {
      // A slot can be the org's first ever purchase, so the customer has to be
      // created here too — and it must be the same customer the monthly plan
      // would use, not a second one.
      selectSequence(orgRow(false), []);
      const values = vi.fn().mockResolvedValue(undefined);
      mockInsert.mockReturnValue({ values });
      mockCustomersCreate.mockResolvedValue({ id: "cus_new" });
      mockCheckoutCreate.mockResolvedValue({ url: "https://stripe/capacity" });

      const res = await post();
      expect(res.status).toBe(200);
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({ stripeCustomerId: "cus_new", status: "trialing" }),
      );
      expect(mockCheckoutCreate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: "cus_new" }),
      );
    });

    it("returns 500 when Stripe yields no checkout url", async () => {
      selectSequence(orgRow(false), [{ stripeCustomerId: "cus_existing" }]);
      mockCheckoutCreate.mockResolvedValue({ url: null });
      expect((await post()).status).toBe(500);
    });
  });

  describe("POST /portal", () => {
    it("returns 404 when no subscription exists", async () => {
      selectReturns([]);
      const res = await buildApp().request("/portal", { method: "POST" });
      expect(res.status).toBe(404);
    });

    it("creates a billing portal session", async () => {
      selectReturns([{ stripeCustomerId: "cus_x" }]);
      mockPortalCreate.mockResolvedValue({ url: "https://stripe/portal" });
      const res = await buildApp().request("/portal", { method: "POST" });
      expect(res.status).toBe(200);
      expect((await res.json()).url).toBe("https://stripe/portal");
      expect(mockPortalCreate).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_x" }));
    });
  });
});
