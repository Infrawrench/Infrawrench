import { useUIStore } from "@infrawrench/ui";
import type { ProbesClient } from "@infrawrench/ui/probes";
import {
  createCloudProbe,
  deleteCloudProbe,
  fetchCloudProbeMetrics,
  listCloudProbeSuggestions,
  listCloudProbes,
  updateCloudProbe,
} from "./cloud-probes";

/**
 * Probes are cloud-only: checks run in the cloud poller through the egress
 * proxy, so a desktop app in local mode has nothing to show. The active org is
 * resolved at call time rather than closed over, matching
 * `metric-alerts-client.ts` — the org can change under a mounted panel.
 */
function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error("Synthetic probes require cloud mode — sign in to sync.");
  return orgId;
}

export function createDesktopProbesClient(): ProbesClient {
  return {
    listProbes: async () => (await listCloudProbes(requireOrgId())).probes,
    listSuggestions: async () => (await listCloudProbeSuggestions(requireOrgId())).suggestions,
    probeMetrics: async (probeId, range) =>
      (await fetchCloudProbeMetrics(requireOrgId(), probeId, range)).series,
    createProbe: (input) => createCloudProbe(requireOrgId(), input),
    updateProbe: (probeId, patch) => updateCloudProbe(requireOrgId(), probeId, patch),
    deleteProbe: (probeId) => deleteCloudProbe(requireOrgId(), probeId),
  };
}
