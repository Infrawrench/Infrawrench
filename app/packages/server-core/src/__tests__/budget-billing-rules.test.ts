import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The budget/billing-rule decision, pinned.
 *
 * The decision: **a budget measures collected spend unless that budget
 * explicitly opts in.** A billing rule is organisation policy — a markup that
 * recovers overhead, a discount negotiated outside the provider's pricing — and
 * a budget threshold decides when a real person is paged. If a markup silently
 * raised measured spend, adding one settings row would move every on-call rota
 * in the organisation at once, and every resulting page would be for money
 * nobody spent.
 *
 * This is the same precedent scenario models set (`budget-scenario.test.ts`),
 * with one deliberate difference stated below and tested here: unlike a
 * scenario, opting in affects `actual` thresholds too, because an opted-in
 * budget is measuring the internal figure and month-to-date internal spend is
 * as marked up as the forecast is.
 *
 * The properties that make the decision safe rather than merely stated:
 *
 * 1. an un-opted budget **never reads the rules table**, so a markup cannot
 *    reach a threshold it was not invited to;
 * 2. an opted-in budget judges on the adjusted figure, carries the collected
 *    figure alongside it, and **says so in the alert body**; and
 * 3. `rawActualCents` is null — not a copy — on an un-opted budget, so a card
 *    cannot caption every budget in the organisation and make the adjusted ones
 *    invisible.
 */

const sendBudgetAlertPage = vi.fn(async (_orgId: string, _body: string) => false);
vi.mock("../twilio-pager", () => ({ sendBudgetAlertPage }));

const queryCosts = vi.fn();
vi.mock("../clickhouse/cost-readers", () => ({ queryCosts }));

vi.mock("../cost/currency-settings", () => ({
  getOrgCurrencySettings: vi.fn(async () => ({ displayCurrency: null })),
  listOrgExchangeRates: vi.fn(async () => []),
}));

vi.mock("../cost/saved-filters", () => ({ resolveSavedCostFilters: vi.fn(async () => []) }));

vi.mock("../cost/scenario-forecast", () => ({
  resolveCostScenarioModel: vi.fn(),
  forecastWithScenario: vi.fn(),
}));

const resolveBillingAdjustments = vi.fn();
vi.mock("../cost/billing-rules", () => ({ resolveBillingAdjustments }));

import { fakePostgres } from "./helpers/fake-postgres";

// Real Drizzle over a recording driver against the real schema — the budget
// select, the alert-event insert and the notifiedAt update render their actual
// SQL (and shadow-validate under test:postgres:shadow). Results are queued in
// execution order: the budget select, then the insert's RETURNING.
const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

function arrange(budgetRows: Array<Record<string, unknown>>) {
  pg.queueRows(budgetRows);
  pg.queueRows([{ id: "evt1" }]); // the alert-event insert: always a fresh crossing here
}

const routeAlert = vi.fn(async (..._args: unknown[]) => ({
  attempted: 1,
  succeeded: 1,
  held: 0,
  byTransport: { push: 1, slack: 0, msTeams: 0 },
  attemptedByTransport: { push: 1, slack: 0, msTeams: 0 },
  unrouted: false,
  matchedRuleIds: [],
  slackMessages: [],
  deliveryIds: [],
}));
vi.mock("../alerts/route", () => ({
  routeAlert: (...a: unknown[]) => routeAlert(...a),
  alertReached: (r: { succeeded?: number } | null | undefined) => (r?.succeeded ?? 0) > 0,
}));

vi.mock("../workflows/budget-triggers", () => ({
  listBudgetTriggerWorkflows: vi.fn(async () => []),
  fireBudgetTriggerWorkflows: vi.fn(async () => undefined),
}));

const NOW = new Date("2026-07-15T12:00:00Z");

/**
 * What the reader returns for an adjusted query: $20/day adjusted against
 * $10/day collected — a flat 100% markup — for the trailing 60 days.
 */
