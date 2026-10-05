/**
 * DigitalOcean price catalog: Droplet sizes from `GET /v2/sizes`.
 *
 * `/v2/sizes` is the same source the Droplet create form's size picker, the
 * right-sizing catalog and the DOKS node rates read, so the catalog quotes
 * exactly the figures the rest of the plugin already shows. It needs a token
 * (`sizes:read`), hence the credentialed half of the contract.
 *
 * **Wire shape verified against DigitalOcean's published OpenAPI document,
 * October 2026** (`specification/resources/sizes/models/size.yml`,
 * `gpu_info.yml` and `sizes_list.yml` in github.com/digitalocean/openapi):
 * `memory` is MB, `disk` is GB, `transfer` is TB, `price_monthly` and
 * `price_hourly` are USD, `regions` lists the slugs a size can be created in,
 * and `gpu_info` (`count`, `model` like `nvidia_h100`, `vram.amount` +
 * `vram.unit`) is present on GPU Droplet sizes only. The list paginates with
 * `page` / `per_page` and reports `meta.total`.
 *
 * Choices this module makes:
 *
 * - **Monthly prices.** DigitalOcean bills hourly up to a monthly cap and the
 *   cap is `price_monthly`, so the month figure is what a Droplet left on all
 *   month actually costs. `price_hourly` * 730 would overstate it slightly.
 * - **One price per region in `regions`.** DigitalOcean prices a size the
 *   same everywhere, and `/v2/sizes` carries one price, so each region the
 *   size can be created in gets that same published figure. A region a size
 *   is not offered in gets no row.
 * - **Unavailable sizes and unpriced sizes are skipped.** `available: false`
 *   means no new Droplet can use the size, and some quoted-only sizes return
 *   `price_monthly: 0` (the create form's picker drops that chip too); a zero
 *   there means "ask sales", not "free".
 * - **Managed Databases are not catalogued.** The plugin's database estimate
 *   is a heuristic, and `/v2/databases/options` publishes no prices, so there
 *   is no list price to quote.
 */
import {
  normalizePriceCatalogProducts,
  type PriceCatalogDeclaration,
  type PriceCatalogProduct,
  type PriceCatalogRequest,
  type PriceCatalogResult,
} from "@infrawrench/plugin-base";

export const DO_PRICE_CATALOG_SERVICE_DROPLETS = "droplets";

export const doPriceCatalog: PriceCatalogDeclaration = {
  requiresCredentials: true,
  permission: "sizes:read",
  source: {
    name: "DigitalOcean API: List All Droplet Sizes",
    url: "https://docs.digitalocean.com/reference/api/digitalocean/#tag/Sizes",
  },
  refreshHours: 24,
  regionScoped: false,
  services: [{ id: DO_PRICE_CATALOG_SERVICE_DROPLETS, label: "Droplets", family: "compute" }],
  regions: [
    { id: "nyc3", label: "New York 3", area: "north-america" },
    { id: "nyc1", label: "New York 1", area: "north-america" },
    { id: "nyc2", label: "New York 2", area: "north-america" },
    { id: "sfo3", label: "San Francisco 3", area: "north-america" },
    { id: "sfo2", label: "San Francisco 2", area: "north-america" },
    { id: "atl1", label: "Atlanta 1", area: "north-america" },
    { id: "tor1", label: "Toronto 1", area: "north-america" },
    { id: "ric1", label: "Richmond 1", area: "north-america" },
    { id: "mkc1", label: "Kansas City 1", area: "north-america" },
    { id: "mem1", label: "Memphis 1", area: "north-america" },
    { id: "fra1", label: "Frankfurt 1", area: "europe" },
    { id: "ams3", label: "Amsterdam 3", area: "europe" },
    { id: "lon1", label: "London 1", area: "europe" },
    { id: "sgp1", label: "Singapore 1", area: "asia-pacific" },
    { id: "blr1", label: "Bangalore 1", area: "asia-pacific" },
    { id: "syd1", label: "Sydney 1", area: "oceania" },
  ],
};

/** The subset of a `/v2/sizes` element this module decodes. */
export interface DoSizeWire {
  slug: string;
  memory: number;
  vcpus: number;
  disk: number;
  transfer?: number;
  price_monthly: number;
  price_hourly?: number;
  regions?: string[];
  available: boolean;
  description?: string;
  gpu_info?: {
    count?: number;
    model?: string;
    vram?: { amount?: number; unit?: string };
  };
}

