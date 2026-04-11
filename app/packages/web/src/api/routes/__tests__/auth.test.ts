import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AuthSession } from "@/api/auth-middleware";

// ── Mocks ──────────────────────────────────────────────────────────────────
const mockGetAuthorizationUrl = vi.fn().mockReturnValue("https://workos.example.com/auth");

vi.mock("@/auth/workos", () => ({
  workos: {
    userManagement: {
      getAuthorizationUrl: (...args: unknown[]) => mockGetAuthorizationUrl(...args),
    },
  },
  clientId: "test-client-id",
}));

const { authRoutes } = await import("@/api/routes/auth");

// ── Helper ────────────────────────────────────────────────────────────────
function buildApp() {
  const app = new Hono();
  const session: AuthSession = {
    userId: "user-1",
    email: "test@example.com",
  };
  app.use("*", async (c, next) => {
    c.set("session", session);
    c.set("organizationId", "org-1");
    return next();
  });
  app.route("/", authRoutes);
  return app;
}

describe("Auth routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── GET /sign-in — redirect ───────────────────────────────────────────
  describe("GET /sign-in — redirect to WorkOS", () => {
    it("returns a redirect response", async () => {
      const app = buildApp();
      const res = await app.request("/sign-in", { method: "GET", redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("https://workos.example.com/auth");
    });

    it("passes provider authkit and clientId to WorkOS", async () => {
      const app = buildApp();
      await app.request("/sign-in", { method: "GET", redirect: "manual" });
      expect(mockGetAuthorizationUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "authkit",
          clientId: "test-client-id",
        }),
      );
    });
  });

  // ── GET /me — current user ────────────────────────────────────────────
  describe("GET /me — return current session", () => {
    it("returns the session as JSON", async () => {
      const app = buildApp();
      const res = await app.request("/me", { method: "GET" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        userId: "user-1",
        email: "test@example.com",
      });
    });
  });

  // ── POST /sign-out — clear session ────────────────────────────────────
  describe("POST /sign-out — clear session cookie", () => {
    it("returns ok and sets a cookie deletion header", async () => {
      const app = buildApp();
      const res = await app.request("/sign-out", { method: "POST" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);

      // Hono's deleteCookie sets a Set-Cookie with Max-Age=0
      const setCookie = res.headers.get("Set-Cookie");
      expect(setCookie).toContain("wos-session");
    });
  });
});
