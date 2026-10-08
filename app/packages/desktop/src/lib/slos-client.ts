import { useUIStore } from "@infrawrench/ui";
import type { SlosClient } from "@infrawrench/ui/slos";
import {
  createCloudSlo,
  deleteCloudSlo,
  getCloudSlo,
  getCloudSloSources,
  listCloudSlos,
  startCloudSloFreeze,
  updateCloudSlo,
} from "./cloud-slos";

/**
 * SLOs are cloud-only: evaluation runs in the cloud poller over the cloud
 * metric store. The active org is resolved at call time rather than closed
 * over, matching `probes-client.ts`: the org can change under a mounted panel.
 * Every method is offered; the server enforces `resources:write` and
 * `freezes:write`, and the panel shows its error.
 */
function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error("SLOs require cloud mode: sign in to sync.");
  return orgId;
}

export function createDesktopSlosClient(): SlosClient {
  return {
    listSlos: async () => (await listCloudSlos(requireOrgId())).slos,
    getSlo: (sloId) => getCloudSlo(requireOrgId(), sloId),
    listSources: () => getCloudSloSources(requireOrgId()),
    createSlo: (input) => createCloudSlo(requireOrgId(), input),
    updateSlo: (sloId, patch) => updateCloudSlo(requireOrgId(), sloId, patch),
    deleteSlo: (sloId) => deleteCloudSlo(requireOrgId(), sloId),
    startFreeze: (sloId, request) => startCloudSloFreeze(requireOrgId(), sloId, request),
  };
}
