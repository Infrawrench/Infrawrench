import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi, type TestCaller } from "@/http/testing";

// The feeds reach ClickHouse, Postgres and plugin clients; these tests are
// about the transport of the read-only feeds moved together: their gates,
// what each passes to its service, and the sentences of their refusals.
const mockOrphans = vi.fn();
vi.mock("@/services/orphans", () => ({ listOrphans: (...a: unknown[]) => mockOrphans(...a) }));
const mockRightsizing = vi.fn();
vi.mock("@/services/rightsizing", () => ({
  listRightsizing: (...a: unknown[]) => mockRightsizing(...a),
}));
const mockCarbon = vi.fn();
vi.mock("@infrawrench/server-core/cost/carbon", () => ({
  getCarbonEstimate: (...a: unknown[]) => mockCarbon(...a),
}));
const mockCredits = vi.fn();
vi.mock("@infrawrench/server-core/credits/feed", () => ({
  getCreditBurndown: (...a: unknown[]) => mockCredits(...a),
}));
const mockCommitments = vi.fn();
vi.mock("@infrawrench/server-core/commitments/feed", () => ({
  getCommitmentsFeed: (...a: unknown[]) => mockCommitments(...a),
}));
class FakeQueryError extends Error {}
class FakeNotFoundError extends Error {}
const catalog = { listProviders: vi.fn(), search: vi.fn(), compare: vi.fn() };
vi.mock("@infrawrench/server-core/price-catalog", () => ({
  getPriceCatalogService: () => catalog,
  PriceCatalogQueryError: FakeQueryError,
  PriceCatalogNotFoundError: FakeNotFoundError,
}));

const { orphansDomain } = await import("@/http/domains/orphans/index");
const { rightsizingDomain } = await import("@/http/domains/rightsizing/index");
const { carbonDomain } = await import("@/http/domains/carbon/index");
const { creditsDomain } = await import("@/http/domains/credits/index");
const { commitmentsDomain } = await import("@/http/domains/commitments/index");
const { priceCatalogDomain } = await import("@/http/domains/price-catalog/index");

const caller = (mount: string, permissions?: string[]): TestCaller => ({
  basePath: `/api/org/org-1/${mount}`,
  ...(permissions === undefined ? {} : { permissions }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mockOrphans.mockResolvedValue({ accounts: [], totalCount: 0, unownedCount: 0 });
  mockRightsizing.mockResolvedValue({ accounts: [], totalCount: 0, windowDays: 14 });
  mockCarbon.mockResolvedValue({ windowDays: 30, totalKgCo2e: 0 });
  mockCredits.mockResolvedValue({ pots: [], failures: [] });
  mockCommitments.mockResolvedValue({ holdings: [], failures: [] });
  catalog.listProviders.mockResolvedValue([]);
  catalog.search.mockResolvedValue({ rows: [], total: 0 });
  catalog.compare.mockResolvedValue({ providers: [] });
});

describe("GET /orphans", () => {
  it("needs resources:read and withholds spend without costs:read", async () => {
    expect(
      (await buildTestApi(orphansDomain, caller("orphans", ["costs:read"])).request("/")).status,
    ).toBe(403);
    const res = await buildTestApi(orphansDomain, caller("orphans", ["resources:read"])).request(
      "/",
    );
    expect(res.status).toBe(200);
    expect(mockOrphans).toHaveBeenCalledWith("org-1", { includeCosts: false });
    await buildTestApi(orphansDomain, caller("orphans")).request("/");
    expect(mockOrphans).toHaveBeenLastCalledWith("org-1", { includeCosts: true });
  });
});

describe("GET /rightsizing", () => {
  it("bypasses the cache only for refresh=true", async () => {
    const app = buildTestApi(rightsizingDomain, caller("rightsizing"));
    await app.request("/?refresh=yes");
    expect(mockRightsizing).toHaveBeenLastCalledWith("org-1", { refresh: false });
    await app.request("/?refresh=true");
    expect(mockRightsizing).toHaveBeenLastCalledWith("org-1", { refresh: true });
  });
});

describe("GET /carbon", () => {
  it("needs costs:read", async () => {
    const res = await buildTestApi(carbonDomain, caller("carbon", ["resources:read"])).request("/");
    expect(res.status).toBe(403);
  });

  it("passes windowDays and refuses one out of range with its sentence", async () => {
    const app = buildTestApi(carbonDomain, caller("carbon"));
    expect((await app.request("/")).status).toBe(200);
    expect(mockCarbon).toHaveBeenLastCalledWith("org-1", {});
    await app.request("/?windowDays=7");
    expect(mockCarbon).toHaveBeenLastCalledWith("org-1", { windowDays: 7 });
    const res = await app.request("/?windowDays=2.5");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "windowDays must be a whole number between 1 and 365",
    });
  });
});

describe("GET /credits and /commitments", () => {
  it("need costs:read", async () => {
    for (const [domain, mount] of [
      [creditsDomain, "credits"],
      [commitmentsDomain, "commitments"],
    ] as const) {
      expect(
        (await buildTestApi(domain, caller(mount, ["resources:read"])).request("/")).status,
      ).toBe(403);
      expect((await buildTestApi(domain, caller(mount, ["costs:read"])).request("/")).status).toBe(
        200,
      );
    }
    expect(mockCredits).toHaveBeenCalledWith("org-1");
    expect(mockCommitments).toHaveBeenCalledWith("org-1");
  });
});

describe("/price-catalog", () => {
  const app = () => buildTestApi(priceCatalogDomain, caller("price-catalog"));

  it("wraps the provider list", async () => {
    const res = await app().request("/providers");
    expect(await res.json()).toEqual({ providers: [] });
    expect(catalog.listProviders).toHaveBeenCalledWith("org-1");
  });

  it("normalizes the raw query, undocumented aliases included", async () => {
    await app().request("/search?provider=aws,gcp&minVcpus=4&area=nowhere&limit=9999");
    expect(catalog.search).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        pluginIds: ["aws", "gcp"],
        minVcpus: 4,
        area: undefined,
        limit: 500,
      }),
    );
  });

  it("maps the compare refusals to 400 and 404", async () => {
    catalog.compare.mockRejectedValueOnce(new FakeQueryError("Give a target"));
    const bad = await app().request("/compare");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Give a target" });
    catalog.compare.mockRejectedValueOnce(new FakeNotFoundError("No such product"));
    const missing = await app().request("/compare?referencePluginId=aws&referenceSku=x");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "No such product" });
  });
});
