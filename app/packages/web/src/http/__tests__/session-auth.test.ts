/**
 * `SessionAuth` (the HttpApi middleware of the session-only surface): the
 * requests the Hono `sessionMiddleware` it replaced refused, refused with the
 * same statuses and bodies, and a session WorkOS refreshed written back with
 * the `Set-Cookie` that middleware wrote, byte for byte, on every response the
 * request gets.
 *
 * It runs the one implementation (`authenticatePerson` in `http/auth.ts`);
 * only WorkOS, the bearer verification and the database are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { legacyCookie } from "../domains/__tests__/legacy-cookie";

vi.hoisted(() => {
  process.env["WORKOS_API_KEY"] ??= "sk_test_session_auth";
  process.env["WORKOS_CLIENT_ID"] ??= "client_session_auth";
  process.env["WORKOS_COOKIE_PASSWORD"] = "x".repeat(40);
});

const mockVerify = vi.fn();
vi.mock("@/auth/api-auth", () => ({
  verifyWorkosAccessToken: (...a: unknown[]) => mockVerify(...a),
  authenticateApiRequest: vi.fn(async () => null),
  agentAuthResult: vi.fn(async () => null),
}));

const mockLoadSealedSession = vi.fn();
vi.mock("@/auth/workos", () => ({
  workos: {
    userManagement: {
      loadSealedSession: (...a: unknown[]) => mockLoadSealedSession(...a),
      getUser: vi.fn(),
      getAuthorizationUrl: vi.fn(() => "https://workos.example.com/auth"),
    },
  },
  clientId: "client-1",
}));

vi.mock("@infrawrench/server-core/trials/principal", () => ({
  resolveAgentPrincipal: vi.fn(async () => null),
  touchAgentRegistration: vi.fn(async () => undefined),
}));

const mockSelectRows = vi.fn(async (): Promise<unknown[]> => []);
vi.mock("@/db/client", () => {
  const node = {
    from: () => node,
    where: () => node,
    innerJoin: () => node,
    limit: () => mockSelectRows(),
    then: (resolve: (rows: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
      mockSelectRows().then(resolve, reject),
  };
  return {
    db: {
      select: () => node,
      insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
    },
  };
});

const { makeHttpApiHandler } = await import("@/http/server");
const { MiddlewareLive } = await import("@/http/middleware-live");
const { authDomain } = await import("@/http/domains/auth/index");

const effectApi = makeHttpApiHandler([authDomain], MiddlewareLive);

function me(headers: Record<string, string>) {
  return effectApi.handle(new Request("http://localhost/api/auth/me", { headers }));
}

/** The refreshed session cookie as `sessionMiddleware`'s `setCookie` wrote it. */
const refreshedCookie = (sealed: string) =>
  legacyCookie("wos-session", sealed, {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 400,
  });

const AGENT_SUB = "0b7c9f4e-3a0d-4b7e-9a51-2a6f1d8c4e10";

/** A sealed session whose access token has expired, so WorkOS refreshes it. */
function refreshingSession(sealed: string) {
  mockLoadSealedSession.mockReturnValue({
    authenticate: async () => ({ authenticated: false }),
    refresh: async () => ({
      authenticated: true,
      user: { id: "user_1", email: "a@example.com", firstName: null, lastName: null },
      sessionId: "sess_1",
      sealedSession: sealed,
    }),
  });
}

describe("SessionAuth refuses what sessionMiddleware refused", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectRows.mockResolvedValue([]);
  });

  const UNAUTHORIZED = { error: "Unauthorized" };
  const AGENT_REFUSAL = {
    error: "Agent credentials cannot be used here. This endpoint acts on a person's account.",
  };
  const cases: Array<[string, Record<string, string>, unknown, number, unknown]> = [
    ["no credential", {}, null, 401, UNAUTHORIZED],
    ["an iwk_ API key", { authorization: "Bearer iwk_example" }, null, 401, UNAUTHORIZED],
    ["an iwa_ agent credential", { authorization: "Bearer iwa_example" }, null, 401, UNAUTHORIZED],
    [
      "a WorkOS agent token",
      { authorization: "Bearer eyJ.agent" },
      { sub: AGENT_SUB },
      403,
      AGENT_REFUSAL,
    ],
    ["an unverifiable bearer", { authorization: "Bearer eyJ.bad" }, null, 401, UNAUTHORIZED],
  ];

  it.each(cases)("%s", async (_label, headers, claims, status, body) => {
    mockVerify.mockResolvedValue(claims);
    const res = await me(headers);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(body);
  });

  it("answers an agent token with the person-only sentence", async () => {
    mockVerify.mockResolvedValue({ sub: AGENT_SUB });
    const res = await me({ authorization: "Bearer eyJ.agent" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(AGENT_REFUSAL);
  });

  it("refuses a sealed cookie WorkOS will not open", async () => {
    mockLoadSealedSession.mockReturnValue({
      authenticate: async () => ({ authenticated: false }),
      refresh: async () => ({ authenticated: false }),
    });
    const res = await me({ cookie: "wos-session=stale" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(UNAUTHORIZED);
  });
});

describe("a refreshed session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectRows.mockResolvedValue([]);
  });

  it("is written back byte for byte as the Hono middleware wrote it", async () => {
    refreshingSession("Fe26.2**sealed+value/==");
    const res = await me({ cookie: "wos-session=old" });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([refreshedCookie("Fe26.2**sealed+value/==")]);
    expect(res.headers.getSetCookie()[0]).toContain("Max-Age=34560000");
  });

  it("rides an error response too: WorkOS has already rotated the refresh token", async () => {
    refreshingSession("sealed-2");
    mockSelectRows.mockRejectedValue(new Error("database down"));
    const res = await me({ cookie: "wos-session=old" });
    expect(res.status).toBe(500);
    expect(res.headers.getSetCookie()).toEqual([refreshedCookie("sealed-2")]);
  });

  it("does not undo sign-out, whose cleared cookie wins as it did on Hono", async () => {
    refreshingSession("sealed-3");
    const res = await effectApi.handle(
      new Request("http://localhost/api/auth/sign-out", {
        method: "POST",
        headers: { cookie: "wos-session=old" },
      }),
    );
    expect(res.headers.getSetCookie()).toEqual(["wos-session=; Max-Age=0; Path=/"]);
  });

  it("guards the rest of the prefix with the same middleware", async () => {
    mockVerify.mockResolvedValue(null);
    const res = await effectApi.handle(new Request("http://localhost/api/auth/unknown/path"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("answers a person under the prefix with the 404 for a path nothing routes", async () => {
    mockVerify.mockResolvedValue({ sub: "user_1", email: "a@example.com" });
    mockSelectRows.mockResolvedValue([{ id: "user_1", email: "a@example.com" }]);
    const res = await effectApi.handle(
      new Request("http://localhost/api/auth/unknown/path", {
        headers: { authorization: "Bearer eyJ.person" },
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("404 Not Found");
  });
});
