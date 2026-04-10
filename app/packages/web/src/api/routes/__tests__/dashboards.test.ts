import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AuthSession } from "@/api/auth-middleware";

// ── Mocks ──────────────────────────────────────────────────────────────────
const mockInsert = vi.fn();
const mockSelect = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();

vi.mock("@/db/client", () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    select: (...args: unknown[]) => mockSelect(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

vi.mock("uuid", () => ({ v4: () => "dash-uuid-1" }));

const { dashboardRoutes } = await import("@/api/routes/dashboards");

// ── Helper ────────────────────────────────────────────────────────────────
function buildApp() {
  const app = new Hono();
  const session: AuthSession = {
    userId: "user-1",
    organizationId: "org-1",
    email: "test@example.com",
  };
  app.use("*", async (c, next) => {
    c.set("session", session);
    return next();
  });
  app.route("/", dashboardRoutes);
  return app;
}

/** Builds a drizzle-style chained query mock: select().from().where().orderBy().limit() */
function chainMock(result: unknown) {
  const limit = vi.fn().mockResolvedValue(result);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockImplementation(() => {
    // Some chains need orderBy, some need limit directly
    return { orderBy, limit };
  });
  const innerJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ where, innerJoin });
  return { from, where, orderBy, limit, innerJoin };
}

describe("Dashboard routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── GET / — list dashboards ───────────────────────────────────────────
  describe("GET / — list dashboards", () => {
    it("returns dashboards for the org", async () => {
      const rows = [
        { id: "d1", name: "Home", isDefault: true },
        { id: "d2", name: "Prod", isDefault: false },
      ];
      // select().from().where().orderBy() resolves to rows
      const orderBy = vi.fn().mockResolvedValue(rows);
      const where = vi.fn().mockReturnValue({ orderBy });
      const from = vi.fn().mockReturnValue({ where });
      mockSelect.mockReturnValue({ from });

      const app = buildApp();
      const res = await app.request("/", { method: "GET" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(2);
      expect(body[0].name).toBe("Home");
    });
  });

  // ── POST / — create dashboard ─────────────────────────────────────────
  describe("POST / — create a dashboard", () => {
    it("creates a dashboard with isDefault=false", async () => {
      const created = { id: "dash-uuid-1", name: "Staging", isDefault: false };
      const returning = vi.fn().mockResolvedValue([created]);
      const values = vi.fn().mockReturnValue({ returning });
      mockInsert.mockReturnValue({ values });

      const app = buildApp();
      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Staging" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.isDefault).toBe(false);
      expect(body.name).toBe("Staging");
    });
  });

  // ── GET /default/full — auto-create default ───────────────────────────
  describe("GET /default/full — get-or-create default dashboard", () => {
    it("creates the default dashboard when none exists", async () => {
      // First select() for finding default dashboard returns empty
      const selectChain1 = chainMock([]);
      // Second select() for pins returns empty array
      const selectChain2 = chainMock([]);

      let selectCallCount = 0;
      mockSelect.mockImplementation(() => {
        selectCallCount++;
        return selectCallCount === 1 ? selectChain1 : selectChain2;
      });

      const defaultDash = { id: "dash-uuid-1", name: "Home", isDefault: true, organizationId: "org-1" };
      const returning = vi.fn().mockResolvedValue([defaultDash]);
      const values = vi.fn().mockReturnValue({ returning });
      mockInsert.mockReturnValue({ values });

      const app = buildApp();
      const res = await app.request("/default/full", { method: "GET" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.dashboard.name).toBe("Home");
      expect(body.dashboard.isDefault).toBe(true);
      expect(mockInsert).toHaveBeenCalled();
    });
  });

  // ── DELETE /:id — delete dashboard ────────────────────────────────────
  describe("DELETE /:id — delete a dashboard", () => {
    it("prevents deletion of the default dashboard", async () => {
      const chain = chainMock([{ isDefault: true }]);
      mockSelect.mockReturnValue(chain);

      const app = buildApp();
      const res = await app.request("/d1", { method: "DELETE" });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/default/i);
    });

    it("deletes a non-default dashboard", async () => {
      const chain = chainMock([{ isDefault: false }]);
      mockSelect.mockReturnValue(chain);

      const where = vi.fn().mockResolvedValue(undefined);
      mockDelete.mockReturnValue({ where });

      const app = buildApp();
      const res = await app.request("/d2", { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      // Deletes pins first, then the dashboard
      expect(mockDelete).toHaveBeenCalledTimes(2);
    });

    it("returns 404 when dashboard does not exist", async () => {
      const chain = chainMock([]);
      mockSelect.mockReturnValue(chain);

      const app = buildApp();
      const res = await app.request("/nonexistent", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });

  // ── POST /pin — pin a resource ────────────────────────────────────────
  describe("POST /pin — pin a resource to a dashboard", () => {
    it("inserts a pin with onConflictDoNothing", async () => {
      // select for dashboard check
      const dashChain = chainMock([{ id: "d1" }]);
      // select for resource check
      const resChain = chainMock([{ id: "r1" }]);

      let selectCallCount = 0;
      mockSelect.mockImplementation(() => {
        selectCallCount++;
        return selectCallCount === 1 ? dashChain : resChain;
      });

      const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
      const values = vi.fn().mockReturnValue({ onConflictDoNothing });
      mockInsert.mockReturnValue({ values });

      const app = buildApp();
      const res = await app.request("/pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dashboardId: "d1", resourceId: "r1" }),
      });

      expect(res.status).toBe(200);
      expect(onConflictDoNothing).toHaveBeenCalled();
    });

    it("returns 404 if dashboard not found", async () => {
      const chain = chainMock([]);
      mockSelect.mockReturnValue(chain);

      const app = buildApp();
      const res = await app.request("/pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dashboardId: "bad", resourceId: "r1" }),
      });
      expect(res.status).toBe(404);
    });
  });

  // ── POST /unpin — unpin a resource ────────────────────────────────────
  describe("POST /unpin — unpin a resource", () => {
    it("deletes the pin and returns ok", async () => {
      const dashChain = chainMock([{ id: "d1" }]);
      mockSelect.mockReturnValue(dashChain);

      const where = vi.fn().mockResolvedValue(undefined);
      mockDelete.mockReturnValue({ where });

      const app = buildApp();
      const res = await app.request("/unpin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dashboardId: "d1", resourceId: "r1" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });
  });
});
