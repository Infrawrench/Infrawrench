import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginManifestSchema } from "@infrawrench/plugin-base";
import {
  fetchHetznerPriceCatalog,
  hetznerPriceCatalog,
  hetznerServerTypeToProduct,
  type HetznerServerTypeWire,
} from "../price-catalog.js";
import { HetznerClient } from "../client.js";
import { plugin } from "../plugin.js";

const TB = 2 ** 40;

/** Shape per the `/server_types` schema in docs.hetzner.cloud/cloud.spec.json. */
const CX22: HetznerServerTypeWire = {
  name: "cx22",
  description: "CX22",
  cores: 2,
  memory: 4,
  disk: 40,
  cpu_type: "shared",
  storage_type: "local",
  architecture: "x86",
  category: "Shared vCPU",
  deprecation: null,
  locations: [
    { name: "fsn1", deprecation: null, available: true },
    { name: "nbg1", deprecation: null, available: false },
    {
      name: "hel1",
      deprecation: { announced: "2026-01-01T00:00:00Z", unavailable_after: "2026-04-01T00:00:00Z" },
      available: true,
    },
  ],
  prices: [
    {
      location: "fsn1",
      price_hourly: { net: "0.0060", gross: "0.0071" },
      price_monthly: { net: "3.7900", gross: "4.5101" },
      included_traffic: 20 * TB,
    },
    {
      location: "nbg1",
      price_hourly: { net: "0.0060", gross: "0.0071" },
      price_monthly: { net: "3.7900", gross: "4.5101" },
      included_traffic: 20 * TB,
    },
    {
      location: "hel1",
      price_hourly: { net: "0.0060", gross: "0.0071" },
      price_monthly: { net: "3.7900", gross: "4.5101" },
      included_traffic: 20 * TB,
    },
  ],
};

describe("hetznerServerTypeToProduct", () => {
  it("quotes NET monthly prices (not gross) for every non-deprecated location", () => {
    const product = hetznerServerTypeToProduct(CX22, "EUR")!;
    expect(product.prices).toEqual([
      { region: "fsn1", rateType: "on-demand", unit: "month", amount: 3.79, currency: "EUR" },
      // Sold out (`available: false`) keeps its published price.
      { region: "nbg1", rateType: "on-demand", unit: "month", amount: 3.79, currency: "EUR" },
    ]);
    expect(product.prices.some((p) => p.amount === 4.5101)).toBe(false);
  });

  it("maps specs, series and the create-form estimate link", () => {
    const product = hetznerServerTypeToProduct(CX22, "EUR")!;
    expect(product).toMatchObject({
      sku: "cx22",
      name: "CX22",
      serviceId: "cloud-servers",
      family: "compute",
      series: "Shared vCPU",
      specs: {
        vcpus: 2,
        memoryGb: 4,
        storageGb: 40,
        storageType: "local",
        architecture: "x86_64",
        network: "20 TB included traffic",
      },
      estimate: { resourceTypeId: "server", fields: { serverType: "cx22", location: "{region}" } },
    });
  });

  it("drops a type deprecated in every location, and honours the legacy top-level flag", () => {
    const allDeprecated: HetznerServerTypeWire = {
      ...CX22,
      locations: CX22.locations!.map((l) => ({
        ...l,
        deprecation: {
          announced: "2026-01-01T00:00:00Z",
          unavailable_after: "2026-04-01T00:00:00Z",
        },
      })),
    };
    expect(hetznerServerTypeToProduct(allDeprecated, "EUR")).toBeNull();
    const { locations: _locations, ...withoutLocations } = CX22;
    const legacy: HetznerServerTypeWire = { ...withoutLocations, deprecated: true };
    expect(hetznerServerTypeToProduct(legacy, "EUR")).toBeNull();
  });

  it("omits the traffic label when locations include different amounts", () => {
    const mixed: HetznerServerTypeWire = {
      ...CX22,
      prices: [
        { ...CX22.prices![0]!, included_traffic: 20 * TB },
        { ...CX22.prices![1]!, included_traffic: 1 * TB },
      ],
    };
    expect(hetznerServerTypeToProduct(mixed, "EUR")!.specs.network).toBeUndefined();
  });
});

describe("fetchHetznerPriceCatalog", () => {
  it("lists server types and prices them in the /pricing currency", async () => {
    const fetchAll = vi.fn().mockResolvedValue([CX22]);
    const result = await fetchHetznerPriceCatalog(
      { fetchAll: fetchAll as never, currency: async () => "EUR" },
      { serviceId: "cloud-servers" },
    );
    expect(fetchAll).toHaveBeenCalledWith("/server_types", "server_types");
    expect(result.products.map((p) => p.sku)).toEqual(["cx22"]);
  });
});

describe("client wiring", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads /server_types and /pricing through the client's fetch", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const body = url.includes("/server_types")
        ? { server_types: [CX22], meta: { pagination: { total_entries: 1 } } }
        : url.includes("/pricing")
          ? { pricing: { currency: "EUR", vat_rate: "19.00" } }
          : null;
      if (!body) throw new Error(`unexpected ${url}`);
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as unknown as Response;
    });
    const client = new HetznerClient({ apiToken: "fake-token" }, plugin.resourceTypes);
    const result = await client.fetchPriceCatalog({ serviceId: "cloud-servers" });
    expect(result.products[0]!.prices[0]).toMatchObject({ currency: "EUR", amount: 3.79 });
  });

  it("declares a credentialed catalog the manifest schema accepts", () => {
    expect(plugin.manifest.priceCatalog).toBe(hetznerPriceCatalog);
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
  });
});
