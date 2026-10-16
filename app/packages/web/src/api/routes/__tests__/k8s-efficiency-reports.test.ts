import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthSession } from "@/api/auth-middleware";
import { buildTestApp } from "./test-utils";

// The service is mocked: it reaches the Drizzle client and ClickHouse. These
// tests own the transport contract (permissions, validation, status codes,
// audit, the export's shape).
const mockList = vi.fn();
const mockGet = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockSoftDelete = vi.fn();
const mockRun = vi.fn();
const mockQuery = vi.fn();
const mockOptions = vi.fn();
const mockValues = vi.fn();

vi.mock("../../../services/k8s-efficiency-reports", () => ({
  listKubernetesEfficiencyReports: (...args: unknown[]) => mockList(...args),
  getKubernetesEfficiencyReport: (...args: unknown[]) => mockGet(...args),
  createKubernetesEfficiencyReport: (...args: unknown[]) => mockCreate(...args),
  updateKubernetesEfficiencyReport: (...args: unknown[]) => mockUpdate(...args),
  softDeleteKubernetesEfficiencyReport: (...args: unknown[]) => mockSoftDelete(...args),
  runKubernetesEfficiencyReport: (...args: unknown[]) => mockRun(...args),
  queryKubernetesEfficiency: (...args: unknown[]) => mockQuery(...args),
  getKubernetesEfficiencyOptions: (...args: unknown[]) => mockOptions(...args),
  getKubernetesEfficiencyTagValues: (...args: unknown[]) => mockValues(...args),
}));

class FakeCostReportFolderError extends Error {}
vi.mock("../../../services/cost-report-folders", () => ({
  CostReportFolderError: FakeCostReportFolderError,
}));

const mockLogAudit = vi.fn();
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { kubernetesEfficiencyReportRoutes } = await import("@/api/routes/k8s-efficiency-reports");
const { buildKubernetesEfficiencyResult } = await import("@infrawrench/client-core");

const buildApp = () => buildTestApp(kubernetesEfficiencyReportRoutes);

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
  app.route("/", kubernetesEfficiencyReportRoutes);
  return app;
}

const config = {
  version: 1,
  dateRange: { kind: "relative", preset: "30d" },
  granularity: "week",
  filters: [{ dimension: "tag", tagKey: "namespace", op: "in", values: ["payments"] }],
  groupBy: "workload",
  idle: "separate",
  basis: "total",
};

const report = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Payments efficiency",
  description: null,
  config,
  folderId: null,
  createdByUserId: "user-1",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const result = buildKubernetesEfficiencyResult(
  [
    {
      bucket: "2026-10-12",
      group: "payments/Deployment/api",
      accountId: "c1",
      service: "kubernetes-workload",
      resource: "cpu",
      usage: "used",
      currency: "USD",
      amount: 6,
    },
    {
      bucket: "2026-10-12",
      group: "payments/Deployment/api",
      accountId: "c1",
      service: "kubernetes-workload",
      resource: "cpu",
      usage: "unused",
      currency: "USD",
      amount: 4,
    },
  ],
  {
    config: config as Parameters<typeof buildKubernetesEfficiencyResult>[1]["config"],
    from: "2026-10-12",
    to: "2026-10-16",
  },
);

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue([report]);
  mockGet.mockResolvedValue(report);
  mockCreate.mockResolvedValue(report);
  mockUpdate.mockResolvedValue(report);
  mockSoftDelete.mockResolvedValue(true);
  mockRun.mockResolvedValue({ reportId: report.id, name: report.name, result });
  mockQuery.mockResolvedValue(result);
  mockOptions.mockResolvedValue({
    clusters: [],
    regions: [],
    namespaces: [],
    nodePools: [],
    labelKeys: [],
  });
  mockValues.mockResolvedValue(["payments"]);
});

