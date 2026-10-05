/**
 * Hetzner Cloud price catalog: server types from `GET /v1/server_types`.
 *
 * `/server_types` carries the specs (cores, memory GB, disk GB, `cpu_type`,
 * `storage_type`, `architecture`, `category`) and a `prices[]` entry per
 * location with `price_hourly` / `price_monthly` as `{net, gross}` decimal
 * strings, `included_traffic` in bytes and `price_per_tb_traffic`. It needs a
 * project token, hence the credentialed half of the contract. The currency is
 * not on `/server_types`; it comes from `/pricing`, read through the client's
 * existing rate-card cache so a cost pass and a catalog fetch share one call.
 *
 * Wire shape verified against https://docs.hetzner.cloud/cloud.spec.json,
 * October 2026.
 *
 * Choices this module makes:
 *
 * - **Net prices (VAT excluded).** The catalog compares providers, and every
 *   other provider's list price is ex-tax; quoting Hetzner gross would add
 *   German VAT to one column only. This matches the cost collector
 *   (`pricing.ts`, also net). Note the server create form's size picker shows
 *   **gross**, so its chip reads higher than the catalog for the same type.
 * - **Monthly prices.** Hetzner bills hourly up to a monthly cap, and the cap
 *   is `price_monthly`; that is what a server left on all month costs.
 * - **Deprecated locations are dropped.** Deprecation is per location since
 *   2025-09-24 (`locations[].deprecation`); a type deprecated everywhere has
 *   no prices left and so drops out entirely. Older payloads without
 *   `locations[]` fall back to the top-level `deprecation` / `deprecated`.
 *   A location that is merely sold out (`available: false`) keeps its price:
 *   the published rate still stands.
 */
import {
  normalizePriceCatalogProducts,
  type PriceCatalogDeclaration,
  type PriceCatalogPrice,
  type PriceCatalogProduct,
  type PriceCatalogRequest,
  type PriceCatalogResult,
} from "@infrawrench/plugin-base";
import { BYTES_PER_TB, parseDecimal, toNumber } from "./pricing.js";

export const HETZNER_PRICE_CATALOG_SERVICE = "cloud-servers";

export const hetznerPriceCatalog: PriceCatalogDeclaration = {
  requiresCredentials: true,
  permission: "Read",
  source: {
    name: "Hetzner Cloud API: List Server Types",
    url: "https://docs.hetzner.cloud/reference/cloud#server-types-list-server-types",
  },
  refreshHours: 24,
  regionScoped: false,
  services: [{ id: HETZNER_PRICE_CATALOG_SERVICE, label: "Cloud Servers", family: "compute" }],
  regions: [
    { id: "fsn1", label: "Falkenstein", area: "europe" },
    { id: "nbg1", label: "Nuremberg", area: "europe" },
    { id: "hel1", label: "Helsinki", area: "europe" },
    { id: "ash", label: "Ashburn, VA", area: "north-america" },
    { id: "hil", label: "Hillsboro, OR", area: "north-america" },
    { id: "sin", label: "Singapore", area: "asia-pacific" },
  ],
};

interface WirePrice {
  net?: string;
  gross?: string;
}

interface WireDeprecation {
  unavailable_after?: string;
  announced?: string;
}

/** The subset of a `/v1/server_types` element this module decodes. */
export interface HetznerServerTypeWire {
  name: string;
  description?: string;
  cores: number;
  memory: number;
  disk: number;
  cpu_type?: "shared" | "dedicated";
  storage_type?: "local" | "network";
  architecture?: "x86" | "arm";
  category?: string;
  deprecated?: boolean;
  deprecation?: WireDeprecation | null;
  locations?: Array<{ name: string; deprecation?: WireDeprecation | null; available?: boolean }>;
  prices?: Array<{
    location: string;
    price_hourly?: WirePrice;
    price_monthly?: WirePrice;
    included_traffic?: number | null;
  }>;
}

