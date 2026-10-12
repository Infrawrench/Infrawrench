import { useUIStore } from "@infrawrench/ui";
import type { ServicesClient } from "@infrawrench/ui/services";
import type { ServiceRef } from "@infrawrench/client-core";
import { listCloudAccounts } from "./cloud-accounts";
import { listCloudOwnerCandidates } from "./cloud-ownership";
import { fetchCloudRunbooks } from "./cloud-resources";
import { listCloudSlos } from "./cloud-slos";
import {
  addCloudServiceMembers,
  createCloudScorecard,
  createCloudService,
  deleteCloudScorecard,
  deleteCloudService,
  evaluateCloudScorecard,
  getCloudOrgScorecard,
  getCloudScorecardOverview,
  getCloudService,
  getCloudServiceScorecards,
  getCloudServicesForResources,
  getCloudServiceSummary,
  listCloudOnCallSchedules,
  listCloudScorecards,
  listCloudServices,
  listCloudTagKeys,
  listCloudVirtualTags,
  removeCloudServiceMember,
  restoreCloudServiceMember,
  searchCloudServiceResources,
  updateCloudScorecard,
  updateCloudService,
} from "./cloud-services";

/**
 * Services are cloud-only: membership is resolved against the cloud
 * inventory and billing data, and scores by the cloud poller. The active org
 * is resolved at call time rather than closed over, matching
 * `slos-client.ts`: the org can change under a mounted panel. Every method is
 * offered; the server enforces `resources:write` (and `team:read` /
 * `costs:read` for two of the pickers, which then just come back empty).
 */
function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error("Services require cloud mode: sign in to sync.");
  return orgId;
}

export function createDesktopServicesClient(): ServicesClient {
  return {
    listServices: async () => (await listCloudServices(requireOrgId())).services,
    getService: (id) => getCloudService(requireOrgId(), id),
    getServiceSummary: (id) => getCloudServiceSummary(requireOrgId(), id),
    getServiceScorecards: (id) => getCloudServiceScorecards(requireOrgId(), id),
    listScorecards: async () => (await listCloudScorecards(requireOrgId())).scorecards,
    getScorecardOverview: () => getCloudScorecardOverview(requireOrgId()),
    getOrgScorecard: () => getCloudOrgScorecard(requireOrgId()),
    listOwnerCandidates: () => listCloudOwnerCandidates(requireOrgId()),
    listOnCallSchedules: () => listCloudOnCallSchedules(requireOrgId()),
    listSlos: async () => (await listCloudSlos(requireOrgId())).slos,
    listRunbooks: () => fetchCloudRunbooks(requireOrgId()),
    listTagKeys: () => listCloudTagKeys(requireOrgId()),
    listVirtualTags: () => listCloudVirtualTags(requireOrgId()),
    listAccounts: async () =>
      (await listCloudAccounts(requireOrgId())).map((a) => ({
        id: a.id,
        pluginId: a.pluginId,
        displayName: a.displayName,
      })),
    searchResources: (query) => searchCloudServiceResources(requireOrgId(), query),
    createService: (input) => createCloudService(requireOrgId(), input),
    updateService: (id, patch) => updateCloudService(requireOrgId(), id, patch),
    deleteService: (id) => deleteCloudService(requireOrgId(), id),
    addMembers: (id, resourceIds) => addCloudServiceMembers(requireOrgId(), id, resourceIds),
    removeMember: (id, resourceId) => removeCloudServiceMember(requireOrgId(), id, resourceId),
    restoreMember: (id, resourceId) => restoreCloudServiceMember(requireOrgId(), id, resourceId),
    createScorecard: (input) => createCloudScorecard(requireOrgId(), input),
    updateScorecard: (id, patch) => updateCloudScorecard(requireOrgId(), id, patch),
    deleteScorecard: (id) => deleteCloudScorecard(requireOrgId(), id),
    evaluateScorecard: (id) => evaluateCloudScorecard(requireOrgId(), id),
  };
}

/** The services one resource belongs to, for the resource page's Ownership tab. */
export async function fetchDesktopServicesForResource(resourceId: string): Promise<ServiceRef[]> {
  const res = await getCloudServicesForResources(requireOrgId(), [resourceId]);
  return res?.services?.[resourceId] ?? [];
}
