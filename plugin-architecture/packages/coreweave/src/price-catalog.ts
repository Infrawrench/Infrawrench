import {
  normalizePriceCatalogProducts,
  type PriceCatalogArea,
  type PriceCatalogDeclaration,
  type PriceCatalogProduct,
  type PriceCatalogRegionDeclaration,
  type PriceCatalogRequest,
  type PriceCatalogResult,
} from "@infrawrench/plugin-base";
import { INSTANCE_TYPES, PRICING_AS_OF, ZONES, type InstanceSpec } from "./catalog.js";

/**
 * The price catalog, re-shaped from the static instance table in
 * `catalog.ts`. CoreWeave has no pricing API, so this is public (no account
 * needed) and every figure is the `hourlyUsd` already used by cost estimates
 * and the Node Pool form.
 *
 * Region handling: https://www.coreweave.com/pricing publishes separate
 * "North America" and "Europe" price lists, and `hourlyUsd` holds the North
 * America on-demand rate. Emitting that rate against a European zone would be
 * pricing one region from another's list, so prices are emitted only for the
 * North American zones each instance is listed in, and only those zones are
 * declared. European zones come back when the table carries Europe's rates.
 *
 * Only on-demand is emitted: the page's Spot column is not in the table and
 * reserved capacity is contract-priced. Instances listed as "Contact sales"
 * (`hourlyUsd: null`) are absent rather than zero.
 */

export const COREWEAVE_PRICING_URL = "https://www.coreweave.com/pricing";

const GPU_SERVICE = "gpu-instances";
const CPU_SERVICE = "cpu-instances";

/** CoreWeave zone prefix -> geography. `RNO2A` is Reno, Nevada. */
function zoneArea(zone: string): PriceCatalogArea | null {
  if (/^(US|CA)-/.test(zone) || zone === "RNO2A") return "north-america";
  if (zone.startsWith("EU-")) return "europe";
  return null;
}

function zoneLabel(zone: string): string {
  if (zone === "RNO2A") return "RNO2A (Reno, NV)";
  return zone;
}

/** The zone most instance types are listed in leads, so it is the default. */
const PREFERRED_ZONE = "US-EAST-04A";

function northAmericaZones(): string[] {
  const na = ZONES.filter((z) => zoneArea(z) === "north-america");
  return [PREFERRED_ZONE, ...na.filter((z) => z !== PREFERRED_ZONE)];
}

const REGIONS: PriceCatalogRegionDeclaration[] = northAmericaZones().map((id) => ({
  id,
  label: zoneLabel(id),
  area: "north-america",
}));

const DECLARED = new Set(REGIONS.map((r) => r.id));

export const priceCatalog: PriceCatalogDeclaration = {
  requiresCredentials: false,
  source: { name: "CoreWeave pricing page", url: COREWEAVE_PRICING_URL },
  // A static table bundled with the plugin: nothing changes between releases.
  refreshHours: 168,
  regionScoped: false,
  services: [
    { id: GPU_SERVICE, label: "GPU instances", family: "gpu" },
    { id: CPU_SERVICE, label: "CPU instances", family: "compute" },
  ],
  regions: REGIONS,
};

function architecture(spec: InstanceSpec): string {
  // Grace and Vera are NVIDIA's Arm CPUs; everything else in the table is x86.
  return /Grace|Vera/i.test(spec.cpuModel) ? "arm64" : "x86_64";
}

function toProduct(spec: InstanceSpec, region?: string): PriceCatalogProduct | null {
  if (spec.hourlyUsd === null) return null;
  const amount = spec.hourlyUsd;
  const zones = spec.zones.filter((z) => DECLARED.has(z) && (!region || z === region));
  const isGpu = spec.family === "gpu";
  return {
    sku: spec.id,
    name: spec.name,
    serviceId: isGpu ? GPU_SERVICE : CPU_SERVICE,
    family: isGpu ? "gpu" : "compute",
    series: spec.gpuModel ?? spec.cpuModel,
    specs: {
      vcpus: spec.vcpus,
      memoryGb: spec.ramGb,
      ...(isGpu && spec.gpuCount > 0
        ? { gpuCount: spec.gpuCount, gpuMemoryGb: spec.gpuMemoryGb }
        : {}),
      ...(spec.gpuModel ? { gpuModel: spec.gpuModel } : {}),
      ...(spec.storageTb > 0 ? { storageGb: Math.round(spec.storageTb * 1000) } : {}),
      architecture: architecture(spec),
    },
    prices: zones.map((zone) => ({
      region: zone,
      rateType: "on-demand",
      unit: "hour",
      amount,
      currency: "USD",
      effectiveDate: PRICING_AS_OF,
    })),
    // The Node Pool form's instance type select takes the same id. The
    // cluster (and so the zone) is a picker on the form itself.
    estimate: { resourceTypeId: "node-pool", fields: { instanceType: spec.id } },
  };
}

export async function fetchPriceCatalog(request: PriceCatalogRequest): Promise<PriceCatalogResult> {
  if (request.serviceId !== GPU_SERVICE && request.serviceId !== CPU_SERVICE) {
    return { products: [] };
  }
  const wantGpu = request.serviceId === GPU_SERVICE;
  const products: PriceCatalogProduct[] = [];
  for (const spec of INSTANCE_TYPES) {
    if ((spec.family === "gpu") !== wantGpu) continue;
    const product = toProduct(spec, request.region);
    if (product) products.push(product);
  }
  return { products: normalizePriceCatalogProducts(products) };
}
