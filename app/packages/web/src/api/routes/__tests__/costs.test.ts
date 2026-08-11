import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthSession } from "@/api/auth-middleware";
import { buildTestApp } from "./test-utils";

const mockSelect = vi.fn();

vi.mock("@/db/client", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
  },
}));

const mockQueryCosts = vi.fn();
const mockGetCostDimensionValues = vi.fn();
const mockGetCostTagKeys = vi.fn();
const mockGetCostCoverage = vi.fn();

vi.mock("@infrawrench/server-core/clickhouse/cost-readers", () => ({
  queryCosts: (...args: unknown[]) => mockQueryCosts(...args),
  getCostDimensionValues: (...args: unknown[]) => mockGetCostDimensionValues(...args),
  getCostTagKeys: (...args: unknown[]) => mockGetCostTagKeys(...args),
  getCostCoverage: (...args: unknown[]) => mockGetCostCoverage(...args),
}));

vi.mock("@infrawrench/server-core/cost/forecast", () => ({
  forecastDaily: vi.fn().mockReturnValue([]),
}));

const mockLoadConversionContext = vi.fn();

// Same reason as the modules below: the currency-settings module reaches
// server-core's db client, which throws at import time without DATABASE_URL.
// The conversion *arithmetic* is deliberately not mocked — it is pure, and the
// point of these tests is that the route wires it up, not that it multiplies.
vi.mock("@infrawrench/server-core/cost/currency-settings", () => ({
  loadConversionContext: (...args: unknown[]) => mockLoadConversionContext(...args),
  getOrgCurrencySettings: vi.fn().mockResolvedValue({ displayCurrency: null }),
  listOrgExchangeRates: vi.fn().mockResolvedValue([]),
}));

// Same reason: the saved-filter resolver reaches server-core's db client at
// import time. Its behaviour (AND-composition, error on a dangling reference)
// is covered in services/__tests__/cost-query-saved-filters.test.ts; requests
// in this file never set savedFilterId, so the mock is never called.
// The billing-rule resolver reaches Postgres at import time. Nothing here asks
// for an adjusted answer, so it is never called — it only has to exist.
vi.mock("@infrawrench/server-core/cost/billing-rules", () => ({
  resolveBillingAdjustments: vi.fn(),
  listBillingRules: vi.fn(async () => []),
}));

vi.mock("@infrawrench/server-core/cost/saved-filters", () => ({
  SavedCostFilterResolutionError: class extends Error {},
  resolveSavedCostFilters: vi.fn(),
}));

// Kept out of these tests' import graph: the scenario resolver reaches
// Postgres, and none of these cases apply a scenario.
vi.mock("@infrawrench/server-core/cost/scenario-forecast", () => ({
  CostScenarioResolutionError: class extends Error {},
  CostScenarioApplicationError: class extends Error {},
  resolveCostScenarioModel: vi.fn(),
  forecastWithScenario: vi.fn(),
  toCostScenarioModel: vi.fn(),
}));

const mockGetAnomalySettings = vi.fn();
const mockSetAnomalySettings = vi.fn();

// Mocked rather than imported for real: the settings module reaches
// server-core's db client, which throws at import time without DATABASE_URL.
vi.mock("@infrawrench/server-core/cost/anomaly-settings", () => ({
  getOrgAnomalySettings: (...args: unknown[]) => mockGetAnomalySettings(...args),
  setOrgAnomalySettings: (...args: unknown[]) => mockSetAnomalySettings(...args),
}));

const mockGetEfficiencySettings = vi.fn();
const mockSetEfficiencySettings = vi.fn();

// Same reason as the anomaly settings above: the module reaches server-core's
// db client, which throws at import time without DATABASE_URL.
vi.mock("@infrawrench/server-core/cost/efficiency-settings", () => ({
  getOrgEfficiencySettings: (...args: unknown[]) => mockGetEfficiencySettings(...args),
  setOrgEfficiencySettings: (...args: unknown[]) => mockSetEfficiencySettings(...args),
}));

