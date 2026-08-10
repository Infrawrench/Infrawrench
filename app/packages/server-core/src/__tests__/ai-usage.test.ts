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
    status: "status",
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
  reserveWorkflowAiSpend,
  finalizeWorkflowAiUsage,
  releaseWorkflowAiReservation,
  estimateTokensFromChars,
} = await import("../billing/ai-usage");

describe("getAiSpendStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No prepaid capacity unless a test says otherwise.
    mockActiveCapacitySeats.mockResolvedValue(0);
  });

  /**
   * Queue the four selects in call order: the org row, the subscription row,
   * the chat_usage month sum, and the workflow_ai_usage month sum.
   */
  function setup(
    cap: number | null,
    chatTotal: string,
    workflowTotal = "0",
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
    mockSelect
      .mockReturnValueOnce({ from: orgFrom })
      .mockReturnValueOnce({ from: subFrom })
      .mockReturnValueOnce({ from: chatFrom })
      .mockReturnValueOnce({ from: wfFrom });
  }

  it("reports month-to-date and cap", async () => {
    setup(1_000_000, "250000");
    const s = await getAiSpendStatus("o1");
    expect(s.monthToDateMicros).toBe(250000);
    expect(s.monthlyCapMicros).toBe(1_000_000);
    expect(s.exceeded).toBe(false);
    expect(s.freeTier).toBe(false);
  });

  it("sums chat and workflow AI spend into one month-to-date figure", async () => {
    // The cap is a single pool: a workflow must not get $5 of AI on top of
    // everything chat already spent.
    setup(1_000_000, "600000", "500000");
    const s = await getAiSpendStatus("o1");
    expect(s.monthToDateMicros).toBe(1_100_000);
    expect(s.exceeded).toBe(true);
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
    setup(null, "4999999", "0", null);
    const s = await getAiSpendStatus("o1");
    expect(s.monthlyCapMicros).toBe(5_000_000);
    expect(s.freeTier).toBe(true);
    expect(s.exceeded).toBe(false);
  });

  it("blocks free-tier orgs at $5 even with no org cap", async () => {
    setup(null, "5000000", "0", null);
    const s = await getAiSpendStatus("o1");
    expect(s.exceeded).toBe(true);
  });

  it("treats a canceled subscription as free tier", async () => {
    setup(null, "6000000", "0", "canceled");
    const s = await getAiSpendStatus("o1");
    expect(s.monthlyCapMicros).toBe(5_000_000);
    expect(s.freeTier).toBe(true);
    expect(s.exceeded).toBe(true);
  });

  it("keeps an org cap below $5 for free-tier orgs", async () => {
    setup(2_000_000, "1000000", "0", null);
    const s = await getAiSpendStatus("o1");
    expect(s.monthlyCapMicros).toBe(2_000_000);
  });

  it("treats complimentary orgs as paid and uncapped even without a subscription", async () => {
    setup(null, "999999999", "0", null, true);
    const s = await getAiSpendStatus("o1");
    expect(s.monthlyCapMicros).toBeNull();
    expect(s.exceeded).toBe(false);
    expect(s.freeTier).toBe(false);
    expect(s.complimentary).toBe(true);
  });

  it("still honors a self-set org cap on complimentary orgs", async () => {
    setup(1_000_000, "1500000", "0", null, true);
    const s = await getAiSpendStatus("o1");
    expect(s.monthlyCapMicros).toBe(1_000_000);
    expect(s.exceeded).toBe(true);
    expect(s.freeTier).toBe(false);
  });

  it("treats a prepaid capacity slot as paid, with no subscription at all", async () => {
    // The org bought two years of seats outright. Handing it the $5 free-tier
    // cap would contradict every other paid check.
    mockActiveCapacitySeats.mockResolvedValue(1);
    setup(null, "6000000", "0", null);
    const s = await getAiSpendStatus("o1");
    expect(s.monthlyCapMicros).toBeNull();
    expect(s.freeTier).toBe(false);
    expect(s.exceeded).toBe(false);
  });

  it("does not query slots when the subscription already settles it", async () => {
    setup(null, "1000", "0", "active");
    await getAiSpendStatus("o1");
    expect(mockActiveCapacitySeats).not.toHaveBeenCalled();
  });

  it("falls back to the free tier once every slot has lapsed", async () => {
    mockActiveCapacitySeats.mockResolvedValue(0);
    setup(null, "6000000", "0", null);
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
        status: "final",
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
    // The report is fire-and-forget; give it a microtask turn to (not) run.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("reserve / finalize / release workflow AI spend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveCapacitySeats.mockResolvedValue(0);
    delete process.env["INFRAWRENCH_STRIPE_CHAT_METER_EVENT"];
    delete process.env["STRIPE_SECRET_KEY"];
    mockExecute.mockResolvedValue(undefined);
  });

  function queueSpendSelects(cap: number | null, chatTotal: string, workflowTotal = "0") {
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
    mockSelect
      .mockReturnValueOnce({ from: orgFrom })
      .mockReturnValueOnce({ from: subFrom })
      .mockReturnValueOnce({ from: chatFrom })
      .mockReturnValueOnce({ from: wfFrom });
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
      });
    });

    const id = await reserveWorkflowAiSpend({
      organizationId: "o1",
      workflowId: "wf1",
      runId: "run1",
      model: "claude-haiku-4-5",
      estimatedCostMicros: 50_000,
    });

    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(mockExecute).toHaveBeenCalled();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "o1",
        workflowId: "wf1",
        costMicros: 50_000,
        status: "reserved",
        inputTokens: 0,
        outputTokens: 0,
      }),
    );
  });

  it("refuses a reservation when the org is already at its cap", async () => {
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      queueSpendSelects(100_000, "100000");
      await fn({
        execute: mockExecute,
        select: (...a: unknown[]) => mockSelect(...a),
        insert: (...a: unknown[]) => mockInsert(...a),
      });
    });

    await expect(
      reserveWorkflowAiSpend({
        organizationId: "o1",
        workflowId: "wf1",
        model: "claude-haiku-4-5",
        estimatedCostMicros: 1,
      }),
    ).rejects.toThrow(/monthly AI spend cap/);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("finalizes a reservation into real token counts", async () => {
    const returning = vi.fn().mockResolvedValue([{ id: "res-1" }]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    mockUpdate.mockReturnValue({ set });

    const cost = await finalizeWorkflowAiUsage("res-1", {
      organizationId: "o1",
      workflowId: "wf1",
      model: "claude-sonnet-5",
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });

    expect(cost).toBe(4_500_000);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        costMicros: 4_500_000,
        status: "final",
        inputTokens: 1_000_000,
      }),
    );
  });

  it("treats a missing reservation as a stopped run", async () => {
    const returning = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    mockUpdate.mockReturnValue({ set });

    await expect(
      finalizeWorkflowAiUsage("gone", {
        organizationId: "o1",
        workflowId: "wf1",
        model: "claude-haiku-4-5",
        usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    ).rejects.toThrow(/Workflow stopped/);
  });

  it("releases only reserved rows", async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    mockDelete.mockReturnValue({ where });
    await releaseWorkflowAiReservation("res-1");
    expect(mockDelete).toHaveBeenCalled();
    expect(where).toHaveBeenCalled();
  });

  it("estimates tokens from character length", () => {
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(5)).toBe(2);
    expect(estimateTokensFromChars(0)).toBe(1);
  });
});
