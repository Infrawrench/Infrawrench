import { describe, it, expect, vi, beforeEach } from "vitest";

// Agent-auth resolution is exercised in server-core's own suite; here it must
// simply answer "not an agent" so `sub` keeps being read as a WorkOS user id.
// Mocked rather than left real because the module reaches Postgres at import.
vi.mock("@infrawrench/server-core/trials/ceremony", () => ({
  resolveAgentCredential: vi.fn(async () => null),
  getClaimStatus: vi.fn(async () => null),
}));

vi.mock("@infrawrench/server-core/trials/principal", () => ({
  resolveAgentPrincipal: vi.fn(async () => null),
  touchAgentRegistration: vi.fn(async () => undefined),
}));

const mockSelect = vi.fn();
const mockUpdate = vi.fn();
vi.mock("@/db/client", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

vi.mock("@/db/schema", () => ({
  apiKeys: {
    id: "id",
    hashedKey: "hashed_key",
    revokedAt: "revoked_at",
    legacyHashSunsetAt: "legacy_hash_sunset_at",
  },
  organizationMembers: { id: "id", userId: "user_id", organizationId: "organization_id" },
}));

const mockKeyedHash = vi.fn();
const mockLegacySha256Hex = vi.fn();
vi.mock("@/services/encryption", () => ({
  keyedHash: (...args: unknown[]) => mockKeyedHash(...args),
  legacySha256Hex: (...args: unknown[]) => mockLegacySha256Hex(...args),
}));

const mockGetJwksUrl = vi.fn().mockReturnValue("https://workos.test/jwks");
vi.mock("../workos", () => ({
  workos: { userManagement: { getJwksUrl: (...a: unknown[]) => mockGetJwksUrl(...a) } },
  clientId: "client-1",
}));

const mockJwtVerify = vi.fn();
vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn().mockReturnValue("jwks-set"),
  jwtVerify: (...args: unknown[]) => mockJwtVerify(...args),
}));

const mockHasPermission = vi.fn();
vi.mock("@infrawrench/server-core/permissions/catalog", () => ({
  hasPermission: (...args: unknown[]) => mockHasPermission(...args),
}));

const { authenticateApiRequest, requireScope, verifyWorkosAccessToken } =
  await import("../api-auth");

function req(headers: Record<string, string>): Request {
  return new Request("https://x.test/", { headers });
}

function selectReturning(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  return { from };
}

/** The membership lookup, which ends in `.limit(1)`. */
function membershipReturning(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  return { from };
}

/** A membership row, i.e. the key's owner is still in the org. */
const MEMBER = [{ id: "m1" }];

function updateChain() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  mockUpdate.mockReturnValue({ set });
  return { set, where };
}

describe("verifyWorkosAccessToken", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns claims on a valid token", async () => {
    mockJwtVerify.mockResolvedValue({ payload: { sub: "u1", org_id: "o1" } });
    const claims = await verifyWorkosAccessToken("good");
    expect(claims).toEqual({ sub: "u1", org_id: "o1" });
  });

  it("returns null when verification throws", async () => {
    mockJwtVerify.mockRejectedValue(new Error("bad sig"));
    expect(await verifyWorkosAccessToken("bad")).toBeNull();
  });

  /**
   * Regression guard. WorkOS AuthKit tokens carry no `aud` claim, and their
   * `iss` varies by configuration and SDK version — passing either option to
   * `jwtVerify` rejects every real token and locks out all bearer clients
   * (MCP, mobile, desktop sync, chat). Isolation comes from the per-client
   * JWKS instead. See the comment on `verifyWorkosAccessToken`.
   */
  it("does not constrain aud or iss during verification", async () => {
    mockJwtVerify.mockResolvedValue({ payload: { sub: "u1" } });
    await verifyWorkosAccessToken("token");

    const options = mockJwtVerify.mock.calls[0]![2] as Record<string, unknown> | undefined;
    expect(options?.["audience"]).toBeUndefined();
    expect(options?.["issuer"]).toBeUndefined();
  });

  it("accepts a token with no aud claim", async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { sub: "u1", sid: "session_1", iss: "https://auth.example.com" },
    });
    expect(await verifyWorkosAccessToken("no-aud")).toMatchObject({ sub: "u1" });
  });
});

