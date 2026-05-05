import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AuthSession } from "@/api/auth-middleware";

const mockGetAuthorizationUrl = vi.fn().mockReturnValue("https://workos.example.com/auth");
const mockSelect = vi.fn();

vi.mock("@/auth/workos", () => ({
  workos: {
    userManagement: {
      getAuthorizationUrl: (...args: unknown[]) => mockGetAuthorizationUrl(...args),
    },
  },
  clientId: "test-client-id",
}));

vi.mock("@/db/client", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
  },
}));

vi.mock("@/db/schema", () => ({
  organizations: { id: "id", displayName: "display_name" },
  organizationMembers: { userId: "user_id", organizationId: "organization_id", role: "role" },
}));

const { authRoutes } = await import("@/api/routes/auth");

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
    // Default mock for db.select().from().where().limit() chain (used by /me and /orgs)
    const limit = vi.fn().mockResolvedValue([{ organizationId: "org-1" }]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    mockSelect.mockReturnValue({ from });
  });

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
