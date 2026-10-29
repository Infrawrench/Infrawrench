import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const mockAuth = vi.fn();
vi.mock("@/auth/api-auth", () => ({
  authenticateApiRequest: (...a: unknown[]) => mockAuth(...a),
}));

const { whoamiRoutes } = await import("@/api/routes/whoami");

function buildApp() {
  const app = new Hono();
  app.route("/api/v1/whoami", whoamiRoutes);
  return app;
}

describe("GET /api/v1/whoami", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 for an unknown credential", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await buildApp().request("/api/v1/whoami", {
      headers: { authorization: "Bearer iwk_nope" },
    });
    expect(res.status).toBe(401);
  });

  it.each([
    [{ userId: "user_1", organizationId: "org-1" }, "user"],
    [{ userId: "user_1", organizationId: "org-1", apiKeyId: "key-1", scopes: [] }, "api_key"],
    // An agent's scopes are final and empty here; it is still identified.
    [{ userId: "u-agent", organizationId: "org-1", agentRegistrationId: "reg-1" }, "agent"],
  ])("identifies %o as %s", async (auth, principal) => {
    mockAuth.mockResolvedValue(auth);
    const res = await buildApp().request("/api/v1/whoami", {
      headers: { authorization: "Bearer token" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: auth.userId,
      organizationId: auth.organizationId,
      principal,
    });
  });
});
