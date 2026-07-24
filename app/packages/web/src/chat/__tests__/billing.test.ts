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
  organizations: { id: "id", chatMonthlyCapMicros: "cap" },
  subscriptions: { organizationId: "org", stripeCustomerId: "cust" },
}));

const mockMeterCreate = vi.fn();
const mockGetStripe = vi.fn();
vi.mock("../../services/stripe", () => ({ getStripe: (...a: unknown[]) => mockGetStripe(...a) }));
vi.mock("uuid", () => ({ v4: () => "usage-uuid" }));

const { getMonthlySpend, recordUsage } = await import("../billing");

describe("getMonthlySpend", () => {
  beforeEach(() => vi.clearAllMocks());

  function setup(cap: number | null, total: string) {
    const orgLimit = vi.fn().mockResolvedValue([{ cap }]);
    const orgWhere = vi.fn().mockReturnValue({ limit: orgLimit });
    const orgFrom = vi.fn().mockReturnValue({ where: orgWhere });
    const sumWhere = vi.fn().mockResolvedValue([{ total }]);
    const sumFrom = vi.fn().mockReturnValue({ where: sumWhere });
    mockSelect.mockReturnValueOnce({ from: orgFrom }).mockReturnValueOnce({ from: sumFrom });
  }

  it("reports month-to-date and cap", async () => {
    setup(1_000_000, "250000");
    const s = await getMonthlySpend("o1");
    expect(s.monthToDateMicros).toBe(250000);
    expect(s.monthlyCapMicros).toBe(1_000_000);
    expect(s.exceeded).toBe(false);
  });

  it("flags exceeded when spend >= cap", async () => {
    setup(200000, "250000");
    const s = await getMonthlySpend("o1");
    expect(s.exceeded).toBe(true);
  });

  it("never exceeded when cap is null", async () => {
    setup(null, "999999999");
    const s = await getMonthlySpend("o1");
    expect(s.monthlyCapMicros).toBeNull();
    expect(s.exceeded).toBe(false);
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
    const cost = await recordUsage({
      organizationId: "o1",
      conversationId: "c1",
      messageId: "m1",
      model: "claude",
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(cost).toBe(4_500_000);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ id: "usage-uuid", organizationId: "o1", costMicros: 4_500_000 }),
    );
  });

  it("reports to Stripe meter when configured", async () => {
    process.env["INFRAWRENCH_STRIPE_CHAT_METER_EVENT"] = "chat_tokens";
    const values = vi.fn().mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values });
    const subLimit = vi.fn().mockResolvedValue([{ stripeCustomerId: "cus_1" }]);
    const subWhere = vi.fn().mockReturnValue({ limit: subLimit });
    const subFrom = vi.fn().mockReturnValue({ where: subWhere });
    mockSelect.mockReturnValue({ from: subFrom });
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
