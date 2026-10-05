/**
 * Scaleway price catalog: Instance types per zone, from the Instance v1 API's
 * `GET /instance/v1/zones/{zone}/products/servers` (the SDK's
 * `Instancev1.API.listServersTypes`, the same call the create form's size
 * picker makes). It needs an API key, hence the credentialed half of the
 * contract, and it is zone-scoped: `request.region` is a zone id
 * (`fr-par-1`, `nl-ams-1`...).
 *
 * Field names verified against the SDK's generated types
 * (`@scaleway/sdk-instance` `v1/types.gen.d.ts`, `ServerType`), October 2026:
 * `ncpus`, `ram` (bytes), `gpu`, `gpuInfo { gpuManufacturer, gpuName,
 * gpuMemory (bytes) }`, `arch`, `volumesConstraint { minSize, maxSize }`
 * (bytes), `perVolumeConstraint.lSsd`, `scratchStorageMaxSize` (bytes),
 * `network.sumInternetBandwidth` (bits/s), `hourlyPrice` (EUR),
 * `monthlyPrice` and `endOfService`. The response is a page of a map keyed by
 * commercial type, with `totalCount`; the endpoint pages with `page` /
 * `per_page`, and the newer v2alpha1 server-types API carries no prices at
 * all, so v1 stays the source.
 *
 * Choices this module makes:
 *
 * - **Hourly prices.** `hourlyPrice` is the billed rate; `monthlyPrice` is
 *   marked deprecated in the API ("estimated monthly price, for a 30 days
 *   month"), so it is not quoted.
 * - **End-of-service types are skipped**: they can no longer be ordered.
 * - **Storage** is the type's included local SSD (`volumesConstraint.maxSize`
 *   when local SSD volumes are allowed) or its scratch NVMe; a block-only
 *   type has no `storageGb`, because its storage is bought separately.
 */
import {
  normalizePriceCatalogProducts,
  type PriceCatalogDeclaration,
  type PriceCatalogProduct,
  type PriceCatalogRequest,
  type PriceCatalogResult,
} from "@infrawrench/plugin-base";
import type { Instancev1 } from "@scaleway/sdk-instance";
import { SCW_ZONES } from "./locations.js";

export const SCW_PRICE_CATALOG_SERVICE = "instances";

const ZONE_LABELS: Record<string, string> = {
  "fr-par-1": "Paris 1",
  "fr-par-2": "Paris 2",
  "fr-par-3": "Paris 3",
  "nl-ams-1": "Amsterdam 1",
  "nl-ams-2": "Amsterdam 2",
  "nl-ams-3": "Amsterdam 3",
  "pl-waw-1": "Warsaw 1",
  "pl-waw-2": "Warsaw 2",
  "pl-waw-3": "Warsaw 3",
  "it-mil-1": "Milan 1",
};

export const scalewayPriceCatalog: PriceCatalogDeclaration = {
  requiresCredentials: true,
  permission: "InstancesReadOnly",
  source: {
    name: "Scaleway Instance API: List Instance types",
    url: "https://www.scaleway.com/en/developers/api/instances/",
  },
  refreshHours: 24,
  regionScoped: true,
  services: [{ id: SCW_PRICE_CATALOG_SERVICE, label: "Instances", family: "compute" }],
  regions: SCW_ZONES.map((zone) => ({
    id: zone,
    label: ZONE_LABELS[zone] ?? zone,
    area: "europe" as const,
  })),
};

type ServerType = Instancev1.ServerType;

export interface ScalewayPriceCatalogContext {
  listServersTypes(request: {
    zone: string;
    page: number;
    perPage: number;
  }): Promise<{ totalCount: number; servers: Record<string, ServerType> }>;
}

const PER_PAGE = 100;
/** Far above today's catalog; hitting it flags `truncated`. */
const MAX_PAGES = 10;
const GIB = 1024 ** 3;
/** Scaleway sizes volumes in decimal bytes (a 20 GB volume is 20 000 000 000). */
const GB = 1e9;

