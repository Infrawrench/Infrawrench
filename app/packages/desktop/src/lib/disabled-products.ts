import { useCallback } from "react";
import { useDisabledProductsFrom, useUIStore } from "@infrawrench/ui";
import type { ProductId } from "@infrawrench/client-core";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

/**
 * The apps the active cloud organization has turned off (Settings, Apps).
 * Local mode has no organization and so no policy: nothing is off. Follows a
 * save made in this window without a reload; see `useDisabledProductsFrom`.
 */
export function useDisabledProducts(): ProductId[] {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const load = useCallback(
    () =>
      runRpc(cloudClient("products").products.get({ params: { orgId: activeCloudOrgId ?? "" } })),
    [activeCloudOrgId],
  );
  return useDisabledProductsFrom(activeCloudOrgId, load);
}
