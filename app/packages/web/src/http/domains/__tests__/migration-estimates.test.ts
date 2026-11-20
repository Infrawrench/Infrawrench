import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi, type TestCaller } from "@/http/testing";

// The estimate reaches Postgres, cost data and plugin clients; these tests
// are about the transport: the gates, what each handler passes to the
// service, and how the service's refusals reach the caller.
class FakeInputError extends Error {}
class FakeSourceNotFound extends Error {}
class FakeLimitError extends Error {}
const service = { targets: vi.fn(), compute: vi.fn(), terraform: vi.fn() };
const store = {
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
};
vi.mock("@infrawrench/server-core/migration-estimate", () => ({
  getMigrationEstimateService: () => service,
  MigrationEstimateInputError: FakeInputError,
  MigrationEstimateSourceNotFoundError: FakeSourceNotFound,
  MigrationEstimateLimitError: FakeLimitError,
  listMigrationEstimates: (...a: unknown[]) => store.list(...a),
  getMigrationEstimate: (...a: unknown[]) => store.get(...a),
  createMigrationEstimate: (...a: unknown[]) => store.create(...a),
  updateMigrationEstimate: (...a: unknown[]) => store.update(...a),
  deleteMigrationEstimate: (...a: unknown[]) => store.remove(...a),
}));
const createScenario = vi.fn();
vi.mock("@/services/cost-scenarios", () => ({
  createCostScenarioModel: (...a: unknown[]) => createScenario(...a),
  CostScenarioNameConflictError: class extends Error {},
  CostScenarioLimitError: class extends Error {},
}));
vi.mock("@/services/audit", () => ({ logAudit: vi.fn(async () => undefined) }));

const { migrationEstimatesDomain } = await import("@/http/domains/migration-estimates/index");

const ESTIMATE_ID = "11111111-1111-4111-8111-111111111111";
const caller = (permissions?: string[]): TestCaller => ({
  basePath: "/api/org/org-1/migration-estimates",
  ...(permissions === undefined ? {} : { permissions }),
});
const app = (permissions?: string[]) => buildTestApi(migrationEstimatesDomain, caller(permissions));

const input = {
  name: "Checkout on Hetzner",
  source: { kind: "service", serviceId: "checkout" },
  targetPluginId: "hetzner",
  targetRegion: null,
  overrides: {},
};
const saved = {
  id: ESTIMATE_ID,
  ...input,
  sourceName: "Checkout",
  createdByUserId: null,
  createdAt: "2026-11-18T00:00:00.000Z",
  updatedAt: "2026-11-18T00:00:00.000Z",
};
const result = (comparable: unknown) => ({
  estimateId: ESTIMATE_ID,
  name: input.name,
  source: { kind: "service", label: "Checkout", resourceCount: 0 },
  target: { pluginId: "hetzner", pluginName: "Hetzner" },
  region: {
    region: "fsn1",
    regionLabel: "Falkenstein",
    area: "europe",
    sourceAreas: [],
    choice: "nearest",
    crossesArea: null,
  },
  rows: [],
  unmatched: [],
  totals: {
    current: [],
    target: [],
    currentUnknown: 0,
    targetUnknown: 0,
    unmatchedCurrent: [],
    comparable,
  },
  displayCurrency: null,
  terraform: false,
  truncated: false,
  generatedAt: "2026-11-18T00:00:00.000Z",
});

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  service.targets.mockResolvedValue([
    {
      pluginId: "hetzner",
      pluginName: "Hetzner",
      categories: ["vm"],
      regions: [],
      priceCatalog: true,
      needsAccount: true,
      hasAccount: false,
      terraform: true,
    },
  ]);
  service.compute.mockResolvedValue(result(null));
  store.get.mockResolvedValue(saved);
  store.create.mockResolvedValue(saved);
});

describe("/migration-estimates", () => {
  it("lists the targets", async () => {
    const res = await app().request("/targets");
    expect(res.status).toBe(200);
    expect((await res.json()).providers[0].pluginId).toBe("hetzner");
  });

  it("computes a preview and maps the service's refusals", async () => {
    const ok = await app().request("/preview", post(input));
    expect(ok.status).toBe(200);
    expect(service.compute).toHaveBeenCalledWith("org-1", input);

    service.compute.mockRejectedValueOnce(new FakeInputError("Unknown target provider"));
    const bad = await app().request("/preview", post(input));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Unknown target provider" });

    service.compute.mockRejectedValueOnce(new FakeSourceNotFound("Service not found."));
    const missing = await app().request("/preview", post(input));
    expect(missing.status).toBe(404);
  });

  it("refuses a body with unknown keys", async () => {
    const res = await app().request("/preview", post({ ...input, extra: true }));
    expect(res.status).toBe(400);
    expect(service.compute).not.toHaveBeenCalled();
  });

  it("saves with costs:write only, and only for a provider it can target", async () => {
    const denied = await app(["costs:read"]).request("/", post(input));
    expect(denied.status).toBe(403);

    const created = await app().request("/", post(input));
    expect(created.status).toBe(200);
    expect(store.create).toHaveBeenCalledWith("org-1", input, expect.anything());

    const unknown = await app().request("/", post({ ...input, targetPluginId: "nope" }));
    expect(unknown.status).toBe(400);
  });

  it("computes a saved estimate from its stored inputs", async () => {
    const res = await app().request(`/${ESTIMATE_ID}/result`);
    expect(res.status).toBe(200);
    expect(service.compute).toHaveBeenCalledWith("org-1", input, { estimateId: ESTIMATE_ID });

    store.get.mockResolvedValueOnce(null);
    const gone = await app().request(`/${ESTIMATE_ID}/result`);
    expect(gone.status).toBe(404);
  });

  it("answers 400 for Terraform when the target has no export", async () => {
    service.terraform.mockResolvedValueOnce(null);
    const res = await app().request(`/${ESTIMATE_ID}/terraform`);
    expect(res.status).toBe(400);
  });

  it("creates a scenario model from the paired delta, and refuses without one", async () => {
    const none = await app().request(`/${ESTIMATE_ID}/scenario`, post({ startDate: "2027-01-01" }));
    expect(none.status).toBe(400);
    expect(createScenario).not.toHaveBeenCalled();

    service.compute.mockResolvedValueOnce(
      result({ currency: "USD", current: 500, target: 300, pairedDelta: -200, pairedRows: 2 }),
    );
    createScenario.mockResolvedValueOnce({
      id: "22222222-2222-4222-8222-222222222222",
      name: "Checkout on Hetzner on Hetzner",
      currency: "USD",
    });
    const res = await app().request(`/${ESTIMATE_ID}/scenario`, post({ startDate: "2027-01-01" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ monthlyDelta: -200, currency: "USD" });
    const [, model] = createScenario.mock.calls[0]!;
    expect(model.adjustments[0]).toMatchObject({
      kind: "recurring",
      period: "monthly",
      amountCents: -20000,
      startDate: "2027-01-01",
    });
  });
});
