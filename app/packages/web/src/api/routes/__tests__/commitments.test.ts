import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthSession } from "@/api/auth-middleware";
import { buildTestApp } from "./test-utils";

// Services are mocked: they reach the Drizzle and ClickHouse clients. These
// tests own the transport contract: permissions, validation, status codes
// and audit.
const mockFeed = vi.fn();
vi.mock("@infrawrench/server-core/commitments/feed", () => ({
  getCommitmentsFeed: (...args: unknown[]) => mockFeed(...args),
}));

const mockRunConfig = vi.fn();
const mockOptions = vi.fn();
class FakeCommitmentReportError extends Error {}
vi.mock("@infrawrench/server-core/commitments/report", () => ({
  runCommitmentReportConfig: (...args: unknown[]) => mockRunConfig(...args),
  getCommitmentReportOptions: (...args: unknown[]) => mockOptions(...args),
  CommitmentReportError: FakeCommitmentReportError,
}));

const mockList = vi.fn();
const mockGet = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockRun = vi.fn();
vi.mock("../../../services/commitment-reports", () => ({
  listCommitmentReports: (...args: unknown[]) => mockList(...args),
  getCommitmentReport: (...args: unknown[]) => mockGet(...args),
  createCommitmentReport: (...args: unknown[]) => mockCreate(...args),
  updateCommitmentReport: (...args: unknown[]) => mockUpdate(...args),
  softDeleteCommitmentReport: (...args: unknown[]) => mockDelete(...args),
  runCommitmentReport: (...args: unknown[]) => mockRun(...args),
}));

class FakeCostReportFolderError extends Error {}
vi.mock("../../../services/cost-report-folders", () => ({
  CostReportFolderError: FakeCostReportFolderError,
}));

const mockLogAudit = vi.fn();
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { default: commitmentRoutes } = await import("@/api/routes/commitments");

const buildApp = () => buildTestApp(commitmentRoutes);

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
  app.route("/", commitmentRoutes);
  return app;
}

const config = {
  version: 1,
  dateRange: { kind: "relative", preset: "90d" },
  granularity: "weekly",
  groupBy: "service",
  filters: { providers: ["aws"] },
  metric: "utilization",
};

const report = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Coverage by service",
  description: null,
  config,
  folderId: null,
  createdByUserId: "user-1",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const result = {
  from: "2026-07-18",
  to: "2026-10-15",
  granularity: "weekly",
  groupBy: "service",
  buckets: [],
  series: [],
  overall: [],
  providers: [],
  notices: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue([report]);
  mockGet.mockResolvedValue(report);
  mockCreate.mockResolvedValue(report);
  mockUpdate.mockResolvedValue(report);
  mockDelete.mockResolvedValue(true);
  mockRun.mockResolvedValue({ ...result, reportId: report.id, name: report.name });
  mockRunConfig.mockResolvedValue(result);
  mockOptions.mockResolvedValue({
    providers: [],
    accounts: [],
    services: [],
    regions: [],
    commitments: [],
  });
});

describe("reads", () => {
  it("need costs:read", async () => {
    const app = buildAppWithPermissions([]);
    for (const path of ["/reports", "/report-options", `/reports/${report.id}`]) {
      expect((await app.request(path)).status).toBe(403);
    }
    const run = await app.request(`/reports/${report.id}/run`, { method: "POST" });
    expect(run.status).toBe(403);
  });

  it("lists saved reports", async () => {
    const res = await buildApp().request("/reports");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([report]);
    expect(mockList).toHaveBeenCalledWith("org-1");
  });

  it("404s an unknown report", async () => {
    mockGet.mockResolvedValue(null);
    expect((await buildApp().request("/reports/nope")).status).toBe(404);
  });

  it("runs a saved report", async () => {
    const res = await buildApp().request(`/reports/${report.id}/run`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(mockRun).toHaveBeenCalledWith("org-1", report.id);
  });

  it("turns a refused range into a 400", async () => {
    mockRun.mockRejectedValue(new FakeCommitmentReportError("too long"));
    const res = await buildApp().request(`/reports/${report.id}/run`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "too long" });
  });
});

describe("POST /report-query", () => {
  it("validates the config before running it", async () => {
    const res = await buildApp().request("/report-query", {
      method: "POST",
      body: JSON.stringify({ ...config, granularity: "hourly" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/one row per day/);
    expect(mockRunConfig).not.toHaveBeenCalled();
  });

  it("runs a valid config with costs:read only", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/report-query", {
      method: "POST",
      body: JSON.stringify(config),
    });
    expect(res.status).toBe(200);
    expect(mockRunConfig).toHaveBeenCalledWith("org-1", config);
  });

  it("refuses a malformed body", async () => {
    const res = await buildApp().request("/report-query", { method: "POST", body: "{" });
    expect(res.status).toBe(400);
  });
});

describe("writes", () => {
  const body = JSON.stringify({ name: " Coverage by service ", config });

  it("need costs:write", async () => {
    const app = buildAppWithPermissions(["costs:read"]);
    expect((await app.request("/reports", { method: "POST", body })).status).toBe(403);
    expect((await app.request(`/reports/${report.id}`, { method: "PUT", body })).status).toBe(403);
    expect((await app.request(`/reports/${report.id}`, { method: "DELETE" })).status).toBe(403);
  });

  it("creates with a normalized body and audits it", async () => {
    const res = await buildApp().request("/reports", { method: "POST", body });
    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith(
      "org-1",
      { name: "Coverage by service", description: null, config, folderId: null },
      "user-1",
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "commitment_report.create", entityId: report.id }),
    );
  });

  it("refuses an invalid body without writing", async () => {
    const res = await buildApp().request("/reports", {
      method: "POST",
      body: JSON.stringify({ name: "x", config: { ...config, groupBy: "instance_family" } }),
    });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("maps a bad folder to 400", async () => {
    mockCreate.mockRejectedValue(new FakeCostReportFolderError("Unknown folder."));
    const res = await buildApp().request("/reports", { method: "POST", body });
    expect(res.status).toBe(400);
  });

  it("updates and 404s a missing report", async () => {
    expect(
      (await buildApp().request(`/reports/${report.id}`, { method: "PUT", body })).status,
    ).toBe(200);
    mockUpdate.mockResolvedValue(null);
    expect(
      (await buildApp().request(`/reports/${report.id}`, { method: "PUT", body })).status,
    ).toBe(404);
  });

  it("deletes and audits", async () => {
    const res = await buildApp().request(`/reports/${report.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "commitment_report.delete" }),
    );
    mockDelete.mockResolvedValue(false);
    expect((await buildApp().request(`/reports/${report.id}`, { method: "DELETE" })).status).toBe(
      404,
    );
  });
});

describe("GET /", () => {
  it("still serves the feed", async () => {
    mockFeed.mockResolvedValue({ holdings: [] });
    const res = await buildApp().request("/");
    expect(res.status).toBe(200);
    expect(mockFeed).toHaveBeenCalledWith("org-1");
  });
});
