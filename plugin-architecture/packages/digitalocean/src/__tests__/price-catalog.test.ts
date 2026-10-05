import { describe, expect, it, vi } from "vitest";
import { pluginManifestSchema } from "@infrawrench/plugin-base";
import { doPriceCatalog, doSizeToProduct, fetchDoPriceCatalog } from "../price-catalog.js";
import { plugin } from "../plugin.js";
import { DigitalOceanClient } from "../client.js";

/** Shapes follow the per-field examples in DO's OpenAPI `size.yml` / `gpu_info.yml`. */
const BASIC = {
  slug: "s-1vcpu-1gb",
  memory: 1024,
  vcpus: 1,
  disk: 25,
  transfer: 1.0,
  price_monthly: 6.0,
  price_hourly: 0.00893,
  regions: ["nyc1", "fra1"],
  available: true,
  description: "Basic",
};

const GPU = {
  slug: "gpu-h100x1-80gb",
  memory: 245760,
  vcpus: 20,
  disk: 720,
  transfer: 15.0,
  price_monthly: 2482.56,
  price_hourly: 3.39,
  regions: ["tor1"],
  available: true,
  description: "H100 GPU - 1X",
  gpu_info: { count: 1, model: "nvidia_h100", vram: { amount: 80, unit: "gib" } },
};

describe("doSizeToProduct", () => {
  it("maps specs and emits one monthly USD price per region the size is offered in", () => {
    const product = doSizeToProduct(BASIC)!;
    expect(product).toMatchObject({
      sku: "s-1vcpu-1gb",
      serviceId: "droplets",
      family: "compute",
      series: "Basic",
      specs: { vcpus: 1, memoryGb: 1, storageGb: 25, network: "1 TB transfer" },
      estimate: { resourceTypeId: "droplet", fields: { size: "s-1vcpu-1gb", region: "{region}" } },
    });
    expect(product.specs.gpuCount).toBeUndefined();
    expect(product.prices).toEqual([
      { region: "nyc1", rateType: "on-demand", unit: "month", amount: 6, currency: "USD" },
      { region: "fra1", rateType: "on-demand", unit: "month", amount: 6, currency: "USD" },
    ]);
  });

  it("puts GPU sizes in the gpu family with model, count and VRAM", () => {
    const product = doSizeToProduct(GPU)!;
    expect(product.family).toBe("gpu");
    expect(product.specs).toMatchObject({
      gpuCount: 1,
      gpuModel: "NVIDIA H100",
      gpuMemoryGb: 80,
      memoryGb: 240,
    });
  });

  it("skips unavailable sizes, quoted-only (zero-priced) sizes and sizes with no regions", () => {
    expect(doSizeToProduct({ ...BASIC, available: false })).toBeNull();
    expect(doSizeToProduct({ ...BASIC, price_monthly: 0 })).toBeNull();
    expect(doSizeToProduct({ ...BASIC, regions: [] })).toBeNull();
  });
});

describe("fetchDoPriceCatalog", () => {
  it("paginates /v2/sizes until meta.total is reached", async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => ({ ...BASIC, slug: `s-fake-${i}` }));
    const fetch = vi.fn((path: string) => {
      if (path === "/sizes?per_page=200&page=1")
        return Promise.resolve({ sizes: page1, meta: { total: 201 } });
      if (path === "/sizes?per_page=200&page=2")
        return Promise.resolve({ sizes: [GPU], meta: { total: 201 } });
      throw new Error(`unexpected path ${path}`);
    });
    const result = await fetchDoPriceCatalog({ fetch: fetch as never }, { serviceId: "droplets" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.products).toHaveLength(201);
    expect(result.truncated).toBeUndefined();
  });

  it("returns nothing for a service it does not declare", async () => {
    const fetch = vi.fn();
    const result = await fetchDoPriceCatalog({ fetch: fetch as never }, { serviceId: "nope" });
    expect(result.products).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("price catalog wiring", () => {
  it("declares a credentialed, region-wide droplet catalog the manifest schema accepts", () => {
    expect(plugin.manifest.priceCatalog).toBe(doPriceCatalog);
    expect(doPriceCatalog.requiresCredentials).toBe(true);
    expect(doPriceCatalog.regionScoped).toBe(false);
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
  });

  it("exposes fetchPriceCatalog on the client", async () => {
    const client = new DigitalOceanClient({ apiToken: "dop_v1_fake" });
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ sizes: [BASIC], meta: { total: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      const result = await client.fetchPriceCatalog({ serviceId: "droplets" });
      expect(result.products.map((p) => p.sku)).toEqual(["s-1vcpu-1gb"]);
    } finally {
      spy.mockRestore();
    }
  });
});
