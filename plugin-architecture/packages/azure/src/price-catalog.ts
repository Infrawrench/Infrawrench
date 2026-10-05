/**
 * The Azure half of the price catalog: Linux virtual machine list prices from
 * the public Retail Prices API, the same source and pager the create-form
 * estimator uses (`pricing.ts`). Public, so it lives on the Plugin and works
 * for an org that has never connected a subscription.
 *
 * Docs: https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices
 *
 * One query per region:
 * `serviceName eq 'Virtual Machines' and armRegionName eq '<region>' and priceType ne 'DevTestConsumption'`
 * on api-version 2023-01-01-preview, the only version that returns the
 * `savingsPlan` array. Filter values are case sensitive on that version.
 *
 * Rate mapping (Linux only: Windows rows carry "Windows" in productName):
 * - `on-demand`: type Consumption, no "Spot" / "Low Priority" in skuName or
 *   meterName.
 * - `spot`: type Consumption with "Spot". Low Priority (Batch) is skipped.
 * - `reserved`: type Reservation with reservationTerm "1 Year" / "3 Years".
 *   The API's retailPrice on a Reservation row is the **total for the whole
 *   term** even though unitOfMeasure says "1 Hour" (the docs' own sample is
 *   an E64 v4 at 25,007 USD for "1 Year"), so it is divided by the term's
 *   hours (8,760 a year) to give the hourly equivalent the catalog compares.
 *   5- and 10-year terms (a handful of rows) are not emitted.
 * - `savings-plan`: the on-demand row's `savingsPlan` array, already hourly.
 *
 * Specs: the Retail Prices API carries no vCPU or memory. vCPUs, memory, GPUs
 * and temp storage come from {@link SIZE_SPECS}, a table copied from the
 * Microsoft Learn size pages; outside it the vCPU count is parsed from the
 * size name only where Azure's naming convention makes the number the vCPU
 * count, and memory is left absent rather than guessed.
 */
import {
  normalizePriceCatalogProducts,
  type HostServices,
  type HttpHostServices,
  type PriceCatalogArea,
  type PriceCatalogDeclaration,
  type PriceCatalogPrice,
  type PriceCatalogProduct,
  type PriceCatalogRequest,
  type PriceCatalogResult,
  type PriceCatalogSpecs,
} from "@infrawrench/plugin-base";
import { fetchRetailPrices, type RetailPriceItem } from "./pricing.js";
import { AZURE_REGIONS } from "./regions.js";

const SERVICE_ID = "virtual-machines";
/** The VM resource type; its create form keys region and size this way. */
const VM_RESOURCE_TYPE = "azure-vm";
/** eastus alone is ~13 pages of 1,000 rows; leave headroom before truncating. */
const MAX_PAGES = 40;
const CACHE_MS = 24 * 3_600_000;
const HOURS_PER_YEAR = 8760;

const REGION_AREAS: Record<string, PriceCatalogArea> = {
  eastus: "north-america",
  eastus2: "north-america",
  westus: "north-america",
  westus2: "north-america",
  westus3: "north-america",
  centralus: "north-america",
  northcentralus: "north-america",
  southcentralus: "north-america",
  canadacentral: "north-america",
  canadaeast: "north-america",
  northeurope: "europe",
  westeurope: "europe",
  uksouth: "europe",
  ukwest: "europe",
  francecentral: "europe",
  germanywestcentral: "europe",
  swedencentral: "europe",
  norwayeast: "europe",
  switzerlandnorth: "europe",
  polandcentral: "europe",
  italynorth: "europe",
  eastasia: "asia-pacific",
  southeastasia: "asia-pacific",
  japaneast: "asia-pacific",
  japanwest: "asia-pacific",
  koreacentral: "asia-pacific",
  centralindia: "asia-pacific",
  southindia: "asia-pacific",
  australiaeast: "oceania",
  australiasoutheast: "oceania",
  brazilsouth: "south-america",
  southafricanorth: "africa",
  uaenorth: "middle-east",
  qatarcentral: "middle-east",
};

export const priceCatalog: PriceCatalogDeclaration = {
  requiresCredentials: false,
  source: {
    name: "Azure Retail Prices API",
    url: "https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices",
  },
  refreshHours: 24,
  regionScoped: true,
  services: [{ id: SERVICE_ID, label: "Virtual machines", family: "compute" }],
  // AZURE_REGIONS is already in preference order with eastus first.
  regions: AZURE_REGIONS.flatMap((r) => {
    const area = REGION_AREAS[r.id];
    return area ? [{ id: r.id, label: r.label, area }] : [];
  }),
};

