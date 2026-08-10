import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Budget threshold evaluation tests, focused on the notification fan-out:
 * Twilio page + mobile push + Slack, and `notifiedAt` accounting when any one
 * channel succeeds. Cost data is mocked at the queryCosts boundary.
 */

const sendBudgetAlertPage = vi.fn(async () => false);
vi.mock("../twilio-pager", () => ({ sendBudgetAlertPage }));

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

/**
 * All three transports sit behind `routeAlert` now, so that is the single seam
 * these tests mock. `alertReached` is the real predicate rather than a stub —
 * it decides whether a cooldown or claim is kept, and faking it would hide
 * exactly the bug it exists to prevent.
 */
// Defaults to a successful delivery: `routeAlert` never throws and always
// returns a result, so a mock that resolves `undefined` would fail tests in a
// way the real function cannot.
const routeAlert = vi.fn(async (..._args: unknown[]) => routed());
vi.mock("../alerts/route", () => ({
  routeAlert: (...a: unknown[]) => routeAlert(...a),
  alertReached: (r: { succeeded?: number; held?: number } | null | undefined) =>
    (r?.succeeded ?? 0) > 0 || (r?.held ?? 0) > 0,
}));

/** A delivery that reached one Slack channel and one phone. */
function routed(over: Record<string, unknown> = {}) {
  return {
    attempted: 2,
    succeeded: 2,
    byTransport: { push: 1, slack: 1, msTeams: 0 },
    attemptedByTransport: { push: 1, slack: 1, msTeams: 0 },
    held: 0,
    unrouted: false,
    matchedRuleIds: ["rule1"],
    // The tracked-Slack half of the result. Present by default because
    // `byTransport.slack` is 1 — a result claiming a Slack delivery with no
    // message to show for it is a shape the real function never returns.
    slackMessages: [],
    deliveryIds: [],
    ...over,
  };
}

/** A delivery that reached nobody — no rule matched, or every channel failed. */
function unroutedResult() {
  return routed({
    attempted: 0,
    succeeded: 0,
    byTransport: { push: 0, slack: 0, msTeams: 0 },
    attemptedByTransport: { push: 0, slack: 0, msTeams: 0 },
    matchedRuleIds: [],
    slackMessages: [],
    unrouted: true,
  });
}

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
    expect(routeAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org1",
        trigger: "budgetAlerts",
        pushData: expect.objectContaining({ type: "budget_breach", budgetId: "b1" }),
        // The amount is what an "over $500" rule matches on, so it travels as a
        // fact rather than only inside the sentence.
        facts: expect.objectContaining({ amountCents: expect.any(Number) }),
      }),
    );
    expect(sendBudgetAlertPage).toHaveBeenCalledTimes(1);
  });

  it("sets notifiedAt when only push succeeds", async () => {
    budgetRows = [budget()];
    insertReturning = [{ id: "evt1" }];
    sendBudgetAlertPage.mockResolvedValueOnce(false);
    routeAlert.mockResolvedValueOnce(routed());
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);
    expect(updates.some((u) => u.table === "budgetAlertEvents" && "notifiedAt" in u.set)).toBe(
      true,
    );
  });

  it("sets notifiedAt when only Twilio succeeds", async () => {
    budgetRows = [budget()];
    insertReturning = [{ id: "evt1" }];
    sendBudgetAlertPage.mockResolvedValueOnce(true);
    routeAlert.mockResolvedValueOnce(unroutedResult());
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);
    expect(updates.some((u) => u.table === "budgetAlertEvents")).toBe(true);
  });

  it("sets notifiedAt when quiet hours hold the alert rather than sending it", async () => {
    // A held alert has not gone out yet but will, so the crossing counts as
    // notified — leaving `notifiedAt` unset would re-fire it next pass and
    // deliver twice.
    budgetRows = [budget()];
    insertReturning = [{ id: "evt1" }];
    sendBudgetAlertPage.mockResolvedValueOnce(false);
    routeAlert.mockResolvedValueOnce(
      routed({ succeeded: 0, byTransport: { push: 0, slack: 0, msTeams: 0 }, held: 1 }),
    );
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);
    expect(updates.some((u) => u.table === "budgetAlertEvents" && "notifiedAt" in u.set)).toBe(
      true,
    );
  });

  it("does not set notifiedAt when every channel fails", async () => {
    budgetRows = [budget()];
    insertReturning = [{ id: "evt1" }];
    sendBudgetAlertPage.mockResolvedValueOnce(false);
    routeAlert.mockResolvedValueOnce(unroutedResult());
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);
    expect(updates).toHaveLength(0);
  });

  it("skips notification entirely on a duplicate crossing (same month)", async () => {
    budgetRows = [budget()];
    insertReturning = []; // onConflictDoNothing hit the unique index
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);
    expect(sendBudgetAlertPage).not.toHaveBeenCalled();
    expect(routeAlert).not.toHaveBeenCalled();
  });

  it("does not notify below threshold", async () => {
    queryCosts.mockResolvedValue([
      { currency: "USD", points: [{ bucket: "2026-07-01", amount: 100 }] },
    ]);
    budgetRows = [budget()];
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);
    expect(routeAlert).not.toHaveBeenCalled();
  });

  it("never throws when evaluation of one budget fails", async () => {
    budgetRows = [budget()];
    queryCosts.mockRejectedValue(new Error("clickhouse down"));
    await expect(budgetEval.evaluateBudgetsForOrg("org1", NOW)).resolves.toBeUndefined();
  });
});
