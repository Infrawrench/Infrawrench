import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { DEFAULT_RESOURCE_REPORT_CONFIG } from "@infrawrench/client-core";
import type { AuthSession } from "@/api/auth-middleware";

// The service is mocked: it reaches the Drizzle client and ClickHouse. These
// tests own the transport contract: permissions, validation, the costs:read
// hand-off, status codes and audit.
const mockList = vi.fn();
const mockGet = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockSoftDelete = vi.fn();
const mockRun = vi.fn();
const mockCsv = vi.fn();
const mockOptions = vi.fn();
const mockTagValues = vi.fn();
const mockFolders = vi.fn();

class FakeResourceReportError extends Error {}
class FakeVirtualTagUnresolvedError extends Error {}
vi.mock("../../../services/resource-reports", () => ({
  listResourceReports: (...args: unknown[]) => mockList(...args),
  getResourceReport: (...args: unknown[]) => mockGet(...args),
  createResourceReport: (...args: unknown[]) => mockCreate(...args),
  updateResourceReport: (...args: unknown[]) => mockUpdate(...args),
  softDeleteResourceReport: (...args: unknown[]) => mockSoftDelete(...args),
  runResourceReport: (...args: unknown[]) => mockRun(...args),
  resourceReportCsv: (...args: unknown[]) => mockCsv(...args),
  getResourceReportOptions: (...args: unknown[]) => mockOptions(...args),
  getResourceReportTagValues: (...args: unknown[]) => mockTagValues(...args),
  listResourceReportFolders: (...args: unknown[]) => mockFolders(...args),
  ResourceReportError: FakeResourceReportError,
  VirtualTagUnresolvedError: FakeVirtualTagUnresolvedError,
}));

class FakeCostReportFolderError extends Error {}
vi.mock("../../../services/cost-report-folders", () => ({
  CostReportFolderError: FakeCostReportFolderError,
}));

const mockLogAudit = vi.fn();
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { resourceReportRoutes } = await import("@/api/routes/resource-reports");

function buildApp(permissions: string[] = ["resources:read", "resources:write", "costs:read"]) {
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
  app.route("/", resourceReportRoutes);
  return app;
}

const config = DEFAULT_RESOURCE_REPORT_CONFIG;
const report = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Prod inventory",
  description: null,
  config,
  folderId: null,
  createdByUserId: "user-1",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const rows = {
  columns: [],
  rows: [],
  total: 0,
  offset: 0,
  limit: 50,
  truncated: false,
  sort: { column: "core:name", direction: "asc" },
  cost: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue([report]);
  mockGet.mockResolvedValue(report);
  mockCreate.mockResolvedValue(report);
  mockUpdate.mockResolvedValue(report);
  mockSoftDelete.mockResolvedValue(true);
  mockRun.mockResolvedValue(rows);
  mockCsv.mockResolvedValue("Name\r\nweb-1\r\n");
  mockOptions.mockResolvedValue({});
  mockTagValues.mockResolvedValue(["prod"]);
  mockFolders.mockResolvedValue([]);
});

describe("reads", () => {
  it("need resources:read", async () => {
    for (const path of ["/", "/folders", "/options", `/${report.id}`, `/${report.id}/rows`]) {
      const res = await buildApp([]).request(path);
      expect(res.status, path).toBe(403);
    }
  });

  it("lists the reports", async () => {
    const res = await buildApp().request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([report]);
    expect(mockList).toHaveBeenCalledWith("org-1");
  });

  it("404s a report the caller cannot see", async () => {
    mockGet.mockResolvedValue(null);
    expect((await buildApp().request(`/${report.id}`)).status).toBe(404);
    expect((await buildApp().request(`/${report.id}/rows`)).status).toBe(404);
    expect((await buildApp().request(`/${report.id}/csv`)).status).toBe(404);
  });

  it("passes the type narrowing and the costs:read flag to the options", async () => {
    await buildApp(["resources:read"]).request(
      "/options?types=aws/ec2-instance,bogus,gcp/gce-instance",
    );
    expect(mockOptions).toHaveBeenCalledWith("org-1", {
      types: [
        { pluginId: "aws", resourceTypeId: "ec2-instance" },
        { pluginId: "gcp", resourceTypeId: "gce-instance" },
      ],
      includeCosts: false,
    });
  });

  it("requires a key for tag values", async () => {
    expect((await buildApp().request("/tag-values")).status).toBe(400);
    const res = await buildApp().request("/tag-values?source=virtual_tag&key=team");
    expect(await res.json()).toEqual({ values: ["prod"] });
    expect(mockTagValues).toHaveBeenCalledWith("org-1", "virtual_tag", "team", true);
  });
});

