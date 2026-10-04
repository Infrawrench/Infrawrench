import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Usage budgets, custom periods and hierarchies, pinned at the resolver and at
 * the alert pass:
 *
 * 1. a usage budget reads the usage quantity in its unit, never money, and its
 *    alert speaks in that unit and carries no money facts for routing;
 * 2. a custom period measures exactly its own window and keys alert events by
 *    the period's start day (calendar-month budgets keep `YYYY-MM`);
 * 3. a parent's figures are the sum of its children's, re-measured over the
 *    parent's window, and children that outgrow it are reported.
 */

const sendBudgetAlertPage = vi.fn(async () => false);
vi.mock("../twilio-pager", () => ({ sendBudgetAlertPage }));

const queryCosts = vi.fn();
const queryUsageDaily = vi.fn();
vi.mock("../clickhouse/cost-readers", () => ({ queryCosts, queryUsageDaily }));

// A budget's owner (`visibility_user_id`) resolves to a restricted scope; null
// to the whole org. The scope's contents do not matter here, only that the
// resolver's reads run inside the right one.
vi.mock("../cost/visibility", () => ({
  resolveObjectCostVisibility: vi.fn(async (organizationId: string, userId: string | null) =>
    userId
      ? { organizationId, restricted: true, userId, layers: [] }
      : { organizationId, restricted: false },
  ),
}));

vi.mock("../cost/currency-settings", () => ({
  getOrgCurrencySettings: vi.fn(async () => ({ displayCurrency: null })),
  listOrgExchangeRates: vi.fn(async () => []),
}));
vi.mock("../cost/saved-filters", () => ({ resolveSavedCostFilters: vi.fn(async () => []) }));

import { fakePostgres } from "./helpers/fake-postgres";

const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

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

let budgetEval: typeof import("../cost/budget-eval");

type Row = Record<string, unknown>;

/** A budgets row with every column, in table order (see fake-postgres). */
function budget(over: Row = {}): Record<string, unknown> {
  return {
    id: "b1",
    organizationId: "org1",
    name: "Budget",
    amountCents: 100_000,
    currency: "USD",
    filters: [],
    thresholds: [{ type: "actual", percent: 50 }],
    costBasis: "cash",
    savedFilterId: null,
    scenarioModelId: null,
    useAdjustedSpend: false,
    visibilityUserId: null,
    createdByUserId: null,
    deletedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    measure: "cost",
    usageUnit: null,
    usageAmount: null,
    period: null,
    parentBudgetId: null,
    ...over,
  };
}

/** Spend per scope: the account filter's first value picks the series. */
function spendByAccount(series: Record<string, Array<[string, number]>>) {
  queryCosts.mockImplementation(
    async (_org: string, q: { filters: Array<{ values: string[] }> }) => {
      const key = q.filters[0]?.values[0] ?? "";
      const points = (series[key] ?? []).map(([bucket, amount]) => ({ bucket, amount }));
      return [{ key: "", currency: "USD", points }];
    },
  );
}

const scoped = (account: string) => [{ dimension: "account", op: "in", values: [account] }];

beforeEach(async () => {
  vi.clearAllMocks();
  pg.reset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  queryCosts.mockResolvedValue([]);
  queryUsageDaily.mockResolvedValue([]);
  budgetEval = await import("../cost/budget-eval");
});

describe("usage budgets", () => {
  it("sums the usage quantity in the budget's unit, not money", async () => {
    queryUsageDaily.mockResolvedValue([
      { bucket: "2026-07-01", amount: 400_000 },
      { bucket: "2026-07-02", amount: 300_000 },
    ]);
    const row = budget({ measure: "usage", usageUnit: "tokens", usageAmount: 1_000_000 });
    const resolver = new budgetEval.BudgetStatusResolver("org1", [row as never], NOW);
    const status = await resolver.status("b1");
    expect(queryCosts).not.toHaveBeenCalled();
    expect(queryUsageDaily).toHaveBeenCalledWith(
      "org1",
      expect.objectContaining({ usageUnit: "tokens", to: "2026-07-15" }),
    );
    expect(status).toMatchObject({
      measure: "usage",
      limit: 1_000_000,
      actualUsage: 700_000,
      actualCents: 0,
      periodKey: "2026-07",
    });
  });

  it("alerts in the unit and gives routing no money facts", async () => {
    queryUsageDaily.mockResolvedValue([{ bucket: "2026-07-01", amount: 600_000 }]);
    pg.queueRows([budget({ measure: "usage", usageUnit: "tokens", usageAmount: 1_000_000 })]);
    pg.queueRows([{ id: "evt1" }]);
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);
    const event = routeAlert.mock.calls[0]![0] as { body: string; facts: Record<string, unknown> };
    expect(event.body).toContain("usage 600K tokens has reached 50% of 1M tokens");
    expect(event.facts).toEqual({ key: "Budget" });
  });
});

