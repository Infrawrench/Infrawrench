import { beforeEach, describe, expect, it, vi } from "vitest";
import { alertReachedImpl, routed } from "./helpers/route-alert";

/**
 * Unit-cost regression evaluation tests that exercise the *pipeline*, not the
 * maths — `unit-cost-regression.test.ts` covers the gap rules and thresholds.
 *
 * What this file is for: the trigger goes through `routeAlert` and never
 * through a transport; the fire-once row is keyed on the window end; a gap in
 * the metric series never becomes a firing once real ClickHouse and Postgres
 * shapes are in the loop.
 */

const queryCosts = vi.fn();
vi.mock("../clickhouse/cost-readers", () => ({ queryCosts }));

const getMetricValues = vi.fn();
vi.mock("../cost/metric-ingest", () => ({ getMetricValues }));

const getOrgEfficiencySettings = vi.fn();
vi.mock("../cost/efficiency-settings", () => ({ getOrgEfficiencySettings }));

const getOrgCurrencySettings = vi.fn(async () => ({ displayCurrency: null }));
const listOrgExchangeRates = vi.fn(async () => []);
vi.mock("../cost/currency-settings", () => ({ getOrgCurrencySettings, listOrgExchangeRates }));

const resolveSavedCostFilters = vi.fn();
class SavedCostFilterResolutionError extends Error {}
vi.mock("../cost/saved-filters", () => ({
  resolveSavedCostFilters,
  SavedCostFilterResolutionError,
}));

/** Mocked only so the assertions can prove nothing called them. */
const sendPushToOrg = vi.fn();
const sendSlackToChannels = vi.fn();
const sendMsTeamsToWebhooks = vi.fn();
vi.mock("../push/dispatch", () => ({ sendPushToOrg }));
vi.mock("../slack", () => ({
  sendSlackToChannels,
  sendSlackToChannelsTracked: sendSlackToChannels,
}));
vi.mock("../msteams", () => ({ sendMsTeamsToWebhooks }));

const BUSINESS_METRICS = { id: "id", organizationId: "organization_id", createdAt: "created_at" };
const REGRESSION_EVENTS = { id: "id" };
vi.mock("../db/schema", () => ({
  businessMetrics: BUSINESS_METRICS,
  unitCostRegressionEvents: REGRESSION_EVENTS,
}));

let metricRows: Array<Record<string, unknown>> = [];
let insertWins = true;
let notifiedInCooldown = 0;
let inserts: Array<Record<string, unknown>> = [];
let stamped = 0;

const db = {
  select: (cols?: Record<string, unknown>) => ({
    from: (table: unknown) => {
      // The cooldown probe selects a count; the metric list selects columns.
      if (cols && "n" in cols) {
        return { where: () => Promise.resolve([{ n: notifiedInCooldown }]) };
      }
      const chain = {
        where: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve(table === BUSINESS_METRICS ? metricRows : []),
        then: (resolve: (v: unknown) => void) => resolve(metricRows),
      };
      return chain;
    },
  }),
  insert: () => ({
    values: (values: Record<string, unknown>) => {
      inserts.push(values);
      return {
        onConflictDoNothing: () => ({
          returning: () => Promise.resolve(insertWins ? [{ id: `ev${inserts.length}` }] : []),
        }),
      };
    },
  }),
  update: () => ({
    set: (patch: Record<string, unknown>) => {
      if (patch["notifiedAt"] instanceof Date) stamped += 1;
      return { where: () => Promise.resolve() };
    },
  }),
};
vi.mock("../db/client", () => ({ db }));

const routeAlert = vi.fn(async (..._args: unknown[]) => routed());
vi.mock("../alerts/route", () => ({
  routeAlert: (...a: unknown[]) => routeAlert(...a),
  alertReached: alertReachedImpl,
}));

let evaluate: typeof import("../cost/unit-cost-regression-eval").evaluateUnitCostRegressionsForOrg;

