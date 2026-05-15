/**
 * Wire protocol for the bastion-agent ↔ backend WebSocket. Both sides import
 * these types so the multiplex envelope stays in sync as it evolves.
 *
 * The agent dials outbound (so it works behind NAT) and the backend opens
 * one logical TCP stream per cloud-API request, multiplexed over the single
 * WS by `streamId`. Bytes inside the streams are opaque to the agent — TLS
 * is terminated on the backend (client) ↔ cloud API (server), so the agent
 * only sees encrypted bytes.
 */

/** Subprotocol name advertised on the WS Upgrade. */
export const BASTION_WS_SUBPROTOCOL = "infrawrench-bastion-v1";

/** Bumped together with a breaking change to message shapes. Older agents are rejected. */
export const BASTION_PROTOCOL_VERSION = 1;

/** First message backend → agent after a successful auth. */
export interface BastionHelloMessage {
  op: "hello";
  protocolVersion: number;
  /**
   * Hostnames the agent is allowed to open TCP streams to. The backend
   * computes this from the accounts that reference this bastion (one entry
   * per cloud-API hostname). Any `open` for a host outside this list is
   * rejected agent-side — a confused-deputy safeguard.
   *
   * Wildcards are supported as a leading `*.` (e.g. `*.amazonaws.com`).
   * Empty array means "no destinations allowed yet" — useful for the first
   * connect before any accounts are bound.
   */
  allowlist: string[];
  /** Application-level heartbeat interval in milliseconds. */
  heartbeatMs: number;
}

/** backend → agent: open a new TCP stream. */
export interface BastionOpenMessage {
  op: "open";
  streamId: number;
  host: string;
  port: number;
}

/** backend → agent or agent → backend: data on a stream. `data` is base64. */
export interface BastionDataMessage {
  op: "data";
  streamId: number;
  data: string;
}

/** backend → agent: write-half close (TCP FIN from backend side). */
export interface BastionEndMessage {
  op: "end";
  streamId: number;
}

/** agent → backend: stream opened OK (TCP connection up). */
export interface BastionOpenedMessage {
  op: "opened";
  streamId: number;
}

/** agent → backend: stream open failed (DNS, connection refused, allowlist). */
export interface BastionOpenFailedMessage {
  op: "open-failed";
  streamId: number;
  reason: string;
}

/** Either direction: fully close a stream (best-effort half-close on the other side). */
export interface BastionCloseMessage {
  op: "close";
  streamId: number;
  reason?: string;
}

/** Heartbeat. Either side sends ping; the other replies pong. */
export interface BastionPingMessage {
  op: "ping";
}

export interface BastionPongMessage {
  op: "pong";
}

/** agent → backend: optional first message identifying the agent build. */
export interface BastionAgentInfoMessage {
  op: "agent-info";
  agentVersion: string;
}

export type BastionMessage =
  | BastionHelloMessage
  | BastionOpenMessage
  | BastionDataMessage
  | BastionEndMessage
  | BastionOpenedMessage
  | BastionOpenFailedMessage
  | BastionCloseMessage
  | BastionPingMessage
  | BastionPongMessage
  | BastionAgentInfoMessage;
