import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
const mockInsert = vi.fn();
vi.mock("@/db/client", () => ({
  db: {
    select: (...a: unknown[]) => mockSelect(...a),
    insert: (...a: unknown[]) => mockInsert(...a),
  },
}));

const mockLoadSealedSession = vi.fn();
vi.mock("@/auth/workos", () => ({
  workos: {
    userManagement: { loadSealedSession: (...a: unknown[]) => mockLoadSealedSession(...a) },
  },
}));

const mockAuthenticateApiRequest = vi.fn();
const mockRequireScope = vi.fn();
const mockVerifyWorkosAccessToken = vi.fn();
vi.mock("@/auth/api-auth", () => ({
  authenticateApiRequest: (...a: unknown[]) => mockAuthenticateApiRequest(...a),
  requireScope: (...a: unknown[]) => mockRequireScope(...a),
  verifyWorkosAccessToken: (...a: unknown[]) => mockVerifyWorkosAccessToken(...a),
}));

const mockEnsureUser = vi.fn();
vi.mock("@/api/auth-middleware", () => ({
  ensureUserFromClaims: (...a: unknown[]) => mockEnsureUser(...a),
}));

const { authenticateChat } = await import("@/chat/auth");

// Minimal Hono-context stub covering the methods authenticateChat uses.
function makeCtx(opts: { authorization?: string; cookie?: string }) {
  const headers = new Headers();
  if (opts.cookie) headers.set("cookie", opts.cookie);
  if (opts.authorization) headers.set("authorization", opts.authorization);
  const raw = new Request("http://localhost/api/org/org-1/chat", { headers });
  return {
    req: {
      header: (name: string) => headers.get(name) ?? undefined,
      raw,
    },
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  } as never;
}

function membershipReturns(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  mockSelect.mockReturnValue({ from });
}

describe("authenticateChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["WORKOS_COOKIE_PASSWORD"] = "x".repeat(40);
  });

  describe("API key bearer", () => {
    it("401s when the API key is invalid", async () => {
      mockAuthenticateApiRequest.mockResolvedValue(null);
      const res = await authenticateChat(
        makeCtx({ authorization: "Bearer iwk_bad" }),
        "org-1",
        "chat:write",
      );
      expect((res as Response).status).toBe(401);
    });

    it("403s when the API key lacks the required scope", async () => {
      mockAuthenticateApiRequest.mockResolvedValue({ userId: "u1", organizationId: "org-1" });
      mockRequireScope.mockImplementation(() => {
        throw new Error("missing");
      });
      const res = await authenticateChat(
        makeCtx({ authorization: "Bearer iwk_x" }),
        "org-1",
        "chat:write",
      );
      expect((res as Response).status).toBe(403);
    });

    it("403s when the API key belongs to a different org", async () => {
      mockAuthenticateApiRequest.mockResolvedValue({ userId: "u1", organizationId: "other" });
      mockRequireScope.mockReturnValue(undefined);
      const res = await authenticateChat(
        makeCtx({ authorization: "Bearer iwk_x" }),
        "org-1",
        "chat:write",
      );
      expect((res as Response).status).toBe(403);
    });

    it("succeeds with via=api-key", async () => {
      mockAuthenticateApiRequest.mockResolvedValue({
        userId: "u1",
        organizationId: "org-1",
        apiKeyId: "key-1",
        email: "a@b.com",
      });
      mockRequireScope.mockReturnValue(undefined);
      const res = await authenticateChat(
        makeCtx({ authorization: "Bearer iwk_x" }),
        "org-1",
        "chat:write",
      );
      expect(res).toMatchObject({ userId: "u1", organizationId: "org-1", via: "api-key" });
    });
  });

  describe("WorkOS access-token bearer", () => {
    it("401s when the token has no subject", async () => {
      mockVerifyWorkosAccessToken.mockResolvedValue(null);
      const res = await authenticateChat(
        makeCtx({ authorization: "Bearer wos_token" }),
        "org-1",
        "chat:read",
      );
      expect((res as Response).status).toBe(401);
    });

    it("403s when the user is not a member of the org", async () => {
      mockVerifyWorkosAccessToken.mockResolvedValue({ sub: "u1", email: "a@b.com" });
      mockEnsureUser.mockResolvedValue({ id: "u1" });
      membershipReturns([]);
      const res = await authenticateChat(
        makeCtx({ authorization: "Bearer wos_token" }),
        "org-1",
        "chat:read",
      );
      expect((res as Response).status).toBe(403);
    });

    it("succeeds with via=workos-bearer", async () => {
      mockVerifyWorkosAccessToken.mockResolvedValue({ sub: "u1", email: "a@b.com" });
      mockEnsureUser.mockResolvedValue({ id: "u1" });
      membershipReturns([{ id: "m1" }]);
      const res = await authenticateChat(
        makeCtx({ authorization: "Bearer wos_token" }),
        "org-1",
        "chat:read",
      );
      expect(res).toMatchObject({ userId: "u1", via: "workos-bearer" });
    });
  });

  describe("session cookie", () => {
    it("401s with no cookie and no bearer", async () => {
      const res = await authenticateChat(makeCtx({}), "org-1", "chat:read");
      expect((res as Response).status).toBe(401);
    });

    it("authenticates a sealed session and upserts the user", async () => {
      mockLoadSealedSession.mockReturnValue({
        authenticate: vi.fn().mockResolvedValue({
          authenticated: true,
          user: { id: "u1", email: "a@b.com" },
        }),
      });
      const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
      const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
      mockInsert.mockReturnValue({ values });
      membershipReturns([{ id: "m1" }]);

      const res = await authenticateChat(
        makeCtx({ cookie: "wos-session=blob" }),
        "org-1",
        "chat:read",
      );
      expect(res).toMatchObject({ userId: "u1", via: "session" });
    });

    it("401s when the sealed session is not authenticated", async () => {
      mockLoadSealedSession.mockReturnValue({
        authenticate: vi.fn().mockResolvedValue({ authenticated: false }),
      });
      const res = await authenticateChat(
        makeCtx({ cookie: "wos-session=blob" }),
        "org-1",
        "chat:read",
      );
      expect((res as Response).status).toBe(401);
    });

    it("401s when loadSealedSession throws", async () => {
      mockLoadSealedSession.mockImplementation(() => {
        throw new Error("bad seal");
      });
      const res = await authenticateChat(
        makeCtx({ cookie: "wos-session=blob" }),
        "org-1",
        "chat:read",
      );
      expect((res as Response).status).toBe(401);
    });
  });
});
