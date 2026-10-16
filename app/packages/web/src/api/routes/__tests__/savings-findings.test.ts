import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SavingsFinding } from "@infrawrench/client-core";
import { buildTestApp } from "./test-utils";

// Services are mocked (they reach the Drizzle client, which throws at import
// without DATABASE_URL). These tests are about the transport contract:
// permissions, the GET's filter/view application, the status change's audit
// trail and 404, and the view CRUD's status codes. The lifecycle rules are
// pure and tested in server-core (`savings-findings.test.ts`), the filter and
// input rules in client-core.
const mockList = vi.fn();
vi.mock("../../../services/savings-findings", () => ({
  listSavingsFindings: (...args: unknown[]) => mockList(...args),
}));

const mockSetStatus = vi.fn();
vi.mock("@infrawrench/server-core/savings/findings", () => ({
  setFindingStatus: (...args: unknown[]) => mockSetStatus(...args),
}));

vi.mock("@infrawrench/server-core/cost/visibility-context", () => ({
  strictlyVisibleAccountIds: () => null,
}));

const mockViews = {
  list: vi.fn(),
  get: vi.fn(),
  find: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
};
class FakeNameConflictError extends Error {}
vi.mock("../../../services/savings-views", () => ({
  SavingsViewNameConflictError: FakeNameConflictError,
  listSavingsViews: (...a: unknown[]) => mockViews.list(...a),
  getSavingsView: (...a: unknown[]) => mockViews.get(...a),
  findSavingsView: (...a: unknown[]) => mockViews.find(...a),
  createSavingsView: (...a: unknown[]) => mockViews.create(...a),
  updateSavingsView: (...a: unknown[]) => mockViews.update(...a),
  deleteSavingsView: (...a: unknown[]) => mockViews.remove(...a),
}));

const mockLogAudit = vi.fn();
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { savingsFindingRoutes, savingsViewRoutes } = await import("@/api/routes/savings-findings");

function finding(over: Partial<SavingsFinding>): SavingsFinding {
  const kind = over.kind ?? "orphan";
  const sourceId = over.sourceId ?? "r1";
  return {
    key: `${kind}:${sourceId}`,
    kind,
    sourceId,
    title: sourceId,
    detail: null,
    pluginId: "aws",
    pluginName: "AWS",
    accountId: "a1",
    accountName: "Prod",
    region: "us-east-1",
    resourceId: sourceId,
    resourceName: sourceId,
    resourceTypeId: null,
    resourceTypeName: null,
    tags: {},
    monthlySavings: { amount: 10, currency: "USD" },
    status: "ready",
    statusChangedAt: null,
    statusChangedBy: null,
    statusNote: null,
    resolution: null,
    detectedAt: "2026-10-01T00:00:00.000Z",
    lastSeenAt: "2026-10-10T00:00:00.000Z",
    present: true,
    realizedSavings: null,
    ...over,
  };
}

const rows = [
  finding({ sourceId: "small", monthlySavings: { amount: 5, currency: "USD" } }),
  finding({ sourceId: "big", monthlySavings: { amount: 500, currency: "USD" } }),
  finding({ sourceId: "done", status: "completed" }),
  finding({ sourceId: "seat", kind: "seat", resourceId: null }),
];

const view = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Big waste",
  description: null,
  status: "open",
  filter: { minMonthlySavings: 100 },
  sort: { field: "savings", direction: "desc" },
  createdByUserId: "user-1",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue({
    findings: rows,
    summary: { counts: { ready: 3, in_progress: 0, completed: 1, archived: 0 } },
    unavailable: [],
    generatedAt: "2026-10-10T00:00:00.000Z",
  });
  mockViews.find.mockResolvedValue(view);
  mockViews.list.mockResolvedValue([view]);
  mockViews.get.mockResolvedValue(view);
  mockViews.create.mockResolvedValue(view);
  mockViews.update.mockResolvedValue(view);
  mockViews.remove.mockResolvedValue(true);
});

