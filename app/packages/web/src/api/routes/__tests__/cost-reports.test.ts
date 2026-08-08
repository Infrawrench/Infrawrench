import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthSession } from "@/api/auth-middleware";
import { buildTestApp } from "./test-utils";

// The service is mocked rather than exercised: it reaches the Drizzle client,
// which throws at import time without DATABASE_URL. These tests are about the
// transport contract — permissions, validation, status codes, audit — which is
// what this file owns.
const mockList = vi.fn();
const mockGet = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockSoftDelete = vi.fn();
const mockRun = vi.fn();

vi.mock("../../../services/cost-reports", () => ({
  listCostReports: (...args: unknown[]) => mockList(...args),
  getCostReport: (...args: unknown[]) => mockGet(...args),
  createCostReport: (...args: unknown[]) => mockCreate(...args),
  updateCostReport: (...args: unknown[]) => mockUpdate(...args),
  softDeleteCostReport: (...args: unknown[]) => mockSoftDelete(...args),
  runCostReport: (...args: unknown[]) => mockRun(...args),
}));

class FakeCostQueryError extends Error {}
vi.mock("../../../services/cost-query", () => ({
  CostQueryError: FakeCostQueryError,
}));

const mockLogAudit = vi.fn();
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { costReportRoutes } = await import("@/api/routes/cost-reports");

const buildApp = () => buildTestApp(costReportRoutes);

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
  app.route("/", costReportRoutes);
  return app;
}

const config = {
  version: 1,
  chartType: "stacked_bar",
  binning: "daily",
  dateRange: { kind: "relative", preset: "30d" },
  groupBy: "service",
  filters: [],
  topN: 5,
  comparePreviousPeriod: false,
  showForecast: false,
};

const report = {
  id: "report-1",
  name: "Monthly spend",
  description: null,
  config,
  folderId: null,
  createdByUserId: "user-1",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  placements: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue([report]);
  mockGet.mockResolvedValue(report);
  mockCreate.mockResolvedValue(report);
  mockUpdate.mockResolvedValue(report);
  mockSoftDelete.mockResolvedValue(true);
});

describe("GET /", () => {
  it("rejects without costs:read", async () => {
    const res = await buildAppWithPermissions([]).request("/");
    expect(res.status).toBe(403);
  });

  it("lists the org's reports", async () => {
    const res = await buildApp().request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([report]);
    expect(mockList).toHaveBeenCalledWith("org-1");
  });
});

describe("POST /", () => {
  const body = JSON.stringify({ name: "Monthly spend", config });

  it("rejects a costs:read-only caller", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/", {
      method: "POST",
      body,
    });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid config with 400 and does not write", async () => {
    const res = await buildApp().request("/", {
      method: "POST",
      body: JSON.stringify({ name: "Bad", config: { version: 1 } }),
    });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects an empty name", async () => {
    const res = await buildApp().request("/", {
      method: "POST",
      body: JSON.stringify({ name: "", config }),
    });
    expect(res.status).toBe(400);
  });

  it("creates and audits", async () => {
    const res = await buildApp().request("/", { method: "POST", body });
    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ name: "Monthly spend" }),
      "user-1",
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_report.create", entityType: "cost_report" }),
    );
  });
});

describe("GET /:id", () => {
  it("404s an unknown report", async () => {
    mockGet.mockResolvedValue(null);
    const res = await buildApp().request("/nope");
    expect(res.status).toBe(404);
  });

  it("returns the report", async () => {
    const res = await buildApp().request("/report-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(report);
  });
});

describe("PUT /:id", () => {
  const body = JSON.stringify({ name: "Renamed", config });

  it("rejects a costs:read-only caller", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/report-1", {
      method: "PUT",
      body,
    });
    expect(res.status).toBe(403);
  });

  it("404s an unknown report without auditing", async () => {
    mockUpdate.mockResolvedValue(null);
    const res = await buildApp().request("/report-1", { method: "PUT", body });
    expect(res.status).toBe(404);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("updates and audits", async () => {
    const res = await buildApp().request("/report-1", { method: "PUT", body });
    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_report.update", entityId: "report-1" }),
    );
  });
});

describe("DELETE /:id", () => {
  it("rejects a costs:read-only caller", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/report-1", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });

  it("404s an unknown report without auditing", async () => {
    mockSoftDelete.mockResolvedValue(false);
    const res = await buildApp().request("/report-1", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("soft-deletes and audits", async () => {
    const res = await buildApp().request("/report-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockSoftDelete).toHaveBeenCalledWith("org-1", "report-1");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_report.delete", entityId: "report-1" }),
    );
  });
});

describe("POST /:id/run", () => {
  it("rejects without costs:read", async () => {
    const res = await buildAppWithPermissions([]).request("/report-1/run", { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("runs on costs:read alone — executing a report is a read", async () => {
    mockRun.mockResolvedValue({
      reportId: "report-1",
      name: "Monthly spend",
      from: "2026-07-10",
      to: "2026-08-08",
      result: { series: [], currencies: [], totals: {} },
    });
    const res = await buildAppWithPermissions(["costs:read"]).request("/report-1/run", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reportId: "report-1", from: "2026-07-10" });
  });

  it("404s an unknown report", async () => {
    mockRun.mockResolvedValue(null);
    const res = await buildApp().request("/report-1/run", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("maps a bad saved query onto 400 rather than a 500", async () => {
    mockRun.mockRejectedValue(new FakeCostQueryError("Date range too large"));
    const res = await buildApp().request("/report-1/run", { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Date range too large" });
  });
});
