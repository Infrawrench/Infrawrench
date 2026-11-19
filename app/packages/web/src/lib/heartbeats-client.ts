import type { HeartbeatsClient } from "@infrawrench/ui/heartbeats/types";
import type {
  Heartbeat,
  HeartbeatCreate,
  HeartbeatListResponse,
  HeartbeatPatch,
  HeartbeatPingsResponse,
  HeartbeatSuggestionsResponse,
} from "@infrawrench/client-core";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";

/** A server that does not know its public address sends the ping URL as a path. */
function absolute(heartbeat: Heartbeat): Heartbeat {
  return { ...heartbeat, pingUrl: new URL(heartbeat.pingUrl, window.location.origin).toString() };
}

/** Web implementation of the shared heartbeats client, per org. */
export function createWebHeartbeatsClient(orgId: string): HeartbeatsClient {
  const base = `/api/org/${encodeURIComponent(orgId)}/heartbeats`;
  const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    listHeartbeats: async () =>
      (await apiGet<HeartbeatListResponse>(base)).heartbeats.map(absolute),
    listSuggestions: async (resourceId) =>
      (
        await apiGet<HeartbeatSuggestionsResponse>(
          resourceId
            ? `${base}/suggestions?${new URLSearchParams({ resourceId }).toString()}`
            : `${base}/suggestions`,
        )
      ).suggestions,
    listPings: async (id) => (await apiGet<HeartbeatPingsResponse>(`${one(id)}/pings`)).pings,
    createHeartbeat: async (input: HeartbeatCreate) =>
      absolute(await apiPost<Heartbeat>(base, input)),
    updateHeartbeat: async (id: string, patch: HeartbeatPatch) =>
      absolute(await apiPut<Heartbeat>(one(id), patch)),
    deleteHeartbeat: async (id: string) => {
      await apiDelete(one(id));
    },
    rotateToken: async (id: string) =>
      absolute(await apiPost<Heartbeat>(`${one(id)}/rotate-token`, {})),
  };
}
