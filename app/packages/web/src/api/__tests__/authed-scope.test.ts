/**
 * The session-only surface must not run its session check on the org tree.
 *
 * It did, for as long as it was a Hono router: a sub-app's `use("*")` mounted
 * at `/api` becomes `/api/*`, so `sessionMiddleware` ran ahead of
 * `apiKeyOrgMiddleware` on every `/api/org/...` request and turned away `iwk_`
 * API keys and agent tokens, which are not a person's WorkOS session. The
 * surface is HttpApi now (`SessionAuth`, each prefix guarded whole), and the
 * person check is the one implementation both halves run, `authenticatePerson`
 * in `http/auth.ts`; that is what this test intercepts. The middleware tests
 * build a mini app without the real routing, so only a test against the real
 * `api` sees it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env["WORKOS_API_KEY"] ??= "sk_test_authed_scope";
  process.env["WORKOS_CLIENT_ID"] ??= "client_authed_scope";
});

const calls = vi.hoisted(() => ({ session: 0, apiKey: 0 }));

// Stand-ins that answer instead of authenticating, so the test reads which
// check a request reached first.
vi.mock("../../http/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../http/auth")>();
  const { Effect } = await import("effect");
  const { HttpFailure } = await import("../../http/errors");
  return {
    ...actual,
    authenticatePerson: () =>
      Effect.suspend(() => {
        calls.session++;
        return Effect.fail(new HttpFailure(401, { by: "session" }));
      }),
  };
});

vi.mock("../auth-middleware", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth-middleware")>();
  const { createMiddleware } = await import("hono/factory");
  return {
    ...actual,
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