describe("running", () => {
  it("runs a saved report with paging and a sort override", async () => {
    const res = await buildApp().request(
      `/${report.id}/rows?offset=50&limit=25&sort=cost:range&direction=desc`,
    );
    expect(res.status).toBe(200);
    expect(mockRun).toHaveBeenCalledWith("org-1", config, {
      offset: 50,
      limit: 25,
      sort: { column: "cost:range", direction: "desc" },
      includeCosts: true,
    });
  });

  it("refuses an unknown sort column", async () => {
    const res = await buildApp().request(`/${report.id}/rows?sort=bogus`);
    expect(res.status).toBe(400);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("runs cost columns empty for a caller without costs:read", async () => {
    await buildApp(["resources:read"]).request(`/${report.id}/rows`);
    expect(mockRun.mock.calls[0]![2]).toMatchObject({ includeCosts: false });
  });

  it("validates an ad-hoc query and maps run errors to 400", async () => {
    const bad = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ config: { ...config, columns: [] } }),
    });
    expect(bad.status).toBe(400);

    mockRun.mockRejectedValueOnce(new FakeResourceReportError("needs costs"));
    const refused = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ config, offset: 0, limit: 10 }),
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "needs costs" });
  });

  it("exports CSV as an attachment named after the report", async () => {
    const res = await buildApp().request(`/${report.id}/csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("content-disposition")).toMatch(/prod-inventory-\d{4}-\d{2}-\d{2}\.csv/);
    expect(await res.text()).toBe("Name\r\nweb-1\r\n");
  });
});

describe("writes", () => {
  const body = JSON.stringify({ name: "Prod inventory", config });

  it("need resources:write", async () => {
    const res = await buildApp(["resources:read"]).request("/", { method: "POST", body });
    expect(res.status).toBe(403);
  });

  it("refuse a config the shared rules refuse, without writing", async () => {
    const res = await buildApp().request("/", {
      method: "POST",
      body: JSON.stringify({
        name: "Bad",
        config: { ...config, columns: ["core:name", "core:name"] },
      }),
    });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("create, audit and answer 201", async () => {
    const res = await buildApp().request("/", { method: "POST", body });
    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ name: "Prod inventory" }),
      "user-1",
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "resource_report.create", entityType: "resource_report" }),
    );
  });

  it("map a bad folder to 400", async () => {
    mockCreate.mockRejectedValueOnce(new FakeCostReportFolderError("no such folder"));
    const res = await buildApp().request("/", { method: "POST", body });
    expect(res.status).toBe(400);
  });

  it("update and delete, 404 when missing", async () => {
    expect((await buildApp().request(`/${report.id}`, { method: "PUT", body })).status).toBe(200);
    mockUpdate.mockResolvedValueOnce(null);
    expect((await buildApp().request(`/${report.id}`, { method: "PUT", body })).status).toBe(404);
    expect((await buildApp().request(`/${report.id}`, { method: "DELETE" })).status).toBe(200);
    mockSoftDelete.mockResolvedValueOnce(false);
    expect((await buildApp().request(`/${report.id}`, { method: "DELETE" })).status).toBe(404);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "resource_report.delete" }),
    );
  });
});
