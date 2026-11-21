import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

// Services are mocked: they reach the Drizzle client. These tests own the
// transport contract: permissions, validation (the contract's schemas, decoded
// strictly), status codes and audit.
const mockFeed = vi.fn();
vi.mock("@infrawrench/server-core/commitments/feed", () => ({
  getCommitmentsFeed: (...args: unknown[]) => mockFeed(...args),
}));

const mockRunConfig = vi.fn();
const mockOptions = vi.fn();
vi.mock("@infrawrench/server-core/commitments/report", () => ({
  runCommitmentReportConfig: (...args: unknown[]) => mockRunConfig(...args),
  getCommitmentReportOptions: (...args: unknown[]) => mockOptions(...args),
}));

const mockList = vi.fn();
const mockGet = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockRun = vi.fn();
vi.mock("@/services/commitment-reports", () => ({
  listCommitmentReports: (...args: unknown[]) => mockList(...args),
  getCommitmentReport: (...args: unknown[]) => mockGet(...args),
  createCommitmentReport: (...args: unknown[]) => mockCreate(...args),
  updateCommitmentReport: (...args: unknown[]) => mockUpdate(...args),
  softDeleteCommitmentReport: (...args: unknown[]) => mockDelete(...args),
  runSavedCommitmentReport: (...args: unknown[]) => mockRun(...args),
}));

class FakeCostReportFolderError extends Error {}
vi.mock("@/services/cost-report-folders", () => ({
  CostReportFolderError: FakeCostReportFolderError,
}));

const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { commitmentsDomain } = await import("@/http/domains/commitments/index");

const buildApp = (permissions?: string[]) =>
  buildTestApi(commitmentsDomain, {
    basePath: "/api/org/org-1/commitments",
    ...(permissions ? { permissions } : {}),
  });

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

const totals = {
  covered: 80,
  coveredAll: 80,
  unused: 20,
  uncovered: 100,
  uncoveredEligible: 50,
  coveredOnDemand: 120,
  coveredMeasured: 80,
};
const metrics = {
  coverage: 0.444,
  eligibleCoverage: 0.615,
  utilization: 0.8,
  effectiveSavingsRate: 0.09,
  netSavings: 20,
  onDemandRemainder: 100,
  commitmentCost: 100,
  usedCommitmentCost: 80,
  unusedCommitmentCost: 20,
  onDemandEquivalent: 120,
  savingsMeasuredShare: 1,
};
const series = {
  id: "AmazonEC2\u0000USD",
  groupKey: "AmazonEC2",
  label: "AmazonEC2",
  currency: "USD",
  points: [{ bucket: "2026-10-12", totals, metrics }],
  total: { totals, metrics },
};
const result = {
  from: "2026-07-18",
  to: "2026-10-15",
  granularity: "weekly",
  groupBy: "service",
  buckets: ["2026-10-12"],
  series: [series],
  overall: [{ ...series, id: "\u0000USD", groupKey: "", label: "USD" }],
  providers: [{ pluginId: "aws", displayName: "AWS", status: "measured", accountCount: 1 }],
  notices: ["unused_lumped_monthly"],
};

const json = (body: unknown, method = "POST") => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

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
    providers: [{ pluginId: "aws", displayName: "AWS", status: "measured" }],
    accounts: [{ id: "acc-1", name: "Production", pluginId: "aws" }],
    services: ["AmazonEC2"],
    regions: ["us-east-1"],
    commitments: [
      {
        commitmentId: "sp-1",
        accountId: "acc-1",
        pluginId: "aws",
        kind: "savings_plan",
        description: "Compute savings plan",
        state: "active",
      },
    ],
  });
});

describe("reads", () => {
  it("need costs:read", async () => {
    const app = buildApp([]);
    for (const path of ["/reports", "/report-options", `/reports/${report.id}`]) {
      expect((await app.request(path)).status).toBe(403);
    }
    expect((await app.request(`/reports/${report.id}/run`, { method: "POST" })).status).toBe(403);
    expect((await app.request("/report-query", json(config))).status).toBe(403);
    expect(mockRunConfig).not.toHaveBeenCalled();
  });

  it("lists saved reports", async () => {
    const res = await buildApp(["costs:read"]).request("/reports");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([report]);
    expect(mockList).toHaveBeenCalledWith("org-1");
  });

  it("reads one report and 404s an unknown one, to read and to run", async () => {
    expect(await (await buildApp(["costs:read"]).request(`/reports/${report.id}`)).json()).toEqual(
      report,
    );
    mockGet.mockResolvedValue(null);
    mockRun.mockResolvedValue(null);
    expect((await buildApp().request("/reports/nope")).status).toBe(404);
    expect((await buildApp().request("/reports/nope/run", { method: "POST" })).status).toBe(404);
  });

  it("runs a saved report", async () => {
    const res = await buildApp(["costs:read"]).request(`/reports/${report.id}/run`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...result, reportId: report.id, name: report.name });
    expect(mockRun).toHaveBeenCalledWith("org-1", report.id);
  });

  it("returns picker options", async () => {
    const res = await buildApp(["costs:read"]).request("/report-options");
    expect(res.status).toBe(200);
    expect(mockOptions).toHaveBeenCalledWith("org-1");
  });

  it("still serves the feed", async () => {
    mockFeed.mockResolvedValue({ holdings: [] });
    const res = await buildApp(["costs:read"]).request("");
    expect(res.status).toBe(200);
    expect(mockFeed).toHaveBeenCalledWith("org-1");
  });
});

