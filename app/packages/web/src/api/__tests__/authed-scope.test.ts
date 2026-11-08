/**
 * The session-only surface must not run its session check on the org tree.
 *
 * It did, for as long as it was a Hono router: a sub-app's `use("*")` mounted
 * at `/api` becomes `/api/*`, so `sessionMiddleware` ran ahead of
 * `apiKeyOrgMiddleware` on every `/api/org/...` request and turned away `iwk_`
 * API keys and agent tokens, which are not a person's WorkOS session. The
 * surface is HttpApi now (`SessionAuth`, each prefix guarded whole), and the
 * org tree's answer to a path no domain routes is `OrgAuth`
 * (`orgTreeGuard`), whose first step is the key's. This test intercepts the
 * person check (`authenticatePerson` in `http/auth.ts`, what `SessionAuth`
 * runs) and the key lookup (`authenticateApiRequest`, the key step's first
 * read), so it reads which check a request reached first. The middleware
 * tests serve a domain without the real routing, so only a test against the
 * real `api` sees it.
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

vi.mock("@/auth/api-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/auth/api-auth")>();
  return {
    ...actual,
    authenticateApiRequest: async () => {
      calls.apiKey++;
      // A key that does not authenticate: the key step answers its 401.
      return null;
    },
  };
});

const { api } = await import("../index");

beforeEach(() => {
  calls.session = 0;
  calls.apiKey = 0;
});

describe("authed router scope", () => {
  it("lets an API key on the org tree reach the API-key step", async () => {
    const res = await api.request("/api/org/org_1/costs", {
      headers: { authorization: "Bearer iwk_example" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(calls.apiKey).toBe(1);
    expect(calls.session).toBe(0);
  });

  it("authenticates a path nothing routes on the org tree before its 404", async () => {
    for (const [method, path] of [
      ["GET", "/api/org/org_1"],
      ["GET", "/api/org/org_1/no-such-route"],
      ["DELETE", "/api/org/org_1/budgets"],
      ["GET", "/api/org/org_1/budgets/b1/no/such/route"],
    ] as const) {
      const res = await api.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(await res.json(), `${method} ${path}`).toEqual({ error: "Unauthorized" });
      expect(res.headers.get("x-frame-options"), `${method} ${path}`).toBe("DENY");
    }
  });

  it("answers a path outside every guarded prefix with the plain 404", async () => {
    const res = await api.request("/api/no-such-route");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("404 Not Found");
    expect(calls.session).toBe(0);
    expect(calls.apiKey).toBe(0);
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
