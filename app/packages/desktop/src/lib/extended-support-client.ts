import {
  useUIStore,
  type ExtendedSupportClient,
  type ExtendedSupportListResponse,
} from "@infrawrench/ui";
import { cloudClient } from "./cloud-client";
import { DesktopRpcClient, runRpc } from "./rpc/client";

/**
 * Extended-support data access. Both modes run the same declared support
 * calendars; cloud adds the billed overlay, local is list price only. The org
 * is resolved at call time so signing in or out under a mounted Costs tab
 * reaches the right store (the orphans-client convention).
 */
export function createDesktopExtendedSupportClient(): ExtendedSupportClient {
  return {
    listExtendedSupport: (refresh?: boolean) => {
      const orgId = useUIStore.getState().activeCloudOrgId;
      if (!orgId) return runRpc(DesktopRpcClient.use((rpc) => rpc.LocalExtendedSupportList()));
      const list: Promise<ExtendedSupportListResponse> = runRpc(
        cloudClient("extendedSupport").extendedSupport.list({
          params: { orgId },
          query: refresh ? { refresh: "true" } : {},
        }),
      );
      return list;
    },
  };
}
