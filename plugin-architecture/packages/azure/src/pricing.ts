/**
 * Azure retail pricing lookups for the create-resource cost estimator.
 * Queries the public Retail Prices API (no auth required) and caches
 * per-region rate tables. Mirrors the GCP pricing module's shape so the
 * AzureClient can use the same cache-and-dedupe pattern.
 *
 * Docs: https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices
 */
import { z } from "zod";

// Most fields tolerate empty string defaults — Azure returns rows for
// many resource types where SKU/family fields are omitted. Validation only
// blocks responses that drop fields entirely from the JSON shape.
const retailPriceItemSchema = z.object({
  currencyCode: z.string().default(""),
  retailPrice: z.number().default(0),
  unitPrice: z.number().default(0),
  armRegionName: z.string().default(""),
  meterName: z.string().default(""),
  productName: z.string().default(""),
  skuName: z.string().default(""),
  serviceName: z.string().default(""),
  serviceFamily: z.string().default(""),
  unitOfMeasure: z.string().default(""),
  type: z.string().default(""),
  armSkuName: z.string().default(""),
});

const retailPricesPageSchema = z.object({
  Items: z.array(retailPriceItemSchema).optional(),
  NextPageLink: z.string().optional(),
});

type RetailPriceItem = z.infer<typeof retailPriceItemSchema>;

export interface AzurePricingRates {
  /** armSkuName (e.g. "Standard_D2s_v5") -> Linux pay-as-you-go hourly USD */
  vmHourlyUsd: Record<string, number>;
  /** Disk SKU (e.g. "Premium_LRS") -> USD per GB-month */
  diskGbMonthUsd: Record<string, number>;
  /** Redis capacity code (e.g. "C0", "P1") -> USD per month */
  redisMonthlyUsd: Record<string, number>;
  /** App Service plan SKU (e.g. "B1", "P1v3") -> USD per month (Linux) */
  appServiceMonthlyUsd: Record<string, number>;
  /** Function App plan SKU (Y1 consumption, EP1 premium, etc.) -> USD per month */
  functionAppMonthlyUsd: Record<string, number>;
  /** SQL Database SKU (e.g. "Basic", "S0", "P1") -> USD per month */
  sqlDbMonthlyUsd: Record<string, number>;
  /** Per-second Linux Container Instance rates */
  containerInstance: { vcpuPerSecondUsd: number; memoryGbPerSecondUsd: number } | null;
}

export interface AzurePricingCacheEntry extends AzurePricingRates {
  expiresAt: number;
}

export const HOURS_PER_MONTH = 730;
const RETAIL_PRICES_ENDPOINT = "https://prices.azure.com/api/retail/prices";

/**
 * Map each managed-disk SKU we support in the create form to a representative
 * retail SKU that we can price per GB-month. For tier-priced disks (S/E/P
 * series), we sample a mid-size tier and divide by its fixed capacity. For
 * Premium SSD v2 and Ultra disks, Azure publishes a direct per-GB rate.
 */
const DISK_SAMPLES: Record<
  string,
  { productFilter: RegExp; skuFilter: RegExp; unitFilter?: RegExp; divideByGb: number }
> = {
  Standard_LRS: {
    productFilter: /Standard HDD Managed Disks/i,
    skuFilter: /^S10 LRS/i,
    divideByGb: 128,
  },
  StandardSSD_LRS: {
    productFilter: /Standard SSD Managed Disks/i,
    skuFilter: /^E10 LRS/i,
    divideByGb: 128,
  },
  Premium_LRS: {
    productFilter: /Premium SSD Managed Disks/i,
    skuFilter: /^P10 LRS/i,
    divideByGb: 128,
  },
  PremiumV2_LRS: {
    productFilter: /Premium SSD v2/i,
    skuFilter: /LRS/i,
    unitFilter: /GiB\/Month|GB\/Month/i,
    divideByGb: 1,
  },
  UltraSSD_LRS: {
    productFilter: /Ultra Disks/i,
    skuFilter: /LRS/i,
    unitFilter: /GiB\/Hour|GB\/Hour/i,
    divideByGb: 1,
  },
};