const mockListEfficiencyAlerts = vi.fn();
vi.mock("../../../services/efficiency-alerts", () => ({
  listEfficiencyAlerts: (...args: unknown[]) => mockListEfficiencyAlerts(...args),
}));

const mockListAnomalies = vi.fn();
const mockAcknowledgeAnomaly = vi.fn();

/**
 * The anomaly service is mocked rather than exercised: acknowledging writes to
 * two tables in a transaction, and these tests own the transport contract —
 * permissions, validation, status codes, audit. The rules it applies to those
 * writes are pure and have their own suite in server-core
 * (`anomaly-acknowledge.test.ts`).
 */
class FakeCostAnomalyAcknowledgeError extends Error {}
vi.mock("../../../services/cost-anomalies", () => ({
  CostAnomalyAcknowledgeError: FakeCostAnomalyAcknowledgeError,
  listRecentCostAnomalies: (...args: unknown[]) => mockListAnomalies(...args),
  acknowledgeCostAnomaly: (...args: unknown[]) => mockAcknowledgeAnomaly(...args),
}));

const mockLogAudit = vi.fn();
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const mockIsSmsPagingConfigured = vi.fn();

// Same reason as above: the pager module reaches server-core's db client.
vi.mock("@infrawrench/server-core/twilio-pager", () => ({
  isSmsPagingConfigured: (...args: unknown[]) => mockIsSmsPagingConfigured(...args),
}));

// Same reason again: the tag-policy modules reach the db client at import
// time via the services/tag-policy chain.
vi.mock("@infrawrench/server-core/cost/tag-policy", () => ({
  getOrgTagPolicy: vi.fn().mockResolvedValue(null),
  setOrgTagPolicy: vi.fn(),
}));
vi.mock("../../../services/tag-policy", () => ({
  getUntaggedSpendReport: vi.fn(),
  getAccountTagCompliance: vi.fn(),
}));
vi.mock("../../../services/showback", () => ({
  getShowbackReport: vi.fn(),
}));

vi.mock("@/plugins/loader", () => ({
  getPlugin: vi.fn().mockResolvedValue({
    plugin: { manifest: { id: "aws", displayName: "AWS", costs: { dimensions: ["service"] } } },
  }),
  loadPlugins: vi
    .fn()
    .mockResolvedValue([{ plugin: { manifest: { id: "aws", displayName: "AWS" } } }]),
}));

const { costRoutes } = await import("@/api/routes/costs");

const buildApp = () => buildTestApp(costRoutes);

/** App whose session carries only the given permissions. */
function buildAppWithPermissions(permissions: string[]): Hono {
  const app = new Hono();
  const session: AuthSession = { userId: "user-1", email: "test@example.com" };
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    throw err;
  });
  app.use("*", async (c, next) => {
    c.set("session", session);
    c.set("organizationId", "org-1");
    c.set("permissions", permissions);
    c.set("role", null);
    return next();
  });
  app.route("/", costRoutes);
  return app;
}

const validQuery = {
  from: "2026-07-01",
  to: "2026-07-20",
  binning: "daily",
  groupBy: "provider",
  filters: [],
};

const defaultSettings = {
  sigmas: 3,
  minDeltaCents: 1000,
  newSourceMinCents: 2500,
  smsAlerts: "off",
};

