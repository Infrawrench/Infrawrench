import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The budget/scenario decision, pinned.
 *
 * The decision: **budget forecast thresholds keep using the unadjusted trend
 * unless that budget explicitly opts into a model.** A scenario is a hypothesis
 * somebody typed into a form; a forecast threshold decides when a real person
 * gets paged. Letting the first silently move the second would mean anyone with
 * `costs:write` could change an on-call rota by editing an object two screens
 * away, and the page (or the missing page) would carry no evidence of why.
 *
 * The three properties that make the decision safe rather than merely stated:
 *
 * 1. a budget with no `scenarioModelId` behaves **byte-identically** to before
 *    scenarios existed — the model is never even loaded;
 * 2. a budget that opts in judges its forecast thresholds on the adjusted
 *    figure, keeps the unadjusted one alongside it, and **names the model in
 *    the alert body** so "why was I paged" is answerable from the message; and
 * 3. `actual` thresholds are untouched either way — they measure money already
 *    spent, which no scenario can move.
 */

const sendBudgetAlertPage = vi.fn(async () => false);
vi.mock("../twilio-pager", () => ({ sendBudgetAlertPage }));

const queryCosts = vi.fn();
vi.mock("../clickhouse/cost-readers", () => ({ queryCosts }));

vi.mock("../cost/currency-settings", () => ({
  getOrgCurrencySettings: vi.fn(async () => ({ displayCurrency: null })),
  listOrgExchangeRates: vi.fn(async () => []),
}));

vi.mock("../cost/saved-filters", () => ({ resolveSavedCostFilters: vi.fn(async () => []) }));

const resolveCostScenarioModel = vi.fn();
vi.mock("../cost/scenario-forecast", async () => {
  const actual = await vi.importActual<typeof import("../cost/scenario-forecast")>(
    "../cost/scenario-forecast",
  );
  return { ...actual, resolveCostScenarioModel };
});

const tables = {
  budgets: { __t: "budgets" as const, organizationId: "o", deletedAt: "d" },
  budgetAlertEvents: { __t: "budgetAlertEvents" as const, id: "id" },
  costScenarioModels: { __t: "costScenarioModels" as const },
};
vi.mock("../db/schema", () => tables);

let budgetRows: unknown[] = [];
let insertReturning: Array<{ id: string }> = [];
const db = {
  select: () => ({ from: () => ({ where: () => Promise.resolve(budgetRows) }) }),
  insert: () => ({
    values: () => ({ onConflictDoNothing: () => ({ returning: async () => insertReturning }) }),
  }),
  update: () => ({ set: () => ({ where: async () => undefined }) }),
};
vi.mock("../db/client", () => ({ db }));

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

/** Flat $10/day across the trailing 60 days ending today. */
function flatSpend() {
  const points: Array<{ bucket: string; amount: number }> = [];
  for (let i = 59; i >= 0; i--) {
    points.push({
      bucket: new Date(NOW.getTime() - i * 86_400_000).toISOString().slice(0, 10),
      amount: 10,
    });
  }
  return [{ currency: "USD", points }];
}

/**
 * A model that adds $500 on the 20th — inside the projected region, so it moves
 * the month forecast and nothing else.
 */
const model = {
  id: "model-1",
  name: "Q4 plan",
  description: null,
  currency: "USD",
  adjustments: [
    {
      id: "a1",
      label: "Annual licence",
      kind: "one_off" as const,
      startDate: "2026-07-20",
      endDate: null,
      amountCents: 50_000,
      currency: "USD",
      period: null,
      percent: null,
      scope: [],
    },
  ],
  createdByUserId: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

function budget(over: Record<string, unknown> = {}) {
  return {
    id: "b1",
    organizationId: "org1",
    name: "Cloud spend",
    amountCents: 100_000, // $1000
    currency: "USD",
    filters: [],
    savedFilterId: null,
    scenarioModelId: null,
    costBasis: "cash",
    // 50% of $1000 is $500. The bare trend lands at $310 for the month, so this
    // fires only if the scenario's $500 is folded in.
    thresholds: [{ type: "forecast", percent: 50 }],
    ...over,
  };
}

let budgetEval: typeof import("../cost/budget-eval");

beforeEach(async () => {
  vi.clearAllMocks();
  budgetRows = [];
  insertReturning = [{ id: "evt1" }];
  queryCosts.mockResolvedValue(flatSpend());
  resolveCostScenarioModel.mockResolvedValue(model);
  budgetEval = await import("../cost/budget-eval");
});

describe("budgetMonthStatus — the scenario opt-in", () => {
  it("does not load or apply a model for a budget that did not opt in", async () => {
    const status = await budgetEval.budgetMonthStatus("org1", [], "USD", NOW);

    // $10/day: 15 days recorded, 16 days projected.
    expect(status.actualCents).toBe(15_000);
    expect(status.forecastCents).toBe(31_000);
    // Null is the signal that thresholds are judged on the trend.
    expect(status.scenarioForecastCents).toBeNull();
    expect(status.scenarioModelName).toBeNull();
    expect(resolveCostScenarioModel).not.toHaveBeenCalled();
  });

  it("returns the adjusted figure alongside the trend for a budget that opted in", async () => {
    const status = await budgetEval.budgetMonthStatus(
      "org1",
      [],
      "USD",
      NOW,
      undefined,
      null,
      "model-1",
    );

    // The trend is still the trend — both numbers are comparable on a card.
    expect(status.forecastCents).toBe(31_000);
    // ...and the adjusted one carries the $500 landing on the 20th.
    expect(status.scenarioForecastCents).toBe(81_000);
    expect(status.scenarioModelName).toBe("Q4 plan");
    // Recorded spend is untouched by construction.
    expect(status.actualCents).toBe(15_000);
  });

  it("ignores an adjustment dated inside the recorded part of the month", async () => {
    resolveCostScenarioModel.mockResolvedValue({
      ...model,
      adjustments: [{ ...model.adjustments[0]!, startDate: "2026-07-03" }],
    });
    const status = await budgetEval.budgetMonthStatus(
      "org1",
      [],
      "USD",
      NOW,
      undefined,
      null,
      "model-1",
    );
    expect(status.scenarioForecastCents).toBe(status.forecastCents);
  });
});

describe("evaluateBudgetsForOrg — which thresholds a scenario can move", () => {
  it("leaves a forecast threshold on the bare trend when the budget did not opt in", async () => {
    budgetRows = [budget()];
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);
    // $310 forecast against a $500 threshold: nothing fires, exactly as before
    // scenarios existed — and no model was consulted.
    expect(routeAlert).not.toHaveBeenCalled();
    expect(resolveCostScenarioModel).not.toHaveBeenCalled();
  });

  it("fires on the adjusted forecast for a budget that opted in, and names the model", async () => {
    budgetRows = [budget({ scenarioModelId: "model-1" })];
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);

    expect(routeAlert).toHaveBeenCalledTimes(1);
    const call = routeAlert.mock.calls[0]![0] as { body: string };
    expect(call.body).toContain("forecasted spend");
    // The caveat is not optional decoration: it is the only evidence in the
    // message that a hypothesis is inside the number that woke somebody.
    expect(call.body).toContain('includes scenario "Q4 plan"');
  });

  it("never lets a scenario move an `actual` threshold", async () => {
    // $500 of actual spend would be needed; only $150 has been recorded, and
    // the scenario's $500 is in the future where actuals cannot see it.
    budgetRows = [
      budget({ scenarioModelId: "model-1", thresholds: [{ type: "actual", percent: 50 }] }),
    ];
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);
    expect(routeAlert).not.toHaveBeenCalled();
  });
});
