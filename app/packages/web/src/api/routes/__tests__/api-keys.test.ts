import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AuthSession } from "@/api/auth-middleware";

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

function buildApp() {
  const app = new Hono();
  const session: AuthSession = {
    userId: "user-1",
    email: "test@example.com",
  };
  app.use("*", async (c, next) => {
    c.set("session", session);
    c.set("organizationId", "org-1");
    return next();
  });
  app.route("/", apiKeyRoutes);
  return app;
}

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
