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

const mockGetAnomalySettings = vi.fn();
const mockSetAnomalySettings = vi.fn();

// Mocked rather than imported for real: the settings module reaches
// server-core's db client, which throws at import time without DATABASE_URL.
vi.mock("@infrawrench/server-core/cost/anomaly-settings", () => ({
  getOrgAnomalySettings: (...args: unknown[]) => mockGetAnomalySettings(...args),
  setOrgAnomalySettings: (...args: unknown[]) => mockSetAnomalySettings(...args),
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

beforeEach(() => {
  vi.clearAllMocks();
  mockQueryCosts.mockResolvedValue([]);
  mockGetAnomalySettings.mockResolvedValue(defaultSettings);
  mockIsSmsPagingConfigured.mockResolvedValue(false);
  mockSetAnomalySettings.mockImplementation((_org: string, settings: unknown) =>
    Promise.resolve(settings),
  );
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
    expect(body.values).toHaveLength(9);
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
