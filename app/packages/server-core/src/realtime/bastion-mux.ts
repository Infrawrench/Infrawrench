/**
 * The bastion relay's stream table, kept free of Durable Object APIs so it can
 * be tested on its own (`web/edge/realtime.ts` feeds it frames and sends what
 * it returns).
 *
 * Each Node client numbers its streams from 1, exactly as it would against a
 * directly connected agent (`bastion/dispatcher.ts`), so two clients collide.
 * The relay gives every stream its own agent-side id and rewrites ids in both
 * directions. Everything else in a frame passes through untouched: the bytes
 * are TLS the relay cannot read, same as the agent.
 */
import type { BastionMessage } from "../bastion/protocol.js";

/** A frame to send, and to whom. `client` is the client's id. */
export type MuxOutput =
  | { to: "agent"; message: BastionMessage }
  | { to: "client"; client: string; message: BastionMessage };

interface Route {
  client: string;
  clientStreamId: number;
}

export class BastionMux {
  private nextAgentStreamId = 1;
  /** agent stream id → the client stream it carries. */
  private readonly routes = new Map<number, Route>();
  /** client id → (client stream id → agent stream id). */
  private readonly byClient = new Map<string, Map<number, number>>();

  /** Streams currently open, for tests and status. */
  get size(): number {
    return this.routes.size;
  }

  /** A frame from a client. `agentConnected` decides whether an open can proceed. */
  fromClient(client: string, message: BastionMessage, agentConnected: boolean): MuxOutput[] {
    switch (message.op) {
      case "open": {
        if (!agentConnected) {
          return [
            {
              to: "client",
              client,
              message: {
                op: "open-failed",
                streamId: message.streamId,
                reason: "agent disconnected",
              },
            },
          ];
        }
        const agentStreamId = this.nextAgentStreamId++;
        this.routes.set(agentStreamId, { client, clientStreamId: message.streamId });
        let streams = this.byClient.get(client);
        if (!streams) {
          streams = new Map();
          this.byClient.set(client, streams);
        }
        streams.set(message.streamId, agentStreamId);
        return [{ to: "agent", message: { ...message, streamId: agentStreamId } }];
      }
      case "data":
      case "end":
      case "close": {
        const agentStreamId = this.byClient.get(client)?.get(message.streamId);
        if (agentStreamId === undefined) {
          // A stream the relay does not know (it hibernated, or the agent went
          // away): close it on the client so undici gives up on it.
          return message.op === "close"
            ? []
            : [
                {
                  to: "client",
                  client,
                  message: { op: "close", streamId: message.streamId, reason: "unknown stream" },
                },
              ];
        }
        if (message.op === "close") this.forget(agentStreamId);
        return [{ to: "agent", message: { ...message, streamId: agentStreamId } }];
      }
      case "ping":
        return [{ to: "client", client, message: { op: "pong" } }];
      default:
        return [];
    }
  }

  /** A frame from the agent. */
  fromAgent(message: BastionMessage): MuxOutput[] {
    switch (message.op) {
      case "opened":
      case "open-failed":
      case "data":
      case "close": {
        const route = this.routes.get(message.streamId);
        if (!route) {
          return message.op === "close" || message.op === "open-failed"
            ? []
            : [
                {
                  to: "agent",
                  message: { op: "close", streamId: message.streamId, reason: "unknown stream" },
                },
              ];
        }
        if (message.op === "open-failed" || message.op === "close") this.forget(message.streamId);
        return [
          {
            to: "client",
            client: route.client,
            message: { ...message, streamId: route.clientStreamId },
          },
        ];
      }
      default:
        return [];
    }
  }

  /** A client went away: close its streams at the agent. */
  clientGone(client: string): MuxOutput[] {
    const streams = this.byClient.get(client);
    if (!streams) return [];
    const out: MuxOutput[] = [];
    for (const agentStreamId of streams.values()) {
      this.routes.delete(agentStreamId);
      out.push({
        to: "agent",
        message: { op: "close", streamId: agentStreamId, reason: "client gone" },
      });
    }
    this.byClient.delete(client);
    return out;
  }

  /** The agent went away: close every stream at its client. */
  agentGone(): MuxOutput[] {
    const out: MuxOutput[] = [];
    for (const route of this.routes.values()) {
      out.push({
        to: "client",
        client: route.client,
        message: { op: "close", streamId: route.clientStreamId, reason: "agent disconnected" },
      });
    }
    this.routes.clear();
    this.byClient.clear();
    return out;
  }

  private forget(agentStreamId: number): void {
    const route = this.routes.get(agentStreamId);
    if (!route) return;
    this.routes.delete(agentStreamId);
    const streams = this.byClient.get(route.client);
    streams?.delete(route.clientStreamId);
    if (streams && streams.size === 0) this.byClient.delete(route.client);
  }
}
