import { describe, expect, it, vi } from "vitest";
import type {
  Plugin,
  PluginClient,
  PriceCatalogDeclaration,
  PriceCatalogProduct,
} from "@infrawrench/plugin-base";
import {
  createPriceCatalogService,
  PriceCatalogQueryError,
  type PriceCatalogDeps,
} from "../price-catalog/service";

function product(
  sku: string,
  vcpus: number,
  memoryGb: number,
  hourly: number,
  extra: Partial<PriceCatalogProduct> = {},
  region = "r1",
  currency = "USD",
): PriceCatalogProduct {
  return {
    sku,
    name: sku,
    serviceId: "vm",
    family: "compute",
    specs: { vcpus, memoryGb },
    prices: [{ region, rateType: "on-demand", unit: "hour", amount: hourly, currency }],
    ...extra,
  };
}

function decl(overrides: Partial<PriceCatalogDeclaration> = {}): PriceCatalogDeclaration {
  return {
    requiresCredentials: false,
    source: { name: "Fake prices", url: "https://example.invalid/prices" },
    refreshHours: 1,
    services: [{ id: "vm", label: "VMs", family: "compute" }],
    regions: [
      { id: "r1", label: "Region one", area: "north-america" },
      { id: "r2", label: "Region two", area: "europe" },
    ],
    ...overrides,
  };
}

function fakePlugin(
  id: string,
  catalog: PriceCatalogDeclaration,
  products: PriceCatalogProduct[] | (() => Promise<PriceCatalogProduct[]>),
): Plugin {
  const fetchProducts = async () => (typeof products === "function" ? await products() : products);
  return {
    manifest: { id, displayName: id.toUpperCase(), priceCatalog: catalog } as Plugin["manifest"],
    resourceTypes: [],
    createClient: () =>
      ({
        fetchPriceCatalog: async () => ({ products: await fetchProducts() }),
      }) as unknown as PluginClient,
    ...(catalog.requiresCredentials
      ? {}
      : { fetchPriceCatalog: async () => ({ products: await fetchProducts() }) }),
  };
}

function deps(plugins: Plugin[], overrides: Partial<PriceCatalogDeps> = {}): PriceCatalogDeps {
  let now = 1_000_000;
  return {
    listPlugins: async () => plugins,
    listAccountIds: async () => [],
    getClient: async () => null,
    runPublicFetch: (plugin, _org, fn) => fn(plugin),
    loadConverter: async () => ({
      displayCurrency: null,
      convert: (amount, currency) => ({ amount, currency }),
    }),
    now: () => (now += 1),
    ...overrides,
  };
}

