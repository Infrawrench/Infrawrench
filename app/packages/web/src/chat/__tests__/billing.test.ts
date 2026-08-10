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

// The spend-status logic moved to server-core (billing/ai-usage.ts) when
// `infra.ai()` in workflows started sharing the cap — its behavioral tests
// live in server-core's ai-usage.test.ts. Here we only pin the delegation.
const mockGetAiSpendStatus = vi.fn();
vi.mock("@infrawrench/server-core/billing/ai-usage", () => ({
  getAiSpendStatus: (...a: unknown[]) => mockGetAiSpendStatus(...a),
}));

const { getMonthlySpend, recordUsage } = await import("../billing");

describe("getMonthlySpend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to the shared org-wide AI spend status", async () => {
    const status = {
      monthToDateMicros: 250000,
      monthlyCapMicros: 1_000_000,
      exceeded: false,
      freeTier: false,
      complimentary: false,
    };
    mockGetAiSpendStatus.mockResolvedValue(status);
    await expect(getMonthlySpend("o1")).resolves.toEqual(status);
    expect(mockGetAiSpendStatus).toHaveBeenCalledWith("o1");
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
