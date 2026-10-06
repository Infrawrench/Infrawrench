/**
 * The session-only router (`authed` in `api/index.ts`) must not run its session
 * middleware on the org tree.
 *
 * It did, for as long as it existed: a sub-app's `use("*")` mounted at `/api`
 * becomes `/api/*`, so `sessionMiddleware` ran ahead of `apiKeyOrgMiddleware`
 * on every `/api/org/...` request and turned away `iwk_` API keys and agent
 * tokens, which are not a person's WorkOS session. The middleware tests build a
 * mini app without that router, so only a test against the real `api` sees it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["WORKOS_API_KEY"] ??= "sk_test_authed_scope";
  process.env["WORKOS_CLIENT_ID"] ??= "client_authed_scope";
});

const calls = vi.hoisted(() => ({ session: 0, apiKey: 0 }));

vi.mock("../auth-middleware", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth-middleware")>();
  const { createMiddleware } = await import("hono/factory");
  return {
    ...actual,
    // Stand-ins that answer instead of authenticating, so the test reads which
    // middleware a request reached first.
    sessionMiddleware: createMiddleware(async (c) => {
      calls.session++;
      return c.json({ by: "session" }, 401);
    }),
    apiKeyOrgMiddleware: createMiddleware(async (c, next) => {
      const bearer = c.req.header("authorization") ?? "";
      if (!bearer.startsWith("Bearer iwk_")) return next();
      calls.apiKey++;
      return c.json({ by: "api-key" }, 200);
    }),
  };
});

const { api } = await import("../index");

beforeEach(() => {
  calls.session = 0;
  calls.apiKey = 0;
});

describe("authed router scope", () => {
  it("lets an API key on the org tree reach the API-key middleware", async () => {
    const res = await api.request("/api/org/org_1/costs", {
      headers: { authorization: "Bearer iwk_example" },
    });
    expect(await res.json()).toEqual({ by: "api-key" });
    expect(calls.session).toBe(0);
  });

  it("still guards every session-only mount, bare path included", async () => {
    for (const path of [
      "/api/profile",
      "/api/profile/mfa",
      "/api/orgs",
      "/api/auth/me",
      "/api/invitations/x/accept",
      "/api/admin/orgs",
      "/api/push/devices",
    ]) {
      const res = await api.request(path);
      expect(await res.json(), path).toEqual({ by: "session" });
    }
  });
});
