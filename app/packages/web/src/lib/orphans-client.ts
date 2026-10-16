import type {
  IdleFindingSettings,
  IdleFindingsOverview,
  OrphanListResponse,
  OrphansClient,
} from "@infrawrench/ui";
import { apiGet, apiPost, apiPut } from "./api";

/** Web implementation of the Potential savings section's host-injected data access. */
export function createWebOrphansClient(orgId: string): OrphansClient {
  return {
    listOrphans: () => apiGet<OrphanListResponse>(`/api/org/${orgId}/orphans`),
    idleFindings: {
      overview: () => apiGet<IdleFindingsOverview>(`/api/org/${orgId}/idle-findings`),
      save: (settings) =>
        apiPut<IdleFindingSettings>(`/api/org/${orgId}/idle-findings/settings`, settings),
      rescan: async () => {
        await apiPost(`/api/org/${orgId}/idle-findings/rescan`);
      },
    },
  };
}
