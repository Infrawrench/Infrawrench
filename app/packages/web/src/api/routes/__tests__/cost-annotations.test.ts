import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

// The service is mocked rather than exercised: it reaches the Drizzle client,
// which throws at import time without DATABASE_URL. These tests own the
// transport contract — permissions, validation, status codes, audit.
const mockList = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

class FakeCostAnnotationError extends Error {}
vi.mock("../../../services/cost-annotations", () => ({
  CostAnnotationError: FakeCostAnnotationError,
  listCostAnnotations: (...args: unknown[]) => mockList(...args),
  createCostAnnotation: (...args: unknown[]) => mockCreate(...args),
  updateCostAnnotation: (...args: unknown[]) => mockUpdate(...args),
  deleteCostAnnotation: (...args: unknown[]) => mockDelete(...args),
}));

const mockLogAudit = vi.fn();
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { costAnnotationRoutes } = await import("@/api/routes/cost-annotations");

const buildApp = () => buildTestApp(costAnnotationRoutes);
const buildAppWithPermissions = (permissions: string[]) =>
  buildTestApp(costAnnotationRoutes, permissions);

const annotation = {
  id: "ann-1",
  startDate: "2026-07-15",
  endDate: null,
  text: "Migrated the API fleet to Graviton",
  costReportId: null,
  createdByUserId: "user-1",
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:00.000Z",
  // Null for a note somebody wrote by hand; set when the note was minted by
  // acknowledging an anomaly, which is the reverse of that link.
  costAnomalyId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue([annotation]);
  mockCreate.mockResolvedValue(annotation);
  mockUpdate.mockResolvedValue(annotation);
  mockDelete.mockResolvedValue(true);
});

describe("GET /", () => {
  it("rejects without costs:read", async () => {
    expect((await buildAppWithPermissions([]).request("/")).status).toBe(403);
  });

  it("lists every annotation in the org when no report is named", async () => {
    const res = await buildApp().request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ annotations: [annotation] });
    expect(mockList).toHaveBeenCalledWith("org-1", {});
  });

  it("scopes to a report when one is named", async () => {
    await buildApp().request("/?reportId=report-1");
    expect(mockList).toHaveBeenCalledWith("org-1", { reportId: "report-1" });
  });
});

describe("POST /", () => {
  const body = JSON.stringify({ startDate: "2026-07-15", text: "Graviton" });

  it("rejects a costs:read-only caller", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/", {
      method: "POST",
      body,
    });
    expect(res.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("creates and audits", async () => {
    const res = await buildApp().request("/", { method: "POST", body });
    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith(
      "org-1",
      { startDate: "2026-07-15", text: "Graviton" },
      "user-1",
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_annotation.create", entityId: "ann-1" }),
    );
  });

  it("rejects a malformed date and an empty note without writing", async () => {
    const bad = await buildApp().request("/", {
      method: "POST",
      body: JSON.stringify({ startDate: "July 15", text: "x" }),
    });
    expect(bad.status).toBe(400);

    const empty = await buildApp().request("/", {
      method: "POST",
      body: JSON.stringify({ startDate: "2026-07-15", text: "" }),
    });
    expect(empty.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("maps a service rejection to a 400 rather than a 500", async () => {
    // A backwards span or a report id from another org.
    mockCreate.mockRejectedValue(new FakeCostAnnotationError("Unknown cost report."));
    const res = await buildApp().request("/", { method: "POST", body });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown cost report." });
  });
});

describe("PUT /:id", () => {
  const body = JSON.stringify({
    startDate: "2026-07-15",
    endDate: "2026-07-22",
    text: "Migration week",
    costReportId: "report-1",
  });

  it("rejects a costs:read-only caller", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/ann-1", {
      method: "PUT",
      body,
    });
    expect(res.status).toBe(403);
  });

  it("404s when the annotation is not the org's", async () => {
    mockUpdate.mockResolvedValue(null);
    const res = await buildApp().request("/ann-1", { method: "PUT", body });
    expect(res.status).toBe(404);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("updates and audits", async () => {
    const res = await buildApp().request("/ann-1", { method: "PUT", body });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith("org-1", "ann-1", {
      startDate: "2026-07-15",
      endDate: "2026-07-22",
      text: "Migration week",
      costReportId: "report-1",
    });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_annotation.update" }),
    );
  });
});

describe("DELETE /:id", () => {
  it("rejects a costs:read-only caller", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/ann-1", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("404s when nothing was deleted, and audits when something was", async () => {
    mockDelete.mockResolvedValue(false);
    expect((await buildApp().request("/ann-1", { method: "DELETE" })).status).toBe(404);
    expect(mockLogAudit).not.toHaveBeenCalled();

    mockDelete.mockResolvedValue(true);
    expect((await buildApp().request("/ann-1", { method: "DELETE" })).status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_annotation.delete", entityId: "ann-1" }),
    );
  });
});
