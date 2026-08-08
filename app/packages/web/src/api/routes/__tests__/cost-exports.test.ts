import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthSession } from "@/api/auth-middleware";
import { buildTestApp } from "./test-utils";

/**
 * Transport contract for cost exports. Three things this file owns:
 *
 *  - **the permission split**, which is the deliberate part of the design:
 *    reads are `costs:read`, but every write — including "run now" — is
 *    `org:settings:write`, because creating an export is standing
 *    authorisation to ship the org's billing history somewhere;
 *  - **that no response can carry a credential**, which is asserted by
 *    checking the serialised body rather than by trusting the view helper;
 *  - **audit coverage on all four mutations**.
 *
 * The store and the runner are mocked: both reach the Drizzle client, which
 * throws at import time without DATABASE_URL.
 */
const mockList = vi.fn();
const mockGet = vi.fn();
const mockGetRow = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockRun = vi.fn();

class FakeInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

vi.mock("@infrawrench/server-core/cost-exports/store", () => ({
  CostExportInputError: FakeInputError,
  listCostExports: (...a: unknown[]) => mockList(...a),
  getCostExport: (...a: unknown[]) => mockGet(...a),
  getCostExportRow: (...a: unknown[]) => mockGetRow(...a),
  createCostExport: (...a: unknown[]) => mockCreate(...a),
  updateCostExport: (...a: unknown[]) => mockUpdate(...a),
  deleteCostExport: (...a: unknown[]) => mockDelete(...a),
}));

vi.mock("@infrawrench/server-core/cost-exports/run", () => ({
  runCostExport: (...a: unknown[]) => mockRun(...a),
}));

const mockLogAudit = vi.fn();
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { costExportRoutes } = await import("@/api/routes/cost-exports");

const buildApp = () => buildTestApp(costExportRoutes);

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
  app.route("/", costExportRoutes);
  return app;
}

const query = {
  version: 1,
  dimensions: ["provider", "service"],
  tagKeys: ["team"],
  filters: [],
};

const destination = {
  kind: "s3",
  bucket: "finance",
  prefix: "warehouse",
  region: "eu-central-1",
  endpoint: "",
  forcePathStyle: false,
};

const validBody = {
  name: "Finance warehouse",
  format: "csv",
  query,
  cadence: "daily",
  hour: 4,
  timezone: "Europe/Berlin",
  restatementDays: 7,
  enabled: true,
  destination,
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "super-secret-key",
};

const exportView = {
  id: "exp-1",
  name: "Finance warehouse",
  format: "csv",
  query,
  cadence: "daily",
  hour: 4,
  timezone: "Europe/Berlin",
  restatementDays: 7,
  enabled: true,
  destination,
  hasCredentials: true,
  credentialHint: "AKIA…MPLE",
  lastRunAt: null,
  lastStatus: "pending",
  lastError: null,
  lastObjectCount: null,
  lastRowCount: null,
  nextRunAt: "2026-08-09T02:00:00.000Z",
  createdByUserId: "user-1",
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue([exportView]);
  mockGet.mockResolvedValue(exportView);
  mockGetRow.mockResolvedValue({ id: "exp-1", organizationId: "org-1" });
  mockCreate.mockResolvedValue(exportView);
  mockUpdate.mockResolvedValue(exportView);
  mockDelete.mockResolvedValue(true);
  mockRun.mockResolvedValue({
    exportId: "exp-1",
    status: "succeeded",
    objects: [],
    rowCount: 0,
    collectionWatermark: "2026-08-06",
    error: null,
  });
});

describe("GET /", () => {
  it("rejects without costs:read", async () => {
    expect((await buildAppWithPermissions([]).request("/")).status).toBe(403);
  });

  it("lists for a costs:read caller", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/");
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith("org-1");
  });

  it("never puts a credential on the wire", async () => {
    const res = await buildApp().request("/");
    const text = await res.text();
    expect(text).toContain("AKIA…MPLE");
    expect(text).not.toContain("super-secret-key");
    expect(text).not.toContain("encryptedCredentials");
    expect(text).not.toContain("credentialsIv");
  });
});

