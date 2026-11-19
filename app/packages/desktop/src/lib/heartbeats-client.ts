import { useUIStore } from "@infrawrench/ui";
import type { HeartbeatsClient } from "@infrawrench/ui/heartbeats/types";
import type { Heartbeat } from "@infrawrench/client-core";
import { CLOUD_URL } from "../../env";
import {
  createCloudHeartbeat,
  deleteCloudHeartbeat,
  listCloudHeartbeatPings,
  listCloudHeartbeatSuggestions,
  listCloudHeartbeats,
  rotateCloudHeartbeatToken,
  updateCloudHeartbeat,
} from "./cloud-heartbeats";

/**
 * Heartbeats are cloud-only. The active org is resolved at call time rather
 * than closed over, matching `probes-client.ts`: the org can change under a
 * mounted panel.
 */
function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error("Heartbeats require cloud mode: sign in to sync.");
  return orgId;
}

/** A server that does not know its public address sends the ping URL as a path. */
function absolute(heartbeat: Heartbeat): Heartbeat {
  return { ...heartbeat, pingUrl: new URL(heartbeat.pingUrl, CLOUD_URL).toString() };
}

export function createDesktopHeartbeatsClient(): HeartbeatsClient {
  return {
    listHeartbeats: async () =>
      (await listCloudHeartbeats(requireOrgId())).heartbeats.map(absolute),
    listSuggestions: async (resourceId) =>
      (await listCloudHeartbeatSuggestions(requireOrgId(), resourceId)).suggestions,
    listPings: async (id) => (await listCloudHeartbeatPings(requireOrgId(), id)).pings,
    createHeartbeat: async (input) => absolute(await createCloudHeartbeat(requireOrgId(), input)),
    updateHeartbeat: async (id, patch) =>
      absolute(await updateCloudHeartbeat(requireOrgId(), id, patch)),
    deleteHeartbeat: (id) => deleteCloudHeartbeat(requireOrgId(), id),
    rotateToken: async (id) => absolute(await rotateCloudHeartbeatToken(requireOrgId(), id)),
  };
}