/** The shipped efficiency defaults, mirroring DEFAULT_COST_EFFICIENCY_SETTINGS. */
const defaultEfficiencySettings = {
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

/** What the service answers with once a finding has been explained. */
const acknowledgedAnomaly = {
  id: "anom-1",
  day: "2026-07-30",
  kind: "spike",
  dimension: "service",
  dimensionKey: "Amazon EC2",
  currency: "USD",
  actualCents: 27_300,
  baselineCents: 10_000,
  thresholdCents: 15_000,
  detectedAt: "2026-07-31T02:00:00.000Z",
  notifiedAt: null,
  hints: [],
  acknowledgement: {
    explanation: "Migrated the API fleet to Graviton",
    acknowledgedAt: "2026-08-01T09:00:00.000Z",
    acknowledgedByUserId: "user-1",
    annotationId: "ann-1",
  },
};

/** An org that has not opted into conversion — the default in every test. */
const noConversion = { displayCurrency: null, rates: [] };

/** One stated EUR→USD rate, as `loadConversionContext` returns it. */
const eurToUsd = {
  displayCurrency: "USD",
  rates: [
    {
      id: "rate-1",
      fromCurrency: "EUR",
      toCurrency: "USD",
      rate: "2",
      effectiveFrom: "2026-01-01",
      createdBy: "user-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConversionContext.mockResolvedValue(noConversion);
  mockQueryCosts.mockResolvedValue([]);
  mockGetAnomalySettings.mockResolvedValue(defaultSettings);
  mockIsSmsPagingConfigured.mockResolvedValue(false);
  mockSetAnomalySettings.mockImplementation((_org: string, settings: unknown) =>
    Promise.resolve(settings),
  );
  mockGetEfficiencySettings.mockResolvedValue(defaultEfficiencySettings);
  mockSetEfficiencySettings.mockImplementation((_org: string, settings: unknown) =>
    Promise.resolve(settings),
  );
  mockListEfficiencyAlerts.mockResolvedValue([]);
  mockListAnomalies.mockResolvedValue([]);
  mockAcknowledgeAnomaly.mockResolvedValue(acknowledgedAnomaly);
});

describe("POST /query", () => {
  it("rejects without costs:read", async () => {
    const app = buildAppWithPermissions(["dashboards:read"]);
    const res = await app.request("/query", {
      method: "POST",
      body: JSON.stringify(validQuery),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects malformed bodies with 400", async () => {
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, binning: "hourly" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects tag grouping without a tag key", async () => {
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, groupBy: "tag" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects inverted date ranges", async () => {
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, from: "2026-08-01", to: "2026-07-01" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("folds groups beyond topN into Other and labels providers", async () => {
    mockQueryCosts.mockResolvedValue([
      { key: "aws", currency: "USD", points: [{ bucket: "2026-07-01", amount: 100 }] },
      { key: "gcp", currency: "USD", points: [{ bucket: "2026-07-01", amount: 50 }] },
      { key: "fly", currency: "USD", points: [{ bucket: "2026-07-01", amount: 10 }] },
    ]);
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, topN: 2 }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      series: Array<{ key: string; label: string }>;
      totals: Record<string, number>;
    };
    expect(body.series.map((s) => s.key)).toEqual(["aws", "gcp", "__other__"]);
    expect(body.series[0]!.label).toBe("AWS");
    expect(body.series[2]!.label).toBe("Other");
    expect(body.totals["USD"]).toBe(160);
  });

  it("accepts a cost basis and charge types, and passes them down", async () => {
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({
        ...validQuery,
        costBasis: "amortized",
        chargeTypes: ["usage", "commitment_fee"],
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(mockQueryCosts.mock.calls[0]![1]).toMatchObject({
      costBasis: "amortized",
      chargeTypes: ["usage", "commitment_fee"],
    });
  });

  it("defaults to cash and every charge type when neither is given", async () => {
    // Absent, not "cash": an older client's request must reach ClickHouse as
    // the query it always was.
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify(validQuery),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const passed = mockQueryCosts.mock.calls[0]![1] as Record<string, unknown>;
    expect("costBasis" in passed).toBe(false);
    expect("chargeTypes" in passed).toBe(false);
  });

  it("rejects an unknown cost basis", async () => {
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, costBasis: "accrual" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(mockQueryCosts).not.toHaveBeenCalled();
  });

  it("does not convert, and reports no conversion, without a displayCurrency", async () => {
    // The default path for every org: byte-identical to before the feature.
    mockQueryCosts.mockResolvedValue([
      { key: "aws", currency: "USD", points: [{ bucket: "2026-07-01", amount: 100 }] },
      { key: "gcp", currency: "EUR", points: [{ bucket: "2026-07-01", amount: 50 }] },
    ]);
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify(validQuery),
      headers: { "Content-Type": "application/json" },
    });
    const body = (await res.json()) as {
      totals: Record<string, number>;
      currencies: string[];
      conversion?: unknown;
    };
    expect(body.totals).toEqual({ USD: 100, EUR: 50 });
    expect(body.currencies).toEqual(["EUR", "USD"]);
    expect(body.conversion).toBeUndefined();
  });

  it("passes the requested displayCurrency to the conversion context", async () => {
    await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, displayCurrency: "USD" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(mockLoadConversionContext).toHaveBeenCalledWith("org-1", "USD");
  });

  it("rejects a displayCurrency that is not a three-letter code", async () => {
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, displayCurrency: "dollars" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(mockQueryCosts).not.toHaveBeenCalled();
  });

  it("converts into the display currency and reports the rate used", async () => {
    mockLoadConversionContext.mockResolvedValue(eurToUsd);
    mockQueryCosts.mockResolvedValue([
      { key: "aws", currency: "USD", points: [{ bucket: "2026-07-01", amount: 100 }] },
      { key: "gcp", currency: "EUR", points: [{ bucket: "2026-07-01", amount: 50 }] },
    ]);
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, displayCurrency: "USD" }),
      headers: { "Content-Type": "application/json" },
    });
    const body = (await res.json()) as {
      totals: Record<string, number>;
      currencies: string[];
      conversion: { displayCurrency: string; converted: Array<{ currency: string }> };
    };
    // 100 USD passed through, plus 50 EUR at a rate of 2 = 100 USD.
    expect(body.totals).toEqual({ USD: 200 });
    expect(body.currencies).toEqual(["USD"]);
    expect(body.conversion.displayCurrency).toBe("USD");
    expect(body.conversion.converted.map((c) => c.currency)).toEqual(["EUR"]);
  });

  it("merges same-key series that became the same currency", async () => {
    mockLoadConversionContext.mockResolvedValue(eurToUsd);
    mockQueryCosts.mockResolvedValue([
      { key: "aws", currency: "USD", points: [{ bucket: "2026-07-01", amount: 100 }] },
      { key: "aws", currency: "EUR", points: [{ bucket: "2026-07-01", amount: 50 }] },
    ]);
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, displayCurrency: "USD" }),
      headers: { "Content-Type": "application/json" },
    });
    const body = (await res.json()) as { series: Array<{ key: string; points: unknown[] }> };
    // One AWS line, not two — that is the whole point of the feature.
    expect(body.series).toHaveLength(1);
    expect(body.series[0]!.key).toBe("aws");
  });

  it("keeps a currency with no rate as its own series and total", async () => {
    // The failure that matters: silently dropping SEK would understate spend.
    mockLoadConversionContext.mockResolvedValue(eurToUsd);
    mockQueryCosts.mockResolvedValue([
      { key: "gcp", currency: "EUR", points: [{ bucket: "2026-07-01", amount: 50 }] },
      { key: "hetzner", currency: "SEK", points: [{ bucket: "2026-07-01", amount: 500 }] },
    ]);
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, displayCurrency: "USD" }),
      headers: { "Content-Type": "application/json" },
    });
    const body = (await res.json()) as {
      totals: Record<string, number>;
      currencies: string[];
      conversion: { unconverted: string[] };
    };
    expect(body.totals).toEqual({ USD: 100, SEK: 500 });
    expect(body.currencies).toEqual(["SEK", "USD"]);
    expect(body.conversion.unconverted).toEqual(["SEK"]);
  });

  it("ranks topN across the converted total, not within each currency", async () => {
    mockLoadConversionContext.mockResolvedValue(eurToUsd);
    mockQueryCosts.mockResolvedValue([
      { key: "aws", currency: "USD", points: [{ bucket: "2026-07-01", amount: 100 }] },
      { key: "gcp", currency: "EUR", points: [{ bucket: "2026-07-01", amount: 90 }] },
      { key: "fly", currency: "USD", points: [{ bucket: "2026-07-01", amount: 10 }] },
    ]);
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, displayCurrency: "USD", topN: 2 }),
      headers: { "Content-Type": "application/json" },
    });
    const body = (await res.json()) as { series: Array<{ key: string }> };
    // gcp is 180 USD once converted, so it outranks aws; fly folds into Other.
    // Folding before converting would have produced an "Other" per currency.
    expect(body.series.map((s) => s.key)).toEqual(["gcp", "aws", "__other__"]);
  });

  it("rejects an unknown charge type", async () => {
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, chargeTypes: ["usage", "vibes"] }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(mockQueryCosts).not.toHaveBeenCalled();
  });

  it("groups by charge type", async () => {
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, groupBy: "charge_type" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(mockQueryCosts.mock.calls[0]![1]).toMatchObject({ groupBy: "charge_type" });
  });

  it("carries the basis into the comparison period", async () => {
    // A cash previous period against an amortized current one compares two
    // different questions and prints the difference as a change in spend.
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, costBasis: "amortized", comparePreviousPeriod: true }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(mockQueryCosts).toHaveBeenCalledTimes(2);
    expect(mockQueryCosts.mock.calls[1]![1]).toMatchObject({ costBasis: "amortized" });
  });

  it("returns a shifted previous period when requested", async () => {
    mockQueryCosts.mockResolvedValue([]);
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, comparePreviousPeriod: true }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(mockQueryCosts).toHaveBeenCalledTimes(2);
    const second = mockQueryCosts.mock.calls[1]![1] as { from: string; to: string };
    // 20-day span shifted back 20 days.
    expect(second).toMatchObject({ from: "2026-06-11", to: "2026-06-30" });
  });
});

