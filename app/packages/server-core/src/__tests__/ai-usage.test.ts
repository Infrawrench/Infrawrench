import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockExecute = vi.fn();
const mockTransaction = vi.fn();

vi.mock("../db/client", () => ({
  db: {
    select: (...a: unknown[]) => mockSelect(...a),
    insert: (...a: unknown[]) => mockInsert(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
    delete: (...a: unknown[]) => mockDelete(...a),
    transaction: (...a: unknown[]) => mockTransaction(...a),
  },
}));
vi.mock("../db/schema", () => ({
  chatUsage: { organizationId: "org", costMicros: "cost", createdAt: "ts" },
  workflowAiUsage: {
    id: "id",
    organizationId: "org",
    costMicros: "cost",
    createdAt: "ts",
  },
  aiSpendReservations: {
    id: "id",
    organizationId: "org",
    estimatedCostMicros: "est",
    createdAt: "ts",
  },
  organizations: { id: "id", chatMonthlyCapMicros: "cap", complimentary: "complimentary" },
  subscriptions: { organizationId: "org", stripeCustomerId: "cust", status: "status" },
}));

// Prepaid capacity is a third way to be paid here, queried from its own table.
const mockActiveCapacitySeats = vi.fn<() => Promise<number>>();
vi.mock("../billing/capacity-slots", () => ({
  activeCapacitySeats: () => mockActiveCapacitySeats(),
}));

const {
  getAiSpendStatus,
  recordWorkflowAiUsage,
  reserveAiSpend,
  releaseAiSpendReservation,
  estimateTokensFromChars,
  AiSpendCapExceededError,
} = await import("../billing/ai-usage");

describe("getAiSpendStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No prepaid capacity unless a test says otherwise.
    mockActiveCapacitySeats.mockResolvedValue(0);
  });

  /**
   * Queue the five selects in call order: org, subscription, chat_usage sum,
   * workflow_ai_usage sum, and active ai_spend_reservations sum.
   */
  function setup(
    cap: number | null,
    chatTotal: string,
    workflowTotal = "0",
    reservationTotal = "0",
    subStatus: string | null = "active",
    complimentary = false,
  ) {
    const orgLimit = vi.fn().mockResolvedValue([{ cap, complimentary }]);
    const orgWhere = vi.fn().mockReturnValue({ limit: orgLimit });
    const orgFrom = vi.fn().mockReturnValue({ where: orgWhere });
    const subLimit = vi.fn().mockResolvedValue(subStatus ? [{ status: subStatus }] : []);
    const subWhere = vi.fn().mockReturnValue({ limit: subLimit });
    const subFrom = vi.fn().mockReturnValue({ where: subWhere });
    const chatWhere = vi.fn().mockResolvedValue([{ total: chatTotal }]);
    const chatFrom = vi.fn().mockReturnValue({ where: chatWhere });
    const wfWhere = vi.fn().mockResolvedValue([{ total: workflowTotal }]);
    const wfFrom = vi.fn().mockReturnValue({ where: wfWhere });
    const resWhere = vi.fn().mockResolvedValue([{ total: reservationTotal }]);
    const resFrom = vi.fn().mockReturnValue({ where: resWhere });
    mockSelect
      .mockReturnValueOnce({ from: orgFrom })
      .mockReturnValueOnce({ from: subFrom })
      .mockReturnValueOnce({ from: chatFrom })
      .mockReturnValueOnce({ from: wfFrom })
      .mockReturnValueOnce({ from: resFrom });
  }

  it("reports month-to-date and cap", async () => {
    setup(1_000_000, "250000");
    const s = await getAiSpendStatus("o1");
    expect(s.monthToDateMicros).toBe(250000);
    expect(s.monthlyCapMicros).toBe(1_000_000);
    expect(s.exceeded).toBe(false);
    expect(s.freeTier).toBe(false);
  });

  it("sums chat, workflow, and in-flight reservations into one figure", async () => {
    setup(1_000_000, "400000", "300000", "200000");
    const s = await getAiSpendStatus("o1");
    expect(s.monthToDateMicros).toBe(900_000);
    expect(s.exceeded).toBe(false);
  });

  it("flags exceeded when spend >= cap", async () => {
    setup(200000, "250000");
    const s = await getAiSpendStatus("o1");
    expect(s.exceeded).toBe(true);
  });

  it("never exceeded when cap is null on a paid org", async () => {
    setup(null, "999999999");
    const s = await getAiSpendStatus("o1");
    expect(s.monthlyCapMicros).toBeNull();
    expect(s.exceeded).toBe(false);
  });

  it("applies the $5 free-tier cap when there is no subscription", async () => {
    setup(null, "4999999", "0", "0", null);
    const s = await getAiSpendStatus("o1");
    expect(s.monthlyCapMicros).toBe(5_000_000);
    expect(s.freeTier).toBe(true);
    expect(s.exceeded).toBe(false);
  });

  it("blocks free-tier orgs at $5 even with no org cap", async () => {
    setup(null, "5000000", "0", "0", null);
    const s = await getAiSpendStatus("o1");
    expect(s.exceeded).toBe(true);
  });

  it("treats a canceled subscription as free tier", async () => {
    setup(null, "6000000", "0", "0", "canceled");
    const s = await getAiSpendStatus("o1");
    expect(s.monthlyCapMicros).toBe(5_000_000);
    expect(s.freeTier).toBe(true);
    expect(s.exceeded).toBe(true);
  });

  it("keeps an org cap below $5 for free-tier orgs", async () => {
    setup(2_000_000, "1000000", "0", "0", null);
    const s = await getAiSpendStatus("o1");
    expect(s.monthlyCapMicros).toBe(2_000_000);
  });

  it("treats complimentary orgs as paid and uncapped even without a subscription", async () => {
    setup(null, "999999999", "0", "0", null, true);
    const s = await getAiSpendStatus("o1");
    expect(s.monthlyCapMicros).toBeNull();
    expect(s.exceeded).toBe(false);
    expect(s.freeTier).toBe(false);
    expect(s.complimentary).toBe(true);
  });

  it("still honors a self-set org cap on complimentary orgs", async () => {
    setup(1_000_000, "1500000", "0", "0", null, true);
    const s = await getAiSpendStatus("o1");
    expect(s.monthlyCapMicros).toBe(1_000_000);
    expect(s.exceeded).toBe(true);
    expect(s.freeTier).toBe(false);
  });

  it("treats a prepaid capacity slot as paid, with no subscription at all", async () => {
    mockActiveCapacitySeats.mockResolvedValue(1);
    setup(null, "6000000", "0", "0", null);
    const s = await getAiSpendStatus("o1");
    expect(s.monthlyCapMicros).toBeNull();
    expect(s.freeTier).toBe(false);
    expect(s.exceeded).toBe(false);
  });

  it("does not query slots when the subscription already settles it", async () => {
    setup(null, "1000", "0", "0", "active");
    await getAiSpendStatus("o1");
    expect(mockActiveCapacitySeats).not.toHaveBeenCalled();
  });

  it("falls back to the free tier once every slot has lapsed", async () => {
    mockActiveCapacitySeats.mockResolvedValue(0);
    setup(null, "6000000", "0", "0", null);
    const s = await getAiSpendStatus("o1");
    expect(s.monthlyCapMicros).toBe(5_000_000);
    expect(s.freeTier).toBe(true);
  });
});