describe("price catalog service", () => {
  it("searches across providers, sorted by monthly price, with filters", async () => {
    const svc = createPriceCatalogService(
      deps([
        fakePlugin("alpha", decl(), [product("a-small", 2, 4, 0.02), product("a-big", 8, 32, 0.4)]),
        fakePlugin("beta", decl(), [product("b-small", 2, 8, 0.01)]),
      ]),
    );
    const res = await svc.search("org1", { minVcpus: 2, maxVcpus: 4 });
    expect(res.rows.map((r) => r.sku)).toEqual(["b-small", "a-small"]);
    expect(res.rows[0]!.monthlyAmount).toBeCloseTo(7.3);
    expect(res.total).toBe(2);
    expect(res.providers.map((p) => p.state)).toEqual(["ready", "ready"]);
  });

  it("reports a credentialed provider with no account as no-account rather than empty", async () => {
    const svc = createPriceCatalogService(
      deps([fakePlugin("creds", decl({ requiresCredentials: true }), [product("x", 2, 4, 1)])]),
    );
    const res = await svc.search("org1", {});
    expect(res.rows).toEqual([]);
    expect(res.providers[0]!.state).toBe("no-account");
  });

  it("uses an org account for a credentialed catalog", async () => {
    const plugin = fakePlugin("creds", decl({ requiresCredentials: true }), [
      product("x", 2, 4, 1),
    ]);
    const getClient = vi.fn(async () => plugin.createClient({}));
    const svc = createPriceCatalogService(
      deps([plugin], { listAccountIds: async () => ["acct-1"], getClient }),
    );
    const res = await svc.search("org1", {});
    expect(res.rows.map((r) => r.sku)).toEqual(["x"]);
    expect(getClient).toHaveBeenCalledWith("acct-1", "org1");
  });

  it("picks each provider's region from the area and skips providers with none", async () => {
    const svc = createPriceCatalogService(
      deps([
        fakePlugin("alpha", decl(), [product("eu", 2, 4, 0.02, {}, "r2")]),
        fakePlugin("beta", decl({ regions: [{ id: "us", label: "US", area: "north-america" }] }), [
          product("us-only", 2, 4, 0.01, {}, "us"),
        ]),
      ]),
    );
    const res = await svc.search("org1", { area: "europe" });
    expect(res.rows.map((r) => r.sku)).toEqual(["eu"]);
    expect(res.providers.find((p) => p.pluginId === "beta")!.state).toBe("no-region");
  });

  it("caches per refreshHours and fetches once", async () => {
    const fetchProducts = vi.fn(async () => [product("a", 2, 4, 0.02)]);
    const svc = createPriceCatalogService(deps([fakePlugin("alpha", decl(), fetchProducts)]));
    await svc.search("org1", {});
    await svc.search("org2", {});
    expect(fetchProducts).toHaveBeenCalledTimes(1);
  });

  it("reports a failing provider as an error and keeps the others", async () => {
    const svc = createPriceCatalogService(
      deps([
        fakePlugin("alpha", decl(), async () => {
          throw new Error("pricing API down");
        }),
        fakePlugin("beta", decl(), [product("b", 2, 4, 0.01)]),
      ]),
    );
    const res = await svc.search("org1", {});
    expect(res.rows.map((r) => r.sku)).toEqual(["b"]);
    const alpha = res.providers.find((p) => p.pluginId === "alpha")!;
    expect(alpha.state).toBe("error");
    expect(alpha.error).toBe("pricing API down");
  });

  it("compares the cheapest equivalent per provider", async () => {
    const svc = createPriceCatalogService(
      deps([
        fakePlugin("alpha", decl(), [
          product("a-2-4", 2, 4, 0.02),
          product("a-4-16", 4, 16, 0.1),
          product("a-8-32", 8, 32, 0.2),
        ]),
        fakePlugin("beta", decl(), [product("b-4-16", 4, 16, 0.05), product("b-2-2", 2, 2, 0.001)]),
      ]),
    );
    const res = await svc.compare("org1", { vcpus: 4, memoryGb: 16 });
    expect(res.providers.map((p) => p.best?.sku)).toEqual(["b-4-16", "a-4-16"]);
    expect(res.providers[1]!.alternatives.map((r) => r.sku)).toEqual(["a-8-32"]);
  });

  it("compares from a reference product's specs", async () => {
    const svc = createPriceCatalogService(
      deps([
        fakePlugin("alpha", decl(), [product("ref", 4, 16, 0.1)]),
        fakePlugin("beta", decl(), [product("b-4-16", 4, 16, 0.05)]),
      ]),
    );
    const res = await svc.compare("org1", { reference: { pluginId: "alpha", sku: "ref" } });
    expect(res.target).toEqual({ vcpus: 4, memoryGb: 16, gpuCount: null, gpuModel: null });
    expect(res.reference?.sku).toBe("ref");
    expect(res.providers[0]!.best?.sku).toBe("b-4-16");
  });

  it("refuses a compare with no target", async () => {
    const svc = createPriceCatalogService(deps([]));
    await expect(svc.compare("org1", {})).rejects.toBeInstanceOf(PriceCatalogQueryError);
  });

  it("fills {region} in the estimate link", async () => {
    const svc = createPriceCatalogService(
      deps([
        fakePlugin("alpha", decl(), [
          product("a", 2, 4, 0.02, {
            estimate: { resourceTypeId: "vm", fields: { region: "{region}", size: "a" } },
          }),
        ]),
      ]),
    );
    const res = await svc.search("org1", {});
    expect(res.rows[0]!.estimate).toEqual({
      resourceTypeId: "vm",
      fields: { region: "r1", size: "a" },
    });
  });
});
