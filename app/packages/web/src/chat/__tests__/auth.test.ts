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

// The real module reaches the permissions resolver, which imports db/client
// and needs DATABASE_URL at import time.
const mockEffectivePermissions = vi.fn();
vi.mock("@/auth/effective-permissions", () => ({
  effectivePermissions: (...a: unknown[]) => mockEffectivePermissions(...a),
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
    // Permitted unless a test says otherwise.
    mockEffectivePermissions.mockResolvedValue(["chat:read", "chat:write"]);
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

  /**
   * The permission is enforced on every path, not just API keys. Session and
   * OAuth callers previously reached chat on membership alone, which made
   * `chat:read` / `chat:write` unenforceable for the UI.
   */
  describe("chat permission gate", () => {
    function sealedSession() {
      mockLoadSealedSession.mockReturnValue({
        authenticate: vi.fn().mockResolvedValue({
          authenticated: true,
          user: { id: "u1", email: "a@b.com" },
        }),
      });
      mockInsert.mockReturnValue({
        values: vi
          .fn()
          .mockReturnValue({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) }),
      });
    }

    it("403s a session member who lacks the permission", async () => {
      sealedSession();
      membershipReturns([{ id: "m1" }]);
      mockEffectivePermissions.mockResolvedValue(["resources:read"]);
      const res = await authenticateChat(
        makeCtx({ cookie: "wos-session=blob" }),
        "org-1",
        "chat:write",
      );
      expect((res as Response).status).toBe(403);
    });

    it("403s a session member holding only chat:read on a chat:write call", async () => {
      sealedSession();
      membershipReturns([{ id: "m1" }]);
      mockEffectivePermissions.mockResolvedValue(["chat:read"]);
      const res = await authenticateChat(
        makeCtx({ cookie: "wos-session=blob" }),
        "org-1",
        "chat:write",
      );
      expect((res as Response).status).toBe(403);

      // …but the same principal may still read.
      const ok = await authenticateChat(
        makeCtx({ cookie: "wos-session=blob" }),
        "org-1",
        "chat:read",
      );
      expect(ok).toMatchObject({ userId: "u1", via: "session" });
    });

    it("403s a WorkOS bearer principal who lacks the permission", async () => {
      mockVerifyWorkosAccessToken.mockResolvedValue({ sub: "u1", email: "a@b.com" });
      mockEnsureUser.mockResolvedValue({ id: "u1" });
      membershipReturns([{ id: "m1" }]);
      mockEffectivePermissions.mockResolvedValue([]);
      const res = await authenticateChat(
        makeCtx({ authorization: "Bearer wos_token" }),
        "org-1",
        "chat:read",
      );
      expect((res as Response).status).toBe(403);
    });

    it("403s a scoped key whose owner's role lacks the permission", async () => {
      // The key carries chat:write, so `requireScope` passes — the owner's
      // role is what rejects it.
      mockAuthenticateApiRequest.mockResolvedValue({
        userId: "u1",
        organizationId: "org-1",
        apiKeyId: "k1",
        scopes: ["chat:write"],
      });
      mockRequireScope.mockReturnValue(undefined);
      mockEffectivePermissions.mockResolvedValue([]);
      const res = await authenticateChat(
        makeCtx({ authorization: "Bearer iwk_key" }),
        "org-1",
        "chat:write",
      );
      expect((res as Response).status).toBe(403);
    });

    it("scores a key against its scopes, not just the owner's role", async () => {
      mockAuthenticateApiRequest.mockResolvedValue({
        userId: "u1",
        organizationId: "org-1",
        apiKeyId: "k1",
        scopes: ["chat:read"],
      });
      mockRequireScope.mockReturnValue(undefined);
      mockEffectivePermissions.mockResolvedValue(["chat:read"]);
      await authenticateChat(makeCtx({ authorization: "Bearer iwk_key" }), "org-1", "chat:read");

      expect(mockEffectivePermissions).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "u1", scopes: ["chat:read"] }),
      );
    });
  });
});
