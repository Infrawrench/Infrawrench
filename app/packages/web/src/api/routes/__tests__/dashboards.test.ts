import { describe, it, expect, vi, beforeEach } from "vitest";
import { decrypt } from "@/services/encryption";
import { buildTestApp } from "./test-utils";

const mockInsert = vi.fn();
const mockSelect = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockTransaction = vi.fn();
const mockEvaluateKpi = vi.fn();
const mockLogAudit = vi.fn();

vi.mock("@/services/object-sharing", () => ({
  // Sharing is covered by its own suite; here every object is visible.
  filterVisibleObjects: async (_o: string, _t: string, items: unknown[]) => items,
  resolveSharingPrincipal: async () => ({ override: true }),
  runWithSharingPrincipal: (_p: unknown, fn: () => unknown) => fn(),
  grantCreatorOwnership: async () => undefined,
  deleteObjectSharing: async () => undefined,
  requireObjectAccess: async () => "owner",
  loadObjectMeta: async () => ({ name: "x" }),
  listVisibleCostReportFolders: undefined,
  ObjectNotVisibleError: class extends Error {},
  ObjectAccessDeniedError: class extends Error {},
  SharingInputError: class extends Error {},
}));
vi.mock("@/db/client", () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    select: (...args: unknown[]) => mockSelect(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
    transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

vi.mock("@/services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

vi.mock("@/services/dashboard-kpi", () => {
  class DashboardKpiError extends Error {
    constructor(
      message: string,
      readonly status: number = 400,
    ) {
      super(message);
    }
  }
  return {
    DashboardKpiError,
    evaluateDashboardKpi: (...args: unknown[]) => mockEvaluateKpi(...args),
  };
});

vi.mock("uuid", () => ({ v4: () => "dash-uuid-1" }));

// Resolution has its own suite (services/__tests__/default-dashboards.test.ts);
// here it is a stub so the routes' query chains stay the ones under test.
const resolution = {
  dashboardId: "d1",
  dashboardName: "Home",
  source: "org",
  userDefaultDashboardId: null,
  roleDefault: null,
  orgDefaultDashboardId: "d1",
  skipped: [],
};
const mockResolve = vi.fn();
const mockSetMine = vi.fn();
const mockClearMine = vi.fn();
const mockListRoleDefaults = vi.fn();
const mockSetRole = vi.fn();
const mockClearRole = vi.fn();
vi.mock("@/services/default-dashboards", () => {
  class DefaultDashboardError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return {
    DefaultDashboardError,
    resolveDefaultDashboard: (...a: unknown[]) => mockResolve(...a),
    setMyDefaultDashboard: (...a: unknown[]) => mockSetMine(...a),
    clearMyDefaultDashboard: (...a: unknown[]) => mockClearMine(...a),
    listRoleDefaultDashboards: (...a: unknown[]) => mockListRoleDefaults(...a),
    setRoleDefaultDashboard: (...a: unknown[]) => mockSetRole(...a),
    clearRoleDefaultDashboard: (...a: unknown[]) => mockClearRole(...a),
  };
});

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

const { DashboardKpiError } = await import("@/services/dashboard-kpi");

const buildApp = (permissions?: string[]) => buildTestApp(dashboardRoutes, permissions);

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
    mockResolve.mockResolvedValue(resolution);
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

    it("marks the dashboard the caller lands on", async () => {
      const rows = [
        { id: "d1", name: "Home", isDefault: true },
        { id: "d2", name: "Prod", isDefault: false },
      ];
      const orderBy = vi.fn().mockResolvedValue(rows);
      const where = vi.fn().mockReturnValue({ orderBy });
      mockSelect.mockReturnValue({ from: vi.fn().mockReturnValue({ where }) });
      mockResolve.mockResolvedValue({ ...resolution, dashboardId: "d2", source: "user" });

      const res = await buildApp().request("/", { method: "GET" });
      const body = (await res.json()) as Array<{ id: string; isResolvedDefault: boolean }>;
      expect(body.map((d) => [d.id, d.isResolvedDefault])).toEqual([
        ["d1", false],
        ["d2", true],
      ]);
      expect(mockResolve).toHaveBeenCalledWith("org-1", "user-1");
    });
  });

  describe("default dashboard resolution routes", () => {
    it("GET /default returns the caller's resolution", async () => {
      const res = await buildApp().request("/default", { method: "GET" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(resolution);
    });

    it("PUT /default/me sets the caller's default and returns the new resolution", async () => {
      mockSetMine.mockResolvedValue({ id: "d2", name: "Prod" });
      const res = await buildApp().request("/default/me", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dashboardId: "d2" }),
      });
      expect(res.status).toBe(200);
      expect(mockSetMine).toHaveBeenCalledWith("org-1", "user-1", "d2");
    });

    it("PUT /default/me rejects a missing dashboardId", async () => {
      const res = await buildApp().request("/default/me", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      expect(mockSetMine).not.toHaveBeenCalled();
    });

    it("PUT /default/me answers 404 for a dashboard the caller cannot open", async () => {
      const { DefaultDashboardError } = await import("@/services/default-dashboards");
      mockSetMine.mockRejectedValue(new DefaultDashboardError("Dashboard not found", 404));
      const res = await buildApp().request("/default/me", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dashboardId: "hidden" }),
      });
      expect(res.status).toBe(404);
    });

    it("DELETE /default/me clears the caller's default", async () => {
      const res = await buildApp().request("/default/me", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(mockClearMine).toHaveBeenCalledWith("org-1", "user-1");
    });

    it("GET /role-defaults needs team:read", async () => {
      mockListRoleDefaults.mockResolvedValue([]);
      const denied = await buildTestApp(dashboardRoutes, ["dashboards:read"]).request(
        "/role-defaults",
        { method: "GET" },
      );
      expect(denied.status).toBe(403);
      const ok = await buildApp().request("/role-defaults", { method: "GET" });
      expect(ok.status).toBe(200);
    });

    it("PUT /role-defaults/:roleId needs org:settings:write", async () => {
      const res = await buildTestApp(dashboardRoutes, ["dashboards:read", "team:read"]).request(
        "/role-defaults/r1",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dashboardId: "d2" }),
        },
      );
      expect(res.status).toBe(403);
      expect(mockSetRole).not.toHaveBeenCalled();
    });

    it("PUT /role-defaults/:roleId passes a sharing refusal through as 422", async () => {
      const { DefaultDashboardError } = await import("@/services/default-dashboards");
      mockSetRole.mockRejectedValue(
        new DefaultDashboardError("This dashboard is not shared with the Finance role.", 422),
      );
      const res = await buildApp().request("/role-defaults/r1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dashboardId: "d2" }),
      });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/not shared/);
    });

    it("PUT /role-defaults/:roleId returns the role's new default", async () => {
      mockSetRole.mockResolvedValue({
        role: { id: "r1", name: "Finance", isSystem: false, systemKey: null },
        dashboard: { id: "d2", name: "Prod" },
      });
      const res = await buildApp().request("/role-defaults/r1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dashboardId: "d2" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        roleId: "r1",
        roleName: "Finance",
        isSystem: false,
        systemKey: null,
        dashboardId: "d2",
      });
    });

    it("DELETE /role-defaults/:roleId clears it", async () => {
      mockClearRole.mockResolvedValue({ id: "r1", name: "Finance" });
      const res = await buildApp().request("/role-defaults/r1", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(mockClearRole).toHaveBeenCalledWith("org-1", "r1");
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

  describe("GET /default/full: the caller's default dashboard", () => {
    it("loads the dashboard the resolution picked", async () => {
      // First select() loads the resolved dashboard row.
      const selectChain1 = chainMock([
        { id: "d1", name: "Home", isDefault: true, organizationId: "org-1" },
      ]);
      // Later selects: pins/workflow pins use innerJoin().where().orderBy(),
      // widgets use where().orderBy() directly; support both, resolving [].
      const pinsOrderBy = vi.fn().mockResolvedValue([]);
      const pinsWhere = vi.fn().mockReturnValue({ orderBy: pinsOrderBy });
      const pinsInnerJoin = vi.fn().mockReturnValue({ where: pinsWhere });
      const pinsFrom = vi.fn().mockReturnValue({ innerJoin: pinsInnerJoin, where: pinsWhere });
      const selectChain2 = { from: pinsFrom };

      let selectCallCount = 0;
      mockSelect.mockImplementation(() => {
        selectCallCount++;
        return selectCallCount === 1 ? selectChain1 : selectChain2;
      });

      const app = buildApp();
      const res = await app.request("/default/full", { method: "GET" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.dashboard.name).toBe("Home");
      expect(body.dashboard.isDefault).toBe(true);
      expect(body.resolution).toEqual(resolution);
      expect(mockResolve).toHaveBeenCalledWith("org-1", "user-1");
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
    it("inserts a pin with a sync_version, no-oping if already pinned", async () => {
      // select for dashboard check
      const dashChain = chainMock([{ id: "d1" }]);
      // select for resource check
      const resChain = chainMock([{ id: "r1" }]);
      // select for max(gridX) query, where() is awaited directly (no .limit())
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
      // Inserted rows must carry a sync_version, or /pull never returns them.
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({ syncVersion: expect.anything() }),
      );
      // Already pinned → leave the existing card's position alone.
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

  describe("POST /:id/reorder — persist card order", () => {
    /** Captures the `set` payload of every update() in call order. */
    function captureUpdates() {
      const sets: Array<Record<string, unknown>> = [];
      mockUpdate.mockImplementation(() => ({
        set: (payload: Record<string, unknown>) => {
          sets.push(payload);
          return { where: vi.fn().mockResolvedValue(undefined) };
        },
      }));
      return sets;
    }

    it("numbers every card kind into one sequence", async () => {
      mockSelect.mockReturnValue(chainMock([{ id: "d1" }]));
      const sets = captureUpdates();

      const app = buildApp();
      const res = await app.request("/d1/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cards: [
            { kind: "widget", id: "w1" },
            { kind: "resource", id: "r1" },
            { kind: "workflow", id: "f1" },
          ],
        }),
      });

      expect(res.status).toBe(200);
      // gridX is the index within the merged grid, not within each table.
      expect(sets.map((s) => s["gridX"])).toEqual([0, 1, 2]);
      // Only resource pins carry a sync version: they are the only kind the
      // desktop sync protocol pushes.
      expect(sets[1]).toHaveProperty("syncVersion");
      expect(sets[0]).not.toHaveProperty("syncVersion");
    });

    it("still accepts the resource-only body", async () => {
      mockSelect.mockReturnValue(chainMock([{ id: "d1" }]));
      const sets = captureUpdates();

      const app = buildApp();
      const res = await app.request("/d1/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceIds: ["r1", "r2"] }),
      });

      expect(res.status).toBe(200);
      expect(sets).toHaveLength(2);
      expect(sets.every((s) => "syncVersion" in s)).toBe(true);
    });

    it("rejects an unknown card kind rather than silently skipping it", async () => {
      mockSelect.mockReturnValue(chainMock([{ id: "d1" }]));
      captureUpdates();

      const app = buildApp();
      const res = await app.request("/d1/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cards: [{ kind: "chart", id: "c1" }] }),
      });

      expect(res.status).toBe(400);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("returns 404 for a dashboard in another org", async () => {
      mockSelect.mockReturnValue(chainMock([]));
      captureUpdates();

      const app = buildApp();
      const res = await app.request("/d1/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cards: [{ kind: "resource", id: "r1" }] }),
      });

      expect(res.status).toBe(404);
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe("POST /unpin — unpin a resource", () => {
    it("hard-deletes the pin and returns ok", async () => {
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
      // No tombstone: sync is push-only, so nothing would ever read one.
      expect(mockDelete).toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
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

  describe("POST /validate-tabs — validate restored workspace tabs", () => {
    it("keeps the tabs that aren't backed by a row and drops missing dashboards", async () => {
      mockSelect.mockReturnValue(chainMock([]));

      const app = buildApp();
      const res = await app.request("/validate-tabs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tabs: [
            { id: "agents", target: { kind: "agents" } },
            { id: "costs", target: { kind: "costs" } },
            { id: "workflows", target: { kind: "workflows" } },
            { id: "deployments", target: { kind: "deployments" } },
            { id: "chat", target: { kind: "chat" } },
            { id: "dashboard:gone", target: { kind: "dashboard", dashboardId: "gone" } },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(new Set(body.validTabIds)).toEqual(
        new Set(["agents", "costs", "workflows", "deployments", "chat"]),
      );
    });
  });
});

describe("Dashboard widgets: KPI, duplicate, spans", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const kpiConfig = {
    version: 1,
    source: { kind: "cost_report", reportId: "r1", measure: "cost", aggregation: "sum" },
    comparePreviousPeriod: true,
  };

  describe("POST /kpi", () => {
    it("answers a KPI config through the evaluator", async () => {
      mockEvaluateKpi.mockResolvedValue({ value: 120, unit: "money", currency: "USD" });
      const res = await buildApp().request("/kpi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: kpiConfig }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ value: 120 });
      expect(mockEvaluateKpi).toHaveBeenCalledWith(
        "org-1",
        expect.objectContaining({ source: expect.objectContaining({ reportId: "r1" }) }),
        expect.objectContaining({ granted: ["*"] }),
      );
    });

    it("refuses a config the cross-field rules reject", async () => {
      const res = await buildApp().request("/kpi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: {
            ...kpiConfig,
            source: { kind: "budget", budgetId: "b1", measure: "actual" },
            dateRange: { kind: "relative", preset: "30d" },
          },
        }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/budget's own period/);
      expect(mockEvaluateKpi).not.toHaveBeenCalled();
    });

    it("needs costs:read, and budgets:read for a budget", async () => {
      const noCosts = await buildApp(["dashboards:read"]).request("/kpi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: kpiConfig }),
      });
      expect(noCosts.status).toBe(403);

      const noBudgets = await buildApp(["dashboards:read", "costs:read"]).request("/kpi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: { ...kpiConfig, source: { kind: "budget", budgetId: "b1", measure: "actual" } },
        }),
      });
      expect(noBudgets.status).toBe(403);
      expect(mockEvaluateKpi).not.toHaveBeenCalled();
    });

    it("maps an unanswerable config to its status", async () => {
      mockEvaluateKpi.mockRejectedValue(
        new DashboardKpiError("This saved report was deleted", 404),
      );
      const res = await buildApp().request("/kpi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: kpiConfig }),
      });
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/deleted/);
    });
  });

  describe("POST /widgets", () => {
    /** Dashboard lookup, then the three max(gridX) reads. */
    function dashboardThenMax(max: number) {
      mockSelect.mockReturnValueOnce(chainMock([{ id: "d1" }])).mockReturnValue({
        from: () => ({ where: vi.fn().mockResolvedValue([{ value: max }]) }),
      });
    }

    it("starts a KPI card single width and a text card double width", async () => {
      const captured: Array<Record<string, unknown>> = [];
      mockInsert.mockReturnValue({
        values: (v: Record<string, unknown>) => {
          captured.push(v);
          return { returning: vi.fn().mockResolvedValue([{ id: "w-new", ...v }]) };
        },
      });

      const app = buildApp();
      dashboardThenMax(4);
      const kpi = await app.request("/widgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dashboardId: "d1",
          kind: "kpi",
          config: {
            version: 1,
            source: { kind: "commitments", measure: "coverage" },
            comparePreviousPeriod: true,
          },
        }),
      });
      expect(kpi.status).toBe(200);
      expect(captured[0]).toMatchObject({ kind: "kpi", gridW: 1, gridH: 1, gridX: 5 });

      dashboardThenMax(4);
      const text = await app.request("/widgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dashboardId: "d1",
          kind: "text",
          config: { version: 1, markdown: "# Notes" },
        }),
      });
      expect(text.status).toBe(200);
      expect(captured[1]).toMatchObject({ kind: "text", gridW: 2, gridH: 1 });
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "dashboard_widget.create" }),
      );
    });

    it("refuses markdown past the limit", async () => {
      mockSelect.mockReturnValueOnce(chainMock([{ id: "d1" }]));
      const res = await buildApp().request("/widgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dashboardId: "d1",
          kind: "text",
          config: { version: 1, markdown: "x".repeat(20_001) },
        }),
      });
      expect(res.status).toBe(400);
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /widgets/:id spans", () => {
    const widgetRow = {
      id: "w1",
      organizationId: "org-1",
      dashboardId: "d1",
      kind: "cost_graph",
      title: "Spend",
      config: {},
      gridX: 0,
      gridY: 0,
      gridW: 2,
      gridH: 1,
    };

    it("stores a resize without auditing it", async () => {
      mockSelect.mockReturnValue(chainMock([widgetRow]));
      const sets: Array<Record<string, unknown>> = [];
      mockUpdate.mockReturnValue({
        set: (v: Record<string, unknown>) => {
          sets.push(v);
          return {
            where: () => ({ returning: vi.fn().mockResolvedValue([{ ...widgetRow, ...v }]) }),
          };
        },
      });
      const res = await buildApp().request("/widgets/w1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gridW: 3, gridH: 2 }),
      });
      expect(res.status).toBe(200);
      expect(sets[0]).toMatchObject({ gridW: 3, gridH: 2 });
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it("refuses a span outside 1..12", async () => {
      mockSelect.mockReturnValue(chainMock([widgetRow]));
      for (const body of [{ gridW: 0 }, { gridH: 13 }, { gridW: 1.5 }]) {
        const res = await buildApp().request("/widgets/w1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(400);
      }
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe("POST /widgets/:id/duplicate", () => {
    it("inserts the copy right after the original and shifts the cards behind it", async () => {
      const original = {
        id: "w1",
        organizationId: "org-1",
        dashboardId: "d1",
        kind: "text",
        title: "Notes",
        config: { version: 1, markdown: "hi" },
        gridX: 3,
        gridY: 0,
        gridW: 4,
        gridH: 2,
      };
      mockSelect.mockReturnValueOnce(chainMock([original])).mockReturnValueOnce({
        from: () => ({ where: vi.fn().mockResolvedValue([{ title: "Notes" }]) }),
      });
      const shifts: Array<Record<string, unknown>> = [];
      const inserted: Array<Record<string, unknown>> = [];
      mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
        fn({
          update: () => ({
            set: (v: Record<string, unknown>) => {
              shifts.push(v);
              return { where: vi.fn().mockResolvedValue(undefined) };
            },
          }),
          insert: () => ({
            values: (v: Record<string, unknown>) => {
              inserted.push(v);
              return { returning: vi.fn().mockResolvedValue([{ ...v, id: "w2" }]) };
            },
          }),
        }),
      );

      const res = await buildApp().request("/widgets/w1/duplicate", { method: "POST" });
      expect(res.status).toBe(200);
      // All three card tables move along, so the copy's slot is free.
      expect(shifts).toHaveLength(3);
      expect(shifts[0]).toHaveProperty("syncVersion");
      expect(inserted[0]).toMatchObject({
        kind: "text",
        title: "Copy of Notes",
        config: { version: 1, markdown: "hi" },
        gridX: 4,
        gridW: 4,
        gridH: 2,
      });
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "dashboard_widget.duplicate" }),
      );
    });

    it("returns 404 for a widget that does not exist", async () => {
      mockSelect.mockReturnValueOnce(chainMock([]));
      const res = await buildApp().request("/widgets/nope/duplicate", { method: "POST" });
      expect(res.status).toBe(404);
      expect(mockTransaction).not.toHaveBeenCalled();
    });
  });
});
