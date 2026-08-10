import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AuthSession } from "@/api/auth-middleware";
import { buildTestApp } from "./test-utils";

// Mocked rather than imported for real: the service reaches server-core's db
// client, which throws at import time without DATABASE_URL.
const mockListRules = vi.fn();
const mockCreateRule = vi.fn();
const mockGetRule = vi.fn();
const mockUpdateRule = vi.fn();
const mockSoftDeleteRule = vi.fn();
const mockListEvents = vi.fn();
const mockListSelectorOptions = vi.fn();
const mockPreviewSelector = vi.fn();
vi.mock("../../../services/metric-alerts", () => ({
  listRulesWithStatus: (...a: unknown[]) => mockListRules(...a),
  createRule: (...a: unknown[]) => mockCreateRule(...a),
  getRule: (...a: unknown[]) => mockGetRule(...a),
  updateRule: (...a: unknown[]) => mockUpdateRule(...a),
  softDeleteRule: (...a: unknown[]) => mockSoftDeleteRule(...a),
  listEvents: (...a: unknown[]) => mockListEvents(...a),
  listSelectorOptions: (...a: unknown[]) => mockListSelectorOptions(...a),
  previewSelector: (...a: unknown[]) => mockPreviewSelector(...a),
}));

const mockListMetricSeriesKeys = vi.fn();
vi.mock("@infrawrench/server-core/clickhouse/readers", () => ({
  listMetricSeriesKeys: (...a: unknown[]) => mockListMetricSeriesKeys(...a),
}));

const { metricAlertRoutes } = await import("@/api/routes/metric-alerts");

const buildApp = () => buildTestApp(metricAlertRoutes);

/** Same scaffold as buildTestApp but with a narrowed permission set. */
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
  app.route("/", metricAlertRoutes);
  return app;
}

const VALID_INPUT = {
  name: "High CPU",
  pluginId: "aws",
  resourceTypeId: null,
  tagKey: "env",
  tagValue: "prod",
  metricKey: "CPU %",
  comparator: ">",
  threshold: 90,
  forMinutes: 15,
  cooldownMinutes: 60,
  enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockListRules.mockResolvedValue([]);
  mockListEvents.mockResolvedValue([]);
  mockListMetricSeriesKeys.mockResolvedValue([]);
  mockListSelectorOptions.mockResolvedValue({ plugins: [], tagKeys: [] });
  mockPreviewSelector.mockResolvedValue({ matchingResourceCount: 0, sampleResourceNames: [] });
});

describe("metric alert routes", () => {
  it("lists rules", async () => {
    mockListRules.mockResolvedValue([{ id: "r1" }]);
    const res = await buildApp().request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "r1" }]);
    expect(mockListRules).toHaveBeenCalledWith("org-1");
  });

  it("creates a rule from a valid body", async () => {
    mockCreateRule.mockResolvedValue({ id: "r1" });
    const res = await buildApp().request("/", {
      method: "POST",
      body: JSON.stringify(VALID_INPUT),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(mockCreateRule).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ name: "High CPU", comparator: ">" }),
      "user-1",
    );
  });

  it("rejects an invalid comparator with 400", async () => {
    const res = await buildApp().request("/", {
      method: "POST",
      body: JSON.stringify({ ...VALID_INPUT, comparator: "!=" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(mockCreateRule).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with the documented 400, not a 500", async () => {
    const res = await buildApp().request("/", {
      method: "POST",
      body: "{not json",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid metric alert rule" });
    expect(mockCreateRule).not.toHaveBeenCalled();
  });

  it("rejects a window below the floor with 400", async () => {
    const res = await buildApp().request("/", {
      method: "POST",
      body: JSON.stringify({ ...VALID_INPUT, forMinutes: 1 }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("updates a rule and 404s when it does not exist", async () => {
    mockUpdateRule.mockResolvedValueOnce({ id: "r1" });
    const ok = await buildApp().request("/r1", {
      method: "PUT",
      body: JSON.stringify(VALID_INPUT),
      headers: { "Content-Type": "application/json" },
    });
    expect(ok.status).toBe(200);

    mockUpdateRule.mockResolvedValueOnce(null);
    const missing = await buildApp().request("/nope", {
      method: "PUT",
      body: JSON.stringify(VALID_INPUT),
      headers: { "Content-Type": "application/json" },
    });
    expect(missing.status).toBe(404);
  });

  it("deletes a rule", async () => {
    mockSoftDeleteRule.mockResolvedValue(true);
    const res = await buildApp().request("/r1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(mockSoftDeleteRule).toHaveBeenCalledWith("org-1", "r1");
  });

  it("lists events with rule filter and clamped limit", async () => {
    const res = await buildApp().request("/events?ruleId=r1&limit=25");
    expect(res.status).toBe(200);
    expect(mockListEvents).toHaveBeenCalledWith("org-1", { ruleId: "r1", limit: 25 });
  });

  it("feeds the metric key picker from the ClickHouse reader", async () => {
    mockListMetricSeriesKeys.mockResolvedValue([{ label: "CPU %", unit: "%", resourceCount: 3 }]);
    const res = await buildApp().request("/metric-keys?pluginId=aws&resourceTypeId=ec2-instance");
    expect(res.status).toBe(200);
    expect(mockListMetricSeriesKeys).toHaveBeenCalledWith("org-1", {
      pluginId: "aws",
      resourceTypeId: "ec2-instance",
    });
  });

  it("previews a selector", async () => {
    mockPreviewSelector.mockResolvedValue({
      matchingResourceCount: 2,
      sampleResourceNames: ["vm-1", "vm-2"],
    });
    const res = await buildApp().request("/selector-preview?pluginId=aws&tagKey=env");
    expect(res.status).toBe(200);
    expect(mockPreviewSelector).toHaveBeenCalledWith("org-1", {
      pluginId: "aws",
      resourceTypeId: null,
      tagKey: "env",
      tagValue: null,
    });
  });

  it("requires metric-alerts:read to list", async () => {
    const res = await buildAppWithPermissions(["costs:read"]).request("/");
    expect(res.status).toBe(403);
  });

  it("requires metric-alerts:write to create — read is not enough", async () => {
    const res = await buildAppWithPermissions(["metric-alerts:read"]).request("/", {
      method: "POST",
      body: JSON.stringify(VALID_INPUT),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
    expect(mockCreateRule).not.toHaveBeenCalled();
  });

  it("allows listing with metric-alerts:read alone", async () => {
    const res = await buildAppWithPermissions(["metric-alerts:read"]).request("/");
    expect(res.status).toBe(200);
  });
});
