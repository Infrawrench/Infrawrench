import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginManifestSchema, type HostServices } from "@infrawrench/plugin-base";
import {
  fetchLinodePriceCatalog,
  fetchLinodePriceCatalogWith,
  linodePriceCatalog,
  linodeTypeToProduct,
} from "../price-catalog.js";
import { plugin } from "../plugin.js";
import type { LinodeType } from "../types.js";

/** Shape recorded from the public `/v4/linode/types` (values are illustrative). */
const NANODE: LinodeType = {
  id: "g6-nanode-1",
  label: "Nanode 1GB",
  class: "nanode",
  price: { hourly: 0.0075, monthly: 5.0 },
  region_prices: [
    { id: "id-cgk", hourly: 0.009, monthly: 6.0 },
    { id: "br-gru", hourly: 0.0105, monthly: 7.0 },
  ],
  memory: 1024,
  disk: 25600,
  transfer: 1000,
  vcpus: 1,
  gpus: 0,
  network_out: 1000,
  successor: null,
};

const GPU: LinodeType = {
  id: "g1-gpu-rtx6000-2",
  label: "Dedicated 64GB + RTX6000 GPU x2",
  class: "gpu",
  price: { hourly: 3.0, monthly: null },
  region_prices: [],
  memory: 65536,
  disk: 1310720,
  transfer: 20000,
  vcpus: 16,
  gpus: 2,
  network_out: 10000,
  successor: null,
};

const REGIONS = ["us-east", "id-cgk", "br-gru"];

describe("linodeTypeToProduct", () => {
  it("applies region_prices overrides and the default price everywhere else", () => {
    const product = linodeTypeToProduct(NANODE, REGIONS)!;
    expect(product.prices).toEqual([
      { region: "us-east", rateType: "on-demand", unit: "month", amount: 5, currency: "USD" },
      { region: "id-cgk", rateType: "on-demand", unit: "month", amount: 6, currency: "USD" },
      { region: "br-gru", rateType: "on-demand", unit: "month", amount: 7, currency: "USD" },
    ]);
  });

  it("maps specs, series and the create-form estimate link", () => {
    expect(linodeTypeToProduct(NANODE, REGIONS)).toMatchObject({
      sku: "g6-nanode-1",
      name: "Nanode 1GB",
      serviceId: "linodes",
      family: "compute",
      series: "Shared CPU",
      specs: { vcpus: 1, memoryGb: 1, storageGb: 25, network: "1 TB transfer, 1 Gbps out" },
      estimate: { resourceTypeId: "linode", fields: { type: "g6-nanode-1", region: "{region}" } },
    });
  });

  it("puts GPU plans in the gpu family, quoted hourly when there is no monthly cap", () => {
    const product = linodeTypeToProduct(GPU, ["us-east"])!;
    expect(product.family).toBe("gpu");
    expect(product.specs.gpuCount).toBe(2);
    expect(product.specs.gpuModel).toBeUndefined();
    expect(product.prices).toEqual([
      { region: "us-east", rateType: "on-demand", unit: "hour", amount: 3, currency: "USD" },
    ]);
  });

  it("drops a plan with no price at all", () => {
    expect(linodeTypeToProduct({ id: "g0-unpriced" }, REGIONS)).toBeNull();
  });
});

describe("fetchLinodePriceCatalog", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prices every declared region from /linode/types", async () => {
    const all = vi.fn().mockResolvedValue([NANODE, GPU]);
    const result = await fetchLinodePriceCatalogWith(
      { all: all as never },
      { serviceId: "linodes" },
    );
    expect(all).toHaveBeenCalledWith("/linode/types");
    expect(result.products.map((p) => p.sku)).toEqual(["g6-nanode-1", "g1-gpu-rtx6000-2"]);
    expect(result.products[0]!.prices).toHaveLength(linodePriceCatalog.regions.length);
  });

  it("calls the public endpoint anonymously through the host's http", async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({ data: [NANODE], page: 1, pages: 1, results: 1 }),
    });
    const services = { http: { request } } as unknown as HostServices;
    const result = await fetchLinodePriceCatalog({ serviceId: "linodes" }, services);
    expect(result.products).toHaveLength(1);
    const req = request.mock.calls[0]![0] as { url: string; headers: Record<string, string> };
    expect(req.url).toContain("https://api.linode.com/v4/linode/types");
    expect(req.headers["Authorization"]).toBeUndefined();
  });

  it("falls back to the global fetch without host services", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [NANODE], page: 1, pages: 1, results: 1 }), {
        status: 200,
      }),
    );
    const result = await plugin.fetchPriceCatalog!({ serviceId: "linodes" });
    expect(spy).toHaveBeenCalledOnce();
    expect(result.products[0]!.sku).toBe("g6-nanode-1");
  });

  it("returns nothing for an undeclared service", async () => {
    const all = vi.fn();
    expect((await fetchLinodePriceCatalogWith({ all }, { serviceId: "nope" })).products).toEqual(
      [],
    );
    expect(all).not.toHaveBeenCalled();
  });
});

describe("declaration", () => {
  it("is public, region-wide, has an area for every known region and passes the schema", () => {
    expect(linodePriceCatalog.requiresCredentials).toBe(false);
    expect(linodePriceCatalog.regions[0]!.id).toBe("us-east");
    expect(linodePriceCatalog.regions.find((r) => r.area === "europe")!.id).toBe("eu-central");
    expect(linodePriceCatalog.regions).toHaveLength(33);
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
  });
});
