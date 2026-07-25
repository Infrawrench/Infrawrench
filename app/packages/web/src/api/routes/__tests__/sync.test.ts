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
const { dashboards, resources } = await import("@/db/schema");

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

    it.each([[-1], [-999], [1.5], ["0"], [null]])(
      "rejects lastSyncVersion %p",
      async (lastSyncVersion) => {
        // Every row starts at sync_version 0, so a negative value would turn
        // `syncVersion > lastSyncVersion` into "match everything".
        const res = await buildApp().request("/pull", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lastSyncVersion }),
        });
        expect(res.status).toBe(400);
        expect(mockSelect).not.toHaveBeenCalled();
      },
    );

    it("never returns credential ciphertext, only hasCredentials", async () => {
      // The ciphertext is sealed with the server's master key, so no client can
      // read it. Shipping it put credential-shaped material on the wire under
      // `resources:read`, when reading a real credential needs `secrets:read`.
      const projections: Array<Record<string, unknown>> = [];
      mockSelect.mockImplementation((projection?: Record<string, unknown>) => {
        if (projection) projections.push(projection);
        const where = vi.fn().mockResolvedValue([]);
        const innerJoin = vi.fn().mockReturnValue({ where });
        return { from: vi.fn().mockReturnValue({ where, innerJoin }) };
      });

      const res = await buildApp().request("/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lastSyncVersion: 0 }),
      });
      expect(res.status).toBe(200);

      const accountProjection = projections[0]!;
      expect(accountProjection).toHaveProperty("hasCredentials");
      expect(accountProjection).not.toHaveProperty("encryptedCredentials");
      expect(accountProjection).not.toHaveProperty("credentialsIv");
    });

    it("returns rows for accounts/resources/dashboards/pins/associations", async () => {
      // Three org-scoped selects end in .where(); pins and associations have no
      // organization_id of their own, so they .innerJoin() their parent first.
      const makeWhereSelect = (rows: unknown[]) => {
        const where = vi.fn().mockResolvedValue(rows);
        const from = vi.fn().mockReturnValue({ where });
        return { from };
      };
      const joins: unknown[] = [];
      const makeJoinSelect = (rows: unknown[]) => {
        const where = vi.fn().mockResolvedValue(rows);
        const innerJoin = vi.fn().mockImplementation((table: unknown) => {
          joins.push(table);
          return { where };
        });
        const from = vi.fn().mockReturnValue({ innerJoin, where });
        return { from };
      };
      mockSelect
        .mockReturnValueOnce(makeWhereSelect([{ id: "a1" }]))
        .mockReturnValueOnce(makeWhereSelect([{ id: "r1" }]))
        .mockReturnValueOnce(makeWhereSelect([{ id: "d1" }]))
        .mockReturnValueOnce(makeJoinSelect([{ id: "pin1" }]))
        .mockReturnValueOnce(makeJoinSelect([{ id: "assoc1" }]));

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
      // Regression guard: both parentless tables must be joined to an
      // org-scoped parent. Querying them bare leaks every tenant's rows.
      expect(joins).toEqual([dashboards, resources]);
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
    it("returns the max sync version across every table /pull returns", async () => {
      // One GREATEST(...) query rather than one per table. It must cover all
      // five: a client that advances its watermark to this number steps over
      // anything from a table left out, permanently.
      const from = vi.fn().mockResolvedValue([{ max: 12 }]);
      mockSelect.mockReturnValue({ from });

      const res = await buildApp().request("/status", {
        method: "GET",
        headers: { authorization: "Bearer iwk_x" },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).maxSyncVersion).toBe(12);

      const projection = mockSelect.mock.calls[0]![0] as { max: { queryChunks: unknown[] } };
      const sqlText = JSON.stringify(projection.max.queryChunks);
      for (const table of [
        "accounts",
        "resources",
        "dashboards",
        "dashboard_pins",
        "associations",
      ]) {
        expect(sqlText, `status must consider ${table}`).toContain(table);
      }
    });

    it("reports 0 for a brand-new org rather than failing", async () => {
      const from = vi.fn().mockResolvedValue([]);
      mockSelect.mockReturnValue({ from });
      const res = await buildApp().request("/status", {
        method: "GET",
        headers: { authorization: "Bearer iwk_x" },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).maxSyncVersion).toBe(0);
    });
  });
});
