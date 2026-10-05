import { describe, expect, it, vi } from "vitest";
import {
  familyRatesForRegion,
  fetchGcpPriceCatalog,
  gcpPriceCatalog,
  parseComputeSkuDescription,
} from "../price-catalog.js";
import type { CloudBillingSku } from "../pricing.js";

function sku(
  description: string,
  usageType: string,
  usd: number,
  regions = ["us-central1"],
): CloudBillingSku {
  const units = Math.floor(usd);
  return {
    description,
    serviceRegions: regions,
    category: { resourceFamily: "Compute", usageType },
    pricingInfo: [
      {
        pricingExpression: {
          tieredRates: [
            { unitPrice: { units: String(units), nanos: Math.round((usd - units) * 1e9) } },
          ],
        },
      },
    ],
  };
}

const SKUS: CloudBillingSku[] = [
  sku("N2 Instance Core running in Americas", "OnDemand", 0.031611),
  sku("N2 Instance Ram running in Americas", "OnDemand", 0.004237),
  sku("Spot Preemptible N2 Instance Core running in Americas", "Preemptible", 0.0077),
  sku("Spot Preemptible N2 Instance Ram running in Americas", "Preemptible", 0.001),
  sku("Commitment v1: N2 Cpu in Americas for 1 Year", "Commit1Yr", 0.019915),
  // RAM commitment missing on purpose: no half-priced reserved rate.
  sku("N2 Custom Instance Core running in Americas", "OnDemand", 0.9),
  sku("N2 Instance Core running in EMEA", "OnDemand", 0.5, ["europe-west1"]),
];

describe("gcp price catalog", () => {
  it("declares a credentialed catalog with us-central1 first", () => {
    expect(gcpPriceCatalog.requiresCredentials).toBe(true);
    expect(gcpPriceCatalog.regions[0]!.id).toBe("us-central1");
  });

  it("parses plain core and RAM SKUs only", () => {
    expect(parseComputeSkuDescription("N2D AMD Instance Core running in Americas")).toEqual({
      family: "n2d",
      part: "core",
    });
    expect(parseComputeSkuDescription("Commitment v1: E2 Ram in Americas for 3 Year")).toEqual({
      family: "e2",
      part: "ram",
    });
    expect(parseComputeSkuDescription("N2 Custom Instance Core running in Americas")).toBeNull();
    expect(parseComputeSkuDescription("Nvidia L4 GPU running in Americas")).toBeNull();
  });

  it("reads per-region rates by usage type", () => {
    const rates = familyRatesForRegion(SKUS, "us-central1");
    expect(rates.get("n2|on-demand|")).toEqual({ core: 0.031611, ram: 0.004237 });
    expect(rates.get("n2|spot|")).toEqual({ core: 0.0077, ram: 0.001 });
    expect(rates.get("n2|reserved|1yr")).toEqual({ core: 0.019915 });
  });

  it("prices machine types in a zone of the region with an estimate link", async () => {
    const get = vi.fn(async (url: string) => {
      if (url.endsWith("/regions/us-central1")) {
        return { zones: ["https://x/zones/us-central1-b", "https://x/zones/us-central1-a"] };
      }
      return {
        items: [
          { name: "n2-standard-2", guestCpus: 2, memoryMb: 8192 },
          { name: "e2-micro", guestCpus: 2, memoryMb: 1024, isSharedCpu: true },
          {
            name: "g2-standard-4",
            guestCpus: 4,
            memoryMb: 16384,
            accelerators: [{ guestAcceleratorType: "nvidia-l4", guestAcceleratorCount: 1 }],
          },
        ],
      };
    });
    const result = await fetchGcpPriceCatalog(
      { project: "fake-project", get: get as never, computeSkus: async () => SKUS },
      { serviceId: "compute-engine", region: "us-central1" },
    );
    expect(result.products.map((p) => p.sku)).toEqual(["n2-standard-2"]);
    const p = result.products[0]!;
    expect(p.specs).toMatchObject({ vcpus: 2, memoryGb: 8 });
    expect(p.estimate).toEqual({
      resourceTypeId: "gce-instance",
      fields: { zone: "us-central1-a", machineType: "n2-standard-2" },
    });
    const onDemand = p.prices.find((x) => x.rateType === "on-demand")!;
    expect(onDemand.amount).toBeCloseTo(2 * 0.031611 + 8 * 0.004237, 6);
    expect(p.prices.some((x) => x.rateType === "spot")).toBe(true);
    expect(p.prices.some((x) => x.rateType === "reserved")).toBe(false);
    expect(get.mock.calls[1]![0]).toContain("/zones/us-central1-a/machineTypes");
  });
});
