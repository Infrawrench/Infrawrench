import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

// The service is mocked, matching cost-report-folders.test.ts: it reaches the
// Drizzle client, which throws at import time without DATABASE_URL. These
// tests are about the transport contract — permissions, status codes, and
// above all the deletion policy's wire shape: a referenced filter's DELETE is
// a 409 whose body carries the referents, never a success and never a silent
// detach. The input rules (filters XOR query, non-empty, tag keys) are pure
// logic in client-core's `resolveSavedCostFilterInput`, tested there.
const mockList = vi.fn();
const mockGet = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockReferents = vi.fn();

class FakeInUseError extends Error {
  constructor(readonly referents: unknown[]) {
    super("This saved filter is still referenced.");
  }
}
class FakeNameConflictError extends Error {}

vi.mock("../../../services/saved-cost-filters", () => ({
  SavedCostFilterInUseError: FakeInUseError,
  SavedCostFilterNameConflictError: FakeNameConflictError,
  listSavedCostFilters: (...args: unknown[]) => mockList(...args),
  getSavedCostFilter: (...args: unknown[]) => mockGet(...args),
  createSavedCostFilter: (...args: unknown[]) => mockCreate(...args),
  updateSavedCostFilter: (...args: unknown[]) => mockUpdate(...args),
  softDeleteSavedCostFilter: (...args: unknown[]) => mockDelete(...args),
  listSavedCostFilterReferents: (...args: unknown[]) => mockReferents(...args),
}));

const mockLogAudit = vi.fn();
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { savedFilterRoutes } = await import("@/api/routes/saved-filters");

const buildApp = () => buildTestApp(savedFilterRoutes);
const buildAppWithPermissions = (permissions: string[]) =>
  buildTestApp(savedFilterRoutes, permissions);

const filter = {
  id: "sf-1",
  name: "Prod only",
  description: null,
  filters: [{ dimension: "tag", op: "in", values: ["prod"], tagKey: "env" }],
  query: "tag['env'] = 'prod'",
  createdByUserId: "user-1",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const referents = [
  { kind: "budget", id: "b1", name: "Prod spend" },
  { kind: "cost_graph_widget", id: "w1", name: "Spend", dashboardId: "d1", dashboardName: "Main" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue([filter]);
  mockGet.mockResolvedValue(filter);
  mockCreate.mockResolvedValue(filter);
  mockUpdate.mockResolvedValue(filter);
  mockDelete.mockResolvedValue(true);
  mockReferents.mockResolvedValue(referents);
});

describe("GET /", () => {
  it("rejects without costs:read", async () => {
    const res = await buildAppWithPermissions([]).request("/");
    expect(res.status).toBe(403);
  });

  it("lists the org's saved filters", async () => {
    const res = await buildApp().request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([filter]);
    expect(mockList).toHaveBeenCalledWith("org-1");
  });
});

describe("POST /", () => {
  const body = JSON.stringify({ name: "Prod only", filters: filter.filters });

  it("rejects a costs:read-only caller", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/", {
      method: "POST",
      body,
    });
    expect(res.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("creates and audit-logs", async () => {
    const res = await buildApp().request("/", { method: "POST", body });
    expect(res.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ name: "Prod only" }),
      "user-1",
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "saved_cost_filter.create", entityId: "sf-1" }),
    );
  });

  it("maps a name conflict to a 409", async () => {
    mockCreate.mockRejectedValue(new FakeNameConflictError("taken"));
    const res = await buildApp().request("/", { method: "POST", body });
    expect(res.status).toBe(409);
  });

  it("maps a semantic input failure to a 400 with the message", async () => {
    mockCreate.mockRejectedValue(new Error("A saved filter needs at least one term"));
    const res = await buildApp().request("/", { method: "POST", body });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/at least one term/);
  });
});

describe("DELETE /:id", () => {
  it("refuses while referenced: 409 with the referents in the body", async () => {
    mockDelete.mockRejectedValue(new FakeInUseError(referents));
    const res = await buildApp().request("/sf-1", { method: "DELETE" });
    expect(res.status).toBe(409);
    const bodyJson = (await res.json()) as { error: string; referents: unknown[] };
    // The referents ARE the answer — the client names what must be detached.
    expect(bodyJson.referents).toEqual(referents);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("deletes an unreferenced filter and audit-logs", async () => {
    const res = await buildApp().request("/sf-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "saved_cost_filter.delete", entityId: "sf-1" }),
    );
  });

  it("404s an unknown id", async () => {
    mockDelete.mockResolvedValue(false);
    const res = await buildApp().request("/sf-1", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("GET /:id/referents", () => {
  it("answers with the referent list", async () => {
    const res = await buildApp().request("/sf-1/referents");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ referents });
  });

  it("404s when the filter itself is gone", async () => {
    mockGet.mockResolvedValue(null);
    const res = await buildApp().request("/sf-1/referents");
    expect(res.status).toBe(404);
  });
});
