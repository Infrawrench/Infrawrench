import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

// The routes are transport-only; the store owns validation and persistence.
// Mock the store module and assert the routes' own responsibilities: body
// parsing, permission mapping, wire shaping and error translation.
const listLogWorkspaceQueries = vi.fn();
const createLogWorkspaceRecord = vi.fn();
const updateLogWorkspaceRecord = vi.fn();
const deleteLogWorkspaceRecord = vi.fn();

class MockInputError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "LogWorkspaceInputError";
  }
}

vi.mock("@infrawrench/server-core/log-workspaces/store", () => ({
  LogWorkspaceInputError: MockInputError,
  listLogWorkspaceQueries: (...a: unknown[]) => listLogWorkspaceQueries(...a),
  createLogWorkspaceRecord: (...a: unknown[]) => createLogWorkspaceRecord(...a),
  updateLogWorkspaceRecord: (...a: unknown[]) => updateLogWorkspaceRecord(...a),
  deleteLogWorkspaceRecord: (...a: unknown[]) => deleteLogWorkspaceRecord(...a),
  toWire: (row: Record<string, unknown>) => ({ ...row, wired: true }),
}));

const logAudit = vi.fn();
vi.mock("@/services/audit", () => ({
  logAudit: (...a: unknown[]) => logAudit(...a),
}));

// The discovery service imports the db client (which requires DATABASE_URL at
// module scope) — mock it at the boundary like the store.
const listLogCapableResources = vi.fn();
vi.mock("@/services/log-workspaces", () => ({
  listLogCapableResources: (...a: unknown[]) => listLogCapableResources(...a),
}));

const { logWorkspaceRoutes } = await import("@/api/routes/log-workspaces");
const buildApp = () => buildTestApp(logWorkspaceRoutes);

const selector = {
  resourceId: "res-1",
  accountId: "acc-1",
  pluginId: "kubernetes",
  resourceTypeId: "k8s-pod",
};

const record = {
  id: "q1",
  organizationId: "org-1",
  name: "prod errors",
  resources: [selector],
  search: "error",
  alertEnabled: false,
};

describe("log workspace routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /", () => {
    it("returns the org's saved queries", async () => {
      listLogWorkspaceQueries.mockResolvedValue({ queries: [{ id: "q1" }] });
      const res = await buildApp().request("/");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ queries: [{ id: "q1" }] });
      expect(listLogWorkspaceQueries).toHaveBeenCalledWith("org-1");
    });
  });

  describe("GET /resources", () => {
    it("returns the log-capable resource candidates", async () => {
      listLogCapableResources.mockResolvedValue({ resources: [selector] });
      const res = await buildApp().request("/resources");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ resources: [selector] });
      expect(listLogCapableResources).toHaveBeenCalledWith("org-1");
    });
  });

  describe("POST /", () => {
    it("creates a saved query, audits and returns 201", async () => {
      createLogWorkspaceRecord.mockResolvedValue(record);
      const res = await buildApp().request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "prod errors",
          resources: [selector],
          search: "error",
          alertEnabled: true,
        }),
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ id: "q1", wired: true });
      expect(createLogWorkspaceRecord).toHaveBeenCalledWith(
        "org-1",
        { name: "prod errors", resources: [selector], search: "error", alertEnabled: true },
        "user-1",
      );
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "log_workspace_query.create", entityId: "q1" }),
      );
    });

    it("400s on a missing name, non-array resources and incomplete selectors", async () => {
      const app = buildApp();
      const post = (body: unknown) =>
        app.request("/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      expect((await post({ resources: [selector], search: "" })).status).toBe(400);
      expect((await post({ name: "x", resources: "nope", search: "" })).status).toBe(400);
      expect((await post({ name: "x", resources: [{ resourceId: "r" }], search: "" })).status).toBe(
        400,
      );
      expect(createLogWorkspaceRecord).not.toHaveBeenCalled();
    });

    it("maps store input errors onto their HTTP status", async () => {
      createLogWorkspaceRecord.mockRejectedValue(new MockInputError("name taken", 409));
      const res = await buildApp().request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "dup", resources: [selector], search: "" }),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "name taken" });
    });
  });

  describe("PUT /:id", () => {
    it("applies a partial patch and audits", async () => {
      updateLogWorkspaceRecord.mockResolvedValue({ ...record, alertEnabled: true });
      const res = await buildApp().request("/q1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alertEnabled: true }),
      });
      expect(res.status).toBe(200);
      expect(updateLogWorkspaceRecord).toHaveBeenCalledWith("org-1", "q1", {
        alertEnabled: true,
      });
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "log_workspace_query.update" }),
      );
    });

    it("400s an empty patch and 404s an unknown id", async () => {
      const empty = await buildApp().request("/q1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(empty.status).toBe(400);

      updateLogWorkspaceRecord.mockRejectedValue(new MockInputError("Saved query not found", 404));
      const missing = await buildApp().request("/nope", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "renamed" }),
      });
      expect(missing.status).toBe(404);
    });
  });

  describe("DELETE /:id", () => {
    it("deletes, audits and returns 204", async () => {
      deleteLogWorkspaceRecord.mockResolvedValue(record);
      const res = await buildApp().request("/q1", { method: "DELETE" });
      expect(res.status).toBe(204);
      expect(deleteLogWorkspaceRecord).toHaveBeenCalledWith("org-1", "q1");
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "log_workspace_query.delete" }),
      );
    });
  });
});
