import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthSession } from "@/api/auth-middleware";
import { buildTestApp } from "./test-utils";

const mockSelect = vi.fn();

vi.mock("@/db/client", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
  },
}));

const mockQueryCosts = vi.fn();
const mockGetCostDimensionValues = vi.fn();
const mockGetCostTagKeys = vi.fn();
const mockGetCostCoverage = vi.fn();

vi.mock("@infrawrench/server-core/clickhouse/cost-readers", () => ({
  queryCosts: (...args: unknown[]) => mockQueryCosts(...args),
  getCostDimensionValues: (...args: unknown[]) => mockGetCostDimensionValues(...args),
  getCostTagKeys: (...args: unknown[]) => mockGetCostTagKeys(...args),
  getCostCoverage: (...args: unknown[]) => mockGetCostCoverage(...args),
}));

vi.mock("@infrawrench/server-core/cost/forecast", () => ({
  forecastDaily: vi.fn().mockReturnValue([]),
}));

vi.mock("@/plugins/loader", () => ({
  getPlugin: vi.fn().mockResolvedValue({
    plugin: { manifest: { id: "aws", displayName: "AWS", costs: { dimensions: ["service"] } } },
  }),
  loadPlugins: vi
    .fn()
    .mockResolvedValue([{ plugin: { manifest: { id: "aws", displayName: "AWS" } } }]),
}));

const { costRoutes } = await import("@/api/routes/costs");

const buildApp = () => buildTestApp(costRoutes);

/** App whose session carries only the given permissions. */
function buildAppWithPermissions(permissions: string[]): Hono {
  const app = new Hono();
  const session: AuthSession = { userId: "user-1", email: "test@example.com" };
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    throw err;
  });
  app.use("*", async (c, next) => {
    c.set("session", session);
    c.set("organizationId", "org-1");
    c.set("permissions", permissions);
    c.set("role", null);
    return next();
  });
  app.route("/", costRoutes);
  return app;
}

const validQuery = {
  from: "2026-07-01",
  to: "2026-07-20",
  binning: "daily",
  groupBy: "provider",
  filters: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockQueryCosts.mockResolvedValue([]);
});

describe("POST /query", () => {
  it("rejects without costs:read", async () => {
    const app = buildAppWithPermissions(["dashboards:read"]);
    const res = await app.request("/query", {
      method: "POST",
      body: JSON.stringify(validQuery),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects malformed bodies with 400", async () => {
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, binning: "hourly" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects tag grouping without a tag key", async () => {
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, groupBy: "tag" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects inverted date ranges", async () => {
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, from: "2026-08-01", to: "2026-07-01" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("folds groups beyond topN into Other and labels providers", async () => {
    mockQueryCosts.mockResolvedValue([
      { key: "aws", currency: "USD", points: [{ bucket: "2026-07-01", amount: 100 }] },
      { key: "gcp", currency: "USD", points: [{ bucket: "2026-07-01", amount: 50 }] },
      { key: "fly", currency: "USD", points: [{ bucket: "2026-07-01", amount: 10 }] },
    ]);
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, topN: 2 }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      series: Array<{ key: string; label: string }>;
      totals: Record<string, number>;
    };
    expect(body.series.map((s) => s.key)).toEqual(["aws", "gcp", "__other__"]);
    expect(body.series[0]!.label).toBe("AWS");
    expect(body.series[2]!.label).toBe("Other");
    expect(body.totals["USD"]).toBe(160);
  });

  it("returns a shifted previous period when requested", async () => {
    mockQueryCosts.mockResolvedValue([]);
    const res = await buildApp().request("/query", {
      method: "POST",
      body: JSON.stringify({ ...validQuery, comparePreviousPeriod: true }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(mockQueryCosts).toHaveBeenCalledTimes(2);
    const second = mockQueryCosts.mock.calls[1]![1] as { from: string; to: string };
    // 20-day span shifted back 20 days.
    expect(second).toMatchObject({ from: "2026-06-11", to: "2026-06-30" });
  });
});

describe("GET /dimensions", () => {
  it("rejects unknown dimensions", async () => {
    const res = await buildApp().request("/dimensions?dimension=nope");
    expect(res.status).toBe(400);
  });

  it("requires tagKey for the tag dimension", async () => {
    const res = await buildApp().request("/dimensions?dimension=tag");
    expect(res.status).toBe(400);
  });

  it("lists tag keys via dimension=tag-keys", async () => {
    mockGetCostTagKeys.mockResolvedValue(["env", "team"]);
    const res = await buildApp().request("/dimensions?dimension=tag-keys");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ values: ["env", "team"] });
  });
});
