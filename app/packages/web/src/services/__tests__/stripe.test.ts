import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const StripeCtor = vi.fn();
vi.mock("stripe", () => ({ default: StripeCtor }));

describe("stripe service", () => {
  const orig = { ...process.env };
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });
  afterEach(() => {
    process.env = { ...orig };
  });

  it("getStripe throws when STRIPE_SECRET_KEY missing", async () => {
    delete process.env["STRIPE_SECRET_KEY"];
    const { getStripe } = await import("../stripe");
    expect(() => getStripe()).toThrow(/STRIPE_SECRET_KEY/);
  });

  it("getStripe constructs and memoizes the client", async () => {
    process.env["STRIPE_SECRET_KEY"] = "sk_test_123";
    StripeCtor.mockImplementation(() => ({ id: "stripe" }));
    const { getStripe } = await import("../stripe");
    const a = getStripe();
    const b = getStripe();
    expect(a).toBe(b);
    expect(StripeCtor).toHaveBeenCalledTimes(1);
  });

  it("getStripePriceId throws when STRIPE_PRICE_ID missing", async () => {
    delete process.env["STRIPE_PRICE_ID"];
    const { getStripePriceId } = await import("../stripe");
    expect(() => getStripePriceId()).toThrow(/STRIPE_PRICE_ID/);
  });

  it("getStripePriceId returns the configured id", async () => {
    process.env["STRIPE_PRICE_ID"] = "price_1";
    const { getStripePriceId } = await import("../stripe");
    expect(getStripePriceId()).toBe("price_1");
  });

  it("getStripeWebhookSecret throws when missing", async () => {
    delete process.env["STRIPE_WEBHOOK_SECRET"];
    const { getStripeWebhookSecret } = await import("../stripe");
    expect(() => getStripeWebhookSecret()).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });

  it("getStripeWebhookSecret returns the configured secret", async () => {
    process.env["STRIPE_WEBHOOK_SECRET"] = "whsec_1";
    const { getStripeWebhookSecret } = await import("../stripe");
    expect(getStripeWebhookSecret()).toBe("whsec_1");
  });
});
