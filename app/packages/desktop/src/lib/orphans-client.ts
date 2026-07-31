import { useUIStore, type OrphanListResponse, type OrphansClient } from "@infrawrench/ui";
import { invoke } from "./invoke";

/**
 * The orphan finder is cloud-only: classification runs server-side over the
 * org's synced resources. Resolves the active org at call time (not at client
 * construction) so switching org under a mounted Costs tab reaches the new
 * org's data — same convention as the costs client.
 */
export function createDesktopOrphansClient(): OrphansClient {
  return {
    listOrphans: () => {
      const orgId = useUIStore.getState().activeCloudOrgId;
      if (!orgId) {
        throw new Error("Potential savings requires cloud mode — sign in to sync.");
      }
      return invoke<OrphanListResponse>("cloud_orphans_list", { orgId });
    },
  };
}
