import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

// The services are mocked rather than exercised: they reach the Drizzle client
// and ClickHouse. These tests own the transport contract of the forecast
// routes on the report router: permissions, validation, status codes, audit.
vi.mock("../../../services/cost-reports", () => ({
  listCostReports: vi.fn(),
  getCostReport: vi.fn(),
  createCostReport: vi.fn(),
  updateCostReport: vi.fn(),
  softDeleteCostReport: vi.fn(),
  runCostReport: vi.fn(),
}));
vi.mock("../../../services/cost-query", () => ({ CostQueryError: class extends Error {} }));
vi.mock("../../../services/cost-report-folders", () => ({
  CostReportFolderError: class extends Error {},
}));
vi.mock("../../../services/cost-reports-bulk", () => ({
  applyCostReportBulk: vi.fn(),
  CostReportBulkError: class extends Error {},
}));

const mockList = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockRun = vi.fn();
class FakeCostForecastError extends Error {}
class FakeNameConflict extends Error {}
vi.mock("../../../services/cost-forecasts", () => ({
  CostForecastError: FakeCostForecastError,
  CostForecastNameConflictError: FakeNameConflict,
  listCostForecasts: (...args: unknown[]) => mockList(...args),
  createCostForecast: (...args: unknown[]) => mockCreate(...args),
  updateCostForecast: (...args: unknown[]) => mockUpdate(...args),
  deleteCostForecast: (...args: unknown[]) => mockDelete(...args),
  runCostReportForecast: (...args: unknown[]) => mockRun(...args),
}));

const mockLogAudit = vi.fn();
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { costReportRoutes } = await import("@/api/routes/cost-reports");

const buildApp = (permissions?: string[]) => buildTestApp(costReportRoutes, permissions);

const MODEL = "11111111-1111-4111-8111-111111111111";
const forecast = {
  id: "f-1",
  reportId: "r-1",
  name: "Plan",
  description: null,
  scenarioModelIds: [MODEL],
  driverMetricId: null,
  isDefault: true,
  createdByUserId: "user-1",
  createdAt: "2026-10-16T00:00:00.000Z",
  updatedAt: "2026-10-16T00:00:00.000Z",
};
const json = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue([forecast]);
  mockCreate.mockResolvedValue(forecast);
  mockUpdate.mockResolvedValue(forecast);
  mockDelete.mockResolvedValue({ deleted: true, name: "Plan" });
  mockRun.mockResolvedValue({ reportId: "r-1" });
});

describe("GET /:id/forecasts", () => {
  it("needs costs:read", async () => {
    expect((await buildApp([]).request("/r-1/forecasts")).status).toBe(403);
  });

  it("lists the report's forecasts, and 404s a report the caller cannot see", async () => {
    const res = await buildApp(["costs:read"]).request("/r-1/forecasts");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ forecasts: [forecast] });
    expect(mockList).toHaveBeenCalledWith("org-1", "r-1");

    mockList.mockResolvedValueOnce(null);
    expect((await buildApp().request("/r-1/forecasts")).status).toBe(404);
  });
});

describe("POST /:id/forecasts", () => {
  const body = { name: "Plan", scenarioModelIds: [MODEL], isDefault: true };

  it("is a write", async () => {
    const res = await buildApp(["costs:read"]).request("/r-1/forecasts", json(body));
    expect(res.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("creates and audits", async () => {
    const res = await buildApp().request("/r-1/forecasts", json(body));
    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith(
      "org-1",
      "r-1",
      { name: "Plan", scenarioModelIds: [MODEL], isDefault: true },
      "user-1",
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "cost_forecast.create",
        entityType: "cost_forecast",
        entityId: "f-1",
        metadata: expect.objectContaining({ reportId: "r-1", isDefault: true }),
      }),
    );
  });

  it("refuses a malformed body without writing", async () => {
    const res = await buildApp().request(
      "/r-1/forecasts",
      json({ name: "", scenarioModelIds: "nope" }),
    );
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("maps service refusals to 400 and a duplicate name to 409", async () => {
    mockCreate.mockRejectedValueOnce(new FakeCostForecastError("no such model"));
    const bad = await buildApp().request("/r-1/forecasts", json(body));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "no such model" });

    mockCreate.mockRejectedValueOnce(new FakeNameConflict("taken"));
    expect((await buildApp().request("/r-1/forecasts", json(body))).status).toBe(409);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("404s a report the caller cannot edit into", async () => {
    mockCreate.mockResolvedValueOnce(null);
    expect((await buildApp().request("/r-1/forecasts", json(body))).status).toBe(404);
  });
});

describe("PUT and DELETE /:id/forecasts/:forecastId", () => {
  it("replaces one and audits", async () => {
    const res = await buildApp().request("/r-1/forecasts/f-1", {
      ...json({ name: "Plan B", scenarioModelIds: [MODEL] }),
      method: "PUT",
    });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith("org-1", "r-1", "f-1", {
      name: "Plan B",
      scenarioModelIds: [MODEL],
    });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_forecast.update" }),
    );
  });

  it("deletes one and audits, 404 when it is gone", async () => {
    const res = await buildApp().request("/r-1/forecasts/f-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith("org-1", "r-1", "f-1");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_forecast.delete", entityId: "f-1" }),
    );

    mockDelete.mockResolvedValueOnce({ deleted: false, name: null });
    expect((await buildApp().request("/r-1/forecasts/f-2", { method: "DELETE" })).status).toBe(404);
  });

  it("needs costs:write", async () => {
    expect(
      (await buildApp(["costs:read"]).request("/r-1/forecasts/f-1", { method: "DELETE" })).status,
    ).toBe(403);
  });
});

describe("POST /:id/forecasted-costs", () => {
  it("is a read: costs:read is enough, and an empty body runs the default", async () => {
    const res = await buildApp(["costs:read"]).request("/r-1/forecasted-costs", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(mockRun).toHaveBeenCalledWith("org-1", "r-1", {});
  });

  it("passes the window, narrowing and level through", async () => {
    await buildApp().request(
      "/r-1/forecasted-costs",
      json({
        from: "2026-11-01",
        to: "2026-12-31",
        forecastId: "baseline",
        providers: ["aws"],
        services: ["Amazon EC2"],
        confidenceLevel: 95,
        all: true,
      }),
    );
    expect(mockRun).toHaveBeenCalledWith("org-1", "r-1", {
      from: "2026-11-01",
      to: "2026-12-31",
      forecastId: "baseline",
      providers: ["aws"],
      services: ["Amazon EC2"],
      confidenceLevel: 95,
      all: true,
    });
  });

  it("refuses an unsupported level and a malformed day", async () => {
    expect(
      (await buildApp().request("/r-1/forecasted-costs", json({ confidenceLevel: 99 }))).status,
    ).toBe(400);
    expect(
      (await buildApp().request("/r-1/forecasted-costs", json({ to: "next month" }))).status,
    ).toBe(400);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("maps a service refusal to 400 and a hidden report to 404", async () => {
    mockRun.mockRejectedValueOnce(new FakeCostForecastError("measures usage"));
    expect((await buildApp().request("/r-1/forecasted-costs", json({}))).status).toBe(400);
    mockRun.mockResolvedValueOnce(null);
    expect((await buildApp().request("/r-1/forecasted-costs", json({}))).status).toBe(404);
  });
});
