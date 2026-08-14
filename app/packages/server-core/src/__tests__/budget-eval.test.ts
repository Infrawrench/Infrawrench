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

import { fakePostgres } from "./helpers/fake-postgres";

// Real Drizzle over a recording driver against the real schema — the budget
// select, the alert-event insert and the notifiedAt update render their actual
// SQL (and shadow-validate under test:postgres:shadow). Results are queued in
// execution order via `arrange` below.
const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

/**
 * Queue one evaluation pass's query results in execution order: the budget
 * select, the (real) budget-trigger-workflow lookup, the (real) org currency
 * settings lookup, then the alert-event insert's RETURNING —
 * [{id}] = fresh crossing, [] = dupe.
 */
function arrange(
  budgetRows: Array<Record<string, unknown>>,
  insertReturning: Array<{ id: string }>,
) {
  pg.queueRows(budgetRows);
  pg.queueRows([]); // budget-trigger workflows: none
  pg.queueRows([]); // org currency settings: no display currency
  pg.queueRows(insertReturning);
}

/** The notifiedAt bookkeeping, read back from the recorded UPDATE statements. */
const notifiedUpdates = () =>
  pg.queries.filter((q) => q.sql.startsWith('update "budget_alert_events"'));

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

// The select has no projection, so keys are in the budgets table's column
// order — see helpers/fake-postgres.ts.
function budget(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "b1",
    organizationId: "org1",
    name: "Cloud spend",
    amountCents: 100_000, // $1000
    currency: "USD",
    filters: [],
    thresholds: [{ type: "actual", percent: 50 }],
    costBasis: "cash",
    savedFilterId: null,
    scenarioModelId: null,
    useAdjustedSpend: false,
    createdByUserId: null,
    deletedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  pg.reset();
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
    arrange([budget()], [{ id: "evt1" }]);
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
    arrange([budget()], [{ id: "evt1" }]);
    sendBudgetAlertPage.mockResolvedValueOnce(false);
    routeAlert.mockResolvedValueOnce(routed());
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);
    expect(notifiedUpdates().some((q) => q.sql.includes('"notified_at"'))).toBe(true);
  });

  it("sets notifiedAt when only Twilio succeeds", async () => {
    arrange([budget()], [{ id: "evt1" }]);
    sendBudgetAlertPage.mockResolvedValueOnce(true);
    routeAlert.mockResolvedValueOnce(unroutedResult());
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);
    expect(notifiedUpdates().length).toBeGreaterThan(0);
  });

  it("sets notifiedAt when quiet hours hold the alert rather than sending it", async () => {
    // A held alert has not gone out yet but will, so the crossing counts as
    // notified — leaving `notifiedAt` unset would re-fire it next pass and
    // deliver twice.
    arrange([budget()], [{ id: "evt1" }]);
    sendBudgetAlertPage.mockResolvedValueOnce(false);
    routeAlert.mockResolvedValueOnce(
      routed({ succeeded: 0, byTransport: { push: 0, slack: 0, msTeams: 0 }, held: 1 }),
    );
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);
    expect(notifiedUpdates().some((q) => q.sql.includes('"notified_at"'))).toBe(true);
  });

  it("does not set notifiedAt when every channel fails", async () => {
    arrange([budget()], [{ id: "evt1" }]);
    sendBudgetAlertPage.mockResolvedValueOnce(false);
    routeAlert.mockResolvedValueOnce(unroutedResult());
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);
    expect(notifiedUpdates()).toHaveLength(0);
  });

  it("skips notification entirely on a duplicate crossing (same month)", async () => {
    arrange([budget()], []); // onConflictDoNothing hit the unique index
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);
    expect(sendBudgetAlertPage).not.toHaveBeenCalled();
    expect(routeAlert).not.toHaveBeenCalled();
  });

  it("does not notify below threshold", async () => {
    queryCosts.mockResolvedValue([
      { currency: "USD", points: [{ bucket: "2026-07-01", amount: 100 }] },
    ]);
    arrange([budget()], []);
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);
    expect(routeAlert).not.toHaveBeenCalled();
  });

  it("never throws when evaluation of one budget fails", async () => {
    arrange([budget()], []);
    queryCosts.mockRejectedValue(new Error("clickhouse down"));
    await expect(budgetEval.evaluateBudgetsForOrg("org1", NOW)).resolves.toBeUndefined();
  });
});