async function fetchPage(filter: string): Promise<RetailPriceItem[]> {
  const items: RetailPriceItem[] = [];
  let url: string =
    `${RETAIL_PRICES_ENDPOINT}?` +
    new URLSearchParams({
      "api-version": "2023-01-01-preview",
      currencyCode: "USD",
      $filter: filter,
    }).toString();
  // Cap pages to avoid runaway responses on a misfiled OData query.
  for (let page = 0; page < 20 && url; page++) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Azure Retail Prices ${res.status}: ${await res.text()}`);
    const body = retailPricesPageSchema.parse(await res.json());
    items.push(...(body.Items ?? []));
    url = body.NextPageLink ?? "";
  }
  return items;
}

function parseVmRates(items: RetailPriceItem[]): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const item of items) {
    if (item.type !== "Consumption") continue;
    if (!item.armSkuName) continue;
    // Exclude Windows (its products append "Windows"); Linux has no OS suffix.
    if (/Windows/i.test(item.productName)) continue;
    // Spot / Low Priority variants share armSkuName with regular on-demand.
    if (/Spot|Low Priority/i.test(item.meterName) || /Spot|Low Priority/i.test(item.skuName))
      continue;
    if (!/Hour/i.test(item.unitOfMeasure)) continue;
    const existing = rates[item.armSkuName];
    if (existing == null || item.retailPrice < existing) {
      rates[item.armSkuName] = item.retailPrice;
    }
  }
  return rates;
}

function parseDiskRates(items: RetailPriceItem[]): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const [diskSku, sample] of Object.entries(DISK_SAMPLES)) {
    const match = items.find(
      (item) =>
        item.type === "Consumption" &&
        sample.productFilter.test(item.productName) &&
        sample.skuFilter.test(item.skuName) &&
        (!sample.unitFilter || sample.unitFilter.test(item.unitOfMeasure)),
    );
    if (!match) continue;
    let monthly = match.retailPrice / sample.divideByGb;
    // Ultra disks are published per-GB/hour; convert to GB/month.
    if (/Hour/i.test(match.unitOfMeasure)) monthly *= HOURS_PER_MONTH;
    if (monthly > 0) rates[diskSku] = Number(monthly.toFixed(4));
  }
  return rates;
}

function parseRedisRates(items: RetailPriceItem[]): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const item of items) {
    if (item.type !== "Consumption") continue;
    // Redis SKU names look like "Basic C0", "Standard C1", "Premium P1".
    const match = item.skuName.match(/\b([CP]\d+)\b/);
    if (!match) continue;
    const code = match[1]!;
    const hourly = /Hour/i.test(item.unitOfMeasure)
      ? item.retailPrice
      : item.retailPrice / HOURS_PER_MONTH;
    const monthly = hourly * HOURS_PER_MONTH;
    const existing = rates[code];
    if (existing == null || monthly < existing) rates[code] = Number(monthly.toFixed(2));
  }
  return rates;
}

function parseAppServiceRates(items: RetailPriceItem[]): {
  appService: Record<string, number>;
  functionApp: Record<string, number>;
} {
  const appService: Record<string, number> = {};
  const functionApp: Record<string, number> = {};
  for (const item of items) {
    if (item.type !== "Consumption") continue;
    // App Service plan skuNames: "F1 Free", "B1", "S1", "P1v3", "I1v2", "EP1" etc.
    // We key on the leading token.
    if (/Windows/i.test(item.skuName) || /Windows/i.test(item.productName)) continue;
    const token = item.skuName.match(/\b(F1|D1|B\d|S\d|P\d(?:v\d)?|I\d(?:v\d)?|EP\d|Y1)\b/);
    if (!token) continue;
    const code = token[1]!;
    const hourly = /Hour/i.test(item.unitOfMeasure)
      ? item.retailPrice
      : /Month/i.test(item.unitOfMeasure)
        ? item.retailPrice / HOURS_PER_MONTH
        : item.retailPrice;
    const monthly = Number((hourly * HOURS_PER_MONTH).toFixed(2));
    const target = /Functions/i.test(item.productName) || code === "Y1" ? functionApp : appService;
    const existing = target[code];
    if (existing == null || monthly < existing) target[code] = monthly;
  }
  // Free tiers should always be zero.
  if ("F1" in appService) appService["F1"] = 0;
  if ("Y1" in functionApp) functionApp["Y1"] = 0;
  return { appService, functionApp };
}

function parseSqlDbRates(items: RetailPriceItem[]): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const item of items) {
    if (item.type !== "Consumption") continue;
    // Map the DTU-tier and vCore SKUs the create form offers today.
    const code = matchSqlSku(item);
    if (!code) continue;
    const hourly = /Hour/i.test(item.unitOfMeasure)
      ? item.retailPrice
      : /Month/i.test(item.unitOfMeasure)
        ? item.retailPrice / HOURS_PER_MONTH
        : item.retailPrice;
    const monthly = Number((hourly * HOURS_PER_MONTH).toFixed(2));
    const existing = rates[code];
    if (existing == null || monthly < existing) rates[code] = monthly;
  }
  return rates;
}

function matchSqlSku(item: RetailPriceItem): string | null {
  const sku = item.skuName;
  const product = item.productName;
  // DTU Basic/Standard/Premium — productName carries the tier, skuName the DTU level.
  if (/SQL Database Single Basic/i.test(product) && /^Basic$/i.test(sku)) return "Basic";
  if (/SQL Database Single Standard/i.test(product)) {
    const m = sku.match(/^(S\d+)/i);
    if (m) return m[1]!.toUpperCase();
  }
  if (/SQL Database Single Premium/i.test(product)) {
    const m = sku.match(/^(P\d+)/i);
    if (m) return m[1]!.toUpperCase();
  }
  // vCore serverless / provisioned Gen5.
  if (/Serverless/i.test(product) && /Gen5/i.test(sku)) {
    const m = sku.match(/(\d+)\s*vCore/i);
    if (m) return `GP_S_Gen5_${m[1]}`;
  }
  if (/General Purpose/i.test(product) && /Gen5/i.test(sku) && !/Serverless/i.test(product)) {
    const m = sku.match(/(\d+)\s*vCore/i);
    if (m) return `GP_Gen5_${m[1]}`;
  }
  return null;
}

function parseContainerInstanceRates(
  items: RetailPriceItem[],
): AzurePricingRates["containerInstance"] {
  // Container Instances publish separate vCPU-duration and memory-duration meters.
  let vcpu: number | null = null;
  let memory: number | null = null;
  for (const item of items) {
    if (item.type !== "Consumption") continue;
    if (/Windows/i.test(item.productName) || /Windows/i.test(item.skuName)) continue;
    const perSecond = /Second/i.test(item.unitOfMeasure)
      ? item.retailPrice
      : /Hour/i.test(item.unitOfMeasure)
        ? item.retailPrice / 3600
        : null;
    if (perSecond == null) continue;
    if (/vCPU|Core/i.test(item.meterName) && vcpu == null) vcpu = perSecond;
    else if (/Memory/i.test(item.meterName) && memory == null) memory = perSecond;
  }
  if (vcpu == null || memory == null) return null;
  return { vcpuPerSecondUsd: vcpu, memoryGbPerSecondUsd: memory };
}

/**
 * Fetch all relevant Retail Prices for a region in parallel and parse them
 * into a single rate table. Individual service failures do not fail the
 * whole call — they leave that family's map empty, and the estimator will
 * return null for those types.
 */
export async function fetchAzurePricingRates(region: string): Promise<AzurePricingRates> {
  const regionFilter = `armRegionName eq '${region}'`;
  const [vm, disk, redis, appService, sqlDb, containerInstance] = await Promise.all([
    fetchPage(`serviceName eq 'Virtual Machines' and ${regionFilter}`).catch(() => []),
    fetchPage(`serviceFamily eq 'Storage' and ${regionFilter} and serviceName eq 'Storage'`).catch(
      () => [],
    ),
    fetchPage(`serviceName eq 'Redis Cache' and ${regionFilter}`).catch(() => []),
    fetchPage(`serviceName eq 'Azure App Service' and ${regionFilter}`).catch(() => []),
    fetchPage(`serviceName eq 'SQL Database' and ${regionFilter}`).catch(() => []),
    fetchPage(`serviceName eq 'Container Instances' and ${regionFilter}`).catch(() => []),
  ]);

  const { appService: appServiceRates, functionApp: functionAppRates } =
    parseAppServiceRates(appService);

  return {
    vmHourlyUsd: parseVmRates(vm),
    diskGbMonthUsd: parseDiskRates(disk),
    redisMonthlyUsd: parseRedisRates(redis),
    appServiceMonthlyUsd: appServiceRates,
    functionAppMonthlyUsd: functionAppRates,
    sqlDbMonthlyUsd: parseSqlDbRates(sqlDb),
    containerInstance: parseContainerInstanceRates(containerInstance),
  };
}

/**
 * Estimate monthly prices for a set of VM sizes using cached hourly rates.
 * Returns a map keyed by size id (armSkuName). Sizes without a published
 * rate are omitted.
 */
export function estimateVmMonthlyPrices(
  sizes: Array<{ id: string }>,
  rates: AzurePricingRates,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const size of sizes) {
    const hourly = rates.vmHourlyUsd[size.id];
    if (hourly == null) continue;
    out[size.id] = Number((hourly * HOURS_PER_MONTH).toFixed(2));
  }
  return out;
}
