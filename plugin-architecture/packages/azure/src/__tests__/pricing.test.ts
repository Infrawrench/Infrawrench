import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchAzurePricingRates,
  estimateVmMonthlyPrices,
  HOURS_PER_MONTH,
  type AzurePricingRates,
} from "../pricing.js";
import {
  azureSupportsSizePricing,
  getAzureCreateSizePricing,
  getAzureCreateCostEstimate,
} from "../pricing-estimates.js";

function priceResponse(items: unknown[]): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ Items: items }),
    text: async () => "",
  } as unknown as Response;
}

const emptyRates: AzurePricingRates = {
  vmHourlyUsd: {},
  diskGbMonthUsd: {},
  redisMonthlyUsd: {},
  appServiceMonthlyUsd: {},
  functionAppMonthlyUsd: {},
  sqlDbMonthlyUsd: {},
  containerInstance: null,
};

afterEach(() => vi.restoreAllMocks());

describe("fetchAzurePricingRates", () => {
  it("parses VM, disk, redis, app service, sql and container rates from retail rows", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const filter = new URL(url).searchParams.get("$filter") ?? "";
      if (filter.includes("Virtual Machines")) {
        return priceResponse([
          {
            type: "Consumption",
            armSkuName: "Standard_D2s_v5",
            productName: "Virtual Machines Dsv5 Series",
            meterName: "D2s v5",
            skuName: "D2s v5",
            unitOfMeasure: "1 Hour",
            retailPrice: 0.1,
          },
          // Windows variant excluded
          {
            type: "Consumption",
            armSkuName: "Standard_D2s_v5",
            productName: "Virtual Machines Dsv5 Series Windows",
            meterName: "D2s v5",
            skuName: "D2s v5",
            unitOfMeasure: "1 Hour",
            retailPrice: 0.2,
          },
          // Spot variant excluded
          {
            type: "Consumption",
            armSkuName: "Standard_D2s_v5",
            productName: "Virtual Machines Dsv5 Series",
            meterName: "D2s v5 Spot",
            skuName: "D2s v5 Spot",
            unitOfMeasure: "1 Hour",
            retailPrice: 0.05,
          },
        ]);
      }
      if (filter.includes("Storage")) {
        return priceResponse([
          {
            type: "Consumption",
            productName: "Premium SSD Managed Disks",
            skuName: "P10 LRS Disk",
            unitOfMeasure: "1/Month",
            retailPrice: 19.71,
          },
        ]);
      }
      if (filter.includes("Redis Cache")) {
        return priceResponse([
          {
            type: "Consumption",
            skuName: "Standard C1 Cache",
            unitOfMeasure: "1 Hour",
            retailPrice: 0.1,
          },
        ]);
      }
      if (filter.includes("App Service")) {
        return priceResponse([
          {
            type: "Consumption",
            skuName: "B1",
            productName: "App Service",
            unitOfMeasure: "1 Hour",
            retailPrice: 0.075,
          },
          {
            type: "Consumption",
            skuName: "Y1",
            productName: "Functions",
            unitOfMeasure: "1 Hour",
            retailPrice: 0,
          },
          {
            type: "Consumption",
            skuName: "F1 Free",
            productName: "App Service",
            unitOfMeasure: "1 Hour",
            retailPrice: 0,
          },
        ]);
      }
      if (filter.includes("SQL Database")) {
        return priceResponse([
          {
            type: "Consumption",
            productName: "SQL Database Single Standard",
            skuName: "S0",
            unitOfMeasure: "1/Month",
            retailPrice: 15,
          },
        ]);
      }
      if (filter.includes("Container Instances")) {
        return priceResponse([
          {
            type: "Consumption",
            meterName: "vCPU Duration",
            productName: "Container Instances",
            unitOfMeasure: "1 Second",
            retailPrice: 0.000001,
          },
          {
            type: "Consumption",
            meterName: "Memory Duration",
            productName: "Container Instances",
            unitOfMeasure: "1 Second",
            retailPrice: 0.0000001,
          },
        ]);
      }
      return priceResponse([]);
    });

    const rates = await fetchAzurePricingRates("eastus");
    expect(fetchSpy).toHaveBeenCalled();
    expect(rates.vmHourlyUsd["Standard_D2s_v5"]).toBe(0.1);
    expect(rates.diskGbMonthUsd["Premium_LRS"]).toBeGreaterThan(0);
    expect(rates.redisMonthlyUsd["C1"]).toBeCloseTo(0.1 * HOURS_PER_MONTH, 1);
    expect(rates.appServiceMonthlyUsd["B1"]).toBeGreaterThan(0);
    expect(rates.functionAppMonthlyUsd["Y1"]).toBe(0);
    expect(rates.appServiceMonthlyUsd["F1"]).toBe(0);
    expect(rates.sqlDbMonthlyUsd["S0"]).toBe(15);
    expect(rates.containerInstance).not.toBeNull();
  });

  it("tolerates per-family fetch failures (leaves maps empty)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "err",
      json: async () => ({}),
    } as unknown as Response);
    const rates = await fetchAzurePricingRates("eastus");
    expect(rates.vmHourlyUsd).toEqual({});
    expect(rates.containerInstance).toBeNull();
  });
});

