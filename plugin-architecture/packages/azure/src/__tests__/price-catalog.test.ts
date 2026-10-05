import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpHostServices } from "@infrawrench/plugin-base";
import {
  fetchPriceCatalog,
  mapVmRows,
  priceCatalog,
  resetPriceCatalogCache,
} from "../price-catalog.js";
import type { RetailPriceItem } from "../pricing.js";

function row(overrides: Partial<RetailPriceItem>): RetailPriceItem {
  return {
    currencyCode: "USD",
    retailPrice: 0.096,
    unitPrice: 0.096,
    armRegionName: "eastus",
    location: "US East",
    effectiveStartDate: "2024-01-01T00:00:00Z",
    meterName: "D2s v5",
    productName: "Virtual Machines Dsv5 Series",
    skuName: "D2s v5",
    serviceName: "Virtual Machines",
    armSkuName: "Standard_D2s_v5",
    unitOfMeasure: "1 Hour",
    type: "Consumption",
    ...overrides,
  } as RetailPriceItem;
}

describe("azure price catalog", () => {
  afterEach(() => resetPriceCatalogCache());

  it("declares a public catalog with eastus first", () => {
    expect(priceCatalog.requiresCredentials).toBe(false);
    expect(priceCatalog.regions[0]!.id).toBe("eastus");
  });

  it("maps on-demand, spot, reserved and savings-plan rates for Linux rows", () => {
    const products = mapVmRows(
      [
        row({
          savingsPlan: [
            { term: "1 Year", retailPrice: 0.07, unitPrice: 0.07 },
            { term: "3 Years", retailPrice: 0.05, unitPrice: 0.05 },
          ],
        } as Partial<RetailPriceItem>),
        row({ retailPrice: 0.02, skuName: "D2s v5 Spot", meterName: "D2s v5 Spot" }),
        row({
          retailPrice: 0.01,
          skuName: "D2s v5 Low Priority",
          meterName: "D2s v5 Low Priority",
        }),
        row({ productName: "Virtual Machines Dsv5 Series Windows", retailPrice: 0.188 }),
        row({
          type: "Reservation",
          reservationTerm: "1 Year",
          retailPrice: 525.6,
        } as Partial<RetailPriceItem>),
      ],
      "eastus",
    );
    expect(products).toHaveLength(1);
    const p = products[0]!;
    expect(p.sku).toBe("Standard_D2s_v5");
    expect(p.estimate).toEqual({
      resourceTypeId: "azure-vm",
      fields: { region: "{region}", size: "Standard_D2s_v5" },
    });
    const by = (rateType: string, term?: string) =>
      p.prices.find((x) => x.rateType === rateType && x.term === term);
    expect(by("on-demand")!.amount).toBe(0.096);
    expect(by("spot")!.amount).toBe(0.02);
    expect(by("reserved", "1yr")!.amount).toBeCloseTo(525.6 / 8760);
    expect(by("savings-plan", "3yr")!.amount).toBe(0.05);
    expect(p.specs.vcpus).toBe(2);
  });

  it("fetches one region through the host HTTP service and caches it", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ Items: [row({})], NextPageLink: null }),
    }));
    const http = { request } as unknown as HttpHostServices;
    const first = await fetchPriceCatalog(
      { serviceId: "virtual-machines", region: "eastus" },
      { http },
    );
    expect(first.products.map((p) => p.sku)).toEqual(["Standard_D2s_v5"]);
    await fetchPriceCatalog({ serviceId: "virtual-machines", region: "eastus" }, { http });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("refuses region ids that are not ARM region names", async () => {
    const result = await fetchPriceCatalog({
      serviceId: "virtual-machines",
      region: "eastus' or 1 eq 1",
    });
    expect(result.products).toEqual([]);
  });
});