describe("reads", () => {
  it("need costs:read", async () => {
    for (const path of ["/", "/options", `/${report.id}`, "/values?tagKey=team"]) {
      const res = await buildAppWithPermissions([]).request(path);
      expect(res.status).toBe(403);
    }
  });

  it("list the org's reports", async () => {
    const res = await buildApp().request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([report]);
    expect(mockList).toHaveBeenCalledWith("org-1");
  });

  it("404 a report the caller cannot see", async () => {
    mockGet.mockResolvedValue(null);
    expect((await buildApp().request(`/${report.id}`)).status).toBe(404);
  });

  it("need a tag key for values", async () => {
    expect((await buildApp().request("/values")).status).toBe(400);
    const res = await buildApp().request("/values?tagKey=namespace");
    expect(await res.json()).toEqual({ values: ["payments"] });
    expect(mockValues).toHaveBeenCalledWith("org-1", "namespace");
  });
});

describe("POST /", () => {
  it("rejects a costs:read-only caller", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/", {
      method: "POST",
      body: JSON.stringify({ name: "x", config }),
    });
    expect(res.status).toBe(403);
  });

  it("refuses a label grouping without a label key, and writes nothing", async () => {
    const res = await buildApp().request("/", {
      method: "POST",
      body: JSON.stringify({ name: "x", config: { ...config, groupBy: "label" } }),
    });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("refuses a filter on a dimension the report does not read", async () => {
    const res = await buildApp().request("/", {
      method: "POST",
      body: JSON.stringify({
        name: "x",
        config: { ...config, filters: [{ dimension: "service", op: "in", values: ["a"] }] },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("creates, records the creator and audits", async () => {
    const res = await buildApp().request("/", {
      method: "POST",
      body: JSON.stringify({ name: "Payments efficiency", config }),
    });
    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ name: "Payments efficiency" }),
      "user-1",
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "kubernetes_efficiency_report.create" }),
    );
  });

  it("maps a bad folder to 400", async () => {
    mockCreate.mockRejectedValue(new FakeCostReportFolderError("Folder not found"));
    const res = await buildApp().request("/", {
      method: "POST",
      body: JSON.stringify({ name: "x", config, folderId: "nope" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("PUT and DELETE", () => {
  it("update and audit", async () => {
    const res = await buildApp().request(`/${report.id}`, {
      method: "PUT",
      body: JSON.stringify({ name: "Renamed", config }),
    });
    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "kubernetes_efficiency_report.update" }),
    );
  });

  it("delete, 404 when not the caller's", async () => {
    expect((await buildApp().request(`/${report.id}`, { method: "DELETE" })).status).toBe(200);
    mockSoftDelete.mockResolvedValue(false);
    expect((await buildApp().request(`/${report.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("need costs:write", async () => {
    const app = buildAppWithPermissions(["costs:read"]);
    expect((await app.request(`/${report.id}`, { method: "DELETE" })).status).toBe(403);
  });
});

describe("running", () => {
  it("runs a saved report", async () => {
    const res = await buildApp().request(`/${report.id}/run`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { currencies: unknown[] } };
    expect(body.result.currencies).toHaveLength(1);
  });

  it("previews an unsaved config, validated first", async () => {
    const bad = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ config: { ...config, granularity: "hour" } }),
    });
    expect(bad.status).toBe(400);
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ config }),
    });
    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ groupBy: "workload" }),
    );
  });
});

describe("GET /:id/export", () => {
  it("writes CSV as an attachment", async () => {
    const res = await buildApp().request(`/${report.id}/export?perPeriod=true`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain(
      "payments-efficiency-2026-10-12-2026-10-16.csv",
    );
    const text = await res.text();
    expect(text.split("\r\n")[0]).toMatch(/^currency,period,group/);
    expect(text).toContain("USD,2026-10-12,payments/Deployment/api,group,,10,6,4,");
  });

  it("writes NDJSON, one record per line", async () => {
    const res = await buildApp().request(`/${report.id}/export?format=ndjson`);
    expect(res.headers.get("Content-Type")).toContain("ndjson");
    const lines = (await res.text()).trim().split("\n");
    expect(JSON.parse(lines[0]!)).toMatchObject({ group: "payments/Deployment/api", total: 10 });
  });

  it("refuses an unknown format", async () => {
    expect((await buildApp().request(`/${report.id}/export?format=xlsx`)).status).toBe(400);
  });
});
