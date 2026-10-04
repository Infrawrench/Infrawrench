/**
 * Live price catalog.
 *
 * Linode publishes every rate it bills through `.../types` endpoints, each
 * with a default `price { hourly, monthly }` and a `region_prices[]` list of
 * per-region overrides (Jakarta and Sao Paulo cost more, for example). All of
 * them are public; none needs a token scope beyond what the account already
 * has. Verified 2026-10-04 against the live API:
 *
 * - `/linode/types`: plans, plus `addons.backups` (the Backups add-on price)
 * - `/volumes/types`: one `volume` type, priced per GB
 * - `/nodebalancers/types`: `nodebalancer` (common), premium tiers (hourly only)
 * - `/lke/types`: `lke-sa` (free control plane), `lke-ha`, `lke-e`
 * - `/object-storage/types`: `objectstorage` (the $5 base), `objectstorage-overage` per GB
 * - `/network-transfer/prices`: `network_transfer` overage per GB
 * - `/networking/reserved/ips/types`: `reserved-ipv4` (hourly only)
 * - `/databases/types`: per engine, per cluster size
 *
 * Billing model (techdocs "Billing and payments"): every service is billed
 * hourly up to a monthly cap. `monthly` is that cap; a `null` monthly means
 * the service has no cap and runs at hourly × hours (Linode quotes those
 * monthly figures at 730 hours).
 */

import type { LinodeApi } from "./api.js";
import type {
  LinodeDatabaseType,
  LinodePrice,
  LinodeRegionPrice,
  LinodeSimpleType,
  LinodeType,
} from "./types.js";

export const HOURS_PER_MONTH = 730;

export interface PriceCatalog {
  linodeTypes: LinodeType[];
  volumeTypes: LinodeSimpleType[];
  nodeBalancerTypes: LinodeSimpleType[];
  lkeTypes: LinodeSimpleType[];
  objectStorageTypes: LinodeSimpleType[];
  transferPrices: LinodeSimpleType[];
  reservedIpTypes: LinodeSimpleType[];
  databaseTypes: LinodeDatabaseType[];
}

export interface ResolvedPrice {
  hourly: number | null;
  monthly: number | null;
}

interface Priced {
  price?: LinodePrice | undefined;
  region_prices?: LinodeRegionPrice[] | undefined;
}

function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The price that applies in `region`: the regional override when there is one. */
export function regionalPrice(t: Priced | undefined, region: string | undefined): ResolvedPrice {
  if (!t) return { hourly: null, monthly: null };
  const override = region ? t.region_prices?.find((p) => p.id === region) : undefined;
  const src = override ?? t.price;
  return { hourly: num(src?.hourly), monthly: num(src?.monthly) };
}

/** The monthly figure: the cap when there is one, otherwise 730 hours. */
export function monthlyOf(p: ResolvedPrice): number | null {
  if (p.monthly != null) return p.monthly;
  if (p.hourly != null) return p.hourly * HOURS_PER_MONTH;
  return null;
}

/** What `hours` of the service costs within one calendar month: hourly, capped. */
export function accrue(p: ResolvedPrice, hours: number): number | null {
  if (p.hourly == null) return null;
  const raw = p.hourly * Math.max(0, hours);
  return p.monthly != null ? Math.min(raw, p.monthly) : raw;
}

export function findLinodeType(
  catalog: PriceCatalog,
  id: string | undefined,
): LinodeType | undefined {
  if (!id) return undefined;
  return catalog.linodeTypes.find((t) => t.id === id);
}

export function backupsPrice(t: LinodeType | undefined, region: string | undefined): ResolvedPrice {
  const b = t?.addons?.backups;
  return regionalPrice(b ? { price: b.price, region_prices: b.region_prices } : undefined, region);
}

export function simpleType(list: LinodeSimpleType[], id: string): LinodeSimpleType | undefined {
  return list.find((t) => t.id === id);
}

/** Per-cluster price of a Managed Database plan at `clusterSize` nodes. */
export function databasePrice(
  catalog: PriceCatalog,
  typeId: string | undefined,
  engine: string | undefined,
  clusterSize: number,
): ResolvedPrice {
  const t = catalog.databaseTypes.find((d) => d.id === typeId);
  const key = engine === "postgresql" || engine === "postgres" ? "postgresql" : "mysql";
  const row = t?.engines?.[key]?.find((e) => (e.quantity ?? 1) === clusterSize);
  return { hourly: num(row?.price?.hourly), monthly: num(row?.price?.monthly) };
}

export interface PriceCatalogCache {
  get(): Promise<PriceCatalog>;
}

const TTL_MS = 6 * 60 * 60 * 1000;

/**
 * One catalog per client, refreshed every six hours. Each endpoint is fetched
 * independently and a failure leaves its slice empty: an unreachable
 * reserved-IP price must not take Linode plan prices down with it. Callers
 * treat a missing price as "cannot price", never as zero.
 */
export function createPriceCatalogCache(api: LinodeApi): PriceCatalogCache {
  let cached: { at: number; value: Promise<PriceCatalog> } | null = null;

  async function load(): Promise<PriceCatalog> {
    const pick = <T>(r: PromiseSettledResult<T[]>): T[] =>
      r.status === "fulfilled" ? r.value : [];
    const [linodeTypes, volumes, nbs, lke, obj, transfer, reserved, dbs] = await Promise.allSettled(
      [
        api.all<LinodeType>("/linode/types"),
        api.all<LinodeSimpleType>("/volumes/types"),
        api.all<LinodeSimpleType>("/nodebalancers/types"),
        api.all<LinodeSimpleType>("/lke/types"),
        api.all<LinodeSimpleType>("/object-storage/types"),
        api.all<LinodeSimpleType>("/network-transfer/prices"),
        api.all<LinodeSimpleType>("/networking/reserved/ips/types"),
        api.all<LinodeDatabaseType>("/databases/types"),
      ],
    );
    return {
      linodeTypes: pick(linodeTypes),
      volumeTypes: pick(volumes),
      nodeBalancerTypes: pick(nbs),
      lkeTypes: pick(lke),
      objectStorageTypes: pick(obj),
      transferPrices: pick(transfer),
      reservedIpTypes: pick(reserved),
      databaseTypes: pick(dbs),
    };
  }

  return {
    get() {
      const now = Date.now();
      if (!cached || now - cached.at > TTL_MS) {
        const value = load();
        cached = { at: now, value };
        // A failed load must not be cached for six hours.
        value.catch(() => {
          if (cached?.value === value) cached = null;
        });
      }
      return cached.value;
    },
  };
}

/** Plan class → the group the size picker shows it under. */
export function planCategory(cls: string | undefined): string {
  switch (cls) {
    case "nanode":
    case "standard":
      return "Shared CPU";
    case "dedicated":
      return "Dedicated CPU";
    case "premium":
      return "Premium CPU";
    case "highmem":
      return "High Memory";
    case "gpu":
      return "GPU";
    case "accelerated":
      return "Accelerated";
    default:
      return "Other";
  }
}
