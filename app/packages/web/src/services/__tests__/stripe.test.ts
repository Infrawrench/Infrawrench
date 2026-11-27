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
    StripeCtor.mockImplementation(function () {
      return { id: "stripe" };
    });
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

  it("finds the short username price by its lookup key, once", async () => {
    process.env["STRIPE_SECRET_KEY"] = "sk_test_123";
    delete process.env["STRIPE_GIT_SHORT_USERNAME_PRICE_ID"];
    const list = vi.fn().mockResolvedValue({ data: [{ id: "price_by_lookup" }] });
    StripeCtor.mockImplementation(function () {
      return { prices: { list } };
    });
    const { getStripeGitShortUsernamePriceId } = await import("../stripe");
    expect(await getStripeGitShortUsernamePriceId()).toBe("price_by_lookup");
    expect(await getStripeGitShortUsernamePriceId()).toBe("price_by_lookup");
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({
      lookup_keys: ["git_short_username"],
      active: true,
      limit: 1,
    });
  });

  it("prefers a configured short username price id, and answers null when there is no price", async () => {
    process.env["STRIPE_SECRET_KEY"] = "sk_test_123";
    const list = vi.fn().mockResolvedValue({ data: [] });
    StripeCtor.mockImplementation(function () {
      return { prices: { list } };
    });
    const { getStripeGitShortUsernamePriceId } = await import("../stripe");
    process.env["STRIPE_GIT_SHORT_USERNAME_PRICE_ID"] = "price_configured";
    expect(await getStripeGitShortUsernamePriceId()).toBe("price_configured");
    expect(list).not.toHaveBeenCalled();
    delete process.env["STRIPE_GIT_SHORT_USERNAME_PRICE_ID"];
    expect(await getStripeGitShortUsernamePriceId()).toBeNull();
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
