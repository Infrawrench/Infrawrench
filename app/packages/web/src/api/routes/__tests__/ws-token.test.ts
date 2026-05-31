import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthSession } from "@/api/auth-middleware";

const mockCreateWsToken = vi.fn();
vi.mock("@/services/ws-tokens", () => ({
  createWsToken: (...a: unknown[]) => mockCreateWsToken(...a),
}));

const { wsTokenRoutes } = await import("@/api/routes/ws-token");

function buildApp(permissions: string[]) {
  const app = new Hono();
  const session: AuthSession = { userId: "user-1", email: "test@example.com" };
  app.onError((err, c) => {
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
  app.route("/", wsTokenRoutes);
  return app;
}

describe("ws-token routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("issues a token when permitted", async () => {
    mockCreateWsToken.mockReturnValue("tok-abc");
    const res = await buildApp(["resources:execute"]).request("/", { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).token).toBe("tok-abc");
    expect(mockCreateWsToken).toHaveBeenCalledWith("user-1", "org-1");
  });

  it("returns 403 when the caller lacks resources:execute", async () => {
    const res = await buildApp(["resources:read"]).request("/", { method: "POST" });
    expect(res.status).toBe(403);
    expect(mockCreateWsToken).not.toHaveBeenCalled();
  });
});
