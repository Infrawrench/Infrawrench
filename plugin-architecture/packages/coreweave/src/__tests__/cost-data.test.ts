import { describe, expect, it } from "vitest";
import { buildCostRows, exportWindow, gpuHoursOf, summarise } from "../cost-data.js";
import type { FocusRow } from "../focus.js";
import { splitWindow } from "../focus.js";
import { parseNegotiatedRates, rateForUsage } from "../rates.js";

const loc = (over: Partial<FocusRow>): FocusRow => ({
  ChargePeriodStart: "2026-09-10T03:00:00Z",
  ChargePeriodEnd: "2026-09-10T04:00:00Z",
  PricingQuantity: 16,
  PricingUnit: "Instance-Hour",
  ServiceName: "GPU Compute",
  SkuId: "gd-8xh100ib-i128",
  RegionId: "US-EAST-04A",
  x_ClusterId: "c-1",
  x_ClusterName: "train",
  x_ProductFamily: "GPU Compute",
  x_CapacityPlan: null,
  ...over,
});

const plan = (over: Partial<FocusRow>): FocusRow => ({
  ChargePeriodStart: "2026-09-10T03:00:00Z",
  PricingQuantity: 16,
  PricingUnit: "Instance-Hour",
  SkuId: "gd-8xh100ib-i128",
  x_CapacityPlan: "On-Demand",
  ...over,
});

describe("buildCostRows", () => {
  it("prices instance-hours at the published on-demand rate and tags the source", () => {
    const rows = buildCostRows([loc({})], [], parseNegotiatedRates(""));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "2026-09-10",
      service: "GPU Compute",
      region: "US-EAST-04A",
      resourceId: "c-1",
      currency: "USD",
      usageAmount: 16,
      usageUnit: "Instance-Hour",
      tags: {
        cluster: "train",
        sku: "gd-8xh100ib-i128",
        pricing: "list",
        capacityPlan: "unattributed",
      },
    });
    expect(rows[0]?.amount).toBeCloseTo(16 * 49.24, 4);
  });

  it("sums hours of the same day, cluster and SKU into one row", () => {
    const rows = buildCostRows(
      [loc({}), loc({ ChargePeriodStart: "2026-09-10T04:00:00Z" })],
      [],
      parseNegotiatedRates(""),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.usageAmount).toBe(32);
  });

  it("splits a location row across capacity plans by that day's mix and prices each plan", () => {
    const rates = parseNegotiatedRates("reserved/gd-8xh100ib-i128=30");
    const rows = buildCostRows(
      [loc({ PricingQuantity: 20 })],
      [plan({ PricingQuantity: 15, x_CapacityPlan: "Reservation" }), plan({ PricingQuantity: 5 })],
      rates,
    );
    const reserved = rows.find((r) => r.tags?.["capacityPlan"] === "reserved");
    const onDemand = rows.find((r) => r.tags?.["capacityPlan"] === "on-demand");
    expect(reserved?.usageAmount).toBe(15);
    expect(reserved?.amount).toBeCloseTo(15 * 30, 4);
    expect(reserved?.tags?.["pricing"]).toBe("negotiated");
    expect(onDemand?.usageAmount).toBe(5);
    expect(onDemand?.amount).toBeCloseTo(5 * 49.24, 4);
  });

  it("keeps usage but no money for a SKU without a published price", () => {
    const rows = buildCostRows([loc({ SkuId: "gb300-4x" })], [], parseNegotiatedRates(""));
    expect(rows[0]?.amount).toBe(0);
    expect(rows[0]?.usageAmount).toBe(16);
    expect(rows[0]?.tags?.["pricing"]).toBe("unpriced");
  });

  it("prices GPU-hours per GPU, storage per GiB-hour and IPs per hour", () => {
    const rates = parseNegotiatedRates("");
    expect(
      rateForUsage(rates, { sku: "gd-8xh100ib-i128", unit: "GPU-Hour", service: "GPU Compute" })
        .rate,
    ).toBeCloseTo(49.24 / 8, 6);
    expect(
      rateForUsage(rates, { sku: "dfs", unit: "GiB-Hour", service: "Storage" }).rate,
    ).toBeCloseTo((0.07 * 1.073741824) / 730, 9);
    expect(
      rateForUsage(rates, { sku: "ip", unit: "IP-Hour", service: "Network" }).rate,
    ).toBeCloseTo(4 / 730, 9);
    expect(rateForUsage(rates, { sku: "x", unit: "Widget-Hour", service: "x" }).source).toBe(
      "unpriced",
    );
  });
});

describe("export windows", () => {
  it("clips history before 2026-01-01 and stops at the top of the current hour", () => {
    const now = Date.parse("2026-10-04T15:42:00Z");
    expect(exportWindow({ fromDate: "2025-11-01", toDate: "2026-10-04" }, now)).toEqual({
      start: "2026-01-01T00:00:00Z",
      end: "2026-10-04T15:00:00Z",
    });
    expect(exportWindow({ fromDate: "2025-01-01", toDate: "2025-06-01" }, now)).toBeNull();
  });

  it("splits long ranges into 90-day requests", () => {
    const parts = splitWindow("2026-01-01T00:00:00Z", "2026-10-01T00:00:00Z");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toEqual(["2026-01-01T00:00:00Z", "2026-04-01T00:00:00Z"]);
    expect(parts.at(-1)?.[1]).toBe("2026-10-01T00:00:00Z");
  });
});

describe("summarise", () => {
  it("rolls up GPU-hours and estimated spend by SKU, cluster and plan", () => {
    const location = [
      loc({}),
      loc({ SkuId: "cd-gp-a192-genoa", ServiceName: "CPU Compute", PricingQuantity: 2 }),
    ];
    const rows = buildCostRows(location, [], parseNegotiatedRates(""));
    const s = summarise(rows, location, { start: "a", end: "b" });
    expect(s.gpuHours).toBe(16 * 8);
    expect(s.estimatedUsd).toBeCloseTo(16 * 49.24 + 2 * 7.78, 2);
    expect(s.bySku[0]?.sku).toBe("gd-8xh100ib-i128");
    expect(s.byCluster[0]).toMatchObject({ cluster: "train", gpuHours: 128 });
  });

  it("counts GPU-hours from either unit", () => {
    expect(gpuHoursOf(loc({ PricingUnit: "GPU-Hour", PricingQuantity: 10 }))).toBe(10);
    expect(gpuHoursOf(loc({ PricingUnit: "Instance-Hour", PricingQuantity: 1 }))).toBe(8);
    expect(gpuHoursOf(loc({ PricingUnit: "GiB-Hour" }))).toBe(0);
  });
});
