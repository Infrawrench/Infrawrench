/**
 * The Google Cloud half of the org-level price catalog: Compute Engine
 * predefined machine types for one region, priced from the Cloud Billing
 * Catalog API, the same source and SKU reader the create-form estimator uses
 * (`pricing.ts`).
 *
 * Credentialed: both halves need an authenticated project, the machine types
 * (`compute.machineTypes.list`, for one zone of the requested region) and the
 * catalog (`cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus`,
 * which the plugin already calls with the account's token).
 *
 * Docs:
 * https://cloud.google.com/billing/docs/how-to/get-pricing-information-api
 * https://cloud.google.com/compute/docs/reference/rest/v1/machineTypes/list
 *
 * How a machine type is priced: Compute Engine bills a predefined machine
 * type as vCPUs times the family's per-core hourly SKU plus GiB of memory
 * times the family's per-GiB hourly SKU. The catalog matches SKUs to the
 * requested region by `serviceRegions` (GCP publishes region-specific SKUs),
 * which is finer than the estimator's Americas/EMEA/APAC geo matching, and
 * reads one rate per `category.usageType`:
 *
 * - `OnDemand` → on-demand.
 * - `Preemptible` → spot (Spot VMs and preemptible VMs share these SKUs).
 * - `Commit1Yr` / `Commit3Yr` → reserved, term `1yr` / `3yr`
 *   (resource-based committed use discounts).
 *
 * A rate type is emitted only when both the core and the RAM SKU for the
 * family were found; half a price is not a price. Shared-core types (e2-micro
 * and friends), which bill a fraction of a core, and machine types with
 * attached accelerators, whose GPUs are separate SKUs, are skipped rather
 * than quoted with the GPU missing.
 */
import {
  normalizePriceCatalogProducts,
  type PriceCatalogArea,
  type PriceCatalogDeclaration,
  type PriceCatalogPrice,
  type PriceCatalogProduct,
  type PriceRateType,
  type PriceCatalogRequest,
  type PriceCatalogResult,
} from "@infrawrench/plugin-base";
import { familyFromMachineType, unitPriceToUsd, type CloudBillingSku } from "./pricing.js";
import { REGION_INFO } from "./regions.js";

export const GCP_PRICE_CATALOG_SERVICE = "compute-engine";

function areaForRegion(id: string): PriceCatalogArea {
  if (id.startsWith("us-") || id.startsWith("northamerica-")) return "north-america";
  if (id.startsWith("southamerica-")) return "south-america";
  if (id.startsWith("australia-")) return "oceania";
  if (id.startsWith("asia-")) return "asia-pacific";
  if (id.startsWith("me-")) return "middle-east";
  if (id.startsWith("africa-")) return "africa";
  return "europe";
}

const REGION_IDS = [
  "us-central1",
  ...Object.keys(REGION_INFO).filter((id) => id !== "us-central1"),
];

export const gcpPriceCatalog: PriceCatalogDeclaration = {
  requiresCredentials: true,
  permission: "compute.machineTypes.list",
  source: {
    name: "Cloud Billing Catalog API",
    url: "https://cloud.google.com/billing/docs/how-to/get-pricing-information-api",
  },
  refreshHours: 24,
  regionScoped: true,
  services: [{ id: GCP_PRICE_CATALOG_SERVICE, label: "Compute Engine", family: "compute" }],
  regions: REGION_IDS.map((id) => ({
    id,
    label: REGION_INFO[id] ? `${id} (${REGION_INFO[id]!.location})` : id,
    area: areaForRegion(id),
  })),
};

type RateKind = { rateType: PriceRateType; term?: string };

function rateKind(usageType: string | undefined): RateKind | null {
  switch (usageType) {
    case "OnDemand":
      return { rateType: "on-demand" };
    case "Preemptible":
      return { rateType: "spot" };
    case "Commit1Yr":
      return { rateType: "reserved", term: "1yr" };
    case "Commit3Yr":
      return { rateType: "reserved", term: "3yr" };
    default:
      return null;
  }
}

/**
 * `{ family, part }` from a Compute SKU description, or null for anything
 * that is not a plain per-family core or RAM SKU (custom, sole-tenant,
 * extended memory, GPUs, licenses).
 */
export function parseComputeSkuDescription(
  description: string,
): { family: string; part: "core" | "ram" } | null {
  if (/Custom|Sole Tenancy|Extended|GPU|License|Premium/i.test(description)) return null;
  const stripped = description
    .replace(/^Spot Preemptible\s+/i, "")
    .replace(/^Preemptible\s+/i, "")
    .replace(/^Commitment v1:?\s+/i, "")
    .replace(/^Commitment\s+/i, "");
  const match = /^([A-Z][A-Z0-9]*)\s+(?:AMD\s+|Arm\s+)?(?:Instance\s+)?(Core|Cpu|Ram)\b/.exec(
    stripped,
  );
  if (!match?.[1] || !match[2]) return null;
  return { family: match[1].toLowerCase(), part: match[2] === "Ram" ? "ram" : "core" };
}

export type FamilyRates = Map<string, { core?: number; ram?: number }>;

