import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

// The change feed's transport contract around the revert (which has its own
// file): the hand-checked bodies and query, and the second permission cost
// per change needs. Nothing here reaches Postgres, ClickHouse or a provider.
vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@infrawrench/server-core/db/client", () => ({ db: {} }));
vi.mock("@/services/plugin-clients", () => ({ getClientForAccount: vi.fn() }));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));

const mockGetDrift = vi.fn();
const mockUpdateDrift = vi.fn();
vi.mock("@infrawrench/server-core/drift/settings", () => ({
  getDriftAlertSettings: (...a: unknown[]) => mockGetDrift(...a),
  updateDriftAlertSettings: (...a: unknown[]) => mockUpdateDrift(...a),
}));

const mockLoadImpacts = vi.fn();
vi.mock("@infrawrench/server-core/cost/change-impact-load", () => ({
  loadChangeCostImpacts: (...a: unknown[]) => mockLoadImpacts(...a),
}));

const { resourceChangesDomain } = await import("@/http/domains/resource-changes/index");

const basePath = "/api/org/org-1/changes";
const buildApp = (permissions?: string[]) =>
  buildTestApi(resourceChangesDomain, { basePath, ...(permissions ? { permissions } : {}) });

const settings = {
  organizationId: "org-1",
  notifyCreated: true,
  notifyUpdated: false,
  notifyDeleted: true,
  cooldownMinutes: 60,
  minChanges: 1,
  accountIds: [],
  lastNotifiedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDrift.mockResolvedValue(settings);
  mockUpdateDrift.mockResolvedValue(settings);
  mockLoadImpacts.mockResolvedValue([]);
});

describe("GET /", () => {
  it("refuses an unknown change kind with its own sentence", async () => {
    const res = await buildApp().request("/?kind=renamed");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unknown change kind "renamed"' });
  });

  it("needs resources:read", async () => {
    expect((await buildApp([]).request("/")).status).toBe(403);
  });
});

describe("GET /resource", () => {
  it("needs a resource id", async () => {
    const res = await buildApp().request("/resource");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "resourceId is required" });
  });
});

describe("drift alert settings", () => {
  const put = (body: unknown, permissions?: string[]) =>
    buildApp(permissions).request("/alert-settings", {
      method: "PUT",
      body: JSON.stringify(body),
    });

  it("reads the stored filter, stamped as ISO", async () => {
    mockGetDrift.mockResolvedValue({
      ...settings,
      lastNotifiedAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    const res = await buildApp().request("/alert-settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ lastNotifiedAt: "2026-10-01T00:00:00.000Z" });
  });

  it("need org:settings:write", async () => {
    expect((await buildApp(["resources:read"]).request("/alert-settings")).status).toBe(403);
    expect((await put({ notifyCreated: true }, ["resources:read"])).status).toBe(403);
  });

  it("refuse a field of the wrong type, naming it", async () => {
    const res = await put({ notifyCreated: "yes" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "notifyCreated must be a boolean" });
    expect(mockUpdateDrift).not.toHaveBeenCalled();
  });

  it("refuse an empty patch", async () => {
    const res = await put({});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No settings supplied" });
  });

  it("save a single toggle", async () => {
    const res = await put({ notifyUpdated: true });
    expect(res.status).toBe(200);
    expect(mockUpdateDrift).toHaveBeenCalledWith("org-1", { notifyUpdated: true });
  });

  it("answer a bound server-core refuses as a 400 with its sentence", async () => {
    mockUpdateDrift.mockRejectedValue(new Error("cooldownMinutes must be at least 5"));
    const res = await put({ cooldownMinutes: 1 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "cooldownMinutes must be at least 5" });
  });
});

describe("POST /cost-impacts", () => {
  const post = (body: unknown, permissions?: string[]) =>
    buildApp(permissions).request("/cost-impacts", {
      method: "POST",
      body: JSON.stringify(body),
    });

  it("needs resources:read on top of costs:read", async () => {
    const res = await post({ changeIds: [] }, ["costs:read"]);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Missing permission: resources:read" });
    expect((await post({ changeIds: [] }, ["resources:read"])).status).toBe(403);
    expect(mockLoadImpacts).not.toHaveBeenCalled();
  });

  it("refuses a body without a list of ids", async () => {
    const res = await post({ changeIds: "c1" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "changeIds must be an array of change ids" });
  });

  it("refuses an unknown cost basis", async () => {
    const res = await post({ changeIds: ["c1"], costBasis: "list" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "costBasis must be cash or amortized" });
  });

  it("passes the ids, the window and the basis through", async () => {
    const res = await post({ changeIds: ["c1", "c2"], windowDays: 14, costBasis: "amortized" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ impacts: [] });
    expect(mockLoadImpacts).toHaveBeenCalledWith("org-1", ["c1", "c2"], {
      windowDays: 14,
      costBasis: "amortized",
    });
  });
});
