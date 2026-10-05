import { describe, expect, it } from "vitest";
import { INSTANCE_TYPES, PRICING_AS_OF } from "../catalog.js";
import { plugin } from "../plugin.js";
import { fetchPriceCatalog, priceCatalog } from "../price-catalog.js";

describe("CoreWeave price catalog", () => {
  it("declares a public, region-unscoped catalog of North American zones", () => {
    expect(plugin.manifest.priceCatalog).toBe(priceCatalog);
    expect(priceCatalog.requiresCredentials).toBe(false);
    expect(priceCatalog.regionScoped).toBe(false);
    expect(priceCatalog.regions[0]?.id).toBe("US-EAST-04A");
    expect(priceCatalog.regions.every((r) => r.area === "north-america")).toBe(true);
    expect(priceCatalog.regions.some((r) => r.id.startsWith("EU-"))).toBe(false);
    expect(typeof plugin.fetchPriceCatalog).toBe("function");
  });

  it("maps GPU instances with specs, on-demand prices and the Node Pool estimate link", async () => {
    const { products, truncated } = await fetchPriceCatalog({ serviceId: "gpu-instances" });
    expect(truncated).toBeUndefined();
    const h100 = products.find((p) => p.sku === "gd-8xh100ib-i128");
    expect(h100).toBeDefined();
    expect(h100!.family).toBe("gpu");
    expect(h100!.specs).toMatchObject({
      gpuCount: 8,
      gpuModel: "NVIDIA H100",
      gpuMemoryGb: 80,
      vcpus: 128,
      memoryGb: 2048,
      storageGb: 30720,
      architecture: "x86_64",
    });
    expect(h100!.estimate).toEqual({
      resourceTypeId: "node-pool",
      fields: { instanceType: "gd-8xh100ib-i128" },
    });
    for (const price of h100!.prices) {
      expect(price).toMatchObject({
        rateType: "on-demand",
        unit: "hour",
        amount: 49.24,
        currency: "USD",
        effectiveDate: PRICING_AS_OF,
      });
    }
    expect(h100!.prices.map((p) => p.region)).toContain("US-EAST-04A");
    // Grace is Arm.
    expect(products.find((p) => p.sku === "gb200-4x")?.specs.architecture).toBe("arm64");
  });

  it("never prices a European zone from the North American list", async () => {
    const { products } = await fetchPriceCatalog({ serviceId: "gpu-instances" });
    const b200 = products.find((p) => p.sku === "b200-8x");
    expect(b200?.prices.some((p) => p.region.startsWith("EU-"))).toBe(false);
  });

  it("skips instances with no published price", async () => {
    const { products } = await fetchPriceCatalog({ serviceId: "gpu-instances" });
    const unpriced = INSTANCE_TYPES.filter((t) => t.hourlyUsd === null).map((t) => t.id);
    expect(unpriced.length).toBeGreaterThan(0);
    for (const id of unpriced) expect(products.find((p) => p.sku === id)).toBeUndefined();
  });

  it("returns CPU instances under the compute service without GPU specs", async () => {
    const { products } = await fetchPriceCatalog({ serviceId: "cpu-instances" });
    expect(products.length).toBeGreaterThan(0);
    expect(products.every((p) => p.family === "compute" && p.specs.gpuCount === undefined)).toBe(
      true,
    );
    expect(products.find((p) => p.sku === "cd-gp-i96-icelake")?.prices).toEqual([
      expect.objectContaining({ region: "RNO2A", amount: 3.36 }),
    ]);
  });

  it("filters to one zone when asked and returns nothing for an unknown service", async () => {
    const { products } = await fetchPriceCatalog({ serviceId: "gpu-instances", region: "RNO2A" });
    expect(products.length).toBeGreaterThan(0);
    expect(products.every((p) => p.prices.every((x) => x.region === "RNO2A"))).toBe(true);
    expect(products.find((p) => p.sku === "b200-8x")).toBeUndefined();
    expect((await fetchPriceCatalog({ serviceId: "nope" })).products).toEqual([]);
  });
});
