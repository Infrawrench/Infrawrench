/**
 * The Oracle Cloud half of the org-level price catalog: Compute VM shapes,
 * priced from Oracle's public price list (`pricing.ts`, the same rates the
 * create form's shape picker and the estimator use).
 *
 * Credentialed, though the prices are public: the shapes come from
 * `ListShapes` (`/20160918/shapes`), which needs a tenancy. Flexible shapes
 * are listed at the same OCPU steps the create form offers (1, 2, 4... OCPUs
 * at OCI's default memory per OCPU), each as its own product, because a
 * catalog row has to have a vCPU and memory figure to be compared.
 *
 * Two conventions worth knowing:
 *
 * - **Hourly, not monthly.** The estimator quotes OCI months at 744 hours
 *   (OCI's own convention); the catalog emits the hourly rate (OCPU-hours
 *   plus GB-hours from the price list's per-part rates) and lets the host
 *   apply the 730-hour month every other provider is compared on.
 * - **One price per region.** OCI list prices are the same in every
 *   commercial region (https://www.oracle.com/cloud/price-list/), so the
 *   source is not region-scoped and each product carries the same rate for
 *   every declared region; a shape that a region does not offer still
 *   appears there, which the source cannot tell us without a call per region.
 */
import {
  normalizePriceCatalogProducts,
  type PriceCatalogArea,
  type PriceCatalogDeclaration,
  type PriceCatalogProduct,
  type PriceCatalogRequest,
  type PriceCatalogResult,
} from "@infrawrench/plugin-base";
import { PRICE_LIST_URL, shapeParts, sizeOptionsFromShapes, type OciShape } from "./pricing.js";
import { OCI_REGIONS } from "./regions.js";

export const OCI_PRICE_CATALOG_SERVICE = "compute";

function areaFor(id: string): PriceCatalogArea {
  const prefix = id.split("-")[0];
  switch (prefix) {
    case "us":
    case "ca":
    case "mx":
      return "north-america";
    case "sa":
      return "south-america";
    case "ap":
      return /sydney|melbourne/.test(id) ? "oceania" : "asia-pacific";
    case "me":
    case "il":
      return "middle-east";
    case "af":
      return "africa";
    default:
      return "europe";
  }
}

export const ociPriceCatalog: PriceCatalogDeclaration = {
  requiresCredentials: true,
  permission: "inspect instance-family (ListShapes)",
  source: { name: "Oracle Cloud price list", url: "https://www.oracle.com/cloud/price-list/" },
  refreshHours: 24,
  regionScoped: false,
  services: [{ id: OCI_PRICE_CATALOG_SERVICE, label: "Compute (VM shapes)", family: "compute" }],
  regions: OCI_REGIONS.map((r) => ({ id: r.id, label: r.label, area: areaFor(r.id) })),
};

/** Hourly list price of a shape configuration, or undefined when unpriced. */
export function shapeHourly(
  rates: Record<string, number>,
  shape: string,
  ocpus: number,
  memoryGb: number,
): number | undefined {
  const parts = shapeParts(shape);
  if (!parts) return undefined;
  const ocpuRate = rates[parts.ocpu];
  if (ocpuRate === undefined) return undefined;
  let hourly = ocpus * ocpuRate;
  if (parts.memory) {
    const memRate = rates[parts.memory];
    if (memRate === undefined) return undefined;
    hourly += memoryGb * memRate;
  }
  return hourly;
}

/** Pure: shapes + rates → products, one price per declared region. */
export function shapesToProducts(
  shapes: OciShape[],
  rates: Record<string, number>,
): PriceCatalogProduct[] {
  const products: PriceCatalogProduct[] = [];
  for (const size of sizeOptionsFromShapes(shapes, rates)) {
    const [shape = size.id, ocpusRaw, memRaw] = size.id.split("/");
    const fixed = shapes.find((s) => s.shape === shape);
    const ocpus = ocpusRaw !== undefined ? Number(ocpusRaw) : (fixed?.ocpus ?? 0);
    const memoryGb = memRaw !== undefined ? Number(memRaw) : (fixed?.memoryInGBs ?? 0);
    const hourly = shapeHourly(rates, shape, ocpus, memoryGb);
    if (hourly === undefined) continue;
    products.push({
      sku: size.id,
      name: size.label,
      serviceId: OCI_PRICE_CATALOG_SERVICE,
      family: "compute",
      series: shape,
      specs: {
        vcpus: size.vcpus,
        memoryGb,
        architecture: /\.A\d\./i.test(shape) ? "arm64" : "x86_64",
      },
      prices: ociPriceCatalog.regions.map((r) => ({
        region: r.id,
        rateType: "on-demand" as const,
        unit: "hour" as const,
        amount: hourly,
        currency: "USD",
      })),
      estimate: { resourceTypeId: "instance", fields: { region: "{region}", size: size.id } },
    });
  }
  return products;
}

export async function fetchOciPriceCatalog(
  ctx: { listShapes(): Promise<OciShape[]>; rates(): Promise<Record<string, number>> },
  request: PriceCatalogRequest,
): Promise<PriceCatalogResult> {
  if (request.serviceId !== OCI_PRICE_CATALOG_SERVICE) return { products: [] };
  const [shapes, rates] = await Promise.all([ctx.listShapes(), ctx.rates()]);
  return { products: normalizePriceCatalogProducts(shapesToProducts(shapes, rates)) };
}

/** Referenced so the source URL stays the one the estimator fetches. */
export const OCI_PRICE_SOURCE_API = PRICE_LIST_URL;