interface SizeSpec {
  vcpus: number;
  memoryGb: number;
  gpuCount?: number;
  gpuModel?: string;
  gpuMemoryGb?: number;
  /** Temp (local) disk, GiB. */
  storageGb?: number;
}

function series(
  names: Array<[string, number, number, number?]>,
  extra: Partial<SizeSpec> = {},
): Record<string, SizeSpec> {
  const out: Record<string, SizeSpec> = {};
  for (const [name, vcpus, memoryGb, storageGb] of names) {
    out[`Standard_${name}`] = {
      vcpus,
      memoryGb,
      ...extra,
      ...(storageGb !== undefined ? { storageGb } : {}),
    };
  }
  return out;
}

/**
 * Sizes copied from the Microsoft Learn size pages (read 2026-10-05):
 * learn.microsoft.com/azure/virtual-machines/sizes/general-purpose/{dsv5,ddsv5,dasv5,bv1}-series,
 * .../memory-optimized/{esv5,easv5}-series, .../compute-optimized/fsv2-series and
 * .../gpu-accelerated/{ncast4v3,nca100v4,ndh100v5,nvadsa10v5}-series.
 * Memory and temp storage are GiB, as the pages state them.
 */
export const SIZE_SPECS: Record<string, SizeSpec> = {
  ...series([
    ["B1ls", 1, 0.5, 4],
    ["B1s", 1, 1, 4],
    ["B1ms", 1, 2, 4],
    ["B2s", 2, 4, 8],
    ["B2ms", 2, 8, 16],
    ["B4ms", 4, 16, 32],
    ["B8ms", 8, 32, 64],
    ["B12ms", 12, 48, 96],
    ["B16ms", 16, 64, 128],
    ["B20ms", 20, 80, 160],
  ]),
  ...series([
    ["D2s_v5", 2, 8],
    ["D4s_v5", 4, 16],
    ["D8s_v5", 8, 32],
    ["D16s_v5", 16, 64],
    ["D32s_v5", 32, 128],
    ["D48s_v5", 48, 192],
    ["D64s_v5", 64, 256],
    ["D96s_v5", 96, 384],
  ]),
  ...series([
    ["D2ds_v5", 2, 8, 75],
    ["D4ds_v5", 4, 16, 150],
    ["D8ds_v5", 8, 32, 300],
    ["D16ds_v5", 16, 64, 600],
    ["D32ds_v5", 32, 128, 1200],
    ["D48ds_v5", 48, 192, 1800],
    ["D64ds_v5", 64, 256, 2400],
    ["D96ds_v5", 96, 384, 3600],
  ]),
  ...series([
    ["D2as_v5", 2, 8],
    ["D4as_v5", 4, 16],
    ["D8as_v5", 8, 32],
    ["D16as_v5", 16, 64],
    ["D32as_v5", 32, 128],
    ["D48as_v5", 48, 192],
    ["D64as_v5", 64, 256],
    ["D96as_v5", 96, 384],
  ]),
  ...series([
    ["E2s_v5", 2, 16],
    ["E4s_v5", 4, 32],
    ["E8s_v5", 8, 64],
    ["E16s_v5", 16, 128],
    ["E20s_v5", 20, 160],
    ["E32s_v5", 32, 256],
    ["E48s_v5", 48, 384],
    ["E64s_v5", 64, 512],
    ["E96s_v5", 96, 672],
    ["E104is_v5", 104, 672],
  ]),
  ...series([
    ["E2as_v5", 2, 16],
    ["E4as_v5", 4, 32],
    ["E8as_v5", 8, 64],
    ["E16as_v5", 16, 128],
    ["E20as_v5", 20, 160],
    ["E32as_v5", 32, 256],
    ["E48as_v5", 48, 384],
    ["E64as_v5", 64, 512],
    ["E96as_v5", 96, 672],
    ["E112ias_v5", 112, 672],
  ]),
  ...series([
    ["F2s_v2", 2, 4, 16],
    ["F4s_v2", 4, 8, 32],
    ["F8s_v2", 8, 16, 64],
    ["F16s_v2", 16, 32, 128],
    ["F32s_v2", 32, 64, 256],
    ["F48s_v2", 48, 96, 384],
    ["F64s_v2", 64, 128, 512],
    ["F72s_v2", 72, 144, 576],
  ]),
  ...series([["NC4as_T4_v3", 4, 28, 176]], { gpuCount: 1, gpuModel: "NVIDIA T4", gpuMemoryGb: 16 }),
  ...series([["NC8as_T4_v3", 8, 56, 352]], { gpuCount: 1, gpuModel: "NVIDIA T4", gpuMemoryGb: 16 }),
  ...series([["NC16as_T4_v3", 16, 110, 352]], {
    gpuCount: 1,
    gpuModel: "NVIDIA T4",
    gpuMemoryGb: 16,
  }),
  ...series([["NC64as_T4_v3", 64, 440, 2816]], {
    gpuCount: 4,
    gpuModel: "NVIDIA T4",
    gpuMemoryGb: 16,
  }),
  ...series([["NC24ads_A100_v4", 24, 220, 64]], {
    gpuCount: 1,
    gpuModel: "NVIDIA A100 PCIe",
    gpuMemoryGb: 80,
  }),
  ...series([["NC48ads_A100_v4", 48, 440, 128]], {
    gpuCount: 2,
    gpuModel: "NVIDIA A100 PCIe",
    gpuMemoryGb: 80,
  }),
  ...series([["NC96ads_A100_v4", 96, 880, 256]], {
    gpuCount: 4,
    gpuModel: "NVIDIA A100 PCIe",
    gpuMemoryGb: 80,
  }),
  ...series([["ND96isr_H100_v5", 96, 1900, 1024]], {
    gpuCount: 8,
    gpuModel: "NVIDIA H100",
    gpuMemoryGb: 80,
  }),
  // Partial-GPU sizes (1/6, 1/3, 1/2 of an A10) carry the model but no count,
  // since a fractional GPU count is not a count.
  ...series(
    [
      ["NV6ads_A10_v5", 6, 55, 180],
      ["NV12ads_A10_v5", 12, 110, 360],
      ["NV18ads_A10_v5", 18, 220, 720],
    ],
    { gpuModel: "NVIDIA A10" },
  ),
  ...series(
    [
      ["NV36ads_A10_v5", 36, 440, 1440],
      ["NV36adms_A10_v5", 36, 880, 2880],
    ],
    { gpuCount: 1, gpuModel: "NVIDIA A10", gpuMemoryGb: 24 },
  ),
  ...series([["NV72ads_A10_v5", 72, 880, 2880]], {
    gpuCount: 2,
    gpuModel: "NVIDIA A10",
    gpuMemoryGb: 24,
  }),
};

