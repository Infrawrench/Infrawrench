import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

// Services are mocked: they reach the Drizzle and ClickHouse clients. These
// tests own the transport contract: permissions, validation, status codes and
// audit.
vi.mock("@infrawrench/server-core/network-flow/feed", () => ({
  getNetworkFlowFeed: vi.fn(),
}));
vi.mock("@infrawrench/server-core/network-flow/kubernetes", () => ({
  getKubernetesNetworkReport: vi.fn(),
  getKubernetesNetworkSettings: vi.fn(),
  setKubernetesNetworkSettings: vi.fn(),
  KubernetesNetworkError: class extends Error {},
}));
vi.mock("@infrawrench/server-core/network-flow/settings", () => ({
  getNetworkFlowSettings: vi.fn(),
  setNetworkFlowSettings: vi.fn(),
  NetworkFlowSettingsError: class extends Error {},
}));

const mockRunConfig = vi.fn();
const mockOptions = vi.fn();
class FakeNetworkFlowReportError extends Error {}
vi.mock("@infrawrench/server-core/network-flow/report", () => ({
  runNetworkFlowReportConfig: (...args: unknown[]) => mockRunConfig(...args),
  getNetworkFlowReportOptions: (...args: unknown[]) => mockOptions(...args),
  NetworkFlowReportError: FakeNetworkFlowReportError,
}));

const mockList = vi.fn();
const mockGet = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockRun = vi.fn();
vi.mock("../../../services/network-flow-reports", () => ({
  listNetworkFlowReports: (...args: unknown[]) => mockList(...args),
  getNetworkFlowReport: (...args: unknown[]) => mockGet(...args),
  createNetworkFlowReport: (...args: unknown[]) => mockCreate(...args),
  updateNetworkFlowReport: (...args: unknown[]) => mockUpdate(...args),
  softDeleteNetworkFlowReport: (...args: unknown[]) => mockDelete(...args),
  runSavedNetworkFlowReport: (...args: unknown[]) => mockRun(...args),
}));

class FakeCostReportFolderError extends Error {}
vi.mock("../../../services/cost-report-folders", () => ({
  CostReportFolderError: FakeCostReportFolderError,
}));

const mockLogAudit = vi.fn();
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { networkFlowRoutes } = await import("@/api/routes/network-flows");

const buildApp = (permissions?: string[]) => buildTestApp(networkFlowRoutes, permissions);

const config = {
  version: 1,
  dateRange: { kind: "relative", preset: "30d" },
  granularity: "daily",
  groupBy: "pair",
  filters: { trafficClasses: ["cross_zone"], networks: ["vpc-1"] },
  metric: "both",
};

const report = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Cross-zone by pair",
  description: null,
  config,
  folderId: null,
  createdByUserId: "user-1",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const result = {
  from: "2026-09-16",
  to: "2026-10-15",
  granularity: "daily",
  groupBy: "pair",
  metric: "both",
  estimated: true,
  buckets: [],
  series: [],
  overall: [],
  groups: [],
  groupCount: 0,
  topTalkers: [],
  sampledPluginIds: [],
  notices: [],
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
    accounts: [],
    networks: [],
    regions: [],
    zones: [],
    services: [],
    resourceTypes: [],
    endpoints: [],
    trafficClasses: [],
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
  });

  it("lists saved reports", async () => {
    const res = await buildApp(["costs:read"]).request("/reports");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([report]);
    expect(mockList).toHaveBeenCalledWith("org-1");
  });

  it("404s an unknown report, to read and to run", async () => {
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
    expect(await res.json()).toMatchObject({ reportId: report.id, estimated: true });
  });

  it("runs an unsaved config after validating it", async () => {
    const ok = await buildApp(["costs:read"]).request("/report-query", json(config));
    expect(ok.status).toBe(200);
    expect(mockRunConfig).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ groupBy: "pair" }),
    );

    const bad = await buildApp().request(
      "/report-query",
      json({ ...config, filters: { trafficClasses: ["peering"] } }),
    );
    expect(bad.status).toBe(400);

    const hourly = await buildApp().request(
      "/report-query",
      json({ ...config, granularity: "hourly" }),
    );
    expect(hourly.status).toBe(400);
    expect((await hourly.json()).error).toMatch(/one row per day/);
  });

  it("turns a refused window into a 400", async () => {
    mockRunConfig.mockRejectedValue(new FakeNetworkFlowReportError("too long"));
    const res = await buildApp().request("/report-query", json(config));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "too long" });
  });

  it("returns picker options", async () => {
    const res = await buildApp(["costs:read"]).request("/report-options");
    expect(res.status).toBe(200);
    expect(mockOptions).toHaveBeenCalledWith("org-1");
  });
});

describe("writes", () => {
  it("need costs:write", async () => {
    const app = buildApp(["costs:read"]);
    expect((await app.request("/reports", json({ name: "x", config }))).status).toBe(403);
    expect(
      (await app.request(`/reports/${report.id}`, json({ name: "x", config }, "PUT"))).status,
    ).toBe(403);
    expect((await app.request(`/reports/${report.id}`, { method: "DELETE" })).status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("creates with the caller as creator and audits it", async () => {
    const res = await buildApp(["costs:write"]).request(
      "/reports",
      json({ name: " Cross-zone by pair ", config, folderId: null }),
    );
    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ name: "Cross-zone by pair", folderId: null }),
      "user-1",
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "network_flow_report.create",
        entityType: "network_flow_report",
        entityId: report.id,
      }),
    );
  });

  it("refuses an invalid body or unknown fields", async () => {
    const app = buildApp();
    expect((await app.request("/reports", json({ name: "", config }))).status).toBe(400);
    expect((await app.request("/reports", json({ name: "x", config, owner: "y" }))).status).toBe(
      400,
    );
    const broken = await app.request("/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(broken.status).toBe(400);
  });

  it("maps a bad folder to a 400", async () => {
    mockCreate.mockRejectedValue(new FakeCostReportFolderError("Folder not found"));
    const res = await buildApp().request(
      "/reports",
      json({ name: "x", config, folderId: "22222222-2222-4222-8222-222222222222" }),
    );
    expect(res.status).toBe(400);
  });

  it("replaces, audits, and 404s a missing report", async () => {
    const res = await buildApp().request(
      `/reports/${report.id}`,
      json({ name: "Renamed", config }, "PUT"),
    );
    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "network_flow_report.update" }),
    );
    mockUpdate.mockResolvedValue(null);
    const missing = await buildApp().request(
      `/reports/${report.id}`,
      json({ name: "Renamed", config }, "PUT"),
    );
    expect(missing.status).toBe(404);
  });

  it("soft-deletes and audits", async () => {
    const res = await buildApp().request(`/reports/${report.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith("org-1", report.id);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "network_flow_report.delete", entityId: report.id }),
    );
    mockDelete.mockResolvedValue(false);
    expect((await buildApp().request(`/reports/${report.id}`, { method: "DELETE" })).status).toBe(
      404,
    );
  });
});
