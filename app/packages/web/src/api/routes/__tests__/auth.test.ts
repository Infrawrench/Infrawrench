import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

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
  users: { id: "id", email: "email" },
}));

const { authRoutes } = await import("@/api/routes/auth");

const buildApp = () => buildTestApp(authRoutes);

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

    // The sealed session cookie caches the user WorkOS handed us at sign-in, so
    // after an email change it still carries the old address. The mirrored row
    // is the fresher of the two and has to win.
    it("prefers the mirrored users row over the session's cached email", async () => {
      const memberships = vi.fn().mockResolvedValue([{ organizationId: "org-1" }]);
      const userRow = vi.fn().mockResolvedValue([{ email: "moved@example.com" }]);
      mockSelect
        .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: memberships }) }) })
        .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: userRow }) }) });

      const app = buildApp();
      const res = await app.request("/me", { method: "GET" });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ email: "moved@example.com" });
    });

    it("falls back to the session email when no mirrored row exists yet", async () => {
      const memberships = vi.fn().mockResolvedValue([{ organizationId: "org-1" }]);
      const noRow = vi.fn().mockResolvedValue([]);
      mockSelect
        .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: memberships }) }) })
        .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: noRow }) }) });

      const app = buildApp();
      const res = await app.request("/me", { method: "GET" });
      await expect(res.json()).resolves.toMatchObject({ email: "test@example.com" });
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