describe("estimateVmMonthlyPrices", () => {
  it("converts hourly to monthly and skips sizes without a rate", () => {
    const rates = { ...emptyRates, vmHourlyUsd: { A: 1 } };
    const out = estimateVmMonthlyPrices([{ id: "A" }, { id: "B" }], rates);
    expect(out["A"]).toBe(Number(HOURS_PER_MONTH.toFixed(2)));
    expect(out["B"]).toBeUndefined();
  });
});

describe("pricing-estimates", () => {
  it("azureSupportsSizePricing", () => {
    expect(azureSupportsSizePricing("azure-vm")).toBe(true);
    expect(azureSupportsSizePricing("azure-aks-cluster")).toBe(true);
    expect(azureSupportsSizePricing("azure-storage-account")).toBe(false);
  });

  it("getAzureCreateSizePricing delegates to estimateVmMonthlyPrices", () => {
    const rates = { ...emptyRates, vmHourlyUsd: { X: 2 } };
    const out = getAzureCreateSizePricing(rates, { sizes: [{ id: "X" }] } as never);
    expect(out["X"]).toBeGreaterThan(0);
  });

  describe("getAzureCreateCostEstimate", () => {
    it("VM = compute + disk", () => {
      const rates = {
        ...emptyRates,
        vmHourlyUsd: { S: 0.1 },
        diskGbMonthUsd: { Premium_LRS: 0.1 },
      };
      const est = getAzureCreateCostEstimate(
        "azure-vm",
        { size: "S", bootDiskSizeGb: "64" },
        rates,
      );
      expect(est).toBeCloseTo(0.1 * HOURS_PER_MONTH + 64 * 0.1, 1);
    });

    it("VM returns null for an unknown size", () => {
      expect(getAzureCreateCostEstimate("azure-vm", { size: "?" }, emptyRates)).toBeNull();
    });

    it("AKS multiplies per-node cost by node count", () => {
      const rates = {
        ...emptyRates,
        vmHourlyUsd: { N: 0.1 },
        diskGbMonthUsd: { Premium_LRS: 0.1 },
      };
      const est = getAzureCreateCostEstimate(
        "azure-aks-cluster",
        { nodeSize: "N", nodeCount: "2" },
        rates,
      );
      expect(est).toBeCloseTo((0.1 * HOURS_PER_MONTH + 128 * 0.1) * 2, 1);
    });

    it("container instance derives from per-second rates", () => {
      const rates = {
        ...emptyRates,
        containerInstance: { vcpuPerSecondUsd: 0.00001, memoryGbPerSecondUsd: 0.000001 },
      };
      const est = getAzureCreateCostEstimate(
        "azure-container-instance",
        { cpu: "1", memoryGb: "1.5" },
        rates,
      );
      expect(est).toBeGreaterThan(0);
    });

    it("container instance returns null without rates", () => {
      expect(getAzureCreateCostEstimate("azure-container-instance", {}, emptyRates)).toBeNull();
    });

    it("redis / app-service / function-app / sql look up by sku", () => {
      const rates = {
        ...emptyRates,
        redisMonthlyUsd: { C1: 50 },
        appServiceMonthlyUsd: { B1: 55 },
        functionAppMonthlyUsd: { Y1: 0 },
        sqlDbMonthlyUsd: { Basic: 5 },
      };
      expect(getAzureCreateCostEstimate("azure-redis-cache", { capacity: "C1" }, rates)).toBe(50);
      expect(getAzureCreateCostEstimate("azure-app-service", { sku: "B1" }, rates)).toBe(55);
      expect(getAzureCreateCostEstimate("azure-function-app", { sku: "Y1" }, rates)).toBe(0);
      expect(getAzureCreateCostEstimate("azure-sql-database", { sku: "Basic" }, rates)).toBe(5);
    });

    it("disk = size * per-gb, null when missing rate", () => {
      const rates = { ...emptyRates, diskGbMonthUsd: { Premium_LRS: 0.1 } };
      expect(
        getAzureCreateCostEstimate("azure-disk", { diskSizeGb: "100", sku: "Premium_LRS" }, rates),
      ).toBe(10);
      expect(getAzureCreateCostEstimate("azure-disk", { sku: "Unknown" }, rates)).toBeNull();
    });

    it("returns null for unhandled types", () => {
      expect(getAzureCreateCostEstimate("azure-vnet", {}, emptyRates)).toBeNull();
    });
  });
});
