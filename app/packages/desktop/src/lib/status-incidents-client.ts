import { useUIStore, type StatusIncidentsClient } from "@infrawrench/ui";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

/**
 * Provider status correlation is cloud-only: the incident cache is filled by
 * the cloud poller. Resolves the active org at call time, same convention as
 * the changes/costs/orphans clients.
 */
export function createDesktopStatusIncidentsClient(): StatusIncidentsClient {
  return {
    listStatusIncidents: () => {
      const orgId = useUIStore.getState().activeCloudOrgId;
      if (!orgId) {
        throw new Error("Provider status correlation requires cloud mode: sign in to sync.");
      }
      return runRpc(cloudClient("statusIncidents").statusIncidents.list({ params: { orgId } }));
    },
  };
}
