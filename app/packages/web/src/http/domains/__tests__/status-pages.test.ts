import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

// The store reaches Postgres; these tests are about the transport: the
// hand-picked bodies, the store's refusals, the routes' own sentences, and the
// public reader answering with no caller at all.
class FakeStatusPageInputError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}
const mockList = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockRotate = vi.fn();
const mockDelete = vi.fn();
const mockPublic = vi.fn();
vi.mock("@infrawrench/server-core/status-pages/store", () => ({
  StatusPageInputError: FakeStatusPageInputError,
  listStatusPages: (...a: unknown[]) => mockList(...a),
  createStatusPageRecord: (...a: unknown[]) => mockCreate(...a),
  updateStatusPageRecord: (...a: unknown[]) => mockUpdate(...a),
  rotateStatusPageSlugRecord: (...a: unknown[]) => mockRotate(...a),
  deleteStatusPageRecord: (...a: unknown[]) => mockDelete(...a),
  getPublicStatusPage: (...a: unknown[]) => mockPublic(...a),
}));
const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));

const { statusPagesDomain } = await import("@/http/domains/status-pages/index");
const app = (permissions?: string[]) =>
  buildTestApi(statusPagesDomain, {
    basePath: "/api/org/org-1/status-pages",
    ...(permissions ? { permissions } : {}),
  });

const page = {
  id: "sp1",
  slug: "abc123",
  title: "Acme status",
  description: null,
  published: false,
  showHistory: true,
  showUptime: true,
  supportUrl: null,
  components: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const publicPage = {
  title: "Acme status",
  description: null,
  state: "operational",
  summary: "All systems operational.",
  components: [],
  notices: [],
  supportUrl: null,
  showHistory: true,
  showUptime: true,
  historyDays: 90,
  generatedAt: "2026-11-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("status page management", () => {
  it("lists the org's pages behind resources:read", async () => {
    mockList.mockResolvedValue({ pages: [page] });
    const res = await app().request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pages: [page] });
    expect(mockList).toHaveBeenCalledWith("org-1");

    const denied = await app([]).request("/");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "Missing permission: resources:read" });
  });

  it("creates from the well-typed fields only, answering 201 and auditing", async () => {
    mockCreate.mockResolvedValue({ ...page, published: true });
    const res = await app().request("/", {
      method: "POST",
      body: JSON.stringify({
        title: "Acme status",
        description: null,
        published: true,
        showHistory: "yes",
        supportUrl: 42,
        components: [
          { probeId: "p1", label: null },
          { probeId: "p2", groupName: "API" },
        ],
      }),
    });
    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      "org-1",
      {
        title: "Acme status",
        description: null,
        published: true,
        components: [
          { probeId: "p1", label: null },
          { probeId: "p2", groupName: "API" },
        ],
      },
      "user-1",
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "status_page.create",
        entityId: "sp1",
        metadata: { title: "Acme status", published: true },
      }),
    );
  });

  it("refuses bodies in the route's own words", async () => {
    const noTitle = await app().request("/", { method: "POST", body: JSON.stringify({}) });
    expect(noTitle.status).toBe(400);
    expect(await noTitle.json()).toEqual({ error: "title is required" });

    const notObject = await app().request("/", { method: "POST", body: "[1]" });
    expect(await notObject.json()).toEqual({ error: "Request body must be an object" });

    const notJson = await app().request("/", { method: "POST", body: "{" });
    expect(await notJson.json()).toEqual({ error: "Invalid JSON body" });

    for (const [components, error] of [
      ["x", "components must be an array"],
      [[1], "Each component must be an object"],
      [[{ probeId: "" }], "Each component needs a probeId"],
      [[{ probeId: "p1", label: 1 }], "Component label must be a string"],
      [[{ probeId: "p1", groupName: true }], "Component groupName must be a string"],
    ] as const) {
      const res = await app().request("/sp1", {
        method: "PUT",
        body: JSON.stringify({ components }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("updates with the patch it was given and audits the publish state", async () => {
    mockUpdate.mockResolvedValue({ ...page, published: true });
    const res = await app().request("/sp1", {
      method: "PUT",
      body: JSON.stringify({ published: true, title: 3 }),
    });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith("org-1", "sp1", { published: true });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "status_page.update",
        metadata: { published: true, componentCount: 0 },
      }),
    );
  });

  it("answers the store's refusal with its status, anything else as the route's 500", async () => {
    mockRotate.mockRejectedValue(new FakeStatusPageInputError("Status page not found", 404));
    const missing = await app().request("/sp1/rotate-slug", { method: "POST" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Status page not found" });

    mockDelete.mockRejectedValue(new Error("connection reset"));
    const broken = await app().request("/sp1", { method: "DELETE" });
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({ error: "Status page operation failed" });
  });

  it("rotates the slug and deletes with 204, auditing both", async () => {
    mockRotate.mockResolvedValue({ ...page, slug: "new" });
    const rotated = await app().request("/sp1/rotate-slug", { method: "POST" });
    expect(rotated.status).toBe(200);
    expect((await rotated.json()).slug).toBe("new");

    mockDelete.mockResolvedValue(page);
    const removed = await app().request("/sp1", { method: "DELETE" });
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe("");
    expect(mockLogAudit.mock.calls.map(([entry]) => entry.action)).toEqual([
      "status_page.rotate_slug",
      "status_page.delete",
    ]);
  });

  it("gates writes on resources:write before reading the body", async () => {
    const res = await app(["resources:read"]).request("/", { method: "POST", body: "nope" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Missing permission: resources:write" });
  });
});

describe("GET /api/status/:slug", () => {
  const read = (slug: string) =>
    buildTestApi(statusPagesDomain, { permissions: [] }).request(`/api/status/${slug}`);

  it("answers a caller holding nothing, with a minute of public cache", async () => {
    mockPublic.mockResolvedValue(publicPage);
    const res = await read("abc123");
    expect(res.status).toBe(200);
    expect(mockPublic).toHaveBeenCalledWith("abc123");
    expect(await res.json()).toEqual(publicPage);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("answers an unknown or unpublished slug with an uncached 404", async () => {
    mockPublic.mockResolvedValue(null);
    const res = await read("nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Status page not found" });
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("answers a failed read with its own 500", async () => {
    mockPublic.mockRejectedValue(new Error("db down"));
    const res = await read("abc123");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Status page unavailable" });
  });
});