describe("GET /savings/findings", () => {
  it("needs resources:read", async () => {
    const res = await buildTestApp(savingsFindingRoutes, []).request("/");
    expect(res.status).toBe(403);
  });

  it("filters and sorts, leaving the summary org-wide", async () => {
    const res = await buildTestApp(savingsFindingRoutes).request(
      "/?status=open&kind=orphan&sort=savings:asc",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { findings: SavingsFinding[]; summary: unknown };
    expect(body.findings.map((f) => f.sourceId)).toEqual(["small", "big"]);
    expect(body.summary).toEqual({
      counts: { ready: 3, in_progress: 0, completed: 1, archived: 0 },
    });
  });

  it("passes costs:read through, so orphan money is withheld without it", async () => {
    await buildTestApp(savingsFindingRoutes, ["resources:read"]).request("/");
    expect(mockList).toHaveBeenCalledWith("org-1", { canReadCosts: false, refresh: false });
  });

  it("applies a saved view, with explicit params overriding it", async () => {
    const res = await buildTestApp(savingsFindingRoutes).request("/?view=Big%20waste");
    const body = (await res.json()) as { findings: SavingsFinding[] };
    expect(mockViews.find).toHaveBeenCalledWith("org-1", "Big waste");
    expect(body.findings.map((f) => f.sourceId)).toEqual(["big"]);

    const all = await buildTestApp(savingsFindingRoutes).request(
      "/?view=Big%20waste&status=all&minSavings=1",
    );
    const allBody = (await all.json()) as { findings: SavingsFinding[] };
    expect(allBody.findings.map((f) => f.sourceId)).toEqual(["big", "done", "seat", "small"]);
  });

  it("404s an unknown view and 400s a bad status", async () => {
    mockViews.find.mockResolvedValue(null);
    expect((await buildTestApp(savingsFindingRoutes).request("/?view=nope")).status).toBe(404);
    expect((await buildTestApp(savingsFindingRoutes).request("/?status=done")).status).toBe(400);
  });
});

describe("POST /savings/findings/status", () => {
  const post = (body: unknown, permissions?: string[]) =>
    buildTestApp(savingsFindingRoutes, permissions).request("/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("needs resources:write", async () => {
    const res = await post({ keys: ["orphan:a"], status: "archived" }, ["resources:read"]);
    expect(res.status).toBe(403);
  });

  it("rejects a bad body", async () => {
    expect((await post({ keys: ["nope"], status: "archived" })).status).toBe(400);
    expect((await post({ keys: ["orphan:a"], status: "gone" })).status).toBe(400);
  });

  it("changes status and audits each finding", async () => {
    const at = "2026-10-11T00:00:00.000Z";
    mockSetStatus.mockResolvedValue({
      updated: ["orphan:a", "orphan:b"].map((key) => ({
        key,
        status: "in_progress",
        statusChangedAt: at,
        statusChangedBy: { userId: "user-1", name: "Ada" },
        statusNote: "on it",
        resolution: null,
      })),
      missing: ["seat:x"],
      previous: new Map([
        ["orphan:a", "ready"],
        ["orphan:b", "archived"],
      ]),
      findings: new Map(),
    });
    const res = await post({
      keys: ["orphan:a", "orphan:b", "seat:x"],
      status: "in_progress",
      note: "on it",
    });
    expect(res.status).toBe(200);
    expect(mockSetStatus).toHaveBeenCalledWith(
      "org-1",
      { keys: ["orphan:a", "orphan:b", "seat:x"], status: "in_progress", note: "on it" },
      { userId: "user-1" },
      null,
      expect.any(Object),
    );
    const body = (await res.json()) as { missing: string[] };
    expect(body.missing).toEqual(["seat:x"]);
    expect(mockLogAudit).toHaveBeenCalledTimes(2);
    expect(mockLogAudit.mock.calls[1]![0]).toMatchObject({
      action: "savings_finding.status_changed",
      entityType: "savings_finding",
      entityId: "orphan:b",
      metadata: { from: "archived", to: "in_progress", note: "on it", bulk: true },
    });
  });

  it("404s when nothing matched", async () => {
    mockSetStatus.mockResolvedValue({
      updated: [],
      missing: ["orphan:a"],
      previous: new Map(),
      findings: new Map(),
    });
    const res = await post({ keys: ["orphan:a"], status: "archived" });
    expect(res.status).toBe(404);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

describe("/savings-views", () => {
  const send = (method: string, path: string, body?: unknown, permissions?: string[]) =>
    buildTestApp(savingsViewRoutes, permissions).request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("lists with resources:read and refuses writes without resources:write", async () => {
    expect((await send("GET", "/", undefined, ["resources:read"])).status).toBe(200);
    expect((await send("POST", "/", { name: "x" }, ["resources:read"])).status).toBe(403);
  });

  it("creates with a normalized body and audits it", async () => {
    const res = await send("POST", "/", {
      name: "  Big waste ",
      filter: { minMonthlySavings: 100 },
    });
    expect(res.status).toBe(200);
    expect(mockViews.create).toHaveBeenCalledWith(
      "org-1",
      {
        name: "Big waste",
        description: null,
        status: "open",
        filter: { minMonthlySavings: 100 },
        sort: { field: "savings", direction: "desc" },
      },
      "user-1",
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "savings_view.create" }),
    );
  });

  it("maps a name conflict to 409 and a bad filter to 400", async () => {
    mockViews.create.mockRejectedValue(new FakeNameConflictError("taken"));
    expect((await send("POST", "/", { name: "Big waste" })).status).toBe(409);
    expect((await send("POST", "/", { name: "x", filter: { colour: "red" } })).status).toBe(400);
  });

  it("404s an invisible view on read, update and delete", async () => {
    mockViews.get.mockResolvedValue(null);
    mockViews.update.mockResolvedValue(null);
    mockViews.remove.mockResolvedValue(false);
    expect((await send("GET", `/${view.id}`)).status).toBe(404);
    expect((await send("PUT", `/${view.id}`, { name: "x" })).status).toBe(404);
    expect((await send("DELETE", `/${view.id}`)).status).toBe(404);
  });
});
