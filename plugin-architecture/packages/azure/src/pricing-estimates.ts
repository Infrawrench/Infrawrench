/**
 * Per-type cost estimation built on top of the rate cache in `pricing.ts`.
 *
 * Inputs are the form fields from the create-resource UI; outputs are
 * "estimated monthly USD" or `null` when we don't have rates for the chosen
 * config (e.g. unknown SKU).
 */
import type { CreateSizePricingRequest } from "@infrawrench/plugin-base";
import { type AzurePricingRates, HOURS_PER_MONTH, estimateVmMonthlyPrices } from "./pricing.js";

export function azureSupportsSizePricing(typeId: string): boolean {
  return (
    typeId === "azure-vm" ||
    typeId === "azure-aks-cluster" ||
    typeId === "azure-postgres-flexible" ||
    typeId === "azure-mysql-flexible"
  );
}

export function getAzureCreateSizePricing(
  rates: AzurePricingRates,
  request: CreateSizePricingRequest,
): Record<string, number> {
  return estimateVmMonthlyPrices(request.sizes, rates);
}

export function getAzureCreateCostEstimate(
  typeId: string,
  fields: Record<string, string>,
  rates: AzurePricingRates,
): number | null {
  if (typeId === "azure-vm") {
    const sizeId = fields["size"] ?? "";
    const hourly = rates.vmHourlyUsd[sizeId];
    if (hourly == null) return null;
    const diskGb = Number(fields["bootDiskSizeGb"] ?? "64");
    const diskRate = rates.diskGbMonthUsd["Premium_LRS"] ?? 0;
    const diskCost = Number.isFinite(diskGb) ? diskGb * diskRate : 0;
    return Number((hourly * HOURS_PER_MONTH + diskCost).toFixed(2));
  }
  if (typeId === "azure-aks-cluster") {
    const sizeId = fields["nodeSize"] ?? "";
    const hourly = rates.vmHourlyUsd[sizeId];
    if (hourly == null) return null;
    const nodeCount = Math.max(1, Number(fields["nodeCount"] ?? "3"));
    const diskRate = rates.diskGbMonthUsd["Premium_LRS"] ?? 0;
    const perNodeDisk = 128 * diskRate;
    return Number(((hourly * HOURS_PER_MONTH + perNodeDisk) * nodeCount).toFixed(2));
  }
  if (typeId === "azure-container-instance") {
    if (!rates.containerInstance) return null;
    const cpu = Number(fields["cpu"] ?? "1");
    const memoryGb = Number(fields["memoryGb"] ?? "1.5");
    const secondsPerMonth = HOURS_PER_MONTH * 3600;
    const monthly =
      cpu * rates.containerInstance.vcpuPerSecondUsd * secondsPerMonth +
      memoryGb * rates.containerInstance.memoryGbPerSecondUsd * secondsPerMonth;
    if (!Number.isFinite(monthly) || monthly <= 0) return null;
    return Number(monthly.toFixed(2));
  }
  if (typeId === "azure-redis-cache") {
    const capacity = fields["capacity"] ?? "C1";
    return rates.redisMonthlyUsd[capacity] ?? null;
  }
  if (typeId === "azure-app-service") {
    const sku = fields["sku"] ?? "B1";
    return rates.appServiceMonthlyUsd[sku] ?? null;
  }
  if (typeId === "azure-function-app") {
    const sku = fields["sku"] ?? "Y1";
    return rates.functionAppMonthlyUsd[sku] ?? null;
  }
  if (typeId === "azure-sql-database") {
    const sku = fields["sku"] ?? "Basic";
    return rates.sqlDbMonthlyUsd[sku] ?? null;
  }
  if (typeId === "azure-disk") {
    const diskSizeGb = Number(fields["diskSizeGb"] ?? "128");
    const sku = fields["sku"] ?? "Premium_LRS";
    const perGb = rates.diskGbMonthUsd[sku];
    if (perGb == null || !Number.isFinite(diskSizeGb) || diskSizeGb <= 0) return null;
    return Number((diskSizeGb * perGb).toFixed(2));
  }
  return null;
}
