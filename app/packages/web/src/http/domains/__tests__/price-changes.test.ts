import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestApi } from "@/http/testing";

// Services are mocked: they reach the Drizzle client and the pricing
// warehouse. These tests own the transport contract: permissions,
// validation, status codes and audit.
const mockList = vi.fn();
const mockCatalog = vi.fn();
vi.mock("@infrawrench/server-core/price-changes/feed", () => ({
  listPriceChanges: (...args: unknown[]) => mockList(...args),
  listCatalogPriceChanges: (...args: unknown[]) => mockCatalog(...args),
}));

class FakeSettingsError extends Error {}
const mockGetSettings = vi.fn();
const mockUpdateSettings = vi.fn();
vi.mock("@infrawrench/server-core/price-changes/settings", () => ({
  getPriceChangeSettings: (...args: unknown[]) => mockGetSettings(...args),
  updatePriceChangeSettings: (...args: unknown[]) => mockUpdateSettings(...args),
  PriceChangeSettingsError: FakeSettingsError,
}));

class FakeScenarioError extends Error {}
const mockScenario = vi.fn();
vi.mock("@/services/price-change-scenario", () => ({
  createPriceChangeScenario: (...args: unknown[]) => mockScenario(...args),
  PriceChangeScenarioError: FakeScenarioError,
}));

class FakeLimitError extends Error {}
vi.mock("@/services/cost-scenarios", () => ({ CostScenarioLimitError: FakeLimitError }));

const mockLogAudit = vi.fn();
vi.mock("@/services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const { priceChangesDomain } = await import("@/http/domains/price-changes/index");

const buildApp = (permissions?: string[]) =>
  buildTestApi(priceChangesDomain, {
    basePath: "/api/org/org-1/price-changes",
    ...(permissions ? { permissions } : {}),
  });

const CHANGE_ID = "11111111-1111-4111-8111-111111111111";
const change = {
  id: CHANGE_ID,
  pluginId: "aws",
  platform: "ec2",
  instanceType: "m5.large",
  region: "us-east-1",
  selection: { operating_system: "Linux" },
  oldHourlyUsd: 0.096,
  newHourlyUsd: 0.105,
  percent: 9.375,
  effectiveAt: "2026-11-01T00:00:00.000Z",
  upcoming: false,
  units: 6,
  approximate: false,
  monthlyImpactUsd: 39.42,
  resources: [],
  belowThreshold: false,
  alertedAt: null,
  suppressionIds: [],
  scenarioModelId: null,
  detectedAt: "2026-11-02T00:00:00.000Z",
  pageUrl: "https://instances.infrawrench.com/aws/ec2/m5.large?region=us-east-1",
};
const settings = {
  organizationId: "org-1",
  enabled: true,
  minMonthlyImpactCents: 1000,
  minPercent: 1,
  registerExpected: true,
  lastNotifiedAt: null,
};

const json = (body: unknown, method = "PUT") => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue({
    changes: [change],
    available: true,
    lastScannedAt: null,
    minMonthlyImpactCents: 1000,
    minPercent: 1,
  });
  mockCatalog.mockResolvedValue({
    available: true,
    platforms: ["ec2", "rds"],
    platform: "rds",
    days: 30,
    changes: [],
    truncated: false,
  });
  mockGetSettings.mockResolvedValue(settings);
  mockUpdateSettings.mockResolvedValue({ ...settings, minPercent: 5 });
  mockScenario.mockResolvedValue({ scenarioModelId: CHANGE_ID, created: true });
});

describe("list", () => {
  it("needs costs:read", async () => {
    expect((await buildApp([]).request("/")).status).toBe(403);
  });

  it("lists the org's changes over the default window", async () => {
    const res = await buildApp(["costs:read"]).request("/");
    expect(res.status).toBe(200);
    expect((await res.json()).changes).toEqual([change]);
    expect(mockList).toHaveBeenCalledWith("org-1", { days: 180 });
  });

  it("takes a window and refuses one out of range", async () => {
    await buildApp(["costs:read"]).request("/?days=30");
    expect(mockList).toHaveBeenCalledWith("org-1", { days: 30 });
    expect((await buildApp(["costs:read"]).request("/?days=0")).status).toBe(400);
    expect((await buildApp(["costs:read"]).request("/?days=abc")).status).toBe(400);
  });
});

describe("catalog", () => {
  it("is resources:read, like the price catalog", async () => {
    expect((await buildApp(["costs:read"]).request("/catalog")).status).toBe(403);
    const res = await buildApp(["resources:read"]).request("/catalog?platform=rds&days=30");
    expect(res.status).toBe(200);
    expect(mockCatalog).toHaveBeenCalledWith({ days: 30, platform: "rds" });
  });

  it("refuses a platform that is not a platform id", async () => {
    const res = await buildApp(["resources:read"]).request("/catalog?platform=ec2'%20OR%201");
    expect(res.status).toBe(400);
    expect(mockCatalog).not.toHaveBeenCalled();
  });
});

describe("settings", () => {
  it("need org:settings:write", async () => {
    expect((await buildApp(["costs:read"]).request("/settings")).status).toBe(403);
  });

  it("reads and writes, auditing the write", async () => {
    const app = buildApp(["org:settings:write"]);
    expect(await (await app.request("/settings")).json()).toEqual({
      enabled: true,
      minMonthlyImpactCents: 1000,
      minPercent: 1,
      registerExpected: true,
      lastNotifiedAt: null,
    });
    const res = await app.request("/settings", json({ minPercent: 5 }));
    expect(res.status).toBe(200);
    expect((await res.json()).minPercent).toBe(5);
    expect(mockUpdateSettings).toHaveBeenCalledWith("org-1", { minPercent: 5 });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "price_change_settings.update" }),
    );
  });

  it("refuses an empty patch and out-of-range values", async () => {
    const app = buildApp(["org:settings:write"]);
    expect((await app.request("/settings", json({}))).status).toBe(400);
    expect((await app.request("/settings", json({ minPercent: 101 }))).status).toBe(400);
    expect((await app.request("/settings", json({ minMonthlyImpactCents: 1.5 }))).status).toBe(400);
    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });
});

describe("scenario", () => {
  it("needs costs:write", async () => {
    const res = await buildApp(["costs:read"]).request(`/${CHANGE_ID}/scenario`, {
      method: "POST",
    });
    expect(res.status).toBe(403);
  });

  it("makes a model and audits it, or 404s an unknown change", async () => {
    const app = buildApp(["costs:write"]);
    const res = await app.request(`/${CHANGE_ID}/scenario`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scenarioModelId: CHANGE_ID, created: true });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cost_scenario.create" }),
    );
    mockScenario.mockResolvedValue(null);
    expect((await app.request(`/${CHANGE_ID}/scenario`, { method: "POST" })).status).toBe(404);
  });

  it("answers 400 for a change that moves nothing", async () => {
    mockScenario.mockRejectedValue(
      new FakeScenarioError("This change does not move your monthly cost."),
    );
    const res = await buildApp(["costs:write"]).request(`/${CHANGE_ID}/scenario`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });
});