describe("POST /", () => {
  const body = JSON.stringify(validBody);

  it("rejects a costs:write caller — writing is org:settings:write", async () => {
    const res = await buildAppWithPermissions(["costs:read", "costs:write"]).request("/", {
      method: "POST",
      body,
    });
    expect(res.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("accepts an org:settings:write caller", async () => {
    const res = await buildAppWithPermissions(["org:settings:write"]).request("/", {
      method: "POST",
      body,
    });
    expect(res.status).toBe(200);
  });

  it("rejects an out-of-range restatement window without writing", async () => {
    const res = await buildApp().request("/", {
      method: "POST",
      body: JSON.stringify({ ...validBody, restatementDays: 400 }),
    });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects an unknown cadence", async () => {
    const res = await buildApp().request("/", {
      method: "POST",
      body: JSON.stringify({ ...validBody, cadence: "hourly" }),
    });
    expect(res.status).toBe(400);
  });

  it("maps a store validation failure onto 400 with its message", async () => {
    mockCreate.mockRejectedValue(new FakeInputError("destination.bucket is required"));
    const res = await buildApp().request("/", { method: "POST", body });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "destination.bucket is required" });
  });

  it("audits the destination but never the credential", async () => {
    const res = await buildApp().request("/", { method: "POST", body });
    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_export.create", entityType: "cost_export" }),
    );
    const logged = JSON.stringify(mockLogAudit.mock.calls[0]![0]);
    expect(logged).toContain("finance/warehouse");
    expect(logged).not.toContain("super-secret-key");
    expect(logged).not.toContain("AKIAEXAMPLE");
  });
});

describe("PUT /:id", () => {
  const body = JSON.stringify({ ...validBody, accessKeyId: undefined, secretAccessKey: undefined });

  it("rejects a costs:write caller", async () => {
    const res = await buildAppWithPermissions(["costs:write"]).request("/exp-1", {
      method: "PUT",
      body,
    });
    expect(res.status).toBe(403);
  });

  it("404s an unknown export without auditing", async () => {
    mockUpdate.mockResolvedValue(null);
    const res = await buildApp().request("/exp-1", { method: "PUT", body });
    expect(res.status).toBe(404);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("passes an omitted credential straight through as 'keep the stored one'", async () => {
    const res = await buildApp().request("/exp-1", { method: "PUT", body });
    expect(res.status).toBe(200);
    const [, , input] = mockUpdate.mock.calls[0]!;
    expect(input).not.toHaveProperty("accessKeyId");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "cost_export.update",
        metadata: expect.objectContaining({ credentialChanged: false }),
      }),
    );
  });

  it("records that the credential changed when one is supplied", async () => {
    await buildApp().request("/exp-1", { method: "PUT", body: JSON.stringify(validBody) });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ credentialChanged: true }),
      }),
    );
  });
});

describe("DELETE /:id", () => {
  it("rejects a costs:write caller", async () => {
    const res = await buildAppWithPermissions(["costs:write"]).request("/exp-1", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });

  it("404s an unknown export without auditing", async () => {
    mockDelete.mockResolvedValue(false);
    const res = await buildApp().request("/exp-1", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("deletes and audits", async () => {
    const res = await buildApp().request("/exp-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_export.delete", entityId: "exp-1" }),
    );
  });
});

describe("POST /:id/run", () => {
  it("is a write, not a read — costs:read alone cannot trigger it", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/exp-1/run", {
      method: "POST",
    });
    expect(res.status).toBe(403);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("404s an unknown export", async () => {
    mockGetRow.mockResolvedValue(null);
    const res = await buildApp().request("/exp-1/run", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns the run result and audits it", async () => {
    const res = await buildApp().request("/exp-1/run", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "succeeded" });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "cost_export.run",
        metadata: expect.objectContaining({ status: "succeeded" }),
      }),
    );
  });

  it("answers 200 with the failure rather than an error status, so the UI can render it", async () => {
    mockRun.mockResolvedValue({
      exportId: "exp-1",
      status: "failed",
      objects: [],
      rowCount: 0,
      collectionWatermark: null,
      error: "S3 PUT failed (403): Access Denied",
    });
    const res = await buildApp().request("/exp-1/run", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "failed",
      error: "S3 PUT failed (403): Access Denied",
    });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ status: "failed" }) }),
    );
  });
});
