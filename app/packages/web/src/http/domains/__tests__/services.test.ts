import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

// The catalog store, lookup, summary and scorecard store reach Postgres;
// these tests are about the transport: the picked body and its sentences,
// the member routes and the change events.
class FakeServiceInputError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockGetRecord = vi.fn();
const mockRestore = vi.fn();
const mockRemove = vi.fn();
vi.mock("@infrawrench/server-core/service-catalog/store", () => ({
  ServiceInputError: FakeServiceInputError,
  addServiceMembers: vi.fn(async () => 1),
  createServiceRecord: (...a: unknown[]) => mockCreate(...a),
  deleteServiceRecord: vi.fn(),
  getServiceRecord: (...a: unknown[]) => mockGetRecord(...a),
  getServiceWire: vi.fn(async (_org: string, row: { id: string }) => ({
    service: { id: row.id },
    membership: { members: [], excluded: [] },
  })),
  listServicesWire: vi.fn(async () => []),
  removeServiceMember: (...a: unknown[]) => mockRemove(...a),
  restoreExcludedMember: (...a: unknown[]) => mockRestore(...a),
  updateServiceRecord: (...a: unknown[]) => mockUpdate(...a),
}));
const mockLookup = vi.fn();
vi.mock("@infrawrench/server-core/service-catalog/lookup", () => ({
  getServicesForResources: (...a: unknown[]) => mockLookup(...a),
}));
vi.mock("@infrawrench/server-core/service-catalog/summary", () => ({
  buildServiceSummary: vi.fn(),
}));
const mockPublish = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@infrawrench/server-core/service-catalog/events", () => ({
  publishServiceChanged: (...a: unknown[]) => mockPublish(...a),
}));
vi.mock("@infrawrench/server-core/scorecards/store", () => ({
  ensureDefaultScorecard: vi.fn(async () => undefined),
  listScorecardHistory: vi.fn(async () => ({})),
  listScorecardResults: vi.fn(async () => []),
  markScorecardsDue: vi.fn(async () => undefined),
}));
const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const { servicesDomain } = await import("@/http/domains/services/index");
const basePath = "/api/org/org-1/services";
const app = () => buildTestApi(servicesDomain, { basePath });

const row = { id: "svc-1", name: "Checkout", slug: "checkout", tier: 1 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("service routes", () => {
  it("creates a service from the picked fields, normalizing rules as the store does", async () => {
    mockCreate.mockResolvedValue(row);
    const res = await app().request("/", {
      method: "POST",
      body: JSON.stringify({
        name: "Checkout",
        slug: null,
        tier: 1,
        rules: [{ kind: "tag", key: " team ", value: 7, extra: true }],
      }),
    });
    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      "org-1",
      {
        name: "Checkout",
        tier: 1,
        rules: [
          {
            kind: "tag",
            key: "team",
            value: null,
            nameMatch: null,
            pluginId: null,
            accountId: null,
          },
        ],
      },
      "user-1",
    );
    expect(mockPublish).toHaveBeenCalledWith("org-1", row, "created");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "service.create" }),
    );
  });

  it("refuses a malformed field in the route's words", async () => {
    const tier = await app().request("/", {
      method: "POST",
      body: JSON.stringify({ name: "x", tier: 7 }),
    });
    expect(tier.status).toBe(400);
    expect(await tier.json()).toEqual({ error: "tier must be 1, 2, 3, 4 or null" });
    const links = await app().request("/svc-1", {
      method: "PATCH",
      body: JSON.stringify({ links: [{ label: "Docs" }] }),
    });
    expect(await links.json()).toEqual({ error: "links must be an array of { label, url }" });
    const empty = await app().request("/svc-1", { method: "PATCH", body: "{}" });
    expect(await empty.json()).toEqual({ error: "No changes supplied" });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("caps the resource lookup", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `r${i}`).join(",");
    const res = await app().request(`/for-resources?ids=${ids}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Ask about at most 500 resources at a time" });
    mockLookup.mockResolvedValue(new Map([["r1", [{ id: "svc-1" }]]]));
    const ok = await app().request("/for-resources?ids=r1,%20,r2");
    expect(await ok.json()).toEqual({ services: { r1: [{ id: "svc-1" }] } });
    expect(mockLookup).toHaveBeenCalledWith("org-1", ["r1", "r2"]);
  });

  it("answers an unknown service with its 404 sentence", async () => {
    mockGetRecord.mockResolvedValue(null);
    const res = await app().request("/nope/summary");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Service not found" });
  });

  it("removes a member, and restores an exclusion only with restore=1", async () => {
    mockGetRecord.mockResolvedValue(row);
    mockRemove.mockResolvedValue("excluded");
    const removed = await app().request("/svc-1/members/r1", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "service.members.exclude" }),
    );
    mockRestore.mockResolvedValue(false);
    const restore = await app().request("/svc-1/members/r1?restore=1", { method: "DELETE" });
    expect(restore.status).toBe(404);
    expect(await restore.json()).toEqual({
      error: "That resource is not excluded from this service",
    });
  });

  it("checks the service exists before reading the members body", async () => {
    mockGetRecord.mockResolvedValue(null);
    const res = await app().request("/nope/members", { method: "POST", body: "not json" });
    expect(res.status).toBe(404);
    mockGetRecord.mockResolvedValue(row);
    const bad = await app().request("/svc-1/members", {
      method: "POST",
      body: JSON.stringify({ resourceIds: "r1" }),
    });
    expect(await bad.json()).toEqual({ error: "resourceIds must be an array of resource ids" });
  });

  it("answers the store's refusal with its status", async () => {
    mockUpdate.mockRejectedValue(new FakeServiceInputError("That slug is taken", 409));
    const res = await app().request("/svc-1", {
      method: "PATCH",
      body: JSON.stringify({ slug: "taken" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "That slug is taken" });
  });
});