describe("GET /dimensions", () => {
  it("rejects unknown dimensions", async () => {
    const res = await buildApp().request("/dimensions?dimension=nope");
    expect(res.status).toBe(400);
  });

  it("requires tagKey for the tag dimension", async () => {
    const res = await buildApp().request("/dimensions?dimension=tag");
    expect(res.status).toBe(400);
  });

  it("lists tag keys via dimension=tag-keys", async () => {
    mockGetCostTagKeys.mockResolvedValue(["env", "team"]);
    const res = await buildApp().request("/dimensions?dimension=tag-keys");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ values: ["env", "team"] });
  });

  it("answers charge_type from the fixed union without querying stored data", async () => {
    // A DISTINCT query would leave the picker empty until a provider happened
    // to bill a credit — so you could never filter credits out until you had
    // one, which is exactly when you stop being able to see the problem.
    const res = await buildApp().request("/dimensions?dimension=charge_type");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { values: Array<{ value: string; label: string }> };
    expect(body.values).toContainEqual({ value: "usage", label: "Usage" });
    expect(body.values).toContainEqual({ value: "credit", label: "Credit" });
    expect(body.values).toContainEqual({
      value: "commitment_covered_usage",
      label: "Commitment-covered usage",
    });
    expect(body.values).toHaveLength(10);
    expect(mockGetCostDimensionValues).not.toHaveBeenCalled();
  });

  it("lists commitments from stored data", async () => {
    mockGetCostDimensionValues.mockResolvedValue(["ri-1", "sp-2"]);
    const res = await buildApp().request("/dimensions?dimension=commitment");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      values: [
        { value: "ri-1", label: "ri-1" },
        { value: "sp-2", label: "sp-2" },
      ],
    });
  });
});