interface DoSizesPage {
  sizes?: DoSizeWire[];
  meta?: { total?: number };
}

/** The client's private `fetch`, bound and passed in (the `DoQuotaContext` shape). */
export interface DoPriceCatalogContext {
  fetch<T>(path: string, options?: RequestInit): Promise<T>;
}

const PER_PAGE = 200;
/** Far above today's catalog (well under 200 sizes); hitting it flags `truncated`. */
const MAX_PAGES = 10;

/** `nvidia_h100` -> `NVIDIA H100`, `amd_mi300x` -> `AMD MI300X`. */
function gpuModelLabel(model: string): string {
  return model
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.toUpperCase())
    .join(" ");
}

/** VRAM in GB, only when the unit is one we can read as GB. */
function vramGb(vram: { amount?: number; unit?: string } | undefined): number | undefined {
  if (!vram || typeof vram.amount !== "number" || !Number.isFinite(vram.amount)) return undefined;
  const unit = (vram.unit ?? "").toLowerCase();
  if (unit === "gib" || unit === "gb") return vram.amount;
  return undefined;
}

/** Map one `/v2/sizes` element to a catalog product, or null when it is not listable. */
export function doSizeToProduct(size: DoSizeWire): PriceCatalogProduct | null {
  if (!size.available) return null;
  const monthly = Number(size.price_monthly);
  if (!Number.isFinite(monthly) || monthly <= 0) return null;
  const regions = Array.isArray(size.regions) ? size.regions : [];
  if (regions.length === 0) return null;

  const gpu = size.gpu_info;
  const isGpu = !!gpu && typeof gpu.count === "number" && gpu.count > 0;
  const gpuMemoryGb = isGpu ? vramGb(gpu?.vram) : undefined;
  const transfer = Number(size.transfer);

  return {
    sku: size.slug,
    name: size.slug,
    serviceId: DO_PRICE_CATALOG_SERVICE_DROPLETS,
    family: isGpu ? "gpu" : "compute",
    ...(size.description ? { series: size.description } : {}),
    specs: {
      vcpus: size.vcpus,
      memoryGb: size.memory / 1024,
      storageGb: size.disk,
      ...(Number.isFinite(transfer) && transfer > 0 ? { network: `${transfer} TB transfer` } : {}),
      ...(isGpu ? { gpuCount: gpu!.count } : {}),
      ...(isGpu && gpu?.model ? { gpuModel: gpuModelLabel(gpu.model) } : {}),
      ...(gpuMemoryGb !== undefined ? { gpuMemoryGb } : {}),
    },
    prices: regions.map((region) => ({
      region,
      rateType: "on-demand" as const,
      unit: "month" as const,
      amount: monthly,
      currency: "USD",
    })),
    estimate: {
      resourceTypeId: "droplet",
      fields: { size: size.slug, region: "{region}" },
    },
  };
}

/** Read every page of `/v2/sizes`. */
export async function fetchDoSizes(
  ctx: DoPriceCatalogContext,
): Promise<{ sizes: DoSizeWire[]; truncated: boolean }> {
  const sizes: DoSizeWire[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await ctx.fetch<DoSizesPage>(`/sizes?per_page=${PER_PAGE}&page=${page}`);
    const batch = data.sizes ?? [];
    sizes.push(...batch);
    const total = data.meta?.total;
    const done = batch.length < PER_PAGE || (typeof total === "number" && sizes.length >= total);
    if (done) return { sizes, truncated: false };
  }
  return { sizes, truncated: true };
}

export async function fetchDoPriceCatalog(
  ctx: DoPriceCatalogContext,
  request: PriceCatalogRequest,
): Promise<PriceCatalogResult> {
  if (request.serviceId !== DO_PRICE_CATALOG_SERVICE_DROPLETS) return { products: [] };
  const { sizes, truncated } = await fetchDoSizes(ctx);
  const products = sizes.map(doSizeToProduct).filter((p): p is PriceCatalogProduct => p !== null);
  return {
    products: normalizePriceCatalogProducts(products),
    ...(truncated ? { truncated: true } : {}),
  };
}