/** Per (family, rate kind) core and RAM hourly USD rates for one region. */
export function familyRatesForRegion(skus: CloudBillingSku[], region: string): FamilyRates {
  const rates: FamilyRates = new Map();
  for (const sku of skus) {
    if (sku.category?.resourceFamily !== "Compute") continue;
    if (!(sku.serviceRegions ?? []).includes(region)) continue;
    const kind = rateKind(sku.category?.usageType);
    if (!kind) continue;
    const parsed = parseComputeSkuDescription(sku.description ?? "");
    if (!parsed) continue;
    const tiers = sku.pricingInfo?.[0]?.pricingExpression?.tieredRates ?? [];
    const rate = unitPriceToUsd(tiers[tiers.length - 1]?.unitPrice);
    if (!(rate > 0)) continue;
    const key = `${parsed.family}|${kind.rateType}|${kind.term ?? ""}`;
    const entry = rates.get(key) ?? {};
    // Several SKUs can match (region-specific and multi-region rows); keep
    // the lowest, the same rule the estimator's "first rate wins" lands on.
    const prev = entry[parsed.part];
    entry[parsed.part] = prev === undefined ? rate : Math.min(prev, rate);
    rates.set(key, entry);
  }
  return rates;
}

export interface GcpMachineType {
  name: string;
  guestCpus: number;
  memoryMb: number;
  isSharedCpu?: boolean;
  accelerators?: Array<{ guestAcceleratorType?: string; guestAcceleratorCount?: number }>;
  deprecated?: { state?: string };
}

const KINDS: RateKind[] = [
  { rateType: "on-demand" },
  { rateType: "spot" },
  { rateType: "reserved", term: "1yr" },
  { rateType: "reserved", term: "3yr" },
];

/** Price machine types against family rates. Pure. */
export function machineTypesToProducts(
  machineTypes: GcpMachineType[],
  rates: FamilyRates,
  region: string,
  zone: string,
): PriceCatalogProduct[] {
  const products: PriceCatalogProduct[] = [];
  for (const mt of machineTypes) {
    if (mt.name.includes("custom")) continue;
    if (mt.isSharedCpu) continue;
    if ((mt.accelerators ?? []).length > 0) continue;
    if (mt.deprecated?.state && mt.deprecated.state !== "ACTIVE") continue;
    const family = familyFromMachineType(mt.name);
    const memoryGb = mt.memoryMb / 1024;
    const prices: PriceCatalogPrice[] = [];
    for (const kind of KINDS) {
      const r = rates.get(`${family}|${kind.rateType}|${kind.term ?? ""}`);
      if (r?.core === undefined || r.ram === undefined) continue;
      prices.push({
        region,
        rateType: kind.rateType,
        ...(kind.term ? { term: kind.term } : {}),
        unit: "hour",
        amount: mt.guestCpus * r.core + memoryGb * r.ram,
        currency: "USD",
      });
    }
    if (prices.length === 0) continue;
    products.push({
      sku: mt.name,
      name: mt.name,
      serviceId: GCP_PRICE_CATALOG_SERVICE,
      family: "compute",
      series: family.toUpperCase(),
      specs: {
        vcpus: mt.guestCpus,
        memoryGb: Math.round(memoryGb * 100) / 100,
        architecture: /^(t2a|c4a)$/.test(family) ? "arm64" : "x86_64",
      },
      prices,
      estimate: { resourceTypeId: "gce-instance", fields: { zone, machineType: mt.name } },
    });
  }
  return products;
}

export interface GcpPriceCatalogContext {
  project: string;
  get<T>(url: string): Promise<T>;
  /** The full Compute SKU list (cached by the caller). */
  computeSkus(): Promise<CloudBillingSku[]>;
}

const MAX_MACHINE_TYPE_PAGES = 5;

export async function fetchGcpPriceCatalog(
  ctx: GcpPriceCatalogContext,
  request: PriceCatalogRequest,
): Promise<PriceCatalogResult> {
  if (request.serviceId !== GCP_PRICE_CATALOG_SERVICE) return { products: [] };
  const region = request.region ?? gcpPriceCatalog.regions[0]!.id;
  if (!/^[a-z0-9-]+$/.test(region)) return { products: [] };
  const base = `https://compute.googleapis.com/compute/v1/projects/${ctx.project}`;
  const regionInfo = await ctx.get<{ zones?: string[] }>(`${base}/regions/${region}`);
  const zone = (regionInfo.zones ?? []).map((z) => z.split("/").pop() ?? z).sort()[0];
  if (!zone) return { products: [] };

  const machineTypes: GcpMachineType[] = [];
  let pageToken = "";
  let truncated = false;
  for (let page = 0; ; page++) {
    if (page >= MAX_MACHINE_TYPE_PAGES) {
      truncated = true;
      break;
    }
    const data = await ctx.get<{ items?: GcpMachineType[]; nextPageToken?: string }>(
      `${base}/zones/${zone}/machineTypes?maxResults=500${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
    );
    machineTypes.push(...(data.items ?? []));
    pageToken = data.nextPageToken ?? "";
    if (!pageToken) break;
  }
  const rates = familyRatesForRegion(await ctx.computeSkus(), region);
  return {
    products: normalizePriceCatalogProducts(
      machineTypesToProducts(machineTypes, rates, region, zone),
    ),
    ...(truncated ? { truncated: true } : {}),
  };
}