/** Yesterday is 2026-08-10, so the windows are 07-28…08-10 vs 07-14…07-27. */
const NOW = new Date("2026-08-11T06:00:00Z");
const DAY_MS = 86_400_000;

const SETTINGS = {
  commitmentExpiryEnabled: true,
  commitmentExpiryHorizonDays: [60, 30, 7],
  commitmentExpiryAlertOnExpired: true,
  commitmentIdleEnabled: true,
  commitmentIdleThresholdPercent: 70,
  commitmentIdleWindowDays: 30,
  commitmentIdleMinMeasuredDays: 14,
  commitmentIdleMinWasteCents: 5000,
  unitCostRegressionEnabled: true,
  unitCostThresholdPercent: 20,
  unitCostWindowDays: 14,
  unitCostMinReportedDays: 10,
  unitCostMinSpendCents: 10_000,
};

function daysIn(from: string, to: string): string[] {
  const days: string[] = [];
  for (
    let t = new Date(`${from}T00:00:00Z`).valueOf();
    t <= new Date(`${to}T00:00:00Z`).valueOf();
    t += DAY_MS
  ) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

const PREVIOUS_DAYS = daysIn("2026-07-14", "2026-07-27");
const CURRENT_DAYS = daysIn("2026-07-28", "2026-08-10");

/** The shape `queryCosts` returns: one group per currency, daily buckets. */
function costs(previousPerDay: number, currentPerDay: number) {
  return [
    {
      key: "",
      currency: "USD",
      points: [
        ...PREVIOUS_DAYS.map((day) => ({ bucket: day, amount: previousPerDay })),
        ...CURRENT_DAYS.map((day) => ({ bucket: day, amount: currentPerDay })),
      ],
    },
  ];
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  metricRows = [
    {
      id: "metric1",
      key: "active-customers",
      name: "Active customers",
      unit: "customer",
      costScope: [],
      savedFilterId: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  ];
  insertWins = true;
  notifiedInCooldown = 0;
  inserts = [];
  stamped = 0;
  getOrgEfficiencySettings.mockResolvedValue({ ...SETTINGS });
  getOrgCurrencySettings.mockResolvedValue({ displayCurrency: null });
  listOrgExchangeRates.mockResolvedValue([]);
  // Spend up 40% per day, flat volume → unit cost up 40%.
  queryCosts.mockResolvedValue(costs(100, 140));
  getMetricValues.mockResolvedValue(
    [...PREVIOUS_DAYS, ...CURRENT_DAYS].map((day) => ({ day, value: 100 })),
  );
  ({ evaluateUnitCostRegressionsForOrg: evaluate } =
    await import("../cost/unit-cost-regression-eval"));
});

describe("evaluateUnitCostRegressionsForOrg — routing", () => {
  it("raises through the alert routing layer, never a transport", async () => {
    await evaluate("org1", NOW, true);

    expect(routeAlert).toHaveBeenCalledTimes(1);
    expect((routeAlert.mock.calls[0]![0] as { trigger: string }).trigger).toBe(
      "unitCostRegressionAlerts",
    );
    expect(sendPushToOrg).not.toHaveBeenCalled();
    expect(sendSlackToChannels).not.toHaveBeenCalled();
    expect(sendMsTeamsToWebhooks).not.toHaveBeenCalled();
  });

  it("names the metric, the move, and what to look at", async () => {
    await evaluate("org1", NOW, true);
    const event = routeAlert.mock.calls[0]![0] as Record<string, any>;

    expect(event["title"]).toBe("Unit cost up 40%: Active customers");
    expect(event["body"]).toContain("cost per customer");
    expect(event["body"]).toContain("Check what changed");
    expect(event["pushData"]).toMatchObject({
      type: "unit_cost_regression",
      orgId: "org1",
      metricId: "metric1",
      windowTo: "2026-08-10",
      currency: "USD",
    });
    // Rules match on the scope's spend, not the sub-cent unit cost.
    expect(event["facts"]).toMatchObject({ currency: "USD", key: "active-customers" });
    expect(event["facts"]["amountCents"]).toBe(196_000);
  });

  it("stamps the row once a delivery reached (or was held for) somebody", async () => {
    await evaluate("org1", NOW, true);
    expect(stamped).toBe(1);
  });
});

describe("evaluateUnitCostRegressionsForOrg — dedup", () => {
  it("keys the row on the current window's last day", async () => {
    await evaluate("org1", NOW, true);
    expect(inserts[0]).toMatchObject({
      metricId: "metric1",
      currency: "USD",
      windowFrom: "2026-07-28",
      windowTo: "2026-08-10",
      previousFrom: "2026-07-14",
      previousTo: "2026-07-27",
      changePercent: 40,
    });
  });

  it("notifies nobody when this window already fired", async () => {
    insertWins = false;
    await evaluate("org1", NOW, true);
    expect(routeAlert).not.toHaveBeenCalled();
  });

  it("stores the row but stays quiet inside the cross-day cooldown", async () => {
    // The windows slide daily, so a regression that persists is a fresh row
    // every morning — the cooldown is what stops fourteen alerts about one
    // level shift.
    notifiedInCooldown = 1;
    await evaluate("org1", NOW, true);
    expect(inserts).toHaveLength(1);
    expect(routeAlert).not.toHaveBeenCalled();
  });
});

describe("evaluateUnitCostRegressionsForOrg — gaps and history", () => {
  it("never fires when the metric has too little reported history", async () => {
    getMetricValues.mockResolvedValue(
      [...PREVIOUS_DAYS.slice(0, 4), ...CURRENT_DAYS].map((day) => ({ day, value: 100 })),
    );
    await evaluate("org1", NOW, true);
    expect(routeAlert).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("never fires from spend on days the metric was not reported", async () => {
    // Spend is flat and volume is flat, but four current-window days have no
    // reported value. Folding their spend into the numerator would read as a
    // regression invented by a broken metric ingest.
    queryCosts.mockResolvedValue(costs(100, 100));
    getMetricValues.mockResolvedValue(
      [...PREVIOUS_DAYS, ...CURRENT_DAYS.slice(0, 10)].map((day) => ({ day, value: 100 })),
    );
    await evaluate("org1", NOW, true);
    expect(routeAlert).not.toHaveBeenCalled();
  });

  it("does not fire when spend rose but cost per customer fell", async () => {
    queryCosts.mockResolvedValue(costs(100, 200));
    getMetricValues.mockResolvedValue([
      ...PREVIOUS_DAYS.map((day) => ({ day, value: 100 })),
      ...CURRENT_DAYS.map((day) => ({ day, value: 300 })),
    ]);
    await evaluate("org1", NOW, true);
    expect(routeAlert).not.toHaveBeenCalled();
  });
});

describe("evaluateUnitCostRegressionsForOrg — guards", () => {
  it("does nothing when the detector is off", async () => {
    getOrgEfficiencySettings.mockResolvedValue({ ...SETTINGS, unitCostRegressionEnabled: false });
    await evaluate("org1", NOW, true);
    expect(queryCosts).not.toHaveBeenCalled();
  });

  it("skips a metric whose saved filter cannot be resolved rather than widening it", async () => {
    // A numerator that quietly widened to the whole estate would page about a
    // regression that is an artefact of the filter breaking.
    metricRows = [{ ...metricRows[0]!, savedFilterId: "filter1" }];
    resolveSavedCostFilters.mockRejectedValue(
      new SavedCostFilterResolutionError("filter was deleted"),
    );
    await evaluate("org1", NOW, true);
    expect(queryCosts).not.toHaveBeenCalled();
    expect(routeAlert).not.toHaveBeenCalled();
  });

  it("swallows a failed metric rather than breaking the poller", async () => {
    queryCosts.mockRejectedValue(new Error("clickhouse down"));
    await expect(evaluate("org1", NOW, true)).resolves.toBeUndefined();
    expect(routeAlert).not.toHaveBeenCalled();
  });
});
