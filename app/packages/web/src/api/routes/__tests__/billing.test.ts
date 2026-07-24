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
}));

vi.mock("uuid", () => ({ v4: () => "sub-uuid-1" }));

const { billingRoutes } = await import("@/api/routes/billing");
const buildApp = () => buildTestApp(billingRoutes);

function selectReturns(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  mockSelect.mockReturnValue({ from });
}

describe("Billing routes", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("GET /status", () => {
    it("returns null when no subscription exists", async () => {
      selectReturns([]);
      const res = await buildApp().request("/status");
      expect(res.status).toBe(200);
      expect(await res.json()).toBeNull();
    });

    it("returns subscription summary fields", async () => {
      selectReturns([
        {
          status: "active",
          seatCount: 5,
          currentPeriodEnd: null,
          stripeCustomerId: "cus_1",
        },
      ]);
      const res = await buildApp().request("/status");
      const body = await res.json();
      expect(body).toMatchObject({ status: "active", seatCount: 5, stripeCustomerId: "cus_1" });
    });
  });

  describe("POST /checkout", () => {
    it("creates a customer + subscription row when none exists", async () => {
      selectReturns([]);
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
      selectReturns([{ stripeCustomerId: "cus_existing" }]);
      mockCheckoutCreate.mockResolvedValue({ url: "https://stripe/checkout2" });
      const res = await buildApp().request("/checkout", { method: "POST" });
      expect(res.status).toBe(200);
      expect(mockCustomersCreate).not.toHaveBeenCalled();
      expect(mockCheckoutCreate).toHaveBeenCalledWith(
        expect.objectContaining({ customer: "cus_existing" }),
      );
    });

    it("sends adjustable seat quantity plus the metered chat price", async () => {
      selectReturns([{ stripeCustomerId: "cus_existing" }]);
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
      selectReturns([{ stripeCustomerId: "cus_existing" }]);
      mockCheckoutCreate.mockResolvedValue({ url: "https://stripe/checkout4" });
      await buildApp().request("/checkout", { method: "POST" });
      const args = mockCheckoutCreate.mock.calls[0]?.[0] as {
        line_items: Array<{ price: string }>;
      };
      expect(args.line_items).toHaveLength(1);
      expect(args.line_items[0]?.price).toBe("price_123");
    });

    it("returns 500 when Stripe yields no checkout url", async () => {
      selectReturns([{ stripeCustomerId: "cus_existing" }]);
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