describe("recordWorkflowAiUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env["INFRAWRENCH_STRIPE_CHAT_METER_EVENT"];
    delete process.env["STRIPE_SECRET_KEY"];
  });

  it("inserts a usage row and returns the marked-up cost", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values });
    // Sonnet 5: $3/MTok input × 1.5 markup = $4.50
    const cost = await recordWorkflowAiUsage({
      organizationId: "o1",
      workflowId: "wf1",
      runId: "run1",
      model: "claude-sonnet-5",
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(cost).toBe(4_500_000);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "o1",
        workflowId: "wf1",
        runId: "run1",
        model: "claude-sonnet-5",
        costMicros: 4_500_000,
      }),
    );
  });

  it("skips Stripe entirely when the meter is not configured", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await recordWorkflowAiUsage({
      organizationId: "o1",
      workflowId: "wf1",
      model: "claude-haiku-4-5",
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("reserve / release AI spend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveCapacitySeats.mockResolvedValue(0);
    delete process.env["INFRAWRENCH_STRIPE_CHAT_METER_EVENT"];
    delete process.env["STRIPE_SECRET_KEY"];
    mockExecute.mockResolvedValue(undefined);
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    mockDelete.mockReturnValue({ where: deleteWhere });
  });

  function queueSpendSelects(
    cap: number | null,
    chatTotal: string,
    workflowTotal = "0",
    reservationTotal = "0",
  ) {
    const orgLimit = vi.fn().mockResolvedValue([{ cap, complimentary: false }]);
    const orgWhere = vi.fn().mockReturnValue({ limit: orgLimit });
    const orgFrom = vi.fn().mockReturnValue({ where: orgWhere });
    const subLimit = vi.fn().mockResolvedValue([{ status: "active" }]);
    const subWhere = vi.fn().mockReturnValue({ limit: subLimit });
    const subFrom = vi.fn().mockReturnValue({ where: subWhere });
    const chatWhere = vi.fn().mockResolvedValue([{ total: chatTotal }]);
    const chatFrom = vi.fn().mockReturnValue({ where: chatWhere });
    const wfWhere = vi.fn().mockResolvedValue([{ total: workflowTotal }]);
    const wfFrom = vi.fn().mockReturnValue({ where: wfWhere });
    const resWhere = vi.fn().mockResolvedValue([{ total: reservationTotal }]);
    const resFrom = vi.fn().mockReturnValue({ where: resWhere });
    mockSelect
      .mockReturnValueOnce({ from: orgFrom })
      .mockReturnValueOnce({ from: subFrom })
      .mockReturnValueOnce({ from: chatFrom })
      .mockReturnValueOnce({ from: wfFrom })
      .mockReturnValueOnce({ from: resFrom });
  }

  it("reserves estimated spend under a transaction when under the cap", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      queueSpendSelects(1_000_000, "100000");
      await fn({
        execute: mockExecute,
        select: (...a: unknown[]) => mockSelect(...a),
        insert: (...a: unknown[]) => mockInsert(...a),
        delete: (...a: unknown[]) => mockDelete(...a),
      });
    });

    const id = await reserveAiSpend("o1", 50_000);

    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(mockExecute).toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalled(); // expired-reservation purge
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "o1",
        estimatedCostMicros: 50_000,
      }),
    );
  });

  it("throws AiSpendCapExceededError when the org is already at its cap", async () => {
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      queueSpendSelects(100_000, "100000");
      await fn({
        execute: mockExecute,
        select: (...a: unknown[]) => mockSelect(...a),
        insert: (...a: unknown[]) => mockInsert(...a),
        delete: (...a: unknown[]) => mockDelete(...a),
      });
    });

    await expect(reserveAiSpend("o1", 1)).rejects.toBeInstanceOf(AiSpendCapExceededError);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("releases a reservation by id", async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    mockDelete.mockReturnValue({ where });
    await releaseAiSpendReservation("res-1");
    expect(mockDelete).toHaveBeenCalled();
    expect(where).toHaveBeenCalled();
  });

  it("estimates tokens from character length", () => {
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(5)).toBe(2);
    expect(estimateTokensFromChars(0)).toBe(1);
  });
});
