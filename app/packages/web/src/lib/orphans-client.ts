import type { OrphanListResponse, OrphansClient } from "@infrawrench/ui";
import { apiGet } from "./api";

/** Web implementation of the savings panel's host-injected data access. */
export function createWebOrphansClient(orgId: string): OrphansClient {
  return {
    listOrphans: () => apiGet<OrphanListResponse>(`/api/org/${orgId}/orphans`),
  };
}
