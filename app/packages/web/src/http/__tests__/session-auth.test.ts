/**
 * `SessionAuth` (the HttpApi middleware of the session-only surface) against
 * the Hono `sessionMiddleware` it replaces: the same requests refused with the
 * same statuses and bodies, and a session WorkOS refreshed written back with a
 * byte-identical `Set-Cookie`, on every response the request gets.
 *
 * Both run the one implementation (`authenticatePerson` in `http/auth.ts`);
 * only WorkOS, the bearer verification and the database are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

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

const { sessionMiddleware } = await import("@/api/auth-middleware");
const { makeHttpApiHandler } = await import("@/http/server");
const { MiddlewareLive } = await import("@/http/middleware-live");
const { authDomain } = await import("@/http/domains/auth/index");

const effectApi = makeHttpApiHandler([authDomain], MiddlewareLive);

const honoApp = new Hono();
honoApp.use("*", sessionMiddleware);
honoApp.get("/api/auth/me", (c) => c.json(c.get("session")));

async function both(headers: Record<string, string>, path = "/api/auth/me") {
  const request = () => new Request(`http://localhost${path}`, { headers });
  const effect = await effectApi.handle(request());
  if (!effect) throw new Error(`no domain routes ${path}`);
  const hono = await honoApp.request(request());
  return { effect, hono };
}

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

  const cases: Array<[string, Record<string, string>, unknown]> = [
    ["no credential", {}, null],
    ["an iwk_ API key", { authorization: "Bearer iwk_example" }, null],
    ["an iwa_ agent credential", { authorization: "Bearer iwa_example" }, null],
    ["a WorkOS agent token", { authorization: "Bearer eyJ.agent" }, { sub: AGENT_SUB }],
    ["an unverifiable bearer", { authorization: "Bearer eyJ.bad" }, null],
  ];

  it.each(cases)("%s", async (_label, headers, claims) => {
    mockVerify.mockResolvedValue(claims);
    const { effect, hono } = await both(headers);
    expect(effect.status).toBe(hono.status);
    expect(await effect.json()).toEqual(await hono.json());
    expect(effect.status).toBeGreaterThanOrEqual(401);
  });

  it("answers an agent token with the person-only sentence", async () => {
    mockVerify.mockResolvedValue({ sub: AGENT_SUB });
    const { effect } = await both({ authorization: "Bearer eyJ.agent" });
    expect(effect.status).toBe(403);
    expect(await effect.json()).toEqual({
      error: "Agent credentials cannot be used here. This endpoint acts on a person's account.",
    });
  });

  it("refuses a sealed cookie WorkOS will not open", async () => {
    mockLoadSealedSession.mockReturnValue({
      authenticate: async () => ({ authenticated: false }),
      refresh: async () => ({ authenticated: false }),
    });
    const { effect, hono } = await both({ cookie: "wos-session=stale" });
    expect([effect.status, hono.status]).toEqual([401, 401]);
    expect(await effect.json()).toEqual(await hono.json());
  });
});

describe("a refreshed session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectRows.mockResolvedValue([]);
  });

  it("is written back byte for byte as the Hono middleware wrote it", async () => {
    refreshingSession("Fe26.2**sealed+value/==");
    const { effect, hono } = await both({ cookie: "wos-session=old" });
    expect(effect.status).toBe(200);
    expect(effect.headers.getSetCookie()).toEqual(hono.headers.getSetCookie());
    expect(effect.headers.getSetCookie()[0]).toContain("Max-Age=34560000");
  });

  it("rides an error response too: WorkOS has already rotated the refresh token", async () => {
    refreshingSession("sealed-2");
    mockSelectRows.mockRejectedValue(new Error("database down"));
    const { effect, hono } = await both({ cookie: "wos-session=old" });
    expect(effect.status).toBe(500);
    expect(effect.headers.getSetCookie()).toEqual(hono.headers.getSetCookie());
  });

  it("does not undo sign-out, whose cleared cookie wins as it did on Hono", async () => {
    refreshingSession("sealed-3");
    const res = await effectApi.handle(
      new Request("http://localhost/api/auth/sign-out", {
        method: "POST",
        headers: { cookie: "wos-session=old" },
      }),
    );
    expect(res?.headers.getSetCookie()).toEqual(["wos-session=; Max-Age=0; Path=/"]);
  });

  it("guards the rest of the prefix with the same middleware", async () => {
    mockVerify.mockResolvedValue(null);
    const res = await effectApi.handle(new Request("http://localhost/api/auth/unknown/path"));
    expect(res?.status).toBe(401);
    expect(await res?.json()).toEqual({ error: "Unauthorized" });
  });
});
