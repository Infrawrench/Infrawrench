import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInstanceRateCache,
  fetchInstanceCatalog,
  fetchInstanceOnDemandRates,
  instancePricingSelectionSql,
} from "../instance-rates.js";
import type { InstancePricingHostServices } from "../manifest.js";

function host(rows: unknown[][], columns: string[]): InstancePricingHostServices {
  return {
    query: vi.fn(async () => ({
      columns: columns.map((name) => ({ name, type: "String" })),
      rows: rows as never,
      truncated: false,
      elapsedMs: 1,
    })),
  };
}

const request = { platform: "ec2", region: "us-east-1", instanceTypes: ["a.large", "b.large"] };

describe("fetchInstanceOnDemandRates", () => {
  beforeEach(() => clearInstanceRateCache());

  it("reads rates by type and leaves out what the region does not sell", async () => {
    const pricing = host([["a.large", 0.1]], ["instanceType", "hourly"]);
    expect(await fetchInstanceOnDemandRates(pricing, request)).toEqual({ "a.large": 0.1 });
  });

  it("is null, not empty, without a warehouse or when it fails", async () => {
    expect(await fetchInstanceOnDemandRates(undefined, request)).toBeNull();
    const failing: InstancePricingHostServices = {
      query: vi.fn(async () => {
        throw new Error("down");
      }),
    };
    expect(await fetchInstanceOnDemandRates(failing, request)).toBeNull();
  });

  it("does not remember a failure", async () => {
    const pricing: InstancePricingHostServices = {
      query: vi
        .fn<InstancePricingHostServices["query"]>()
        .mockRejectedValueOnce(new Error("down"))
        .mockResolvedValue({
          columns: [
            { name: "instanceType", type: "String" },
            { name: "hourly", type: "Float64" },
          ],
          rows: [["a.large", 0.1]],
          truncated: false,
          elapsedMs: 1,
        }),
    };
    expect(await fetchInstanceOnDemandRates(pricing, request)).toBeNull();
    expect(await fetchInstanceOnDemandRates(pricing, request)).toEqual({ "a.large": 0.1 });
  });

  it("answers a repeat from cache, and asks nothing for no types", async () => {
    const pricing = host([["a.large", 0.1]], ["instanceType", "hourly"]);
    await fetchInstanceOnDemandRates(pricing, request);
    await fetchInstanceOnDemandRates(pricing, {
      ...request,
      instanceTypes: ["b.large", "a.large"],
    });
    expect(pricing.query).toHaveBeenCalledTimes(1);
    expect(await fetchInstanceOnDemandRates(pricing, { ...request, instanceTypes: [] })).toEqual(
      {},
    );
  });

  it("stays under the API's statement limit for a whole catalog", async () => {
    const pricing = host([], ["instanceType", "hourly"]);
    const instanceTypes = Array.from({ length: 1600 }, (_, i) => `family${i}.16xlarge`);
    await fetchInstanceOnDemandRates(pricing, { ...request, instanceTypes });
    const calls = vi.mocked(pricing.query).mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    for (const [sql] of calls) expect(sql.length).toBeLessThan(20_000);
  });
});

describe("instancePricingSelectionSql", () => {
  it("escapes values and ignores keys that are not dimensions", () => {
    const sql = instancePricingSelectionSql({
      operating_system: "Li'nux",
      "variant.priority": "Regular",
      "x) OR 1=1 --": "y",
    });
    expect(sql).toBe(
      " AND operating_system IN ('Li\\'nux', '') AND variant['priority'] IN ('Regular', '')",
    );
  });
});

describe("fetchInstanceCatalog", () => {
  beforeEach(() => clearInstanceRateCache());

  it("converts specs to the size picker's units", async () => {
    const pricing = host(
      [["m7g.large", "m7g", "General purpose", "arm64", 2, 8]],
      ["instanceType", "family", "category", "architecture", "vcpu", "memoryGib"],
    );
    expect(await fetchInstanceCatalog(pricing, "ec2")).toEqual([
      {
        instanceType: "m7g.large",
        family: "m7g",
        category: "General purpose",
        architecture: "arm64",
        vcpus: 2,
        memoryMb: 8192,
      },
    ]);
  });

  it("is null when there is nothing to offer, so the plugin keeps its own list", async () => {
    expect(await fetchInstanceCatalog(undefined, "ec2")).toBeNull();
    expect(await fetchInstanceCatalog(host([], ["instanceType"]), "ec2")).toBeNull();
  });
});
