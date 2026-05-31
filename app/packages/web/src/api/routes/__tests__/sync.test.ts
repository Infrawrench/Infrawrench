import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const mockSelect = vi.fn();
const mockInsert = vi.fn();
vi.mock("@/db/client", () => ({
  db: {
    select: (...a: unknown[]) => mockSelect(...a),
    insert: (...a: unknown[]) => mockInsert(...a),
  },
}));

const mockAuth = vi.fn();
const mockRequireScope = vi.fn();
vi.mock("@/auth/api-auth", () => ({
  authenticateApiRequest: (...a: unknown[]) => mockAuth(...a),
  requireScope: (...a: unknown[]) => mockRequireScope(...a),
}));

vi.mock("@/services/encryption", () => ({
  encrypt: vi.fn().mockResolvedValue({ ciphertext: "enc", iv: "iv" }),
  buildAad: vi.fn().mockReturnValue("aad"),
}));

vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));

const { syncRoutes } = await import("@/api/routes/sync");

function buildApp() {
  const app = new Hono();
  app.route("/", syncRoutes);
  return app;
}

const AUTH = { userId: "user-1", organizationId: "org-1", apiKeyId: "key-1" };

describe("Sync routes (bearer auth)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(AUTH);
    mockRequireScope.mockReturnValue(undefined);
  });

  describe("POST /pull", () => {
    it("returns 401 when unauthenticated", async () => {
      mockAuth.mockResolvedValue(null);
      const res = await buildApp().request("/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lastSyncVersion: 0 }),
      });
      expect(res.status).toBe(401);
    });

    it("returns rows for accounts/resources/dashboards/pins/associations", async () => {
      // Five parallel selects, each ends in .where() resolving to rows.
      const makeWhereSelect = (rows: unknown[]) => {
        const where = vi.fn().mockResolvedValue(rows);
        const from = vi.fn().mockReturnValue({ where });
        return { from };
      };
      mockSelect
        .mockReturnValueOnce(makeWhereSelect([{ id: "a1" }]))
        .mockReturnValueOnce(makeWhereSelect([{ id: "r1" }]))
        .mockReturnValueOnce(makeWhereSelect([{ id: "d1" }]))
        .mockReturnValueOnce(makeWhereSelect([{ id: "pin1" }]))
        .mockReturnValueOnce(makeWhereSelect([{ id: "assoc1" }]));

      const res = await buildApp().request("/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lastSyncVersion: 5 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.accounts).toHaveLength(1);
      expect(body.resources).toHaveLength(1);
      expect(body.dashboardPins).toHaveLength(1);
      expect(body.associations).toHaveLength(1);
      expect(mockRequireScope).toHaveBeenCalledWith(AUTH, "resources:read");
    });
  });

  describe("POST /push", () => {
    it("returns 400 on a schema-invalid body", async () => {
      const res = await buildApp().request("/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts: [{ id: "" }] }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Invalid request body");
    });

    it("rejects resources referencing an unknown accountId", async () => {
      // Existing-account lookup returns nothing → missing account.
      const where = vi.fn().mockResolvedValue([]);
      const from = vi.fn().mockReturnValue({ where });
      mockSelect.mockReturnValue({ from });

      const res = await buildApp().request("/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resources: [
            {
              id: "r1",
              pluginId: "aws",
              resourceTypeId: "ec2",
              accountId: "ghost",
              displayName: "vm",
              fieldsJson: {},
              outputsJson: {},
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ],
        }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Unknown accountId/);
      expect(body.accountIds).toContain("ghost");
    });

    it("upserts accounts and logs an audit entry", async () => {
      const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
      const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
      mockInsert.mockReturnValue({ values });

      const res = await buildApp().request("/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accounts: [
            {
              id: "a1",
              pluginId: "aws",
              displayName: "Prod",
              credentials: { k: "v" },
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
      expect(mockInsert).toHaveBeenCalled();
      expect(mockRequireScope).toHaveBeenCalledWith(AUTH, "resources:write");
    });
  });

  describe("GET /status", () => {
    it("returns the max sync version across accounts and resources", async () => {
      const acctWhere = vi.fn().mockResolvedValue([{ accounts: 7 }]);
      const acctFrom = vi.fn().mockReturnValue({ where: acctWhere });
      const resWhere = vi.fn().mockResolvedValue([{ resources: 12 }]);
      const resFrom = vi.fn().mockReturnValue({ where: resWhere });
      mockSelect.mockReturnValueOnce({ from: acctFrom }).mockReturnValueOnce({ from: resFrom });

      const res = await buildApp().request("/status", {
        method: "GET",
        headers: { authorization: "Bearer iwk_x" },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).maxSyncVersion).toBe(12);
    });
  });
});
