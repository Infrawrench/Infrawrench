import { describe, it, expect, vi, beforeEach } from "vitest";

process.env["ENCRYPTION_MASTER_KEY"] = Buffer.alloc(32, 7).toString("base64");

import { buildTestApp } from "./test-utils";

const mockInsert = vi.fn();
const mockSelect = vi.fn();
const mockDelete = vi.fn();
vi.mock("@/db/client", () => ({
  db: {
    insert: (...a: unknown[]) => mockInsert(...a),
    select: (...a: unknown[]) => mockSelect(...a),
    delete: (...a: unknown[]) => mockDelete(...a),
  },
}));

vi.mock("@/services/audit", () => ({ logAudit: vi.fn() }));

const mockIsBastionConnected = vi.fn();
vi.mock("@infrawrench/server-core/bastion/registry", () => ({
  isBastionConnected: (...a: unknown[]) => mockIsBastionConnected(...a),
}));

vi.mock("uuid", () => ({ v4: () => "bastion-uuid-1" }));

const { bastionRoutes } = await import("@/api/routes/bastions");
const buildApp = () => buildTestApp(bastionRoutes);

describe("Bastion routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsBastionConnected.mockReturnValue(false);
  });

  describe("POST /", () => {
    it("registers a bastion and returns a one-time token", async () => {
      const values = vi.fn().mockResolvedValue(undefined);
      mockInsert.mockReturnValue({ values });

      const res = await buildApp().request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "  edge-1  " }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("bastion-uuid-1");
      expect(body.name).toBe("edge-1");
      expect(body.token).toMatch(/^iwb_/);
      expect(body.tokenPrefix).toBe(body.token.slice(0, 12));
      // Stored hashedToken should never equal the raw token.
      const stored = values.mock.calls[0]![0];
      expect(stored.hashedToken).not.toBe(body.token);
      expect(stored.status).toBe("pending");
    });

    it("rejects a blank name", async () => {
      const res = await buildApp().request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "  " }),
      });
      expect(res.status).toBe(400);
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });

  describe("GET /", () => {
    it("lists bastions with live connected flag and account counts", async () => {
      const orderBy = vi.fn().mockResolvedValue([
        {
          id: "b1",
          name: "edge",
          tokenPrefix: "iwb_abc",
          agentVersion: "1.0.0",
          lastSeenAt: new Date("2026-01-02T00:00:00Z"),
          status: "online",
          revokedAt: null,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          createdByUserId: "user-1",
        },
      ]);
      const listWhere = vi.fn().mockReturnValue({ orderBy });
      const listFrom = vi.fn().mockReturnValue({ where: listWhere });

      const groupBy = vi.fn().mockResolvedValue([{ bastionId: "b1", count: 3 }]);
      const countWhere = vi.fn().mockReturnValue({ groupBy });
      const countFrom = vi.fn().mockReturnValue({ where: countWhere });

      mockSelect.mockReturnValueOnce({ from: listFrom }).mockReturnValueOnce({ from: countFrom });
      mockIsBastionConnected.mockReturnValue(true);

      const res = await buildApp().request("/");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({
        id: "b1",
        connected: true,
        accountCount: 3,
        lastSeenAt: "2026-01-02T00:00:00.000Z",
      });
    });
  });

  describe("DELETE /:id", () => {
    it("revokes a bastion and returns ok", async () => {
      const returning = vi.fn().mockResolvedValue([{ id: "b1" }]);
      const where = vi.fn().mockReturnValue({ returning });
      mockDelete.mockReturnValue({ where });

      const res = await buildApp().request("/b1", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    });

    it("returns 404 when the bastion is not found", async () => {
      const returning = vi.fn().mockResolvedValue([]);
      const where = vi.fn().mockReturnValue({ returning });
      mockDelete.mockReturnValue({ where });

      const res = await buildApp().request("/missing", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });
});