export interface HetznerPriceCatalogContext {
  fetchAll<T>(path: string, rootKey: string): Promise<T[]>;
  /** The project's price currency (from `/pricing`, via the rate-card cache). */
  currency(): Promise<string>;
}

/** Locations a type can still be priced in, or null when every location is (no list). */
function liveLocations(st: HetznerServerTypeWire): Set<string> | null {
  if (st.locations && st.locations.length > 0) {
    return new Set(st.locations.filter((l) => !l.deprecation).map((l) => l.name));
  }
  if (st.deprecation || st.deprecated) return new Set();
  return null;
}

function architectureLabel(arch: HetznerServerTypeWire["architecture"]): string | undefined {
  if (arch === "x86") return "x86_64";
  if (arch === "arm") return "arm64";
  return undefined;
}

function seriesLabel(st: HetznerServerTypeWire): string | undefined {
  if (st.category) return st.category;
  if (st.cpu_type === "shared") return "Shared vCPU";
  if (st.cpu_type === "dedicated") return "Dedicated vCPU";
  return undefined;
}

/** `20 TB included traffic` when every priced location includes the same amount. */
function trafficLabel(prices: NonNullable<HetznerServerTypeWire["prices"]>): string | undefined {
  const amounts = new Set(prices.map((p) => p.included_traffic ?? null));
  if (amounts.size !== 1) return undefined;
  const bytes = [...amounts][0];
  if (typeof bytes !== "number" || bytes <= 0) return undefined;
  const tb = Number(BigInt(Math.trunc(bytes)) / BYTES_PER_TB);
  return tb > 0 ? `${tb} TB included traffic` : undefined;
}

/** Map one server type to a catalog product (net monthly prices), or null. */
export function hetznerServerTypeToProduct(
  st: HetznerServerTypeWire,
  currency: string,
): PriceCatalogProduct | null {
  const live = liveLocations(st);
  const priced = (st.prices ?? []).filter(
    (p) => p.location && p.price_monthly?.net != null && (live === null || live.has(p.location)),
  );
  const prices: PriceCatalogPrice[] = [];
  for (const p of priced) {
    let amount: number;
    try {
      amount = toNumber(parseDecimal(p.price_monthly!.net!, `${st.name} ${p.location} monthly`));
    } catch {
      continue;
    }
    prices.push({ region: p.location, rateType: "on-demand", unit: "month", amount, currency });
  }
  if (prices.length === 0) return null;

  const series = seriesLabel(st);
  const architecture = architectureLabel(st.architecture);
  const network = trafficLabel(priced);
  return {
    sku: st.name,
    name: st.name.toUpperCase(),
    serviceId: HETZNER_PRICE_CATALOG_SERVICE,
    family: "compute",
    ...(series ? { series } : {}),
    specs: {
      vcpus: st.cores,
      memoryGb: st.memory,
      storageGb: st.disk,
      ...(st.storage_type ? { storageType: st.storage_type } : {}),
      ...(architecture ? { architecture } : {}),
      ...(network ? { network } : {}),
    },
    prices,
    estimate: {
      resourceTypeId: "server",
      fields: { serverType: st.name, location: "{region}" },
    },
  };
}

export async function fetchHetznerPriceCatalog(
  ctx: HetznerPriceCatalogContext,
  request: PriceCatalogRequest,
): Promise<PriceCatalogResult> {
  if (request.serviceId !== HETZNER_PRICE_CATALOG_SERVICE) return { products: [] };
  const [serverTypes, currency] = await Promise.all([
    ctx.fetchAll<HetznerServerTypeWire>("/server_types", "server_types"),
    ctx.currency(),
  ]);
  const products = serverTypes
    .map((st) => hetznerServerTypeToProduct(st, currency))
    .filter((p): p is PriceCatalogProduct => p !== null);
  return { products: normalizePriceCatalogProducts(products) };
}
