import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

// `keyedHash` reads ENCRYPTION_MASTER_KEY when invoked. Set a fixed 32-byte
// test key so the hashing path runs deterministically.
process.env["ENCRYPTION_MASTER_KEY"] = Buffer.alloc(32, 1).toString("base64");
// The WorkOS client module throws at import time if these aren't set.
// `authenticateApiRequest` imports it transitively for JWT verification.
process.env["WORKOS_API_KEY"] = "test_workos_api_key";
process.env["WORKOS_CLIENT_ID"] = "test_workos_client_id";

const mockInsert = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
const mockSelect = vi.fn();
const mockUpdate = vi.fn();

vi.mock("@/db/client", () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    select: (...args: unknown[]) => mockSelect(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

vi.mock("@/services/audit", () => ({
  logAudit: vi.fn(),
}));

vi.mock("uuid", () => ({ v4: () => "test-uuid-1234" }));

const { apiKeyRoutes } = await import("@/api/routes/api-keys");
const { organizationMembers } = await import("@/db/schema");

const buildApp = () => buildTestApp(apiKeyRoutes);

describe("API Keys routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST / — create a new API key", () => {
    it("returns an id and key where the key has iwk_ prefix", async () => {
      const values = vi.fn().mockResolvedValue(undefined);
      mockInsert.mockReturnValue({ values });

      const app = buildApp();
      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "ci-key", scopes: ["sync:write"], expiresAt: null }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("test-uuid-1234");
      expect(body.key).toMatch(/^iwk_/);
    });

    it("hashes the key with SHA-256 before storing", async () => {
      const capturedValues: Record<string, unknown>[] = [];
      const values = vi.fn().mockImplementation((v) => {
        capturedValues.push(v);
        return Promise.resolve();
      });
      mockInsert.mockReturnValue({ values });

      const app = buildApp();
      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "ci-key", scopes: ["sync:write"] }),
      });

      const body = await res.json();
      const stored = capturedValues[0] as Record<string, string>;
      // The stored hash must NOT equal the raw key — it's a hex SHA-256 digest
      expect(stored.hashedKey).toBeDefined();
      expect(stored.hashedKey).not.toBe(body.key);
      expect(stored.hashedKey).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
    });

    it("stores the first 12 chars of the key as prefix", async () => {
      const capturedValues: Record<string, unknown>[] = [];
      const values = vi.fn().mockImplementation((v) => {
        capturedValues.push(v);
        return Promise.resolve();
      });
      mockInsert.mockReturnValue({ values });

      const app = buildApp();
      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "ci-key", scopes: [] }),
      });

      const body = await res.json();
      const stored = capturedValues[0] as Record<string, string>;
      expect(stored.prefix).toBe(body.key.slice(0, 12));
    });
  });

  describe("GET / — list API keys", () => {
    it("returns metadata without exposing hashedKey", async () => {
      const rows = [
        {
          id: "k1",
          name: "ci-key",
          prefix: "iwk_abcd1234",
          scopes: ["sync:write"],
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
          createdAt: new Date("2026-01-01"),
        },
      ];

      // Chain: select() -> from() -> where()
      const where = vi.fn().mockResolvedValue(rows);
      const from = vi.fn().mockReturnValue({ where });
      mockSelect.mockReturnValue({ from });

      const app = buildApp();
      const res = await app.request("/", { method: "GET" });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0]).toHaveProperty("prefix");
      expect(body[0]).toHaveProperty("name");
      expect(body[0]).not.toHaveProperty("hashedKey");
    });

    it("normalises null scopes to empty array", async () => {
      const rows = [
        {
          id: "k1",
          name: "a",
          prefix: "iwk_x",
          scopes: null,
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
          legacyHashSunsetAt: null,
          createdAt: new Date(),
        },
      ];
      const where = vi.fn().mockResolvedValue(rows);
      const from = vi.fn().mockReturnValue({ where });
      mockSelect.mockReturnValue({ from });

      const app = buildApp();
      const body = await (await app.request("/", { method: "GET" })).json();
      expect(body[0].scopes).toEqual([]);
    });

    it("derives needsRotation=false when legacyHashSunsetAt is null", async () => {
      const rows = [
        {
          id: "k1",
          name: "a",
          prefix: "iwk_x",
          scopes: [],
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
          legacyHashSunsetAt: null,
          createdAt: new Date(),
        },
      ];
      const where = vi.fn().mockResolvedValue(rows);
      const from = vi.fn().mockReturnValue({ where });
      mockSelect.mockReturnValue({ from });

      const app = buildApp();
      const body = await (await app.request("/", { method: "GET" })).json();
      expect(body[0].needsRotation).toBe(false);
    });

    it("derives needsRotation=true when legacyHashSunsetAt is set", async () => {
      const rows = [
        {
          id: "k1",
          name: "a",
          prefix: "iwk_x",
          scopes: [],
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
          legacyHashSunsetAt: new Date("2026-11-01"),
          createdAt: new Date(),
        },
      ];
      const where = vi.fn().mockResolvedValue(rows);
      const from = vi.fn().mockReturnValue({ where });
      mockSelect.mockReturnValue({ from });

      const app = buildApp();
      const body = await (await app.request("/", { method: "GET" })).json();
      expect(body[0].needsRotation).toBe(true);
    });
  });

  describe("POST /:id/revoke — revoke an API key", () => {
    it("sets revokedAt to a date", async () => {
      let capturedSet: Record<string, unknown> | undefined;
      const where = vi.fn().mockResolvedValue(undefined);
      const set = vi.fn().mockImplementation((v) => {
        capturedSet = v;
        return { where };
      });
      mockUpdate.mockReturnValue({ set });

      const app = buildApp();
      const res = await app.request("/key-id-1/revoke", { method: "POST" });
      expect(res.status).toBe(200);
      expect(capturedSet?.revokedAt).toBeInstanceOf(Date);
    });
  });

  describe("status derivation from list response fields", () => {
    it("active: revokedAt and expiresAt are both null", () => {
      const row = { revokedAt: null, expiresAt: null };
      const status = deriveStatus(row);
      expect(status).toBe("active");
    });

    it("revoked: revokedAt is set", () => {
      const row = { revokedAt: new Date("2026-01-01"), expiresAt: null };
      const status = deriveStatus(row);
      expect(status).toBe("revoked");
    });

    it("expired: expiresAt is in the past", () => {
      const row = { revokedAt: null, expiresAt: new Date("2020-01-01") };
      const status = deriveStatus(row);
      expect(status).toBe("expired");
    });

    it("active: expiresAt is in the future", () => {
      const row = { revokedAt: null, expiresAt: new Date("2099-01-01") };
      const status = deriveStatus(row);
      expect(status).toBe("active");
    });
  });
});

