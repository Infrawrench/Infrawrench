/**
 * The realtime relay: Durable Objects in the web edge Worker
 * (`web/edge/realtime.ts`) that give process-bound live state a meeting
 * point every runtime can reach.
 *
 * - **Bastion relay**, one object per bastion. The agent's WebSocket ends in
 *   the object instead of in whichever Node process it happened to dial, and
 *   any Node runtime (the session gateway's replicas, the web Lambda, the
 *   poller Lambda) opens a client socket to it and speaks the ordinary bastion
 *   protocol (`bastion/protocol.ts`). The object multiplexes the clients'
 *   streams onto the agent, renumbering stream ids per client.
 * - **Console relay**, one object per live SSH console. The replica that owns
 *   the pty keeps a host socket to it for the session's life (hibernated, so
 *   an idle one costs nothing); another replica reaches the pty through it,
 *   either with a call (`rpc`) or by bridging a guest's socket (`viewer`). The
 *   decisions stay in the owning replica's `SharedConsoleHub`.
 *
 * Node reaches the objects through the Worker's route on `APP_URL`, with
 * `INTERNAL_RELAY_SECRET` in {@link REALTIME_SECRET_HEADER}; the Worker
 * refuses anything else. Without both settings (local development, a
 * single-process self-host) the relay is off and everything stays in process,
 * exactly as before.
 */

/** Every relay path is under this prefix; none of it is public API. */
export const REALTIME_PREFIX = "/api/realtime";

/** Header carrying `INTERNAL_RELAY_SECRET` from Node to the Worker. */
export const REALTIME_SECRET_HEADER = "x-iw-relay-secret";

/** Where the bastion agent dials (unchanged from the Node endpoint). */
export const BASTION_AGENT_PATH = "/api/bastions/agent";

/** `wss://…/api/realtime/bastions/:id`: a Node client of a bastion's agent. */
export function bastionClientPath(bastionId: string): string {
  return `${REALTIME_PREFIX}/bastions/${encodeURIComponent(bastionId)}`;
}

/** `POST …/api/realtime/bastions/:id/allowlist`: push a new allowlist to the agent. */
export function bastionAllowlistPath(bastionId: string): string {
  return `${bastionClientPath(bastionId)}/allowlist`;
}

/** `wss://…/api/realtime/consoles/:liveId/host`: the owning replica's link. */
export function consoleHostPath(liveConsoleId: string): string {
  return `${REALTIME_PREFIX}/consoles/${encodeURIComponent(liveConsoleId)}/host`;
}

/** `POST …/api/realtime/consoles/:liveId/rpc`: call the owning replica's hub. */
export function consoleRpcPath(liveConsoleId: string): string {
  return `${REALTIME_PREFIX}/consoles/${encodeURIComponent(liveConsoleId)}/rpc`;
}

/** `wss://…/api/realtime/consoles/:liveId/viewer?participant=…`: a bridged guest. */
export function consoleViewerPath(liveConsoleId: string, participantId: string): string {
  return `${REALTIME_PREFIX}/consoles/${encodeURIComponent(liveConsoleId)}/viewer?participant=${encodeURIComponent(participantId)}`;
}

/** Sent by the bastion relay to a client: whether an agent is connected now. */
export interface BastionRelayStatusMessage {
  op: "relay-status";
  agentConnected: boolean;
}

/** Close code the relay uses when it has no agent (client) or no host (viewer). */
export const RELAY_CLOSE_UNAVAILABLE = 4404;

/** Close code for a socket replaced by a newer one for the same role. */
export const RELAY_CLOSE_REPLACED = 4409;

// --- console relay ---------------------------------------------------------

/** The hub methods another replica may call on the owning one. */
export type ConsoleRpcMethod = "describe" | "bindShare" | "mark" | "refresh" | "detach" | "revoke";

/** Relay → host: a call from another replica. */
export interface ConsoleRpcRequest {
  op: "rpc";
  id: string;
  method: ConsoleRpcMethod;
  args: unknown[];
}

/** Host → relay: the answer to {@link ConsoleRpcRequest}. */
export interface ConsoleRpcResponse {
  op: "rpc-result";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Relay → host: a guest's socket arrived on another replica and was bridged. */
export interface ConsoleViewerOpen {
  op: "viewer-open";
  viewer: string;
  participantId: string;
}

/** Relay → host: one frame from a bridged guest (the browser's JSON, verbatim). */
export interface ConsoleViewerFrame {
  op: "viewer-frame";
  viewer: string;
  data: string;
}

/** Relay → host: a bridged guest's socket closed. */
export interface ConsoleViewerGone {
  op: "viewer-gone";
  viewer: string;
}

/** Host → relay: a frame for one bridged guest (JSON, verbatim to the browser). */
export interface ConsoleToViewer {
  op: "to-viewer";
  viewer: string;
  data: string;
}

/** Host → relay: hang up on one bridged guest. */
export interface ConsoleCloseViewer {
  op: "close-viewer";
  viewer: string;
}

export type ConsoleRelayToHost =
  ConsoleRpcRequest | ConsoleViewerOpen | ConsoleViewerFrame | ConsoleViewerGone;
export type ConsoleHostToRelay = ConsoleRpcResponse | ConsoleToViewer | ConsoleCloseViewer;

/** How long the relay waits for the host to answer a call. */
export const CONSOLE_RPC_TIMEOUT_MS = 10_000;
