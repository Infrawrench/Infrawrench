/**
 * Heartbeat monitors: cloud-mode only (pings land on the cloud app and the
 * deadline sweep runs in the cloud poller). Typed calls to the contract's
 * `heartbeats` domain over the cloud transport (`./cloud-client.ts`); each
 * answer is the server's JSON, handed on as the client-core type the panels
 * use, so a contract change the desktop's types disagree with fails here at
 * compile time. The public ping group is not reachable this way: the
 * transport's allowlist refuses unauthenticated routes.
 */
import type {
  Heartbeat,
  HeartbeatCreate,
  HeartbeatListResponse,
  HeartbeatPatch,
  HeartbeatPingsResponse,
  HeartbeatSuggestionsResponse,
} from "@infrawrench/client-core";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

const heartbeats = () => cloudClient("heartbeats").heartbeats;

export function listCloudHeartbeats(orgId: string): Promise<HeartbeatListResponse> {
  return runRpc(heartbeats().list({ params: { orgId } }));
}

export function listCloudHeartbeatSuggestions(
  orgId: string,
  resourceId?: string,
): Promise<HeartbeatSuggestionsResponse> {
  return runRpc(
    heartbeats().suggestions({ params: { orgId }, query: resourceId ? { resourceId } : {} }),
  );
}

export function listCloudHeartbeatPings(
  orgId: string,
  heartbeatId: string,
): Promise<HeartbeatPingsResponse> {
  return runRpc(heartbeats().pings({ params: { orgId, heartbeatId }, query: {} }));
}

export function createCloudHeartbeat(orgId: string, input: HeartbeatCreate): Promise<Heartbeat> {
  return runRpc(heartbeats().create({ params: { orgId }, payload: input }));
}

export function updateCloudHeartbeat(
  orgId: string,
  heartbeatId: string,
  patch: HeartbeatPatch,
): Promise<Heartbeat> {
  return runRpc(heartbeats().update({ params: { orgId, heartbeatId }, payload: patch }));
}

export function rotateCloudHeartbeatToken(orgId: string, heartbeatId: string): Promise<Heartbeat> {
  return runRpc(heartbeats().rotateToken({ params: { orgId, heartbeatId } }));
}

export function deleteCloudHeartbeat(orgId: string, heartbeatId: string): Promise<void> {
  return runRpc(heartbeats().delete({ params: { orgId, heartbeatId } }));
}
