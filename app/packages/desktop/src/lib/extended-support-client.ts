import {
  useUIStore,
  type ExtendedSupportClient,
  type ExtendedSupportListResponse,
} from "@infrawrench/ui";
import { invoke } from "./invoke";

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
      if (!orgId) return invoke<ExtendedSupportListResponse>("local_extended_support_list");
      return invoke<ExtendedSupportListResponse>("cloud_extended_support_list", {
        orgId,
        refresh: Boolean(refresh),
      });
    },
  };
}
