import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApp } from "./test-utils";

const mockConstruct = vi.fn();
const mockRetrieve = vi.fn();
const mockListLineItems = vi.fn();
const mockReport = vi.fn();
const mockRecordCapacity = vi.fn();
const mockRefundCapacity = vi.fn();
const order: string[] = [];

vi.mock("@/services/stripe", () => ({
  getStripe: () => ({
    webhooks: { constructEvent: (...args: unknown[]) => mockConstruct(...args) },
    subscriptions: { retrieve: (...args: unknown[]) => mockRetrieve(...args) },
    checkout: { sessions: { listLineItems: (...args: unknown[]) => mockListLineItems(...args) } },
  }),
  getStripeWebhookSecret: () => "whsec_test",
}));

vi.mock("@/services/revnu-checkout", () => ({
  queuePaidCheckout: (...args: unknown[]) => mockReport(...args),
}));

vi.mock("@/db/client", () => ({
  db: {
    update: () => ({
      set: () => ({
        where: () => {
          order.push("billing");
          return Promise.resolve();
        },
      }),
    }),
  },
}));

vi.mock("@infrawrench/server-core/billing/capacity-slots", () => ({
  recordCapacitySlotPurchase: (...args: unknown[]) => mockRecordCapacity(...args),
  refundCapacitySlots: (...args: unknown[]) => mockRefundCapacity(...args),
}));

const { stripeWebhookRoutes } = await import("../stripe-webhook");
const app = buildTestApp(stripeWebhookRoutes);

function post(signature?: string) {
  return app.request("/", {
    method: "POST",
    body: "{}",
    headers: signature ? { "stripe-signature": signature } : {},
  });
}

function event(type: string, object: Record<string, unknown>, created = 1_754_000_000) {
  return { id: "evt_1", type, created, data: { object } };
}

const paidSubscription = {
  id: "cs_sub",
  payment_status: "paid",
  mode: "subscription",
  customer: "cus_1",
  subscription: "sub_1",
  metadata: { organizationId: "org-1" },
};

describe("Stripe webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    mockRetrieve.mockResolvedValue({
      items: { data: [{ quantity: 2 }] },
      current_period_start: 1_700_000_000,
      current_period_end: 1_702_000_000,
    });
    mockListLineItems.mockResolvedValue({ data: [{ quantity: 1 }] });
    mockRecordCapacity.mockResolvedValue({ granted: true, expiresAt: new Date("2028-01-01") });
    mockRefundCapacity.mockResolvedValue(0);
    mockReport.mockResolvedValue(undefined);
  });

  it("rejects a missing signature before it trusts the body", async () => {
    const res = await post();
    expect(res.status).toBe(400);
    expect(mockConstruct).not.toHaveBeenCalled();
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("rejects a signature Stripe does not accept", async () => {
    mockConstruct.mockImplementation(() => {
      throw new Error("bad signature");
    });
    const res = await post("t=1,v1=nope");
    expect(res.status).toBe(400);
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("reports a paid subscription checkout after the plan is updated", async () => {
    mockConstruct.mockReturnValue(event("checkout.session.completed", paidSubscription));
    const res = await post("t=1,v1=ok");
    expect(res.status).toBe(200);
    expect(order).toEqual(["billing"]);
    expect(mockReport).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cs_sub" }),
      1_754_000_000,
    );
  });

  it("does not report an unpaid checkout, including the success redirect's session", async () => {
    mockConstruct.mockReturnValue(
      event("checkout.session.completed", { ...paidSubscription, payment_status: "unpaid" }),
    );
    const res = await post("t=1,v1=ok");
    expect(res.status).toBe(200);
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("reports a delayed payment when it later succeeds", async () => {
    mockConstruct.mockReturnValue(
      event("checkout.session.async_payment_succeeded", paidSubscription),
    );
    const res = await post("t=1,v1=ok");
    expect(res.status).toBe(200);
    expect(mockReport).toHaveBeenCalledTimes(1);
  });

  it("reports a paid capacity purchase and does not also treat it as a subscription", async () => {
    mockConstruct.mockReturnValue(
      event("checkout.session.completed", {
        id: "cs_slot",
        payment_status: "paid",
        mode: "payment",
        metadata: { organizationId: "org-1", kind: "capacity_slot" },
      }),
    );
    const res = await post("t=1,v1=ok");
    expect(res.status).toBe(200);
    expect(mockRecordCapacity).toHaveBeenCalled();
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockReport).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cs_slot" }),
      1_754_000_000,
    );
  });

  it("does not report invoice.paid", async () => {
    mockConstruct.mockReturnValue(event("invoice.paid", { id: "in_1", subscription: "sub_1" }));
    const res = await post("t=1,v1=ok");
    expect(res.status).toBe(200);
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("keeps a refund counted and does not report a reversal", async () => {
    mockRefundCapacity.mockResolvedValue(1);
    mockConstruct.mockReturnValue(event("charge.refunded", { id: "ch_1", payment_intent: "pi_1" }));
    const res = await post("t=1,v1=ok");
    expect(res.status).toBe(200);
    expect(mockRefundCapacity).toHaveBeenCalledWith("pi_1");
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("does not report a capacity purchase that granted nothing", async () => {
    mockListLineItems.mockResolvedValue({ data: [] });
    mockConstruct.mockReturnValue(
      event("checkout.session.completed", {
        id: "cs_slot",
        payment_status: "paid",
        mode: "payment",
        metadata: { organizationId: "org-1", kind: "capacity_slot" },
      }),
    );
    const res = await post("t=1,v1=ok");
    expect(res.status).toBe(200);
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("queues only after the billing write", async () => {
    mockReport.mockImplementation(() => {
      order.push("revnu");
    });
    mockConstruct.mockReturnValue(event("checkout.session.completed", paidSubscription));
    const res = await post("t=1,v1=ok");
    expect(res.status).toBe(200);
    expect(order).toEqual(["billing", "revnu"]);
  });
});