function gpuModel(info: ServerType["gpuInfo"]): string | undefined {
  if (!info?.gpuName) return undefined;
  const maker = info.gpuManufacturer?.trim();
  if (!maker || info.gpuName.toLowerCase().startsWith(maker.toLowerCase())) return info.gpuName;
  return `${maker} ${info.gpuName}`;
}

function storage(st: ServerType): { storageGb?: number; storageType?: string } {
  const localSsdMax = st.perVolumeConstraint?.lSsd?.maxSize ?? 0;
  const included = st.volumesConstraint?.maxSize ?? 0;
  if (localSsdMax > 0 && included > 0)
    return { storageGb: included / GB, storageType: "local ssd" };
  const scratch = st.scratchStorageMaxSize ?? 0;
  if (scratch > 0) return { storageGb: scratch / GB, storageType: "scratch nvme" };
  return { storageType: "block" };
}

/** Map one commercial type in one zone to a catalog product, or null. */
export function scalewayServerTypeToProduct(
  slug: string,
  st: ServerType,
  zone: string,
): PriceCatalogProduct | null {
  if (st.endOfService) return null;
  if (typeof st.hourlyPrice !== "number" || !Number.isFinite(st.hourlyPrice)) return null;
  const gpus = typeof st.gpu === "number" && st.gpu > 0 ? st.gpu : 0;
  const model = gpus > 0 ? gpuModel(st.gpuInfo) : undefined;
  const gpuMemory = gpus > 0 ? st.gpuInfo?.gpuMemory : undefined;
  const internet = st.network?.sumInternetBandwidth;
  const arch = st.arch && st.arch !== "unknown_arch" ? st.arch : undefined;
  return {
    sku: slug,
    name: slug,
    serviceId: SCW_PRICE_CATALOG_SERVICE,
    family: gpus > 0 ? "gpu" : "compute",
    series: slug.replace(/-.*$/, ""),
    specs: {
      vcpus: st.ncpus,
      memoryGb: st.ram / GIB,
      ...(gpus > 0 ? { gpuCount: gpus } : {}),
      ...(model ? { gpuModel: model } : {}),
      ...(gpuMemory && gpuMemory > 0 ? { gpuMemoryGb: gpuMemory / GIB } : {}),
      ...storage(st),
      ...(arch ? { architecture: arch } : {}),
      ...(internet && internet > 0 ? { network: `${internet / 1e9} Gbps internet` } : {}),
    },
    prices: [
      {
        region: zone,
        rateType: "on-demand",
        unit: "hour",
        amount: st.hourlyPrice,
        currency: "EUR",
      },
    ],
    estimate: {
      resourceTypeId: "instance",
      fields: { commercialType: slug, zone: "{region}" },
    },
  };
}

export async function fetchScalewayPriceCatalog(
  ctx: ScalewayPriceCatalogContext,
  request: PriceCatalogRequest,
): Promise<PriceCatalogResult> {
  if (request.serviceId !== SCW_PRICE_CATALOG_SERVICE) return { products: [] };
  const zone = request.region ?? scalewayPriceCatalog.regions[0]!.id;
  const types: Array<[string, ServerType]> = [];
  let truncated = true;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await ctx.listServersTypes({ zone, page, perPage: PER_PAGE });
    const batch = Object.entries(data.servers ?? {});
    types.push(...batch);
    if (batch.length < PER_PAGE || types.length >= data.totalCount) {
      truncated = false;
      break;
    }
  }
  const products = types
    .map(([slug, st]) => scalewayServerTypeToProduct(slug, st, zone))
    .filter((p): p is PriceCatalogProduct => p !== null);
  return {
    products: normalizePriceCatalogProducts(products),
    ...(truncated ? { truncated: true } : {}),
  };
}
