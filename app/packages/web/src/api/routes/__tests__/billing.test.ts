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
vi.mock("@/services/stripe", () => ({
  getStripe: () => stripeClient,
  getStripePriceId: () => "price_123",
  getStripeChatPriceId: () => mockChatPriceId(),
  // Unset by default: the build line item is opt-in, same as chat's.
  getStripeBuildPriceId: () => null,
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

describe("Billing routes", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("GET /status", () => {
    it("returns a null subscription when none exists", async () => {
      selectSequence(orgRow(false), []);
      const res = await buildApp().request("/status");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ complimentary: false, subscription: null });
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
      expect(await res.json()).toEqual({ complimentary: true, subscription: null });
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
