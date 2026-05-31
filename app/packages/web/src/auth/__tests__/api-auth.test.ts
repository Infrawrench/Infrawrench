import { describe, it, expect, vi, beforeEach } from "vitest";

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
    const { set } = updateChain();
    const result = await authenticateApiRequest(req({ authorization: "Bearer iwk_legacy" }));
    expect(result?.scopes).toEqual(["resources:read", "resources:write"]);
    // rehash sets hashedKey + clears sunset
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ hashedKey: "hmac-hash", legacyHashSunsetAt: null }),
    );
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