describe("custom periods", () => {
  it("measures a fortnight from its start day and keys events by it", async () => {
    spendByAccount({
      "": [
        ["2026-07-05", 999],
        ["2026-07-13", 300],
        ["2026-07-14", 300],
      ],
    });
    const period = { kind: "recurring", unit: "week", interval: 2, startDate: "2026-06-29" };
    pg.queueRows([budget({ period, amountCents: 100_000 })]);
    pg.queueRows([{ id: "evt1" }]);
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);
    const insert = pg.queries.find((q) => q.sql.startsWith('insert into "budget_alert_events"'));
    expect(insert?.params).toEqual(expect.arrayContaining(["2026-07-13", "2026-07-26"]));
    const event = routeAlert.mock.calls[0]![0] as { body: string };
    // Only the two days inside the window count; July 5th is the previous one.
    expect(event.body).toContain(
      "spend $600 has reached 50% of $1,000 for 2026-07-13 to 2026-07-26",
    );
  });

  it("measures nothing when no explicit period covers today", async () => {
    const row = budget({
      amountCents: 0,
      period: {
        kind: "explicit",
        periods: [{ start: "2026-08-01", end: "2026-08-31", amountCents: 5 }],
      },
    });
    const resolver = new budgetEval.BudgetStatusResolver("org1", [row as never], NOW);
    const status = await resolver.status("b1");
    expect(status).toMatchObject({ periodStart: null, limit: null, periodKey: null });
    expect(queryCosts).not.toHaveBeenCalled();
  });
});

describe("hierarchies", () => {
  it("rolls children up over the parent's window and warns when they outgrow it", async () => {
    spendByAccount({ a: [["2026-07-02", 700]], b: [["2026-07-03", 500]] });
    const rows = [
      budget({ id: "p", name: "Parent", amountCents: 100_000 }),
      budget({ id: "a", parentBudgetId: "p", amountCents: 80_000, filters: scoped("a") }),
      budget({ id: "b", parentBudgetId: "p", amountCents: 50_000, filters: scoped("b") }),
    ];
    const resolver = new budgetEval.BudgetStatusResolver("org1", rows as never, NOW);
    const parent = await resolver.status("p");
    expect(parent).toMatchObject({ rolledUp: true, childCount: 2, actualCents: 120_000 });
    expect(parent.hierarchyWarnings.map((w) => w.kind)).toEqual(
      expect.arrayContaining(["allocation", "actual"]),
    );
    expect(parent.hierarchyWarnings.find((w) => w.kind === "allocation")).toMatchObject({
      childTotal: 130_000,
      parentLimit: 100_000,
    });
    // The children's own statuses reuse the reads the parent already made.
    await resolver.status("a");
    await resolver.status("b");
    expect(queryCosts).toHaveBeenCalledTimes(2);
  });

  it("re-measures a monthly child over a quarterly parent's window", async () => {
    spendByAccount({ a: [["2026-07-02", 100]] });
    const rows = [
      budget({
        id: "p",
        period: { kind: "recurring", unit: "quarter", interval: 1, startDate: "2026-07-01" },
      }),
      budget({ id: "a", parentBudgetId: "p", filters: scoped("a") }),
    ];
    const resolver = new budgetEval.BudgetStatusResolver("org1", rows as never, NOW);
    const parent = await resolver.status("p");
    expect(parent).toMatchObject({ periodStart: "2026-07-01", periodEnd: "2026-09-30" });
    // Different windows, so no allocation comparison is possible.
    expect(parent.hierarchyWarnings.some((w) => w.kind === "allocation")).toBe(false);
    expect(queryCosts).toHaveBeenCalledWith(
      "org1",
      expect.objectContaining({ from: "2026-05-17", to: "2026-07-15" }),
    );
  });

  it("rolls a scoped member's parent up from their own budgets only, inside their scope", async () => {
    const { currentCostVisibility } = await import("../cost/visibility-context");
    const seenScopes: Array<{ account: string; userId: string | null }> = [];
    queryCosts.mockImplementation(
      async (_org: string, q: { filters: Array<{ values: string[] }> }) => {
        const account = q.filters[0]?.values[0] ?? "";
        const v = currentCostVisibility();
        seenScopes.push({ account, userId: v?.restricted ? v.userId : null });
        const amount = account === "a" ? 700 : account === "b" ? 500 : 0;
        return [{ key: "", currency: "USD", points: [{ bucket: "2026-07-02", amount }] }];
      },
    );
    pg.queueRows([
      budget({ id: "p", name: "Parent", visibilityUserId: "s1" }),
      // The scoped member's own child, and an org-wide one an admin attached.
      budget({
        id: "a",
        parentBudgetId: "p",
        visibilityUserId: "s1",
        thresholds: [],
        filters: scoped("a"),
      }),
      budget({ id: "b", parentBudgetId: "p", thresholds: [], filters: scoped("b") }),
    ]);
    pg.queueRows([{ id: "evt1" }]);
    await budgetEval.evaluateBudgetsForOrg("org1", NOW);

    // Only the child the owner can see was measured, and inside their scope.
    expect(seenScopes).toEqual([{ account: "a", userId: "s1" }]);
    const event = routeAlert.mock.calls[0]![0] as { body: string };
    expect(event.body).toContain("$700");
    expect(event.body).not.toContain("$1,200");
  });
});
