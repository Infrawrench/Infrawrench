import { describe, expect, it } from "vitest";
import { fetchOciPriceCatalog, ociPriceCatalog, shapeHourly } from "../price-catalog.js";
import { FALLBACK_RATES, type OciShape } from "../pricing.js";

const SHAPES: OciShape[] = [
  {
    shape: "VM.Standard.E4.Flex",
    isFlexible: true,
    ocpuOptions: { min: 1, max: 2 },
    memoryOptions: { defaultPerOcpuInGBs: 16 },
  },
  { shape: "VM.Standard2.1", ocpus: 1, memoryInGBs: 15 },
  { shape: "BM.Standard.E4.128", ocpus: 128, memoryInGBs: 2048 },
];

describe("oracle cloud price catalog", () => {
  it("is credentialed and not region scoped", () => {
    expect(ociPriceCatalog.requiresCredentials).toBe(true);
    expect(ociPriceCatalog.regionScoped).toBe(false);
    expect(ociPriceCatalog.regions[0]!.area).toBe("north-america");
  });

  it("lists flex shapes at OCPU steps with hourly prices in every region", async () => {
    const result = await fetchOciPriceCatalog(
      { listShapes: async () => SHAPES, rates: async () => FALLBACK_RATES },
      { serviceId: "compute" },
    );
    const skus = result.products.map((p) => p.sku);
    expect(skus).toContain("VM.Standard.E4.Flex/1/16");
    expect(skus).toContain("VM.Standard.E4.Flex/2/32");
    expect(skus.some((s) => s.startsWith("BM."))).toBe(false);
    const one = result.products.find((p) => p.sku === "VM.Standard.E4.Flex/1/16")!;
    expect(one.specs).toMatchObject({ vcpus: 2, memoryGb: 16 });
    const hourly = shapeHourly(FALLBACK_RATES, "VM.Standard.E4.Flex", 1, 16)!;
    expect(one.prices).toHaveLength(ociPriceCatalog.regions.length);
    expect(one.prices[0]).toMatchObject({ rateType: "on-demand", unit: "hour", currency: "USD" });
    expect(one.prices[0]!.amount).toBeCloseTo(hourly, 9);
    expect(one.estimate).toEqual({
      resourceTypeId: "instance",
      fields: { region: "{region}", size: "VM.Standard.E4.Flex/1/16" },
    });
  });

  it("returns nothing for an unknown service", async () => {
    const result = await fetchOciPriceCatalog(
      { listShapes: async () => SHAPES, rates: async () => FALLBACK_RATES },
      { serviceId: "nope" },
    );
    expect(result.products).toEqual([]);
  });
});
