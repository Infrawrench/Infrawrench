import { useUIStore, type OrphanListResponse, type OrphansClient } from "@infrawrench/ui";
import { invoke } from "./invoke";

/**
 * Potential savings data access. The same declarative orphan rules classify
 * both modes — what differs is the store they are read from, and whether cost
 * annotation is possible at all:
 *
 * - cloud — the server scans the org's synced rows and annotates each match
 *   with trailing spend from the collected billing data.
 * - local — the main process scans this machine's SQLite workspace
 *   (`local_orphans_list`). No billing data exists locally, so the response
 *   comes back with `costBasis: "unavailable"` and the section drops the cost
 *   column rather than implying every flagged resource is free.
 *
 * The org is resolved at call time (not at client construction) so switching
 * org — including signing in or out — under a mounted Costs tab reaches the
 * right data. Same convention as the costs client.
 */
export function createDesktopOrphansClient(): OrphansClient {
  return {
    listOrphans: () => {
      const orgId = useUIStore.getState().activeCloudOrgId;
      if (!orgId) return invoke<OrphanListResponse>("local_orphans_list");
      return invoke<OrphanListResponse>("cloud_orphans_list", { orgId });
    },
  };
}
