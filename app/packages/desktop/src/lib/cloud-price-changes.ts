/**
 * List-price changes: cloud-mode only. Typed calls to the contract's
 * `priceChanges` domain over the cloud transport (`./cloud-client.ts`), the
 * same routes web calls.
 */
import type { CatalogPriceChangeResponse, PriceChangeListResponse } from "@infrawrench/client-core";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

const priceChanges = () => cloudClient("priceChanges").priceChanges;

export function listCloudPriceChanges(
  orgId: string,
  days: number,
): Promise<PriceChangeListResponse> {
  return runRpc(priceChanges().list({ params: { orgId }, query: { days: String(days) } }));
}

export function listCloudCatalogPriceChanges(
  orgId: string,
  query: { platform?: string; days: number },
): Promise<CatalogPriceChangeResponse> {
  return runRpc(
    priceChanges().catalog({
      params: { orgId },
      query: { ...(query.platform ? { platform: query.platform } : {}), days: String(query.days) },
    }),
  );
}

export function createCloudPriceChangeScenario(
  orgId: string,
  changeId: string,
): Promise<{ scenarioModelId: string; created: boolean }> {
  return runRpc(priceChanges().createScenario({ params: { orgId, changeId } }));
}
