import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
vi.mock("../../db/client", () => ({
  db: {
    select: (...a: unknown[]) => mockSelect(...a),
    insert: (...a: unknown[]) => mockInsert(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
  },
}));
vi.mock("../../db/schema", () => ({
  chatUsage: { id: "id", organizationId: "org", costMicros: "cost", createdAt: "ts" },
  organizations: { id: "id", chatMonthlyCapMicros: "cap", complimentary: "complimentary" },
  subscriptions: { organizationId: "org", stripeCustomerId: "cust", status: "status" },
}));

const mockMeterCreate = vi.fn();
const mockGetStripe = vi.fn();
vi.mock("../../services/stripe", () => ({ getStripe: (...a: unknown[]) => mockGetStripe(...a) }));
vi.mock("uuid", () => ({ v4: () => "usage-uuid" }));

const { getMonthlySpend, recordUsage } = await import("../billing");

describe("getMonthlySpend", () => {
  beforeEach(() => vi.clearAllMocks());

  function setup(
    cap: number | null,
    total: string,
    subStatus: string | null = "active",
    complimentary = false,
  ) {
    const orgLimit = vi.fn().mockResolvedValue([{ cap, complimentary }]);
    const orgWhere = vi.fn().mockReturnValue({ limit: orgLimit });
    const orgFrom = vi.fn().mockReturnValue({ where: orgWhere });
    const subLimit = vi.fn().mockResolvedValue(subStatus ? [{ status: subStatus }] : []);
    const subWhere = vi.fn().mockReturnValue({ limit: subLimit });
    const subFrom = vi.fn().mockReturnValue({ where: subWhere });
    const sumWhere = vi.fn().mockResolvedValue([{ total }]);
    const sumFrom = vi.fn().mockReturnValue({ where: sumWhere });
    mockSelect
      .mockReturnValueOnce({ from: orgFrom })
      .mockReturnValueOnce({ from: subFrom })
      .mockReturnValueOnce({ from: sumFrom });
  }

  it("reports month-to-date and cap", async () => {
    setup(1_000_000, "250000");
    const s = await getMonthlySpend("o1");
    expect(s.monthToDateMicros).toBe(250000);
    expect(s.monthlyCapMicros).toBe(1_000_000);
    expect(s.exceeded).toBe(false);
    expect(s.freeTier).toBe(false);
  });

  it("flags exceeded when spend >= cap", async () => {
    setup(200000, "250000");
    const s = await getMonthlySpend("o1");
    expect(s.exceeded).toBe(true);
  });

  it("never exceeded when cap is null on a paid org", async () => {
    setup(null, "999999999");
    const s = await getMonthlySpend("o1");
    expect(s.monthlyCapMicros).toBeNull();
    expect(s.exceeded).toBe(false);
  });

  it("applies the $5 free-tier cap when there is no subscription", async () => {
    setup(null, "4999999", null);
    const s = await getMonthlySpend("o1");
    expect(s.monthlyCapMicros).toBe(5_000_000);
    expect(s.freeTier).toBe(true);
    expect(s.exceeded).toBe(false);
  });

  it("blocks free-tier orgs at $5 even with no org cap", async () => {
    setup(null, "5000000", null);
    const s = await getMonthlySpend("o1");
    expect(s.exceeded).toBe(true);
  });

  it("treats a canceled subscription as free tier", async () => {
    setup(null, "6000000", "canceled");
    const s = await getMonthlySpend("o1");
    expect(s.monthlyCapMicros).toBe(5_000_000);
    expect(s.freeTier).toBe(true);
    expect(s.exceeded).toBe(true);
  });

  it("keeps an org cap below $5 for free-tier orgs", async () => {
    setup(2_000_000, "1000000", null);
    const s = await getMonthlySpend("o1");
    expect(s.monthlyCapMicros).toBe(2_000_000);
  });

  it("treats complimentary orgs as paid and uncapped even without a subscription", async () => {
    setup(null, "999999999", null, true);
    const s = await getMonthlySpend("o1");
    expect(s.monthlyCapMicros).toBeNull();
    expect(s.exceeded).toBe(false);
    expect(s.freeTier).toBe(false);
    expect(s.complimentary).toBe(true);
  });

  it("still honors a self-set org cap on complimentary orgs", async () => {
    setup(1_000_000, "1500000", null, true);
    const s = await getMonthlySpend("o1");
    expect(s.monthlyCapMicros).toBe(1_000_000);
    expect(s.exceeded).toBe(true);
    expect(s.freeTier).toBe(false);
  });
});

describe("recordUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["INFRAWRENCH_STRIPE_CHAT_METER_EVENT"];
  });

  it("inserts a usage row and returns the cost", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values });
    // Sonnet 5: $3/Mtok input × 1.5 markup = $4.50
    const cost = await recordUsage({
      organizationId: "o1",
      conversationId: "c1",
      messageId: "m1",
      model: "claude-sonnet-5",
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(cost).toBe(4_500_000);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ id: "usage-uuid", organizationId: "o1", costMicros: 4_500_000 }),
    );
  });

  /** Chain for the org-complimentary lookup inside reportUsageToStripe. */
  function orgSelectChain(complimentary: boolean) {
    const limit = vi.fn().mockResolvedValue([{ complimentary }]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    return { from };
  }

  it("reports to Stripe meter when configured", async () => {
    process.env["INFRAWRENCH_STRIPE_CHAT_METER_EVENT"] = "chat_tokens";
    const values = vi.fn().mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values });
    const subLimit = vi.fn().mockResolvedValue([{ stripeCustomerId: "cus_1" }]);
    const subWhere = vi.fn().mockReturnValue({ limit: subLimit });
    const subFrom = vi.fn().mockReturnValue({ where: subWhere });
    mockSelect.mockReturnValueOnce(orgSelectChain(false)).mockReturnValue({ from: subFrom });
    const updWhere = vi.fn().mockResolvedValue(undefined);
    const updSet = vi.fn().mockReturnValue({ where: updWhere });
    mockUpdate.mockReturnValue({ set: updSet });
    mockGetStripe.mockReturnValue({ billing: { meterEvents: { create: mockMeterCreate } } });
    mockMeterCreate.mockResolvedValue({});

    await recordUsage({
      organizationId: "o1",
      conversationId: "c1",
      messageId: "m1",
      model: "claude",
      usage: { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    // allow the fire-and-forget reporter to run
    await new Promise((r) => setTimeout(r, 0));
    expect(mockMeterCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: "chat_tokens",
        identifier: expect.any(String),
        payload: expect.objectContaining({ stripe_customer_id: "cus_1" }),
      }),
    );
    // Only declared payload keys — Stripe treats extras as meter dimensions.
    const payload = (mockMeterCreate.mock.calls[0]?.[0] as { payload: object }).payload;
    expect(Object.keys(payload).sort()).toEqual(["stripe_customer_id", "value"]);
  });

  it("never reports complimentary orgs to Stripe", async () => {
    process.env["INFRAWRENCH_STRIPE_CHAT_METER_EVENT"] = "chat_tokens";
    const values = vi.fn().mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values });
    mockSelect.mockReturnValueOnce(orgSelectChain(true));
    mockGetStripe.mockReturnValue({ billing: { meterEvents: { create: mockMeterCreate } } });

    const cost = await recordUsage({
      organizationId: "o1",
      conversationId: "c1",
      messageId: "m1",
      model: "claude-sonnet-5",
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    await new Promise((r) => setTimeout(r, 0));
    // Usage is still recorded internally (cost tracking), just never billed.
    expect(cost).toBe(4_500_000);
    expect(values).toHaveBeenCalled();
    expect(mockMeterCreate).not.toHaveBeenCalled();
  });

  it("swallows Stripe failures without throwing", async () => {
    process.env["INFRAWRENCH_STRIPE_CHAT_METER_EVENT"] = "chat_tokens";
    const values = vi.fn().mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values });
    const subLimit = vi.fn().mockResolvedValue([{ stripeCustomerId: "cus_1" }]);
    const subWhere = vi.fn().mockReturnValue({ limit: subLimit });
    const subFrom = vi.fn().mockReturnValue({ where: subWhere });
    mockSelect.mockReturnValue({ from: subFrom });
    mockGetStripe.mockImplementation(() => {
      throw new Error("not configured");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      recordUsage({
        organizationId: "o1",
        conversationId: "c1",
        messageId: "m1",
        model: "claude",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    ).resolves.toBe(0);
    await new Promise((r) => setTimeout(r, 0));
    errSpy.mockRestore();
  });
});
