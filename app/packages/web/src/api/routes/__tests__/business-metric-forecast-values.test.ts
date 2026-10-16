import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

// Everything the business-metrics router imports that reaches the database or
// ClickHouse is mocked. These tests own the forecast-values transport only.
vi.mock("@infrawrench/server-core/cost/metric-ingest", () => ({
  BusinessMetricIngestError: class extends Error {},
  ingestMetricValues: vi.fn(),
}));
vi.mock("@infrawrench/server-core/cost/metric-importers", () => ({
  BusinessMetricImporterError: class extends Error {},
  deleteBusinessMetricImporter: vi.fn(),
  getBusinessMetricImporter: vi.fn(),
  listBusinessMetricImportRuns: vi.fn(),
  listBusinessMetricSourceAccounts: vi.fn(),
  listBusinessMetricSourceOptions: vi.fn(),
  previewBusinessMetricImport: vi.fn(),
  runBusinessMetricImporterNow: vi.fn(),
  upsertBusinessMetricImporter: vi.fn(),
}));
const mockGetMetric = vi.fn();
vi.mock("../../../services/business-metrics", () => ({
  BusinessMetricInputError: class extends Error {},
  BusinessMetricKeyConflictError: class extends Error {},
  createBusinessMetric: vi.fn(),
  getBusinessMetric: (...args: unknown[]) => mockGetMetric(...args),
  listBusinessMetricLabels: vi.fn(),
  listBusinessMetricValues: vi.fn(),
  listBusinessMetrics: vi.fn(),
  softDeleteBusinessMetric: vi.fn(),
  updateBusinessMetric: vi.fn(),
}));
vi.mock("../../../services/unit-cost-query", () => ({
  BusinessMetricNotFoundError: class extends Error {},
  CostQueryError: class extends Error {},
  listUsageUnits: vi.fn(),
  runUnitCostQuery: vi.fn(),
  runUsageUnitCostQuery: vi.fn(),
}));

const mockList = vi.fn();
const mockWrite = vi.fn();
const mockDelete = vi.fn();
vi.mock("../../../services/business-metric-forecast-values", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/business-metric-forecast-values")
  >("../../../services/business-metric-forecast-values");
  return {
    BusinessMetricForecastValueError: actual.BusinessMetricForecastValueError,
    parseForecastValueRange: actual.parseForecastValueRange,
    listBusinessMetricForecastValues: (...args: unknown[]) => mockList(...args),
    writeBusinessMetricForecastValues: (...args: unknown[]) => mockWrite(...args),
    deleteBusinessMetricForecastValues: (...args: unknown[]) => mockDelete(...args),
  };
});
vi.mock("../../../db/client", () => ({ db: {} }));

const mockLogAudit = vi.fn();
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { businessMetricRoutes } = await import("@/api/routes/business-metrics");

const buildApp = (permissions?: string[]) => buildTestApp(businessMetricRoutes, permissions);
const post = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMetric.mockResolvedValue({ id: "m-1", key: "customers", name: "Customers" });
  mockList.mockResolvedValue([{ day: "2026-11-01", value: 1200, updatedAt: "x" }]);
  mockWrite.mockResolvedValue({ written: 2 });
  mockDelete.mockResolvedValue({ deleted: 3 });
});

describe("GET /:id/forecast-values", () => {
  it("lists planned values within a range", async () => {
    const res = await buildApp(["costs:read"]).request(
      "/customers/forecast-values?from=2026-11-01&to=2026-11-30",
    );
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith("m-1", { from: "2026-11-01", to: "2026-11-30" });
  });

  it("refuses a malformed range and 404s an unknown metric", async () => {
    expect((await buildApp().request("/customers/forecast-values?from=Nov")).status).toBe(400);
    mockGetMetric.mockResolvedValueOnce(null);
    expect((await buildApp().request("/nope/forecast-values")).status).toBe(404);
  });
});

describe("POST /:id/forecast-values", () => {
  const body = {
    values: [
      { date: "2026-11-01", value: 1200 },
      { date: "2026-11-02", value: 1210 },
    ],
  };

  it("needs costs:write", async () => {
    const res = await buildApp(["costs:read"]).request("/customers/forecast-values", post(body));
    expect(res.status).toBe(403);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("writes and audits", async () => {
    const res = await buildApp().request("/customers/forecast-values", post(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ written: 2 });
    expect(mockWrite).toHaveBeenCalledWith("org-1", "m-1", body.values, "user-1");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "business_metric.forecast_values.write",
        metadata: { key: "customers", days: 2 },
      }),
    );
  });

  it("refuses negative values and an empty batch before the service", async () => {
    for (const values of [[{ date: "2026-11-01", value: -5 }], []]) {
      const res = await buildApp().request("/customers/forecast-values", post({ values }));
      expect(res.status).toBe(400);
    }
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe("DELETE /:id/forecast-values", () => {
  it("deletes a range and audits it", async () => {
    const res = await buildApp().request(
      "/customers/forecast-values?from=2026-11-01&to=2026-11-03",
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith("m-1", { from: "2026-11-01", to: "2026-11-03" });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "business_metric.forecast_values.delete" }),
    );
  });

  it("refuses a backwards range", async () => {
    const res = await buildApp().request(
      "/customers/forecast-values?from=2026-11-05&to=2026-11-01",
      { method: "DELETE" },
    );
    expect(res.status).toBe(400);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