describe("authenticateApiRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKeyedHash.mockResolvedValue("hmac-hash");
    mockLegacySha256Hex.mockResolvedValue("legacy-hash");
  });

  it("returns null without a Bearer header", async () => {
    expect(await authenticateApiRequest(req({}))).toBeNull();
  });

  it("returns null for non-Bearer scheme", async () => {
    expect(await authenticateApiRequest(req({ authorization: "Basic abc" }))).toBeNull();
  });

  it("authenticates a valid iwk_ key via HMAC hash", async () => {
    mockSelect.mockReturnValueOnce(
      selectReturning([
        {
          id: "k1",
          userId: "u1",
          organizationId: "o1",
          scopes: ["resources:read"],
          expiresAt: null,
          legacyHashSunsetAt: null,
        },
      ]),
    );
    mockSelect.mockReturnValueOnce(membershipReturning(MEMBER));
    updateChain();
    const result = await authenticateApiRequest(req({ authorization: "Bearer iwk_abc" }));
    expect(result).toEqual({
      userId: "u1",
      organizationId: "o1",
      apiKeyId: "k1",
      scopes: ["resources:read"],
    });
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("returns null when iwk_ key not found by either hash", async () => {
    mockSelect.mockReturnValueOnce(selectReturning([])); // HMAC miss
    mockSelect.mockReturnValueOnce(selectReturning([])); // legacy miss
    const result = await authenticateApiRequest(req({ authorization: "Bearer iwk_missing" }));
    expect(result).toBeNull();
  });

  it("rehashes a legacy-hash hit and migrates deprecated scopes", async () => {
    mockSelect.mockReturnValueOnce(selectReturning([])); // HMAC miss
    mockSelect.mockReturnValueOnce(
      selectReturning([
        {
          id: "k2",
          userId: "u2",
          organizationId: "o2",
          scopes: ["sync:read", "sync:write"],
          expiresAt: null,
          legacyHashSunsetAt: null,
        },
      ]),
    );
    mockSelect.mockReturnValueOnce(membershipReturning(MEMBER));
    const { set } = updateChain();
    const result = await authenticateApiRequest(req({ authorization: "Bearer iwk_legacy" }));
    expect(result?.scopes).toEqual(["resources:read", "resources:write"]);
    // rehash sets hashedKey + clears sunset
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ hashedKey: "hmac-hash", legacyHashSunsetAt: null }),
    );
    // A rename is a rename: the new strings replace the old ones on the row.
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ["resources:read", "resources:write"] }),
    );
  });

  /**
   * Regression guard for the `dashboards:*` → `workflows:*` split. The
   * grandfathering ran once, in migration
   * `0055_grandfather_workflow_permissions`; authentication must not expand
   * anything on top of what the row stores. Expanding here would be bad twice
   * over: the widened set is written straight back to `api_keys.scopes` (so the
   * key would permanently hold scopes its creator never ticked, and the key
   * listing would show them), and a key minted *after* the split to
   * deliberately exclude workflow access would silently gain it.
   */
  it("returns a dashboards-scoped key exactly as stored, and persists no expansion", async () => {
    mockSelect.mockReturnValueOnce(
      selectReturning([
        {
          id: "k4",
          userId: "u4",
          organizationId: "o4",
          scopes: ["dashboards:read", "dashboards:write"],
          createdAt: new Date("2026-01-01T00:00:00Z"),
          expiresAt: null,
          legacyHashSunsetAt: null,
        },
      ]),
    );
    mockSelect.mockReturnValueOnce(membershipReturning(MEMBER));
    const { set } = updateChain();
    const result = await authenticateApiRequest(req({ authorization: "Bearer iwk_dash" }));
    expect(result?.scopes).toEqual(["dashboards:read", "dashboards:write"]);
    // Touching `lastUsedAt` is expected; rewriting `scopes` is not.
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]![0]).not.toHaveProperty("scopes");
  });

  it("rejects a legacy-hash hit past its sunset", async () => {
    mockSelect.mockReturnValueOnce(selectReturning([])); // HMAC miss
    mockSelect.mockReturnValueOnce(
      selectReturning([
        {
          id: "k3",
          userId: "u3",
          organizationId: "o3",
          scopes: [],
          expiresAt: null,
          legacyHashSunsetAt: new Date(Date.now() - 1000),
        },
      ]),
    );
    const result = await authenticateApiRequest(req({ authorization: "Bearer iwk_old" }));
    expect(result).toBeNull();
  });

  it("rejects an expired key", async () => {
    mockSelect.mockReturnValueOnce(
      selectReturning([
        {
          id: "k4",
          userId: "u4",
          organizationId: "o4",
          scopes: [],
          expiresAt: new Date(Date.now() - 1000),
          legacyHashSunsetAt: null,
        },
      ]),
    );
    const result = await authenticateApiRequest(req({ authorization: "Bearer iwk_expired" }));
    expect(result).toBeNull();
  });

  it("rejects a key whose owner is no longer a member of the org", async () => {
    mockSelect.mockReturnValueOnce(
      selectReturning([
        {
          id: "k5",
          userId: "removed-user",
          organizationId: "o5",
          scopes: ["resources:read"],
          expiresAt: null,
          legacyHashSunsetAt: null,
        },
      ]),
    );
    mockSelect.mockReturnValueOnce(membershipReturning([]));
    const result = await authenticateApiRequest(req({ authorization: "Bearer iwk_orphan" }));
    expect(result).toBeNull();
    // Never records a use for a key it refused.
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("falls back to WorkOS access token when not an iwk_ key", async () => {
    mockJwtVerify.mockResolvedValue({
      payload: { sub: "wu1", org_id: "wo1", email: "w@e.com" },
    });
    const result = await authenticateApiRequest(req({ authorization: "Bearer jwt.token.here" }));
    expect(result).toEqual({ userId: "wu1", organizationId: "wo1", email: "w@e.com" });
  });

  it("returns null when WorkOS token lacks org_id", async () => {
    mockJwtVerify.mockResolvedValue({ payload: { sub: "wu1" } });
    const result = await authenticateApiRequest(req({ authorization: "Bearer jwt.token" }));
    expect(result).toBeNull();
  });
});

describe("requireScope", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is a no-op when the principal has no scopes (full user)", () => {
    expect(() =>
      requireScope({ userId: "u", organizationId: "o" }, "resources:read"),
    ).not.toThrow();
    expect(mockHasPermission).not.toHaveBeenCalled();
  });

  it("passes when the scope matches", () => {
    mockHasPermission.mockReturnValue(true);
    expect(() =>
      requireScope({ userId: "u", organizationId: "o", scopes: ["*"] }, "resources:read"),
    ).not.toThrow();
  });

  it("throws when the scope is missing", () => {
    mockHasPermission.mockReturnValue(false);
    expect(() =>
      requireScope({ userId: "u", organizationId: "o", scopes: ["chat:read"] }, "resources:write"),
    ).toThrow(/Missing required scope: resources:write/);
  });
});