function spend(adjusted: boolean) {
  const points: Array<{ bucket: string; amount: number }> = [];
  const rawPoints: Array<{ bucket: string; amount: number }> = [];
  for (let i = 59; i >= 0; i--) {
    const bucket = new Date(NOW.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    points.push({ bucket, amount: adjusted ? 20 : 10 });
    rawPoints.push({ bucket, amount: 10 });
  }
  return [{ currency: "USD", points, ...(adjusted ? { rawPoints } : {}) }];
}

/** A rule set with one enabled rule in it, so it is not the empty case. */
const MARKUP = {
  adjustments: {
    factors: [{ ruleId: "r1", name: "Overhead", match: {}, factor: 2 }],
    reallocations: [],
    fixed: [],
  },
  rules: [
    { id: "r1", name: "Overhead", kind: "percentage" as const, summary: "+100% on all spend" },
  ],
};

// The select has no projection, so keys are in the budgets table's column
// order — see helpers/fake-postgres.ts.
function budget(over: Record<string, unknown> = {}) {
  return {
    id: "b1",
    organizationId: "org1",
    name: "Cloud spend",
    amountCents: 100_000, // $1000
    currency: "USD",
    filters: [],
    // $500. Collected month-to-date is $150, adjusted is $300 — so an `actual`
    // threshold at 50% fires on neither, which is what makes the *forecast*
    // pair below the discriminating case.
    thresholds: [{ type: "forecast", percent: 50 }],
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

let budgetEval: typeof import("../cost/budget-eval");

beforeEach(async () => {
  vi.clearAllMocks();
  pg.reset();
  // The reader decides what to return from whether adjustments were passed —
  // exactly as the real one does.
  queryCosts.mockImplementation(async (_org: string, q: { adjustments?: unknown }) =>
    spend(Boolean(q.adjustments)),
  );
  resolveBillingAdjustments.mockResolvedValue(MARKUP);
  budgetEval = await import("../cost/budget-eval");
});

describe("budgetMonthStatus — the billing-rule opt-in", () => {
  it("does not read the rules table at all for a budget that did not opt in", async () => {
    const status = await budgetEval.budgetMonthStatus("org1", [], "USD", NOW);

    expect(resolveBillingAdjustments).not.toHaveBeenCalled();
    // $10/day collected: 15 days recorded, 31 in the month.
    expect(status.actualCents).toBe(15_000);
    expect(status.forecastCents).toBe(31_000);
    expect(status.adjustedSpend).toBe(false);
    // Null, not a copy of actualCents — see the header.
    expect(status.rawActualCents).toBeNull();
  });

  it("measures the adjusted figure and carries the collected one for a budget that opted in", async () => {
    const status = await budgetEval.budgetMonthStatus(
      "org1",
      [],
      "USD",
      NOW,
      undefined,
      null,
      null,
      true,
    );

    expect(resolveBillingAdjustments).toHaveBeenCalledWith("org1");
    expect(status.adjustedSpend).toBe(true);
    // Adjusted: $20/day.
    expect(status.actualCents).toBe(30_000);
    expect(status.forecastCents).toBe(62_000);
    // Collected, from the same pass.
    expect(status.rawActualCents).toBe(15_000);
  });

  it("adjusts `actual` too — unlike a scenario, which cannot touch spent money", async () => {
    const raw = await budgetEval.budgetMonthStatus("org1", [], "USD", NOW);
    const adjusted = await budgetEval.budgetMonthStatus(
      "org1",
      [],
      "USD",
      NOW,
      undefined,
      null,
      null,
      true,
    );
    // The deliberate difference from the scenario precedent: an opted-in budget
    // is measuring the internal figure, and month-to-date internal spend is as
    // marked up as the forecast is. Judging one on each would be a budget
    // measuring two different things.
    expect(adjusted.actualCents).toBe(raw.actualCents * 2);
  });

  it("passes no adjustments to the reader when the org has no rules in force", async () => {
    resolveBillingAdjustments.mockResolvedValue({
      adjustments: { factors: [], reallocations: [], fixed: [] },
      rules: [],
    });
    await budgetEval.budgetMonthStatus("org1", [], "USD", NOW, undefined, null, null, true);
    expect(queryCosts.mock.calls[0]![1]).not.toHaveProperty("adjustments");
  });
});

describe("evaluateBudgetsForOrg — what pages a human", () => {
  it("does not fire on a markup the budget never opted into", async () => {
    // Collected forecast is $310, the threshold is $500. The markup would take
    // it to $620 — which must not happen for an un-opted budget.
    arrange([budget()]);
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);

    expect(resolveBillingAdjustments).not.toHaveBeenCalled();
    expect(routeAlert).not.toHaveBeenCalled();
    expect(sendBudgetAlertPage).not.toHaveBeenCalled();
  });

  it("fires for an opted-in budget and names the collected figure in the body", async () => {
    arrange([budget({ useAdjustedSpend: true })]);
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);

    expect(sendBudgetAlertPage).toHaveBeenCalledTimes(1);
    const body = sendBudgetAlertPage.mock.calls[0]![1];
    expect(body).toContain("forecasted spend");
    // "Why is this number bigger than the bill" has to be answerable from the
    // message itself — it is often the only place the figure is ever read.
    expect(body).toContain("billing rules applied");
    expect(body).toContain("collected spend");
  });
});
