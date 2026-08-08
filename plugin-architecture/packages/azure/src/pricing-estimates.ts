/**
 * Per-type cost estimation built on top of the rate cache in `pricing.ts`.
 *
 * Inputs are field values from the create-resource UI; outputs are a
 * {@link CostEstimate} — a monthly total plus the line items that make it up
 * — or `null` when we have no rates for the chosen config (e.g. an unknown
 * SKU). Nothing here approximates: an unpriced component is dropped and the
 * estimate says it is partial.
 *
 * Where the create form and the lister spell a field differently, both
 * spellings are accepted, so the same call prices an existing resource from
 * its stored fields. That is the split `rightsizing.createSizeFieldKey`
 * already names on `azure-vm` (`size` in the form, `vmSize` on the resource).
 */
import {
  buildCostEstimate,
  type CostEstimate,
  type CostEstimateLineItem,
  type CreateSizePricingRequest,
} from "@infrawrench/plugin-base";
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

/** First non-empty value among `keys`, so form and lister spellings both work. */
function pick(fields: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    const value = fields[key];
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

/**
 * Map Redis form/lister fields onto a pricing rate key like `C0` / `P1`.
 *
 * The create form stores `capacity` as `"0"`..`"6"` and `sku` as
 * Basic/Standard/Premium; the lister stores the same pair (capacity as a
 * number that `stringifyFields` turns into `"0"`). Rate tables are keyed by
 * the family+capacity code Azure publishes (`C0`, `P1`, …). Already-coded
 * values (`"C1"`) are accepted as-is so tests and any hand-built payloads keep
 * working.
 */
function redisRateKey(fields: Record<string, string>): string {
  const raw = pick(fields, "capacity");
  if (/^[CP]\d+$/i.test(raw)) return raw.toUpperCase();
  const sku = pick(fields, "sku") || "Basic";
  const family = sku.toLowerCase() === "premium" ? "P" : "C";
  // Form default is capacity "0" (C0 / P0) — not C1.
  const n = raw === "" ? 0 : Number(raw);
  if (!Number.isFinite(n) || n < 0) return `${family}0`;
  return `${family}${Math.floor(n)}`;
}

function positiveNumber(raw: string, fallback: number): number {
  const n = Number(raw === "" ? fallback : raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function money(usd: number): string {
  return `$${Number(usd.toFixed(5))}`;
}

/** The `hourly × 730` compute line every VM-shaped type shares. */
function computeLine(label: string, hourlyUsd: number | undefined): CostEstimateLineItem | null {
  if (hourlyUsd == null) return null;
  return {
    label,
    monthlyAmount: hourlyUsd * HOURS_PER_MONTH,
    detail: `${money(hourlyUsd)}/hour × ${HOURS_PER_MONTH} h`,
  };
}

function diskLine(
  label: string,
  sizeGb: number,
  sku: string,
  rates: AzurePricingRates,
): CostEstimateLineItem | null {
  const perGb = rates.diskGbMonthUsd[sku];
  if (perGb == null || sizeGb <= 0) return null;
  return {
    label,
    monthlyAmount: sizeGb * perGb,
    detail: `${sizeGb} GB × ${money(perGb)}/GB-month (${sku})`,
    quantity: sizeGb,
    unit: "GB",
  };
}

/** A flat published monthly rate (App Service, SQL DB, Redis, Functions). */
function flatLine(label: string, monthlyUsd: number | undefined): CostEstimateLineItem | null {
  if (monthlyUsd == null) return null;
  return { label, monthlyAmount: monthlyUsd, detail: "Published monthly rate" };
}

/** Managed disks default to Premium SSD unless the form says otherwise. */
const DEFAULT_DISK_SKU = "Premium_LRS";
/** AKS attaches this much OS disk to each node by default. */
const AKS_NODE_DISK_GB = 128;

export function estimateAzureCost(
  typeId: string,
  fields: Record<string, string>,
  rates: AzurePricingRates,
): CostEstimate | null {
  if (typeId === "azure-vm") {
    const sizeId = pick(fields, "size", "vmSize");
    const hourly = rates.vmHourlyUsd[sizeId];
    const diskGb = positiveNumber(pick(fields, "bootDiskSizeGb", "osDiskSizeGb"), 64);
    const compute = computeLine(`Virtual machine (${sizeId})`, hourly);
    const disk = diskLine("OS disk", diskGb, DEFAULT_DISK_SKU, rates);
    return buildCostEstimate([compute, disk], {
      partial: !compute || (diskGb > 0 && !disk),
      notes: ["Pay-as-you-go Linux rate. Bandwidth and public IPs are billed separately."],
    });
  }

  if (typeId === "azure-aks-cluster") {
    const sizeId = pick(fields, "nodeSize", "vmSize");
    const hourly = rates.vmHourlyUsd[sizeId];
    const nodeCount = Math.max(1, Math.floor(positiveNumber(pick(fields, "nodeCount"), 3)));
    const perNodeDisk = rates.diskGbMonthUsd[DEFAULT_DISK_SKU];
    const nodes = hourly == null ? null : hourly * HOURS_PER_MONTH;
    return buildCostEstimate(
      [
        nodes == null
          ? null
          : {
              label: `Nodes (${nodeCount} × ${sizeId})`,
              monthlyAmount: nodes * nodeCount,
              detail: `${nodeCount} × ${money(nodes)}/month`,
              quantity: nodeCount,
              unit: "nodes",
            },
        perNodeDisk == null
          ? null
          : {
              label: "Node OS disks",
              monthlyAmount: perNodeDisk * AKS_NODE_DISK_GB * nodeCount,
              detail: `${nodeCount} × ${AKS_NODE_DISK_GB} GB × ${money(perNodeDisk)}/GB-month`,
              quantity: nodeCount * AKS_NODE_DISK_GB,
              unit: "GB",
            },
      ],
      {
        partial: nodes == null || perNodeDisk == null,
        notes: ["The Free tier control plane costs nothing; Standard tier is billed per cluster."],
      },
    );
  }

  if (typeId === "azure-container-instance") {
    if (!rates.containerInstance) return null;
    const cpu = positiveNumber(pick(fields, "cpu"), 1);
    const memoryGb = positiveNumber(pick(fields, "memoryGb"), 1.5);
    const secondsPerMonth = HOURS_PER_MONTH * 3600;
    return buildCostEstimate(
      [
        {
          label: "vCPU",
          monthlyAmount: cpu * rates.containerInstance.vcpuPerSecondUsd * secondsPerMonth,
          detail: `${cpu} vCPU × ${HOURS_PER_MONTH} h`,
          quantity: cpu,
          unit: "vCPU",
        },
        {
          label: "Memory",
          monthlyAmount: memoryGb * rates.containerInstance.memoryGbPerSecondUsd * secondsPerMonth,
          detail: `${memoryGb} GB × ${HOURS_PER_MONTH} h`,
          quantity: memoryGb,
          unit: "GB",
        },
      ],
      {
        notes: [
          "Billed per second while the container group runs — this assumes it runs all month.",
        ],
      },
    );
  }

  if (typeId === "azure-redis-cache") {
    // Rate cache is keyed by SKU codes ("C0", "P1"); the create form and the
    // lister store a numeric capacity ("0") plus a tier name (Basic/Premium).
    // Accept either shape so create-time and existing-resource estimates match.
    const code = redisRateKey(fields);
    return buildCostEstimate([flatLine(`Cache (${code})`, rates.redisMonthlyUsd[code])]);
  }

  if (typeId === "azure-app-service") {
    const sku = pick(fields, "sku") || "B1";
    return buildCostEstimate([
      flatLine(`App Service plan (${sku})`, rates.appServiceMonthlyUsd[sku]),
    ]);
  }

  if (typeId === "azure-function-app") {
    const sku = pick(fields, "sku") || "Y1";
    const line = flatLine(`Plan (${sku})`, rates.functionAppMonthlyUsd[sku]);
    return buildCostEstimate([line], {
      notes:
        sku === "Y1"
          ? ["Consumption plan — executions beyond the free grant are billed on top."]
          : [],
    });
  }

  if (typeId === "azure-sql-database") {
    const sku = pick(fields, "sku") || "Basic";
    return buildCostEstimate([flatLine(`Database (${sku})`, rates.sqlDbMonthlyUsd[sku])]);
  }

  if (typeId === "azure-disk") {
    const diskSizeGb = positiveNumber(pick(fields, "diskSizeGb", "sizeGb"), 128);
    const sku = pick(fields, "sku") || DEFAULT_DISK_SKU;
    return buildCostEstimate([diskLine(`Managed disk (${sku})`, diskSizeGb, sku, rates)]);
  }

  return null;
}