describe("POST /report-query", () => {
  it("runs a valid config, as decoded, with costs:read only", async () => {
    const res = await buildApp(["costs:read"]).request("/report-query", json(config));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(mockRunConfig).toHaveBeenCalledWith("org-1", config);
  });

  it("refuses hourly with the reason, before running anything", async () => {
    const res = await buildApp().request(
      "/report-query",
      json({ ...config, granularity: "hourly" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: Array<{ message: string }> };
    expect(body.error).toBe("Invalid commitment report config");
    expect(body.issues[0]!.message).toMatch(/one row per day/);
    expect(mockRunConfig).not.toHaveBeenCalled();
  });

  it("refuses unknown keys, empty or repeated filter values, and long daily windows", async () => {
    const app = buildApp();
    for (const body of [
      { ...config, binning: "daily" },
      { ...config, filters: { providers: [] } },
      { ...config, filters: { providers: ["aws", "aws"] } },
      {
        ...config,
        granularity: "daily",
        dateRange: { kind: "absolute", from: "2025-01-01", to: "2026-06-30" },
      },
    ]) {
      expect((await app.request("/report-query", json(body))).status).toBe(400);
    }
    expect(mockRunConfig).not.toHaveBeenCalled();
  });

  it("refuses a malformed body", async () => {
    const res = await buildApp().request("/report-query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(res.status).toBe(400);
  });
});

describe("writes", () => {
  const body = { name: "Coverage by service", config };

  it("need costs:write", async () => {
    const app = buildApp(["costs:read"]);
    expect((await app.request("/reports", json(body))).status).toBe(403);
    expect((await app.request(`/reports/${report.id}`, json(body, "PUT"))).status).toBe(403);
    expect((await app.request(`/reports/${report.id}`, { method: "DELETE" })).status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("creates the body exactly as sent, with the caller as creator, and audits it", async () => {
    const res = await buildApp(["costs:write"]).request(
      "/reports",
      json({ ...body, description: "Weekly", folderId: null }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(report);
    expect(mockCreate).toHaveBeenCalledWith(
      "org-1",
      { ...body, description: "Weekly", folderId: null },
      "user-1",
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "commitment_report.create",
        entityType: "commitment_report",
        entityId: report.id,
        metadata: { name: report.name },
      }),
    );
  });

  it("refuses an invalid body without writing", async () => {
    const app = buildApp();
    for (const invalid of [
      { name: "", config },
      { name: " Coverage ", config },
      { ...body, owner: "y" },
      { name: "x", config: { ...config, groupBy: "instance_family" } },
    ]) {
      const res = await app.request("/reports", json(invalid));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("Invalid commitment report");
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("maps a folder the service refuses to a 400 with its sentence", async () => {
    mockCreate.mockRejectedValue(new FakeCostReportFolderError("Unknown folder."));
    const res = await buildApp().request("/reports", json({ ...body, folderId: "folder-1" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown folder." });
    expect(mockLogAudit).not.toHaveBeenCalled();

    mockUpdate.mockRejectedValue(new FakeCostReportFolderError("Unknown folder."));
    const put = await buildApp().request(
      `/reports/${report.id}`,
      json({ ...body, folderId: "folder-1" }, "PUT"),
    );
    expect(put.status).toBe(400);
  });

  it("leaves any other failure a 500", async () => {
    mockCreate.mockRejectedValue(new Error("connection reset"));
    expect((await buildApp().request("/reports", json(body))).status).toBe(500);
  });

  it("replaces, audits, and 404s a missing report", async () => {
    const res = await buildApp().request(`/reports/${report.id}`, json(body, "PUT"));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith("org-1", report.id, body);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "commitment_report.update" }),
    );
    mockUpdate.mockResolvedValue(null);
    expect((await buildApp().request(`/reports/${report.id}`, json(body, "PUT"))).status).toBe(404);
  });

  it("deletes, audits, and 404s a missing report", async () => {
    const res = await buildApp().request(`/reports/${report.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "commitment_report.delete", entityId: report.id }),
    );
    mockDelete.mockResolvedValue(false);
    expect((await buildApp().request(`/reports/${report.id}`, { method: "DELETE" })).status).toBe(
      404,
    );
  });
});
