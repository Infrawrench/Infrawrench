import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

const mockRunUnitCostQuery = vi.fn();
const mockRunUsageUnitCostQuery = vi.fn();

class MockBusinessMetricNotFoundError extends Error {}
class MockCostQueryError extends Error {
  queryError?: unknown;
}

vi.mock("../../../services/unit-cost-query", () => ({
  BusinessMetricNotFoundError: MockBusinessMetricNotFoundError,
  CostQueryError: MockCostQueryError,
  listUsageUnits: vi.fn(),
  runUnitCostQuery: (...args: unknown[]) => mockRunUnitCostQuery(...args),
  runUsageUnitCostQuery: (...args: unknown[]) => mockRunUsageUnitCostQuery(...args),
}));
vi.mock("../../../services/business-metrics", () => ({}));
vi.mock("@infrawrench/server-core/cost/metric-ingest", () => ({}));
vi.mock("@infrawrench/server-core/cost/metric-importers", () => ({}));
vi.mock("../../../services/audit", () => ({ logAudit: vi.fn() }));

const { businessMetricRoutes } = await import("@/api/routes/business-metrics");

const response = {
  metric: { id: "m1", key: "orders", name: "Orders", unit: "order", kind: "count", currency: null },
  mode: "unit_cost",
  binning: "daily",
  scale: 1,
  gapBuckets: 1,
  partialBuckets: 0,
  series: [
    {
      currency: "USD",
      overallValue: 0.5,
      overallCost: 10,
      overallMetricValue: 20,
      points: [
        {
          bucket: "2026-10-01",
          value: 0.5,
          cost: 10,
          metricValue: 20,
          reportedDays: 1,
          bucketDays: 1,
        },
        {
          bucket: "2026-10-02",
          value: null,
          cost: 4,
          metricValue: null,
          gap: "no_metric_value",
          reportedDays: 0,
          bucketDays: 1,
        },
      ],
    },
  ],
};

const post = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "Content-Type": "application/json" },
});
const query = { from: "2026-10-01", to: "2026-10-02", binning: "daily" };

beforeEach(() => {
  vi.clearAllMocks();
  mockRunUnitCostQuery.mockResolvedValue(response);
  mockRunUsageUnitCostQuery.mockResolvedValue({ ...response, metric: null, usageUnit: "GB-Mo" });
});

describe("POST /business-metrics/:id/unit-costs/export", () => {
  it("rejects without costs:read", async () => {
    const app = buildTestApp(businessMetricRoutes, ["dashboards:read"]);
    const res = await app.request("/m1/unit-costs/export", post(query));
    expect(res.status).toBe(403);
  });

  it("answers a CSV by default, the query passed through without the format", async () => {
    const res = await buildTestApp(businessMetricRoutes).request(
      "/m1/unit-costs/export",
      post({ ...query, format: "csv" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("content-disposition")).toContain(
      "unit-costs-orders-2026-10-01-to-2026-10-02.csv",
    );
    expect(mockRunUnitCostQuery).toHaveBeenCalledWith("org-1", "m1", query);
    const lines = (await res.text()).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    // The gap row: empty value, the reason named.
    expect(lines[2]).toMatch(/,4,,,,no_metric_value$/);
  });

  it("answers NDJSON when asked", async () => {
    const res = await buildTestApp(businessMetricRoutes).request(
      "/m1/unit-costs/export",
      post({ ...query, format: "ndjson" }),
    );
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    const rows = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows[1]).toMatchObject({ bucket: "2026-10-02", value: null, gap: "no_metric_value" });
  });

  it("maps a missing metric to 404 and a bad format to 400", async () => {
    mockRunUnitCostQuery.mockRejectedValueOnce(new MockBusinessMetricNotFoundError("nope"));
    const missing = await buildTestApp(businessMetricRoutes).request(
      "/m2/unit-costs/export",
      post(query),
    );
    expect(missing.status).toBe(404);
    const bad = await buildTestApp(businessMetricRoutes).request(
      "/m1/unit-costs/export",
      post({ ...query, format: "xlsx" }),
    );
    expect(bad.status).toBe(400);
  });
});

describe("POST /business-metrics/usage-unit-costs/export", () => {
  it("names the file after the usage unit", async () => {
    const res = await buildTestApp(businessMetricRoutes).request(
      "/usage-unit-costs/export",
      post({ ...query, mode: "usage_unit_cost", usageUnit: "GB-Mo" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("unit-costs-gb-mo-");
    expect(mockRunUsageUnitCostQuery).toHaveBeenCalled();
  });
});
