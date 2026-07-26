import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Budget threshold evaluation tests, focused on the notification fan-out:
 * Twilio page + mobile push + Slack, and `notifiedAt` accounting when any one
 * channel succeeds. Cost data is mocked at the queryCosts boundary.
 */

const sendBudgetAlertPage = vi.fn(async () => false);
vi.mock("../twilio-pager", () => ({ sendBudgetAlertPage }));

const sendPushToOrg = vi.fn(async () => ({ attempted: 0, succeeded: 0 }));
vi.mock("../push/dispatch", () => ({ sendPushToOrg }));

const sendSlackToOrg = vi.fn(async () => ({ attempted: 0, succeeded: 0, failed: 0 }));
vi.mock("../slack", () => ({ sendSlackToOrg }));

// A single cost group: $500 spent this month, in one bucket.
const queryCosts = vi.fn();
vi.mock("../clickhouse/cost-readers", () => ({ queryCosts }));

const tables = {
  budgets: { __t: "budgets" as const, organizationId: "o", deletedAt: "d" },
  budgetAlertEvents: { __t: "budgetAlertEvents" as const, id: "id" },
};
vi.mock("../db/schema", () => tables);

let budgetRows: unknown[] = [];
// Result of the alert-event insert; [{id}] = fresh crossing, [] = dupe.
let insertReturning: Array<{ id: string }> = [];
const updates: Array<{ table: string; set: Record<string, unknown> }> = [];

const db = {
  select: () => ({ from: () => ({ where: () => Promise.resolve(budgetRows) }) }),
  insert: (table: { __t: string }) => ({
    values: () => ({
      onConflictDoNothing: () => ({
        returning: () => Promise.resolve(insertReturning),
      }),
    }),
  }),
  update: (table: { __t: string }) => ({
    set: (s: Record<string, unknown>) => {
      updates.push({ table: table.__t, set: s });
      return { where: () => Promise.resolve() };
    },
  }),
};
vi.mock("../db/client", () => ({ db }));

let budgetEval: typeof import("../cost/budget-eval");

const NOW = new Date("2026-07-15T12:00:00Z");

function budget(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "b1",
    organizationId: "org1",
    name: "Cloud spend",
    amountCents: 100_000, // $1000
    currency: "USD",
    filters: [],
    thresholds: [{ type: "actual", percent: 50 }],
    ...over,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  budgetRows = [];
  insertReturning = [];
  updates.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  // $600 on July 1st — over a 50% threshold of a $1000 budget.
  queryCosts.mockResolvedValue([
    { currency: "USD", points: [{ bucket: "2026-07-01", amount: 600 }] },
  ]);
  budgetEval = await import("../cost/budget-eval");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("evaluateBudgetsForOrg — notification fan-out", () => {
  it("sends push with the budget deep-link payload on a fresh crossing", async () => {
    budgetRows = [budget()];
    insertReturning = [{ id: "evt1" }];
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);
    expect(sendPushToOrg).toHaveBeenCalledWith(
      "org1",
      "budgetAlerts",
      expect.objectContaining({
        data: {
          type: "budget_breach",
          orgId: "org1",
          budgetId: "b1",
          month: "2026-07",
          thresholdPercent: 50,
        },
      }),
    );
    expect(sendBudgetAlertPage).toHaveBeenCalledTimes(1);
  });

  it("sets notifiedAt when only push succeeds", async () => {
    budgetRows = [budget()];
    insertReturning = [{ id: "evt1" }];
    sendBudgetAlertPage.mockResolvedValueOnce(false);
    sendPushToOrg.mockResolvedValueOnce({ attempted: 1, succeeded: 1 });
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);
    expect(updates.some((u) => u.table === "budgetAlertEvents" && "notifiedAt" in u.set)).toBe(
      true,
    );
  });

  it("sets notifiedAt when only Twilio succeeds", async () => {
    budgetRows = [budget()];
    insertReturning = [{ id: "evt1" }];
    sendBudgetAlertPage.mockResolvedValueOnce(true);
    sendPushToOrg.mockResolvedValueOnce({ attempted: 0, succeeded: 0 });
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);
    expect(updates.some((u) => u.table === "budgetAlertEvents")).toBe(true);
  });

  it("sets notifiedAt when only Slack succeeds", async () => {
    budgetRows = [budget()];
    insertReturning = [{ id: "evt1" }];
    sendBudgetAlertPage.mockResolvedValueOnce(false);
    sendPushToOrg.mockResolvedValueOnce({ attempted: 0, succeeded: 0 });
    sendSlackToOrg.mockResolvedValueOnce({ attempted: 1, succeeded: 1, failed: 0 });
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);
    expect(updates.some((u) => u.table === "budgetAlertEvents" && "notifiedAt" in u.set)).toBe(
      true,
    );
  });

  it("does not set notifiedAt when every channel fails", async () => {
    budgetRows = [budget()];
    insertReturning = [{ id: "evt1" }];
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);
    expect(updates).toHaveLength(0);
  });

  it("skips notification entirely on a duplicate crossing (same month)", async () => {
    budgetRows = [budget()];
    insertReturning = []; // onConflictDoNothing hit the unique index
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);
    expect(sendBudgetAlertPage).not.toHaveBeenCalled();
    expect(sendPushToOrg).not.toHaveBeenCalled();
  });

  it("does not notify below threshold", async () => {
    queryCosts.mockResolvedValue([
      { currency: "USD", points: [{ bucket: "2026-07-01", amount: 100 }] },
    ]);
    budgetRows = [budget()];
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);
    expect(sendPushToOrg).not.toHaveBeenCalled();
  });

  it("never throws when evaluation of one budget fails", async () => {
    budgetRows = [budget()];
    queryCosts.mockRejectedValue(new Error("clickhouse down"));
    await expect(budgetEval.evaluateBudgetsForOrg("org1", NOW)).resolves.toBeUndefined();
  });
});