/**
 * vCPUs from the size name, per Azure's naming convention
 * (learn.microsoft.com/azure/virtual-machines/vm-naming-conventions): the
 * number after the family letters is the vCPU count, and a constrained-vCPU
 * size (`Standard_E4-2s_v5`) has its active count after the dash. The
 * convention does not hold for the first-generation A0-A11 and the D/DS/G/GS
 * v1 and v2 sizes (D11 is 2 vCPUs, D15_v2 is 20), so those return undefined.
 */
export function vcpusFromSizeName(armSkuName: string): number | undefined {
  const m = /^Standard_([A-Z]+)(\d+)(?:-(\d+))?[a-z]*(?:_.*?)?(?:_v(\d+))?$/.exec(armSkuName);
  if (!m) return undefined;
  const family = m[1]!;
  const version = m[4] ? Number(m[4]) : 1;
  if (family === "A" && !m[4]) return undefined;
  if (["D", "DS", "G", "GS"].includes(family) && version <= 2) return undefined;
  const n = Number(m[3] ?? m[2]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function specsFor(armSkuName: string): PriceCatalogSpecs {
  const known = SIZE_SPECS[armSkuName];
  // Arm sizes carry a `p` in the additive features (D2ps_v5, E4pds_v6).
  const arm = /^Standard_[A-Z]+\d+(?:-\d+)?[a-z]*p[a-z]*_/.test(armSkuName);
  const architecture = arm ? "arm64" : "x86_64";
  if (known) {
    return {
      vcpus: known.vcpus,
      memoryGb: known.memoryGb,
      ...(known.gpuCount !== undefined ? { gpuCount: known.gpuCount } : {}),
      ...(known.gpuModel ? { gpuModel: known.gpuModel } : {}),
      ...(known.gpuMemoryGb !== undefined ? { gpuMemoryGb: known.gpuMemoryGb } : {}),
      ...(known.storageGb !== undefined ? { storageGb: known.storageGb, storageType: "ssd" } : {}),
      architecture,
    };
  }
  const vcpus = vcpusFromSizeName(armSkuName);
  return { ...(vcpus !== undefined ? { vcpus } : {}), architecture };
}

function termOf(azureTerm: string | null | undefined): "1yr" | "3yr" | null {
  if (azureTerm === "1 Year") return "1yr";
  if (azureTerm === "3 Years") return "3yr";
  return null;
}

function dateOf(item: RetailPriceItem): string | undefined {
  return item.effectiveStartDate || undefined;
}

/** Pure mapping from Retail Prices rows to catalog products, for one region. */
export function mapVmRows(items: RetailPriceItem[], region: string): PriceCatalogProduct[] {
  interface Acc {
    seriesName?: string;
    prices: Map<string, PriceCatalogPrice>;
  }
  const bySku = new Map<string, Acc>();
  const put = (sku: string, item: RetailPriceItem, price: PriceCatalogPrice) => {
    let acc = bySku.get(sku);
    if (!acc) {
      acc = { prices: new Map() };
      bySku.set(sku, acc);
    }
    const seriesMatch = /^Virtual Machines (.+?) Series/.exec(item.productName);
    if (seriesMatch?.[1] && !acc.seriesName) acc.seriesName = seriesMatch[1];
    // One price per rate type and term; the cheapest row wins, as in the estimator.
    const key = `${price.rateType}|${price.term ?? ""}`;
    const existing = acc.prices.get(key);
    if (!existing || price.amount < existing.amount) acc.prices.set(key, price);
  };

  for (const item of items) {
    const sku = item.armSkuName;
    if (!sku.startsWith("Standard_")) continue; // dedicated hosts, Basic tier
    if (/Windows/i.test(item.productName)) continue;
    if (item.armRegionName && item.armRegionName !== region) continue;
    if (!/Hour/i.test(item.unitOfMeasure)) continue;
    const currency = item.currencyCode || "USD";
    const effectiveDate = dateOf(item);
    const base = { region, unit: "hour" as const, currency };
    const label = `${item.skuName} ${item.meterName}`;
    if (/Low Priority/i.test(label)) continue;

    if (item.type === "Consumption") {
      const spot = /Spot/i.test(label);
      put(sku, item, {
        ...base,
        rateType: spot ? "spot" : "on-demand",
        amount: item.retailPrice,
        ...(effectiveDate ? { effectiveDate } : {}),
      });
      if (!spot) {
        for (const plan of item.savingsPlan ?? []) {
          const term = termOf(plan.term);
          if (!term) continue;
          put(sku, item, { ...base, rateType: "savings-plan", term, amount: plan.retailPrice });
        }
      }
    } else if (item.type === "Reservation") {
      const term = termOf(item.reservationTerm);
      if (!term) continue;
      const hours = term === "1yr" ? HOURS_PER_YEAR : 3 * HOURS_PER_YEAR;
      put(sku, item, {
        ...base,
        rateType: "reserved",
        term,
        amount: item.retailPrice / hours,
        ...(effectiveDate ? { effectiveDate } : {}),
      });
    }
  }

  const products: PriceCatalogProduct[] = [];
  for (const [sku, acc] of bySku) {
    const specs = specsFor(sku);
    const gpu = sku.startsWith("Standard_N");
    products.push({
      sku,
      name: sku.replace(/^Standard_/, ""),
      serviceId: SERVICE_ID,
      family: gpu ? "gpu" : "compute",
      ...(acc.seriesName ? { series: acc.seriesName } : {}),
      specs,
      prices: [...acc.prices.values()],
      estimate: { resourceTypeId: VM_RESOURCE_TYPE, fields: { region: "{region}", size: sku } },
    });
  }
  products.sort((a, b) => a.sku.localeCompare(b.sku));
  return normalizePriceCatalogProducts(products);
}

const cache = new Map<string, { at: number; result: PriceCatalogResult }>();
const inFlight = new Map<string, Promise<PriceCatalogResult>>();

/** For tests. */
export function resetPriceCatalogCache(): void {
  cache.clear();
  inFlight.clear();
}

async function loadRegion(region: string, http?: HttpHostServices): Promise<PriceCatalogResult> {
  const { items, truncated } = await fetchRetailPrices(
    `serviceName eq 'Virtual Machines' and armRegionName eq '${region}' and priceType ne 'DevTestConsumption'`,
    http,
    MAX_PAGES,
  );
  return { products: mapVmRows(items, region), ...(truncated ? { truncated: true } : {}) };
}

export async function fetchPriceCatalog(
  request: PriceCatalogRequest,
  services?: HostServices,
): Promise<PriceCatalogResult> {
  if (request.serviceId !== SERVICE_ID) return { products: [] };
  const region = request.region ?? priceCatalog.regions[0]!.id;
  // Region ids go into an OData literal; anything but an ARM region name is refused.
  if (!/^[a-z0-9]+$/.test(region)) return { products: [] };
  const hit = cache.get(region);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  const pending = inFlight.get(region);
  if (pending) return pending;
  const promise = loadRegion(region, services?.http)
    .then((result) => {
      cache.set(region, { at: Date.now(), result });
      return result;
    })
    .finally(() => inFlight.delete(region));
  inFlight.set(region, promise);
  return promise;
}
