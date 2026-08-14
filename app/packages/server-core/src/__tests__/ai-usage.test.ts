import { describe, it, expect, vi, beforeEach } from "vitest";

import { fakePostgres } from "./helpers/fake-postgres";

// Real Drizzle over a recording driver against the real schema — every select,
// insert, update and delete below renders its actual SQL (and shadow-validates
// under test:postgres:shadow). Sequential results are queued per statement in
// execution order; `db.transaction` is shimmed flat, so the advisory lock and
// the purge inside `reserveAiSpend` consume queue slots too.
const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

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
  touchAiSpendReservation,
  estimateTokensFromChars,
  AiSpendCapExceededError,
  AI_SPEND_RESERVATION_TTL_MS,
} = await import("../billing/ai-usage");

/** The statements issued against one table, filtered by SQL prefix. */
const queriesOn = (prefix: string) => pg.queries.filter((q) => q.sql.startsWith(prefix));

describe("getAiSpendStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pg.reset();
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
    pg.queueRows([{ cap, complimentary }]);
    pg.queueRows(subStatus ? [{ status: subStatus }] : []);
    pg.queueRows([{ total: chatTotal }]);
    pg.queueRows([{ total: workflowTotal }]);
    pg.queueRows([{ total: reservationTotal }]);
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
    pg.reset();
    delete process.env["INFRAWRENCH_STRIPE_CHAT_METER_EVENT"];
    delete process.env["STRIPE_SECRET_KEY"];
  });

  it("inserts a usage row and returns the marked-up cost", async () => {
    // Sonnet 5: $3/MTok input × 1.5 markup = $4.50
    const cost = await recordWorkflowAiUsage({
      organizationId: "o1",
      workflowId: "wf1",
      runId: "run1",
      model: "claude-sonnet-5",
      usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(cost).toBe(4_500_000);
    const insert = queriesOn('insert into "workflow_ai_usage"')[0];
    expect(insert).toBeDefined();
    // id, org, workflow, run, model, tokens ×4, costMicros — insertion order.
    expect(insert!.params).toEqual([
      expect.stringMatching(/^[0-9a-f-]{36}$/i),
      "o1",
      "wf1",
      "run1",
      "claude-sonnet-5",
      1_000_000,
      0,
      0,
      0,
      4_500_000,
    ]);
  });

  it("skips Stripe entirely when the meter is not configured", async () => {
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
    expect(queriesOn("select")).toEqual([]);
    vi.unstubAllGlobals();
  });
});

describe("reserve / release AI spend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pg.reset();
    mockActiveCapacitySeats.mockResolvedValue(0);
    delete process.env["INFRAWRENCH_STRIPE_CHAT_METER_EVENT"];
    delete process.env["STRIPE_SECRET_KEY"];
  });

  /**
   * Queue every statement `reserveAiSpend` issues inside its (flattened)
   * transaction, in order: the advisory lock, the expired-reservation purge,
   * then the five spend-status selects.
   */
  function queueSpendSelects(
    cap: number | null,
    chatTotal: string,
    workflowTotal = "0",
    reservationTotal = "0",
  ) {
    pg.queueRows([]); // SELECT pg_advisory_xact_lock(...)
    pg.queueRows([]); // delete expired reservations
    pg.queueRows([{ cap, complimentary: false }]);
    pg.queueRows([{ status: "active" }]);
    pg.queueRows([{ total: chatTotal }]);
    pg.queueRows([{ total: workflowTotal }]);
    pg.queueRows([{ total: reservationTotal }]);
  }

  it("reserves estimated spend under a transaction when under the cap", async () => {
    queueSpendSelects(1_000_000, "100000");

    const id = await reserveAiSpend("o1", 50_000);

    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    // The org-scoped advisory lock came first…
    expect(pg.queries[0]!.sql).toContain("pg_advisory_xact_lock");
    expect(pg.queries[0]!.params).toEqual(["ai_spend:o1"]);
    // …then the expired-reservation purge.
    expect(queriesOn('delete from "ai_spend_reservations"')).toHaveLength(1);
    const insert = queriesOn('insert into "ai_spend_reservations"')[0];
    expect(insert).toBeDefined();
    // id, org, estimate, expiresAt — insertion order.
    const [rowId, orgId, estimate, expiresAt] = insert!.params;
    expect(rowId).toBe(id);
    expect(orgId).toBe("o1");
    expect(estimate).toBe(50_000);
    expect(new Date(expiresAt as string).getTime()).toBeGreaterThan(
      Date.now() + AI_SPEND_RESERVATION_TTL_MS - 5_000,
    );
  });

  it("throws AiSpendCapExceededError when the org is already at its cap", async () => {
    queueSpendSelects(100_000, "100000");

    await expect(reserveAiSpend("o1", 1)).rejects.toBeInstanceOf(AiSpendCapExceededError);
    expect(queriesOn("insert")).toEqual([]);
  });

  it("refuses a reservation whose estimate alone would cross the cap", async () => {
    // Settled spend is still under the line; admitting the estimate would push past it.
    queueSpendSelects(1_000_000, "900000");

    await expect(reserveAiSpend("o1", 200_000)).rejects.toBeInstanceOf(AiSpendCapExceededError);
    expect(queriesOn("insert")).toEqual([]);
  });

  it("releases a reservation by id", async () => {
    await releaseAiSpendReservation("res-1");
    const del = queriesOn('delete from "ai_spend_reservations"')[0];
    expect(del).toBeDefined();
    expect(del!.params).toEqual(["res-1"]);
  });

  it("refreshes a reservation's expiry", async () => {
    await touchAiSpendReservation("res-1");
    const update = queriesOn('update "ai_spend_reservations"')[0];
    expect(update).toBeDefined();
    // set expiresAt = $1 where id = $2
    const [expiresAt, id] = update!.params;
    expect(Number.isNaN(new Date(expiresAt as string).getTime())).toBe(false);
    expect(id).toBe("res-1");
  });

  it("estimates tokens from character length", () => {
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(5)).toBe(2);
    expect(estimateTokensFromChars(0)).toBe(1);
  });
});