// Helper matching the status logic a consumer would apply to the list response
function deriveStatus(row: { revokedAt: Date | null; expiresAt: Date | null }): string {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt && row.expiresAt < new Date()) return "expired";
  return "active";
}

describe("authenticateApiRequest — legacy hash sunset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Builds a select() mock that returns `firstRows` on the first call (HMAC
   * lookup) and `secondRows` on the second (legacy lookup). Returns the chain
   * so the assertions can inspect it.
   */
  function mockTwoStageSelect(
    firstRows: unknown[],
    secondRows: unknown[],
    /** Membership rows for the owner-still-in-org check; a member by default. */
    membershipRows: unknown[] = [{ id: "m1" }],
  ) {
    const calls = [firstRows, secondRows];
    // Dispatch on the table rather than call order: the membership lookup only
    // happens after a key matches, so its position in the sequence varies.
    mockSelect.mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => {
        if (table === organizationMembers) {
          const limit = vi.fn().mockResolvedValue(membershipRows);
          return { where: vi.fn().mockReturnValue({ limit }) };
        }
        const rows = calls.shift() ?? [];
        return { where: vi.fn().mockResolvedValue(rows) };
      }),
    }));
  }

  async function callAuth(token: string) {
    const { authenticateApiRequest } = await import("@/auth/api-auth");
    const req = new Request("http://x/", {
      headers: { authorization: `Bearer ${token}` },
    });
    return authenticateApiRequest(req);
  }

  it("accepts a key that matches the HMAC hash without rehashing or touching sunset", async () => {
    const row = {
      id: "k1",
      userId: "user-1",
      organizationId: "org-1",
      scopes: [],
      expiresAt: null,
      revokedAt: null,
      legacyHashSunsetAt: null,
      hashedKey: "irrelevant",
    };
    mockTwoStageSelect([row], []);

    let capturedSet: Record<string, unknown> | undefined;
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockImplementation((v) => {
      capturedSet = v;
      return { where };
    });
    mockUpdate.mockReturnValue({ set });

    const result = await callAuth("iwk_newkey");
    expect(result).not.toBeNull();
    expect(result?.apiKeyId).toBe("k1");
    // HMAC hit: no rehash, no sunset touch.
    expect(capturedSet).toBeDefined();
    expect(capturedSet).not.toHaveProperty("hashedKey");
    expect(capturedSet).not.toHaveProperty("legacyHashSunsetAt");
  });

  it("rehashes and clears legacyHashSunsetAt on legacy hash hit within window", async () => {
    const row = {
      id: "k2",
      userId: "user-1",
      organizationId: "org-1",
      scopes: [],
      expiresAt: null,
      revokedAt: null,
      legacyHashSunsetAt: null,
      hashedKey: "legacy-digest",
    };
    // HMAC lookup misses, legacy lookup hits.
    mockTwoStageSelect([], [row]);

    let capturedSet: Record<string, unknown> | undefined;
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockImplementation((v) => {
      capturedSet = v;
      return { where };
    });
    mockUpdate.mockReturnValue({ set });

    const result = await callAuth("iwk_legacykey");
    expect(result).not.toBeNull();
    expect(capturedSet?.["hashedKey"]).toMatch(/^[0-9a-f]{64}$/);
    expect(capturedSet?.["legacyHashSunsetAt"]).toBeNull();
  });

  it("rejects authentication when legacy hash matches but sunset is in the past", async () => {
    const row = {
      id: "k3",
      userId: "user-1",
      organizationId: "org-1",
      scopes: [],
      expiresAt: null,
      revokedAt: null,
      // Sunset fired in 2020 — well before now. The row must be refused even
      // though the legacy hash still matches.
      legacyHashSunsetAt: new Date("2020-01-01"),
      hashedKey: "legacy-digest",
    };
    mockTwoStageSelect([], [row]);

    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    mockUpdate.mockReturnValue({ set });

    const result = await callAuth("iwk_expiredlegacy");
    expect(result).toBeNull();
    // We must not have written anything for a refused key.
    expect(set).not.toHaveBeenCalled();
  });

  it("returns null when neither HMAC nor legacy lookup finds a row", async () => {
    mockTwoStageSelect([], []);
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    mockUpdate.mockReturnValue({ set });

    const result = await callAuth("iwk_unknown");
    expect(result).toBeNull();
    expect(set).not.toHaveBeenCalled();
  });
});
