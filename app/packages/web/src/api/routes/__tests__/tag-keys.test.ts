import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthSession } from "@/api/auth-middleware";

const mockGetSettings = vi.fn();
const mockSetSettings = vi.fn();
const mockDiscover = vi.fn();
const mockLogAudit = vi.fn();

// The real modules reach server-core's db client at import time, which needs
// DATABASE_URL: stub them at the boundary like costs.test.ts does.
vi.mock("@infrawrench/server-core/cost/tag-key-settings", () => ({
  getOrgTagKeySettings: (...args: unknown[]) => mockGetSettings(...args),
  setOrgTagKeySettings: (...args: unknown[]) => mockSetSettings(...args),
}));
vi.mock("../../../services/tag-keys", () => ({
  discoverTagKeys: (...args: unknown[]) => mockDiscover(...args),
}));
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { tagKeyRoutes } = await import("@/api/routes/tag-keys");

function buildApp(permissions: string[]): Hono {
  const app = new Hono();
  const session: AuthSession = { userId: "user-1", email: "test@example.com" };
  app.onError((err) => {
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
  app.route("/", tagKeyRoutes);
  return app;
}

const put = (body: unknown) => ({
  method: "PUT",
  body: JSON.stringify(body),
  headers: { "Content-Type": "application/json" },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSettings.mockResolvedValue({ hidden: [], preferred: [] });
  mockSetSettings.mockImplementation((_org: string, s: unknown) => Promise.resolve(s));
  mockDiscover.mockResolvedValue({ keys: [], settings: { hidden: [], preferred: [] } });
});

describe("GET /tag-keys", () => {
  it("needs resources:read", async () => {
    const res = await buildApp(["costs:read"]).request("/");
    expect(res.status).toBe(403);
  });

  it("includes cost usage only for callers who can read costs", async () => {
    await buildApp(["resources:read"]).request("/");
    expect(mockDiscover).toHaveBeenLastCalledWith("org-1", { includeCosts: false });
    await buildApp(["resources:read", "costs:read"]).request("/");
    expect(mockDiscover).toHaveBeenLastCalledWith("org-1", { includeCosts: true });
  });
});

describe("GET /tag-keys/settings", () => {
  it("returns the stored settings", async () => {
    mockGetSettings.mockResolvedValue({ hidden: ["aws:*"], preferred: ["team"] });
    const res = await buildApp(["resources:read"]).request("/settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hidden: ["aws:*"], preferred: ["team"] });
  });
});

describe("PUT /tag-keys/settings", () => {
  it("needs org:settings:write", async () => {
    const res = await buildApp(["resources:read"]).request(
      "/settings",
      put({ hidden: [], preferred: [] }),
    );
    expect(res.status).toBe(403);
    expect(mockSetSettings).not.toHaveBeenCalled();
  });

  it("saves trimmed lists and audits the change", async () => {
    const res = await buildApp(["org:settings:write"]).request(
      "/settings",
      put({ hidden: [" aws:cloudformation:* "], preferred: ["team"] }),
    );
    expect(res.status).toBe(200);
    expect(mockSetSettings).toHaveBeenCalledWith("org-1", {
      hidden: ["aws:cloudformation:*"],
      preferred: ["team"],
    });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "tag_key_settings.update", entityId: "org-1" }),
    );
  });

  it("rejects a lone star and inner stars", async () => {
    for (const hidden of [["*"], ["aws:*:id"]]) {
      const res = await buildApp(["org:settings:write"]).request(
        "/settings",
        put({ hidden, preferred: [] }),
      );
      expect(res.status).toBe(400);
    }
    expect(mockSetSettings).not.toHaveBeenCalled();
  });

  it("rejects a key that is both hidden and preferred", async () => {
    const res = await buildApp(["org:settings:write"]).request(
      "/settings",
      put({ hidden: ["team"], preferred: ["team"] }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/both hidden and preferred/);
  });

  it("rejects a document missing a list rather than clearing it", async () => {
    const res = await buildApp(["org:settings:write"]).request(
      "/settings",
      put({ hidden: ["aws:*"] }),
    );
    expect(res.status).toBe(400);
  });
});
