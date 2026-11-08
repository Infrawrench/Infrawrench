/**
 * The price catalog: cloud-mode only. Typed calls to the contract's
 * `priceCatalog` domain over the cloud transport (`./cloud-client.ts`).
 */
import {
  priceCatalogQueryString,
  type PriceCatalogCompareQuery,
  type PriceCatalogCompareResponse,
  type PriceCatalogSearchQuery,
  type PriceCatalogSearchResponse,
} from "@infrawrench/client-core";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

const priceCatalog = () => cloudClient("priceCatalog").priceCatalog;

/**
 * The query parameters client-core's serializer writes for a query (empty
 * values dropped, lists joined with commas, the compare `reference` spread
 * into `referencePluginId`/`referenceSku`), the same ones web sends.
 */
function catalogQuery(
  query: PriceCatalogSearchQuery | PriceCatalogCompareQuery,
): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(priceCatalogQueryString(query)));
}

export function searchCloudPriceCatalog(
  orgId: string,
  query: PriceCatalogSearchQuery,
): Promise<PriceCatalogSearchResponse> {
  return runRpc(priceCatalog().search({ params: { orgId }, query: catalogQuery(query) }));
}

export function compareCloudPriceCatalog(
  orgId: string,
  query: PriceCatalogCompareQuery,
): Promise<PriceCatalogCompareResponse> {
  return runRpc(priceCatalog().compare({ params: { orgId }, query: catalogQuery(query) }));
}
