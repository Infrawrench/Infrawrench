/**
 * Akamai Cloud (Linode) price catalog: plans from `GET /v4/linode/types`.
 *
 * The endpoint is public (it answers without an `Authorization` header;
 * checked against the live API on 2026-10-05, and the API reference lists no
 * OAuth scope for "List types"), so this is the public half of the contract:
 * `Plugin.fetchPriceCatalog`, usable by an org that has never connected an
 * Akamai account. The request goes through the plugin's own `LinodeApi` with
 * an empty token, i.e. the host's HTTP plumbing when it has one and the
 * global fetch otherwise.
 *
 * Each type carries `vcpus`, `memory` (MB), `disk` (MB), `transfer` (GB),
 * `network_out` (Mbps), `gpus`, `class`, a default `price { hourly, monthly }`
 * in USD and `region_prices[]`, the regions whose price differs from the
 * default (Jakarta and Sao Paulo today). See `pricing.ts` for the billing
 * model these come from.
 *
 * Choices this module makes:
 *
 * - **One price per declared region**, the `region_prices` override where one
 *   exists, the default price everywhere else; the same `regionalPrice` the
 *   cost estimate and create form use. `/linode/types` says nothing about
 *   which regions *offer* a plan (GPU plans are in a handful), so a row is
 *   the price that would apply there, not a promise of capacity.
 * - **Monthly where Linode publishes a cap, hourly where it does not.** GPU
 *   plans have `monthly: null` (no cap), and a 730-hour figure would be a
 *   number Linode never published, so those are quoted per hour.
 * - **No GPU model.** The API exposes only a `gpus` count; the model appears
 *   only in the free-text `label` (`RTX6000`, `RTX4000 Ada`), which is not a
 *   field this module will parse into a spec.
 */
import {
  normalizePriceCatalogProducts,
  type HostServices,
  type PriceCatalogArea,
  type PriceCatalogDeclaration,
  type PriceCatalogPrice,
  type PriceCatalogProduct,
  type PriceCatalogRegionDeclaration,
  type PriceCatalogRequest,
  type PriceCatalogResult,
} from "@infrawrench/plugin-base";
import { createLinodeApi, type LinodeApi } from "./api.js";
import { planCategory, regionalPrice } from "./pricing.js";
import { KNOWN_REGIONS } from "./regions.js";
import type { LinodeType } from "./types.js";

export const LINODE_PRICE_CATALOG_SERVICE = "linodes";

const AREA_BY_COUNTRY: Record<string, PriceCatalogArea> = {
  us: "north-america",
  ca: "north-america",
  gb: "europe",
  de: "europe",
  fr: "europe",
  se: "europe",
  es: "europe",
  it: "europe",
  nl: "europe",
  sg: "asia-pacific",
  jp: "asia-pacific",
  in: "asia-pacific",
  id: "asia-pacific",
  au: "oceania",
  br: "south-america",
};

/**
 * Regions a cross-provider comparison should prefer for their area, moved to
 * the front of the list. Frankfurt rather than London for Europe, because
 * that is where the other providers' default European regions sit.
 */
const PREFERRED = ["us-east", "eu-central"];

function declaredRegions(): PriceCatalogRegionDeclaration[] {
  const all = KNOWN_REGIONS.flatMap((r) => {
    const area = AREA_BY_COUNTRY[r.country];
    return area ? [{ id: r.id, label: r.label, area }] : [];
  });
  const preferred = PREFERRED.flatMap((id) => all.filter((r) => r.id === id));
  return [...preferred, ...all.filter((r) => !PREFERRED.includes(r.id))];
}

export const linodePriceCatalog: PriceCatalogDeclaration = {
  requiresCredentials: false,
  source: {
    name: "Linode API: List types",
    url: "https://techdocs.akamai.com/linode-api/reference/get-linode-types",
  },
  refreshHours: 24,
  regionScoped: false,
  services: [{ id: LINODE_PRICE_CATALOG_SERVICE, label: "Linodes", family: "compute" }],
  regions: declaredRegions(),
};

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** One plan to a catalog product, priced in each of `regions`. */
export function linodeTypeToProduct(
  t: LinodeType,
  regions: readonly string[],
): PriceCatalogProduct | null {
  const prices: PriceCatalogPrice[] = [];
  for (const region of regions) {
    const p = regionalPrice(t, region);
    if (finite(p.monthly)) {
      prices.push({
        region,
        rateType: "on-demand",
        unit: "month",
        amount: p.monthly,
        currency: "USD",
      });
    } else if (finite(p.hourly)) {
      prices.push({
        region,
        rateType: "on-demand",
        unit: "hour",
        amount: p.hourly,
        currency: "USD",
      });
    }
  }
  if (prices.length === 0) return null;

  const gpus = finite(t.gpus) && t.gpus > 0 ? t.gpus : 0;
  const network = [
    finite(t.transfer) && t.transfer > 0 ? `${t.transfer / 1000} TB transfer` : null,
    finite(t.network_out) && t.network_out > 0 ? `${t.network_out / 1000} Gbps out` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return {
    sku: t.id,
    name: t.label || t.id,
    serviceId: LINODE_PRICE_CATALOG_SERVICE,
    family: gpus > 0 ? "gpu" : "compute",
    series: planCategory(t.class),
    specs: {
      ...(finite(t.vcpus) ? { vcpus: t.vcpus } : {}),
      ...(finite(t.memory) ? { memoryGb: t.memory / 1024 } : {}),
      ...(finite(t.disk) ? { storageGb: t.disk / 1024 } : {}),
      ...(gpus > 0 ? { gpuCount: gpus } : {}),
      ...(network ? { network } : {}),
    },
    prices,
    estimate: {
      resourceTypeId: "linode",
      fields: { type: t.id, region: "{region}" },
    },
  };
}

export async function fetchLinodePriceCatalogWith(
  api: Pick<LinodeApi, "all">,
  request: PriceCatalogRequest,
): Promise<PriceCatalogResult> {
  if (request.serviceId !== LINODE_PRICE_CATALOG_SERVICE) return { products: [] };
  const types = await api.all<LinodeType>("/linode/types");
  const regions = linodePriceCatalog.regions.map((r) => r.id);
  const products = types
    .map((t) => linodeTypeToProduct(t, regions))
    .filter((p): p is PriceCatalogProduct => p !== null);
  return { products: normalizePriceCatalogProducts(products) };
}

/** `Plugin.fetchPriceCatalog`: anonymous, through the host's HTTP when present. */
export function fetchLinodePriceCatalog(
  request: PriceCatalogRequest,
  services?: HostServices,
): Promise<PriceCatalogResult> {
  return fetchLinodePriceCatalogWith(createLinodeApi({ token: "", services }), request);
}
