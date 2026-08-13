interface CloudBillingSku {
  description?: string;
  serviceRegions?: string[];
  category?: {
    resourceFamily?: string;
    usageType?: string;
  };
  pricingInfo?: Array<{
    pricingExpression?: {
      tieredRates?: Array<{
        unitPrice?: {
          units?: string;
          nanos?: number;
        };
      }>;
    };
  }>;
}

type GceDiskType = "pd-balanced" | "pd-ssd" | "pd-standard";

export interface PricingRates {
  machineRates: Record<string, { corePerHourUsd: number; ramPerGiBHourUsd: number }>;
  diskGbMonthUsd: Partial<Record<GceDiskType, number>>;
}

export interface PricingCacheEntry extends PricingRates {
  expiresAt: number;
}

export type GeoRegion = "Americas" | "EMEA" | "APAC";

const COMPUTE_BILLING_SERVICE_ID = "6F81-5844-456A";
export const HOURS_PER_MONTH = 730;

export function regionFromZone(zone: string): string {
  return zone.replace(/-[a-z]$/, "");
}

export function geoFromRegion(region: string): GeoRegion {
  if (
    region.startsWith("us-") ||
    region.startsWith("northamerica-") ||
    region.startsWith("southamerica-")
  )
    return "Americas";
  if (region.startsWith("asia-") || region.startsWith("australia-")) return "APAC";
  return "EMEA";
}

function unitPriceToUsd(unitPrice?: { units?: string; nanos?: number }): number {
  if (!unitPrice) return 0;
  const units = Number(unitPrice.units ?? "0");
  const nanos = Number(unitPrice.nanos ?? 0);
  return units + nanos / 1_000_000_000;
}

function familyFromMachineType(machineType: string): string {
  const lowered = machineType.toLowerCase();
  if (lowered.startsWith("n2d-")) return "n2d";
  const [family = ""] = lowered.split("-");
  return family;
}

/**
 * Fetch all Compute Engine billing SKUs for a geo and extract machine-type
 * family rates + PD Balanced disk rate.
 */
export async function fetchPricingRatesForGeo(
  geo: GeoRegion,
  apiGet: <T>(url: string) => Promise<T>,
): Promise<PricingRates> {
  let pageToken = "";
  const allSkus: CloudBillingSku[] = [];
  do {
    const params = new URLSearchParams({
      currencyCode: "USD",
      pageSize: "5000",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await apiGet<{ skus?: CloudBillingSku[]; nextPageToken?: string }>(
      `https://cloudbilling.googleapis.com/v1/services/${COMPUTE_BILLING_SERVICE_ID}/skus?${params.toString()}`,
    );
    allSkus.push(...(page.skus ?? []));
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);

  const machineRates: Record<string, { corePerHourUsd: number; ramPerGiBHourUsd: number }> = {};
  const diskGbMonthUsd: Partial<Record<GceDiskType, number>> = {};
  // Match Storage SKU descriptions (excluding "Regional" replicas) to disk types.
  const diskSkuMatchers: Array<{ type: GceDiskType; needle: string }> = [
    { type: "pd-balanced", needle: "Balanced PD Capacity" },
    { type: "pd-ssd", needle: "SSD backed PD Capacity" },
    { type: "pd-standard", needle: "Storage PD Capacity" },
  ];
  const geoRegionPrefixes: Record<GeoRegion, string[]> = {
    Americas: ["us-", "northamerica-", "southamerica-"],
    EMEA: ["europe-", "me-", "africa-"],
    APAC: ["asia-", "australia-"],
  };
  for (const sku of allSkus) {
    const family = sku.category?.resourceFamily;
    const usageType = sku.category?.usageType;
    const description = sku.description ?? "";
    if (usageType !== "OnDemand") continue;

    // Disk SKUs use serviceRegions instead of geo in description.
    if (family === "Storage" && !description.includes("Regional")) {
      const matcher = diskSkuMatchers.find(
        (m) => description.includes(m.needle) && diskGbMonthUsd[m.type] == null,
      );
      if (matcher) {
        const regions = sku.serviceRegions ?? [];
        const prefixes = geoRegionPrefixes[geo];
        const matchesGeo = regions.some((r) => prefixes.some((p) => r.startsWith(p)));
        if (matchesGeo) {
          const rate = unitPriceToUsd(
            sku.pricingInfo?.[0]?.pricingExpression?.tieredRates?.[0]?.unitPrice,
          );
          if (rate > 0) diskGbMonthUsd[matcher.type] = rate;
        }
      }
    }

    const inTargetGeo =
      description.includes(`running in ${geo}`) || description.includes(`in ${geo}`);
    if (!inTargetGeo) continue;

    if (family !== "Compute") continue;

    const isCoreSku = description.includes("Instance Core");
    const isRamSku = description.includes("Instance Ram");
    if (!isCoreSku && !isRamSku) continue;

    const familyMatch = description.match(/^([A-Z0-9]+)\b/);
    const machineFamily = familyMatch?.[1]?.toLowerCase();
    if (!machineFamily) continue;

    const hourly = unitPriceToUsd(
      sku.pricingInfo?.[0]?.pricingExpression?.tieredRates?.[0]?.unitPrice,
    );
    if (!hourly) continue;

    if (!machineRates[machineFamily]) {
      machineRates[machineFamily] = { corePerHourUsd: 0, ramPerGiBHourUsd: 0 };
    }
    if (isCoreSku) machineRates[machineFamily]!.corePerHourUsd = hourly;
    if (isRamSku) machineRates[machineFamily]!.ramPerGiBHourUsd = hourly;
  }

  return { machineRates, diskGbMonthUsd };
}

/**
 * Estimate monthly costs for a set of machine types in a given zone.
 */
export function estimateMachineTypeMonthlyPrices(
  machineTypes: Array<{ id: string; vcpus: number; memoryMb: number }>,
  rates: PricingRates,
): Record<string, number> {
  const ratesByFamily = rates.machineRates;
  const estimated: Record<string, number> = {};

  for (const m of machineTypes) {
    const family = familyFromMachineType(m.id);
    const familyRates = ratesByFamily[family];
    if (!familyRates) continue;
    const memoryGiB = m.memoryMb / 1024;
    const hourly = m.vcpus * familyRates.corePerHourUsd + memoryGiB * familyRates.ramPerGiBHourUsd;
    if (!hourly) continue;
    estimated[m.id] = Number((hourly * HOURS_PER_MONTH).toFixed(2));
  }
  return estimated;
}
