import { describe, it, expect, vi, beforeEach } from "vitest";
import { getPlugin } from "@/plugins/loader";
import { decrypt } from "@/services/encryption";
import { buildTestApp } from "./test-utils";

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

vi.mock("@/plugins/loader", () => ({
  getPlugin: vi.fn().mockResolvedValue({
    plugin: {
      manifest: { logoSvg: "<svg/>", displayName: "Mock Plugin" },
      resourceTypes: [],
      createClient: () => ({}),
    },
  }),
}));

vi.mock("@/services/encryption", () => ({
  decrypt: vi.fn().mockResolvedValue("{}"),
}));

const mockGetLatestStatsBatch = vi.fn();
const mockGetLatestMetricsBatch = vi.fn();
const mockGetLatestAccountCountsBatch = vi.fn();
const mockGetLatestStats = vi.fn();
const mockGetLatestMetrics = vi.fn();
const mockGetMetricRange = vi.fn();

vi.mock("@infrawrench/server-core/clickhouse/readers", () => ({
  getLatestStatsBatch: (...args: unknown[]) => mockGetLatestStatsBatch(...args),
  getLatestMetricsBatch: (...args: unknown[]) => mockGetLatestMetricsBatch(...args),
  getLatestAccountCountsBatch: (...args: unknown[]) => mockGetLatestAccountCountsBatch(...args),
  getLatestStats: (...args: unknown[]) => mockGetLatestStats(...args),
  getLatestMetrics: (...args: unknown[]) => mockGetLatestMetrics(...args),
  getMetricRange: (...args: unknown[]) => mockGetMetricRange(...args),
}));

const { dashboardRoutes } = await import("@/api/routes/dashboards");

const buildApp = () => buildTestApp(dashboardRoutes);

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
    vi.mocked(decrypt).mockResolvedValue("{}");
    mockGetLatestStatsBatch.mockResolvedValue(new Map());
    mockGetLatestMetricsBatch.mockResolvedValue(new Map());
    mockGetLatestAccountCountsBatch.mockResolvedValue(new Map());
    mockGetLatestStats.mockResolvedValue(null);
    mockGetLatestMetrics.mockResolvedValue(null);
    mockGetMetricRange.mockResolvedValue([]);
  });

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

  describe("GET /default/full — get-or-create default dashboard", () => {
    it("creates the default dashboard when none exists", async () => {
      // First select() for finding default dashboard returns empty
      const selectChain1 = chainMock([]);
      // Second select() for pins — uses innerJoin().where().orderBy()
      const pinsOrderBy = vi.fn().mockResolvedValue([]);
      const pinsWhere = vi.fn().mockReturnValue({ orderBy: pinsOrderBy });
      const pinsInnerJoin = vi.fn().mockReturnValue({ where: pinsWhere });
      const pinsFrom = vi.fn().mockReturnValue({ innerJoin: pinsInnerJoin });
      const selectChain2 = { from: pinsFrom };

      let selectCallCount = 0;
      mockSelect.mockImplementation(() => {
        selectCallCount++;
        return selectCallCount === 1 ? selectChain1 : selectChain2;
      });

      const defaultDash = {
        id: "dash-uuid-1",
        name: "Home",
        isDefault: true,
        organizationId: "org-1",
      };
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

  describe("POST /pin — pin a resource to a dashboard", () => {
    it("inserts a pin with onConflictDoNothing", async () => {
      // select for dashboard check
      const dashChain = chainMock([{ id: "d1" }]);
      // select for resource check
      const resChain = chainMock([{ id: "r1" }]);
      // select for max(gridX) query — where() is awaited directly (no .limit())
      const maxWhere = vi.fn().mockResolvedValue([{ maxX: 0 }]);
      const maxFrom = vi.fn().mockReturnValue({ where: maxWhere });
      const maxChain = { from: maxFrom };

      let selectCallCount = 0;
      mockSelect.mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return dashChain;
        if (selectCallCount === 2) return resChain;
        return maxChain;
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

  describe("POST /probe — probe dashboard cards", () => {
    it("projects ClickHouse stats/metrics into ProbeStatus", async () => {
      const stats = [{ label: "Status", value: "Healthy", variant: "status-healthy" }];
      const rows = [
        { resourceId: "res-1", resourceTypeId: "mock-type", accountId: "acct-1" },
        { resourceId: "res-2", resourceTypeId: "mock-type", accountId: "acct-1" },
      ];
      // probe does select().from().innerJoin().where() and awaits where directly
      const where = vi.fn().mockResolvedValue(rows);
      const innerJoin = vi.fn().mockReturnValue({ where });
      const from = vi.fn().mockReturnValue({ innerJoin });
      mockSelect.mockReturnValue({ from });

      mockGetLatestStatsBatch.mockResolvedValue(
        new Map([
          ["res-1", stats],
          ["res-2", stats],
        ]),
      );

      const app = buildApp();
      const res = await app.request("/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [
            {
              resourceId: "res-1",
              accountId: "acct-1",
              pluginId: "plugin-1",
              resourceTypeId: "mock-type",
            },
            {
              resourceId: "res-2",
              accountId: "acct-1",
              pluginId: "plugin-1",
              resourceTypeId: "mock-type",
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body["res-1"]?.phase).toBe("ok");
      expect(body["res-1"]?.stats).toEqual(stats);
      expect(body["res-2"]?.phase).toBe("ok");
      expect(mockGetLatestStatsBatch).toHaveBeenCalledWith("org-1", ["res-1", "res-2"]);
    });

    it("returns 'Resource not found' error for items missing from the DB", async () => {
      const where = vi.fn().mockResolvedValue([]);
      const innerJoin = vi.fn().mockReturnValue({ where });
      const from = vi.fn().mockReturnValue({ innerJoin });
      mockSelect.mockReturnValue({ from });

      const app = buildApp();
      const res = await app.request("/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [
            {
              resourceId: "missing",
              accountId: "acct-1",
              pluginId: "plugin-1",
              resourceTypeId: "mock-type",
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body["missing"]?.phase).toBe("error");
      expect(body["missing"]?.error).toBe("Resource not found");
    });
  });
});
