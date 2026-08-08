import { useUIStore } from "@infrawrench/ui";
import type { OwnershipClient } from "@infrawrench/ui";
import {
  clearCloudResourceOwnership,
  fetchCloudResourceOwnership,
  listCloudOwnerCandidates,
  saveCloudResourceOwnership,
} from "./cloud-ownership";

/**
 * Ownership is cloud-only: it is an org record about an org's resources, and a
 * local workspace has neither. The active org is resolved at call time rather
 * than closed over, matching `probes-client.ts` — the org can change under a
 * mounted panel.
 */
function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error("Ownership requires cloud mode — sign in to sync.");
  return orgId;
}

export function createDesktopOwnershipClient(): OwnershipClient {
  return {
    getResourceOwnership: (resourceId) => fetchCloudResourceOwnership(requireOrgId(), resourceId),
    saveResourceOwnership: (patch) => saveCloudResourceOwnership(requireOrgId(), patch),
    clearResourceOwnership: (resourceId) => clearCloudResourceOwnership(requireOrgId(), resourceId),
    listMembers: () => listCloudOwnerCandidates(requireOrgId()),
  };
}
