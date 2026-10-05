import { describe, it, expect } from "vitest";

import { buildGkeNodeRates, poolZone, type MachineSpec } from "../gke-node-rates.js";
import { fetchPricingRatesForGeo, gpuSkuKey, type PricingRates } from "../pricing.js";

const rates: PricingRates = {
  machineRates: {
    n1: { corePerHourUsd: 0.031611, ramPerGiBHourUsd: 0.004237 },
    a2: { corePerHourUsd: 0.0332, ramPerGiBHourUsd: 0.0045 },
  },
  diskGbMonthUsd: {},
  gpuHourlyUsd: {
    [gpuSkuKey("Nvidia Tesla T4 GPU running in Americas")]: 0.35,
    "a100-tesla": 2.93,
  },
};

const specs = new Map<string, MachineSpec>([
  ["n1-standard-8", { guestCpus: 8, memoryMb: 30720, accelerators: [] }],
  [
    "a2-highgpu-1g",
    {
      guestCpus: 12,
      memoryMb: 87040,
      accelerators: [{ guestAcceleratorType: "nvidia-tesla-a100", guestAcceleratorCount: 1 }],
    },
  ],
]);

describe("gpuSkuKey", () => {
  it("meets a SKU description and an accelerator type on one key", () => {
    expect(gpuSkuKey("Nvidia Tesla T4 GPU running in Americas")).toBe(gpuSkuKey("nvidia-tesla-t4"));
    expect(gpuSkuKey("Nvidia A100 80GB GPU running in EMEA")).toBe(gpuSkuKey("nvidia-a100-80gb"));
    expect(gpuSkuKey("nvidia-tesla-a100")).not.toBe(gpuSkuKey("nvidia-a100-80gb"));
  });
});

describe("buildGkeNodeRates", () => {
  it("prices each pool by machine and attached GPUs, keyed by pool label", () => {
    const out = JSON.parse(
      buildGkeNodeRates(
        {
          location: "us-central1",
          nodePools: [
            { name: "cpu", locations: ["us-central1-a"], config: { machineType: "n1-standard-8" } },
            {
              name: "t4",
              locations: ["us-central1-a"],
              config: {
                machineType: "n1-standard-8",
                accelerators: [{ acceleratorType: "nvidia-tesla-t4", acceleratorCount: "2" }],
              },
            },
            {
              name: "a100",
              locations: ["us-central1-a"],
              config: { machineType: "a2-highgpu-1g" },
            },
          ],
        },
        specs,
        rates,
      ),
    );
    const n1 = 8 * 0.031611 + 30 * 0.004237;
    const pools = out.byNodeLabel["cloud.google.com/gke-nodepool"];
    expect(pools.cpu).toBeCloseTo(n1, 8);
    expect(pools.t4).toBeCloseTo(n1 + 2 * 0.35, 8);
    expect(pools.a100).toBeCloseTo(12 * 0.0332 + 85 * 0.0045 + 2.93, 8);
    expect(out.gpuHourly).toEqual({ "nvidia-tesla-t4": 0.35, "nvidia-tesla-a100": 2.93 });
    expect(out.source).toBe("list-price");
  });

  it("leaves Autopilot, Spot pools and unpriced GPUs out", () => {
    expect(buildGkeNodeRates({ autopilot: { enabled: true }, nodePools: [] }, specs, rates)).toBe(
      "",
    );
    const out = buildGkeNodeRates(
      {
        location: "us-central1-a",
        nodePools: [
          { name: "spot", config: { machineType: "n1-standard-8", spot: true } },
          {
            name: "l4",
            config: {
              machineType: "n1-standard-8",
              accelerators: [{ acceleratorType: "nvidia-l4", acceleratorCount: 1 }],
            },
          },
        ],
      },
      specs,
      rates,
    );
    expect(out).toBe("");
  });

  it("finds the zone to look machine types up in", () => {
    expect(poolZone({ location: "us-central1" }, { locations: ["us-central1-f"] })).toBe(
      "us-central1-f",
    );
    expect(poolZone({ location: "europe-west4-b" }, {})).toBe("europe-west4-b");
    expect(poolZone({ location: "europe-west4" }, {})).toBeNull();
  });
});

describe("fetchPricingRatesForGeo GPU SKUs", () => {
  it("collects the geo's on-demand GPU SKUs and skips commitments", async () => {
    const sku = (description: string, units: string, nanos: number, usageType = "OnDemand") => ({
      description,
      category: { resourceFamily: "Compute", resourceGroup: "GPU", usageType },
      pricingInfo: [{ pricingExpression: { tieredRates: [{ unitPrice: { units, nanos } }] } }],
    });
    const result = await fetchPricingRatesForGeo("Americas", async <T>() => {
      return {
        skus: [
          sku("Nvidia Tesla T4 GPU running in Americas", "0", 350_000_000),
          sku(
            "Commitment v1: Nvidia Tesla T4 GPU running in Americas for 1 Year",
            "0",
            220_000_000,
          ),
          sku("Nvidia Tesla T4 GPU running in EMEA", "0", 410_000_000),
          sku("Nvidia Tesla T4 GPU running in Americas", "0", 110_000_000, "Preemptible"),
        ],
      } as T;
    });
    expect(result.gpuHourlyUsd).toEqual({ [gpuSkuKey("nvidia-tesla-t4")]: 0.35 });
  });
});