describe("anomaly settings", () => {
  function put(app: Hono, body: unknown) {
    return app.request("/anomaly-settings", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }

  it("reads with costs:read, and says whether an SMS could be delivered", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/anomaly-settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...defaultSettings, smsConfigured: false });
  });

  it("reports SMS as reachable when Twilio is set up with a recipient", async () => {
    mockIsSmsPagingConfigured.mockResolvedValue(true);
    const res = await buildAppWithPermissions(["costs:read"]).request("/anomaly-settings");
    expect(await res.json()).toEqual({ ...defaultSettings, smsConfigured: true });
  });

  it("rejects a read without costs:read", async () => {
    const res = await buildAppWithPermissions(["dashboards:read"]).request("/anomaly-settings");
    expect(res.status).toBe(403);
  });

  it("rejects a write to a reader — retuning needs costs:write", async () => {
    const res = await put(buildAppWithPermissions(["costs:read"]), defaultSettings);
    expect(res.status).toBe(403);
    expect(mockSetAnomalySettings).not.toHaveBeenCalled();
  });

  it("saves a valid update", async () => {
    const next = {
      sigmas: 2.5,
      minDeltaCents: 5000,
      newSourceMinCents: 10_000,
      smsAlerts: "new_source",
    };
    const res = await put(buildAppWithPermissions(["costs:write"]), next);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...next, smsConfigured: false });
    expect(mockSetAnomalySettings).toHaveBeenCalledWith("org-1", next);
  });

  it("rejects an unknown SMS mode", async () => {
    const res = await put(buildAppWithPermissions(["costs:write"]), {
      ...defaultSettings,
      smsAlerts: "everything",
    });
    expect(res.status).toBe(400);
    expect(mockSetAnomalySettings).not.toHaveBeenCalled();
  });

  it("rejects an update that omits smsAlerts rather than silently paging off", async () => {
    const { smsAlerts: _omitted, ...withoutSms } = defaultSettings;
    const res = await put(buildAppWithPermissions(["costs:write"]), withoutSms);
    expect(res.status).toBe(400);
    expect(mockSetAnomalySettings).not.toHaveBeenCalled();
  });

  it("rejects a sigma of 0 — it would alert on every fluctuation", async () => {
    const res = await put(buildAppWithPermissions(["costs:write"]), {
      ...defaultSettings,
      sigmas: 0,
    });
    expect(res.status).toBe(400);
    expect(mockSetAnomalySettings).not.toHaveBeenCalled();
  });

  it("rejects a negative floor", async () => {
    const res = await put(buildAppWithPermissions(["costs:write"]), {
      ...defaultSettings,
      minDeltaCents: -100,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a negative new-source floor", async () => {
    const res = await put(buildAppWithPermissions(["costs:write"]), {
      ...defaultSettings,
      newSourceMinCents: -1,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a sigma beyond the upper bound", async () => {
    const res = await put(buildAppWithPermissions(["costs:write"]), {
      ...defaultSettings,
      sigmas: 50,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a partial update — PUT replaces the whole object", async () => {
    const res = await put(buildAppWithPermissions(["costs:write"]), { sigmas: 4 });
    expect(res.status).toBe(400);
  });

  it("rounds sigmas to the one decimal the form offers", async () => {
    const res = await put(buildAppWithPermissions(["costs:write"]), {
      ...defaultSettings,
      sigmas: 2.46,
    });
    expect(res.status).toBe(200);
    expect(mockSetAnomalySettings).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ sigmas: 2.5 }),
    );
  });
});

/**
 * The text form of the filter. The language itself is exhaustively tested in
 * `@infrawrench/client-core`; these cover the wiring — that a query compiles to
 * exactly the structured filter, that a parse failure comes back as a usable
 * 400, and that the two spellings can never be sent together.
 */
describe("POST /query — cost query language", () => {
  /** The filter as ClickHouse was asked for it. */
  const filtersPassedDown = () =>
    (mockQueryCosts.mock.calls[0]![1] as { filters: unknown }).filters;

  it("compiles a query into exactly the structured filter", async () => {
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({
        ...validQuery,
        filters: [],
        query: "provider = 'aws' AND service IN ('AmazonEC2','AmazonS3')",
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(filtersPassedDown()).toEqual([
      { dimension: "provider", op: "in", values: ["aws"] },
      { dimension: "service", op: "in", values: ["AmazonEC2", "AmazonS3"] },
    ]);
  });

  it("carries a tag key through", async () => {
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, query: "tag['env'] != 'dev'" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(filtersPassedDown()).toEqual([
      { dimension: "tag", op: "not_in", values: ["dev"], tagKey: "env" },
    ]);
  });

  it("runs the identical query however the filter was spelled", async () => {
    const structured = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({
        ...validQuery,
        filters: [{ dimension: "region", op: "not_in", values: ["eu-west-1", "eu-west-2"] }],
      }),
      headers: { "Content-Type": "application/json" },
    });
    const viaStructured = filtersPassedDown();
    expect(structured.status).toBe(200);

    vi.clearAllMocks();
    mockLoadConversionContext.mockResolvedValue(noConversion);
    mockQueryCosts.mockResolvedValue([]);

    const text = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({
        ...validQuery,
        query: "region NOT IN ('eu-west-1', 'eu-west-2')",
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(text.status).toBe(200);
    expect(filtersPassedDown()).toEqual(viaStructured);
  });

  it("treats an empty query as no filter rather than an error", async () => {
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, query: "   " }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(filtersPassedDown()).toEqual([]);
  });

  it("400s a parse failure with the offset and the expected alternatives", async () => {
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, query: "provider = 'aws' AND regionn = 'x'" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      queryError: { offset: number; length: number; expected: string[] };
    };
    expect(body.error).toContain('Unknown dimension "regionn"');
    expect(body.error).toContain('Did you mean "region"');
    expect(body.queryError.offset).toBe("provider = 'aws' AND ".length);
    expect(body.queryError.length).toBe("regionn".length);
    expect(body.queryError.expected).toContain("region");
    expect(mockQueryCosts).not.toHaveBeenCalled();
  });

  it("400s OR rather than silently running an AND", async () => {
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, query: "provider = 'aws' OR provider = 'gcp'" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("OR is not supported");
    expect(mockQueryCosts).not.toHaveBeenCalled();
  });

  it("400s both spellings at once rather than picking a winner", async () => {
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({
        ...validQuery,
        filters: [{ dimension: "provider", op: "in", values: ["gcp"] }],
        query: "provider = 'aws'",
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("not both");
    expect(mockQueryCosts).not.toHaveBeenCalled();
  });

  it("accepts a query alongside an empty filters array — [] is the absence of a filter", async () => {
    // Every client built on CostQueryRequest sends `filters` because the field
    // is required; rejecting that would make the text form unusable from them.
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, filters: [], query: "provider = 'aws'" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a query longer than the schema allows before it is tokenized", async () => {
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, query: `provider = '${"a".repeat(5000)}'` }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(mockQueryCosts).not.toHaveBeenCalled();
  });

  it("keeps values that look like SQL as opaque filter values", async () => {
    // The compiled values are bound as ClickHouse parameters exactly like a
    // structured filter's, so nothing here can be anything but a string.
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({
        ...validQuery,
        query: "service = 'x'') OR 1=1 --'",
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(filtersPassedDown()).toEqual([
      { dimension: "service", op: "in", values: ["x') OR 1=1 --"] },
    ]);
  });
});

describe("efficiency alerts", () => {
  function put(app: Hono, body: unknown) {
    return app.request("/efficiency-alert-settings", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }

  it("reads the tuning with costs:read", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/efficiency-alert-settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(defaultEfficiencySettings);
  });

  it("rejects a read without costs:read", async () => {
    const res = await buildAppWithPermissions(["dashboards:read"]).request(
      "/efficiency-alert-settings",
    );
    expect(res.status).toBe(403);
  });

  it("rejects a write to a reader — retuning needs costs:write", async () => {
    const res = await put(buildAppWithPermissions(["costs:read"]), defaultEfficiencySettings);
    expect(res.status).toBe(403);
    expect(mockSetEfficiencySettings).not.toHaveBeenCalled();
  });

  it("saves a valid update", async () => {
    const next = {
      ...defaultEfficiencySettings,
      commitmentIdleThresholdPercent: 60,
      commitmentExpiryHorizonDays: [90, 14],
    };
    const res = await put(buildApp(), next);
    expect(res.status).toBe(200);
    expect(mockSetEfficiencySettings).toHaveBeenCalledWith("org-1", next);
  });

  it("rejects an out-of-range threshold rather than storing a permanent silence", async () => {
    const res = await put(buildApp(), {
      ...defaultEfficiencySettings,
      commitmentIdleThresholdPercent: 0,
    });
    expect(res.status).toBe(400);
    expect(mockSetEfficiencySettings).not.toHaveBeenCalled();
  });

  it("rejects an empty horizon list — silence is what the enable flag is for", async () => {
    const res = await put(buildApp(), {
      ...defaultEfficiencySettings,
      commitmentExpiryHorizonDays: [],
    });
    expect(res.status).toBe(400);
  });

  it("lists fired alerts with costs:read", async () => {
    mockListEfficiencyAlerts.mockResolvedValue([{ id: "ev1", kind: "commitment_idle" }]);
    const res = await buildAppWithPermissions(["costs:read"]).request("/efficiency-alerts");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [{ id: "ev1", kind: "commitment_idle" }] });
    expect(mockListEfficiencyAlerts).toHaveBeenCalledWith("org-1", {
      kind: undefined,
      limit: 50,
    });
  });

  it("passes a kind filter through", async () => {
    await buildApp().request("/efficiency-alerts?kind=commitment_expiry&limit=5");
    expect(mockListEfficiencyAlerts).toHaveBeenCalledWith("org-1", {
      kind: "commitment_expiry",
      limit: 5,
    });
  });

  it("rejects an unknown kind", async () => {
    const res = await buildApp().request("/efficiency-alerts?kind=nonsense");
    expect(res.status).toBe(400);
    expect(mockListEfficiencyAlerts).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range limit", async () => {
    const res = await buildApp().request("/efficiency-alerts?limit=9999");
    expect(res.status).toBe(400);
  });
});

describe("POST /anomalies/:id/acknowledge", () => {
  const body = JSON.stringify({ explanation: "Migrated the API fleet to Graviton" });

  it("rejects a costs:read-only caller without writing", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request(
      "/anomalies/anom-1/acknowledge",
      {
        method: "POST",
        body,
      },
    );
    expect(res.status).toBe(403);
    expect(mockAcknowledgeAnomaly).not.toHaveBeenCalled();
  });

  it("explains the finding, answers the updated anomaly, and audits", async () => {
    const res = await buildApp().request("/anomalies/anom-1/acknowledge", { method: "POST", body });

    expect(res.status).toBe(200);
    expect(mockAcknowledgeAnomaly).toHaveBeenCalledWith(
      "org-1",
      "anom-1",
      "Migrated the API fleet to Graviton",
      "user-1",
    );
    // The reply carries the note it made, which is how a client links the two
    // without a second request.
    expect(await res.json()).toMatchObject({
      acknowledgement: { annotationId: "ann-1", explanation: "Migrated the API fleet to Graviton" },
    });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "cost_anomaly.acknowledge",
        entityType: "cost_anomaly",
        entityId: "anom-1",
        metadata: expect.objectContaining({ day: "2026-07-30", annotationId: "ann-1" }),
      }),
    );
  });

  it("404s for an anomaly that isn't this org's, and audits nothing", async () => {
    mockAcknowledgeAnomaly.mockResolvedValue(null);
    const res = await buildApp().request("/anomalies/anom-9/acknowledge", { method: "POST", body });
    expect(res.status).toBe(404);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("rejects an empty explanation before reaching the service", async () => {
    const res = await buildApp().request("/anomalies/anom-1/acknowledge", {
      method: "POST",
      body: JSON.stringify({ explanation: "" }),
    });
    expect(res.status).toBe(400);
    expect(mockAcknowledgeAnomaly).not.toHaveBeenCalled();
  });

  it("maps a rejected explanation to a 400 rather than a 500", async () => {
    mockAcknowledgeAnomaly.mockRejectedValue(
      new FakeCostAnomalyAcknowledgeError("Keep the note under 500 characters."),
    );
    const res = await buildApp().request("/anomalies/anom-1/acknowledge", { method: "POST", body });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Keep the note under 500 characters." });
  });
});
