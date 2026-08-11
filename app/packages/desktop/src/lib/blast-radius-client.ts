import { useUIStore } from "@infrawrench/ui";
import type { BlastRadiusClient } from "@infrawrench/ui";
import { fetchCloudBlastRadius } from "./cloud-resources";

/**
 * The impact report is cloud-only — most of what it looks at (dashboards,
 * probes, status pages, leases, schedules, owners, flow attribution) exists
 * only server-side. The active org is resolved at call time rather than closed
 * over, matching `ownership-client.ts`: the org can change under a mounted
 * panel.
 */
function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error("Blast radius requires cloud mode — sign in to sync.");
  return orgId;
}

export function createDesktopBlastRadiusClient(): BlastRadiusClient {
  return {
    getBlastRadius: (resourceId) => fetchCloudBlastRadius(requireOrgId(), resourceId),
  };
}
