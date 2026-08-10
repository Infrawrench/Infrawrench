import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

// The service is mocked rather than exercised, matching cost-reports.test.ts:
// it reaches the Drizzle client, which throws at import time without
// DATABASE_URL. These tests are about the transport contract — permissions,
// validation, status codes, error mapping, audit. The tree rules themselves
// (cycle rejection, the depth limit) are pure logic in client-core's
// `costReportFolderMoveBlocker`, tested exhaustively there; here we prove the
// route turns that rejection into the 400 a client sees.
const mockList = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

class FakeCostReportFolderError extends Error {}
vi.mock("../../../services/cost-report-folders", () => ({
  CostReportFolderError: FakeCostReportFolderError,
  listCostReportFolders: (...args: unknown[]) => mockList(...args),
  createCostReportFolder: (...args: unknown[]) => mockCreate(...args),
  updateCostReportFolder: (...args: unknown[]) => mockUpdate(...args),
  deleteCostReportFolder: (...args: unknown[]) => mockDelete(...args),
}));

const mockLogAudit = vi.fn();
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { costReportFolderRoutes } = await import("@/api/routes/cost-report-folders");

const buildApp = () => buildTestApp(costReportFolderRoutes);
const buildAppWithPermissions = (permissions: string[]) =>
  buildTestApp(costReportFolderRoutes, permissions);

const folder = {
  id: "folder-1",
  name: "Finance",
  parentFolderId: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue([folder]);
  mockCreate.mockResolvedValue(folder);
  mockUpdate.mockResolvedValue(folder);
  mockDelete.mockResolvedValue(true);
});

describe("GET /", () => {
  it("rejects without costs:read", async () => {
    const res = await buildAppWithPermissions([]).request("/");
    expect(res.status).toBe(403);
  });

  it("lists the org's folders", async () => {
    const res = await buildApp().request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([folder]);
    expect(mockList).toHaveBeenCalledWith("org-1");
  });
});

describe("POST /", () => {
  const body = JSON.stringify({ name: "Finance", parentFolderId: null });

  it("rejects a costs:read-only caller", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/", {
      method: "POST",
      body,
    });
    expect(res.status).toBe(403);
  });

  it("rejects an empty name without writing", async () => {
    const res = await buildApp().request("/", {
      method: "POST",
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("maps a depth-limit rejection onto 400 rather than a 500", async () => {
    mockCreate.mockRejectedValue(
      new FakeCostReportFolderError("Folders can be nested at most 3 levels deep."),
    );
    const res = await buildApp().request("/", { method: "POST", body });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Folders can be nested at most 3 levels deep." });
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("creates and audits", async () => {
    const res = await buildApp().request("/", { method: "POST", body });
    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith("org-1", expect.objectContaining({ name: "Finance" }));
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "cost_report_folder.create",
        entityType: "cost_report_folder",
      }),
    );
  });
});

describe("PUT /:id", () => {
  const body = JSON.stringify({ name: "Finance", parentFolderId: "folder-2" });

  it("rejects a costs:read-only caller", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/folder-1", {
      method: "PUT",
      body,
    });
    expect(res.status).toBe(403);
  });

  it("404s an unknown folder without auditing", async () => {
    mockUpdate.mockResolvedValue(null);
    const res = await buildApp().request("/folder-1", { method: "PUT", body });
    expect(res.status).toBe(404);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("rejects reparenting a folder under its own descendant with a clear 400", async () => {
    // The service raises when the requested parent sits inside the folder's
    // own subtree — the write that would make parent_folder_id cyclic.
    mockUpdate.mockRejectedValue(
      new FakeCostReportFolderError(
        "A folder cannot be moved inside itself or one of its subfolders.",
      ),
    );
    const res = await buildApp().request("/folder-1", { method: "PUT", body });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "A folder cannot be moved inside itself or one of its subfolders.",
    });
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("updates and audits", async () => {
    const res = await buildApp().request("/folder-1", { method: "PUT", body });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      "org-1",
      "folder-1",
      expect.objectContaining({ name: "Finance", parentFolderId: "folder-2" }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_report_folder.update", entityId: "folder-1" }),
    );
  });
});

describe("DELETE /:id", () => {
  it("rejects a costs:read-only caller", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/folder-1", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });

  it("404s an unknown folder without auditing", async () => {
    mockDelete.mockResolvedValue(false);
    const res = await buildApp().request("/folder-1", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("deletes and audits", async () => {
    const res = await buildApp().request("/folder-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockDelete).toHaveBeenCalledWith("org-1", "folder-1");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_report_folder.delete", entityId: "folder-1" }),
    );
  });
});
