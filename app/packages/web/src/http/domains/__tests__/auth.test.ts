import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateCookie } from "hono/cookie";
import { buildTestApi } from "@/http/testing";
import { OAUTH_COOKIE_MAX_AGE, OAUTH_STATE_COOKIE, RETURN_TO_COOKIE } from "@/api/oauth-state";

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

const { authDomain } = await import("@/http/domains/auth/index");

const buildApp = () => buildTestApi(authDomain, { basePath: "/api/auth" });

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

      // Exactly what Hono's `deleteCookie(c, "wos-session", { path: "/" })` sent.
      expect(res.headers.getSetCookie()).toEqual([
        generateCookie("wos-session", "", { path: "/", maxAge: 0 }),
      ]);
    });
  });

  describe("GET /sign-in — start the WorkOS redirect", () => {
    const oauthCookie = (name: string, value: string) =>
      generateCookie(name, value, {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
        maxAge: OAUTH_COOKIE_MAX_AGE,
      });

    it("redirects to WorkOS with a state nonce cookie matching the `state` it sent", async () => {
      const res = await buildApp().request("/sign-in");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://workos.example.com/auth");
      const args = mockGetAuthorizationUrl.mock.calls[0]![0] as { state: string };
      expect(args).toMatchObject({ provider: "authkit", clientId: "test-client-id" });
      expect(args.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // Byte for byte what Hono's `setCookie` wrote, and no return-to cookie.
      expect(res.headers.getSetCookie()).toEqual([oauthCookie(OAUTH_STATE_COOKIE, args.state)]);
    });

    it("remembers a same-origin return path in its own cookie", async () => {
      const res = await buildApp().request(
        `/sign-in?return_to=${encodeURIComponent("/org/o1/settings?tab=security")}`,
      );
      const { state } = mockGetAuthorizationUrl.mock.calls[0]![0] as { state: string };
      expect(res.headers.getSetCookie()).toEqual([
        oauthCookie(OAUTH_STATE_COOKIE, state),
        oauthCookie(RETURN_TO_COOKIE, "/org/o1/settings?tab=security"),
      ]);
    });

    it("drops a return path that could leave the origin", async () => {
      const res = await buildApp().request("/sign-in?return_to=//evil.example.com");
      expect(res.status).toBe(302);
      expect(res.headers.getSetCookie()).toHaveLength(1);
    });
  });
});
